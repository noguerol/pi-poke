/**
 * Simulation of the post-compaction wake-up logic of the poke extension.
 * Replicates the state machine from src/index.ts to validate the key scenarios
 * without needing a TUI session.
 *
 * Run: node --experimental-strip-types test/sim-postcompact.ts
 * Expect: "28 passed, 0 failed"
 */
type Phase = "idle" | "running" | "between_runs";
type WakePhase = "armed" | "watching";

interface Wake {
	compactionAt: number;
	willRetry: boolean;
	failed: boolean;
	phase: WakePhase;
}

function isInterruptedStopReason(reason: string | undefined): boolean {
	return reason === "error" || reason === "aborted" || reason === "length";
}
function isFailedStopReason(reason: string | undefined): boolean {
	return reason === "error" || reason === "length";
}

class PokeSim {
	wake: Wake | null = null;
	runPhase: Phase = "idle";
	lastRunStopReason: string | undefined;
	lastPostCompactPokeAt = 0;
	pokeCount = 0;
	cooldownMs = 30_000;
	maxPokes = 2;
	pokes: string[] = [];
	now = Date.now();

	agent_start() {
		this.runPhase = "running";
		this.lastRunStopReason = undefined;
	}
	agent_end(stopReason: string) {
		this.runPhase = "between_runs";
		this.lastRunStopReason = stopReason;
	}
	turn_start() {
		if (this.wake && this.wake.phase === "armed") this.wake.phase = "watching";
	}
	compact(willRetry: boolean, failed = false) {
		const interrupted = willRetry || this.runPhase === "running" || isInterruptedStopReason(this.lastRunStopReason);
		if (interrupted) {
			this.wake = { compactionAt: this.now, willRetry, failed, phase: "armed" };
		}
	}
	input() {
		this.wake = null;
		this.pokeCount = 0;
	}
	settled(): boolean {
		this.runPhase = "idle";
		if (!this.wake) return false;
		let shouldPoke = false;
		if (this.wake.phase === "armed") shouldPoke = true;
		else if (this.wake.phase === "watching") shouldPoke = isFailedStopReason(this.lastRunStopReason);
		if (!shouldPoke) {
			this.pokeCount = 0;
			this.wake = null;
			return false;
		}
		if (this.now - this.lastPostCompactPokeAt < this.cooldownMs || this.pokeCount >= this.maxPokes) {
			this.wake = null;
			return false;
		}
		this.pokeCount++;
		this.lastPostCompactPokeAt = this.now;
		this.pokes.push("poke");
		this.wake = null;
		return true;
	}
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.log(`  ✗ ${name}`); }
}

// ============ Scenario 1: the reported bug ============
// Run errors -> threshold compaction after agent_end -> settles without resuming -> POKE
console.log("\n[1] Bug: error after compaction, dead run -> poke");
{
	const s = new PokeSim();
	s.agent_start();
	s.agent_end("error");        // "This operation was aborted"
	s.compact(false);            // threshold, no retry -> interrupted (error)
	// The run does NOT resume: straight to settle
	check("wake armed", s.wake?.phase === "armed");
	check("settle with armed wake -> poke", s.settled() === true);
	check("message sent", s.pokes.length === 1);
}

// ============ Scenario 2: mid-run compaction + healthy completion -> no poke ============
console.log("\n[2] Mid-run compaction and the work finishes fine -> no poke");
{
	const s = new PokeSim();
	s.agent_start();
	s.turn_start();
	s.compact(false);            // threshold mid-run (runPhase = running) -> armed
	check("wake armed (mid-run)", s.wake?.phase === "armed");
	s.turn_start();              // the run continues
	check("wake switches to watching", s.wake?.phase === "watching");
	s.agent_end("stop");         // work completed
	check("settle watching+ok -> no poke", s.settled() === false);
	check("no messages", s.pokes.length === 0);
	check("counter reset after healthy cycle", s.pokeCount === 0);
}

// ============ Scenario 3: overflow willRetry, retry fails -> poke ============
console.log("\n[3] Overflow recovery: retry fails -> poke");
{
	const s = new PokeSim();
	s.agent_start();
	s.agent_end("error");        // overflow error
	s.compact(true);             // willRetry = true -> armed
	s.turn_start();              // continue() starts a turn
	s.agent_end("error");        // the retry also fails
	check("settle watching+error -> poke", s.settled() === true);
	check("message sent", s.pokes.length === 1);
}

// ============ Scenario 4: overflow willRetry, retry OK -> no poke ============
console.log("\n[4] Overflow recovery: retry OK -> no poke");
{
	const s = new PokeSim();
	s.agent_start();
	s.agent_end("length");       // truncated output (recoverable length)
	s.compact(true);             // willRetry
	s.turn_start();
	s.agent_end("stop");         // retry completed
	check("settle watching+ok -> no poke", s.settled() === false);
	check("no messages", s.pokes.length === 0);
}

// ============ Scenario 5: manual compaction (idle) -> no poke ============
console.log("\n[5] Manual compaction with idle agent -> no poke");
{
	const s = new PokeSim();
	// note: "manual" reason is excluded BEFORE compact() is called in index.ts;
	// here it simply must not arm because there is no interrupted work
	s.compact(false);            // manual -> interrupted = false
	check("no wake", s.wake === null);
	check("settle without wake -> no poke", s.settled() === false);
}

// ============ Scenario 6: user presses Esc during the resume -> no poke ============
console.log("\n[6] User presses Esc during the resume -> no poke");
{
	const s = new PokeSim();
	s.agent_start();
	s.agent_end("error");
	s.compact(false);
	s.turn_start();              // resume starts
	s.agent_end("aborted");      // user cancels
	check("settle watching+aborted -> no poke", s.settled() === false);
	check("no messages", s.pokes.length === 0);
}

// ============ Scenario 7: anti-loop (cooldown + max) ============
console.log("\n[7] Anti-loop: max pokes per episode");
{
	const s = new PokeSim();
	// Episode 1: two consecutive failures
	s.agent_start(); s.agent_end("error"); s.compact(false);
	check("poke #1", s.settled() === true);
	s.now += 31_000;             // cooldown passes
	s.agent_start(); s.agent_end("error"); s.compact(false);
	check("poke #2", s.settled() === true);
	s.now += 31_000;
	s.agent_start(); s.agent_end("error"); s.compact(false);
	check("poke #3 blocked (max 2)", s.settled() === false);
	check("only 2 pokes", s.pokes.length === 2);

	// Episode 2: after a healthy cycle the counter resets
	s.now += 31_000;
	s.agent_start(); s.agent_end("error"); s.compact(false);
	s.turn_start(); s.agent_end("stop");   // healthy cycle
	s.settled();
	s.now += 31_000;
	s.agent_start(); s.agent_end("error"); s.compact(false);
	check("poke #3 after healthy cycle (counter reset)", s.settled() === true);
	check("3 pokes total", s.pokes.length === 3);
}

// ============ Scenario 8: user input cancels the pending wake ============
console.log("\n[8] User input cancels the pending wake");
{
	const s = new PokeSim();
	s.agent_start(); s.agent_end("error"); s.compact(false);
	s.input();                   // the user types
	check("wake cancelled", s.wake === null);
	check("settle -> no poke", s.settled() === false);
}

// ============ Scenario 9: failed compaction (not aborted) with interrupted run -> poke ============
console.log("\n[9] Failed compaction (not aborted) with interrupted run -> poke");
{
	const s = new PokeSim();
	s.agent_start(); s.agent_end("error");
	s.compact(false, true);      // session_compact_failed
	check("wake armed (failed)", s.wake?.failed === true);
	check("settle -> poke", s.settled() === true);
}

// ============ Scenario 10: run completes ok and compacts after agent_end -> no poke ============
console.log("\n[10] Threshold compaction after a completed run -> no poke");
{
	const s = new PokeSim();
	s.agent_start(); s.agent_end("stop");   // run completed
	s.compact(false);                        // post-run threshold
	check("no wake (run ok)", s.wake === null);
	check("settle -> no poke", s.settled() === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

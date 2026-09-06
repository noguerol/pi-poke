/**
 * Simulation of the post-compaction wake-up logic of the poke extension.
 * Replicates the state machine from src/index.ts to validate the key scenarios
 * without needing a TUI session.
 *
 * Run: node --experimental-strip-types test/sim-postcompact.ts
 * Expect: "57 passed, 0 failed"
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
	// a retry poke is scheduled to fire when the cooldown expires
	retryScheduled = false;

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
			// a new episode supersedes any scheduled retry
			this.retryScheduled = false;
			this.wake = { compactionAt: this.now, willRetry, failed, phase: "armed" };
		}
	}
	// User input (typed/RPC): the user took control -> cancel the wake.
	input() {
		this.retryScheduled = false;
		this.wake = null;
		this.pokeCount = 0;
	}
	// Our own pokes re-enter as input events with source "extension": they
	// must NOT cancel the wake (mirrors the source filter in index.ts).
	inputFromExtension() {
		// no-op
	}
	manualPoke() {
		// Typing /poke is an explicit user action: for the wake-up state machine
		// it behaves like user input (cancels pending wakes, resets the counter).
		this.input();
	}
	settled(): boolean {
		this.runPhase = "idle";
		if (!this.wake) return false;
		let shouldPoke = false;
		if (this.wake.phase === "armed") shouldPoke = true;
		else if (this.wake.phase === "watching") shouldPoke = isFailedStopReason(this.lastRunStopReason);
		if (!shouldPoke) {
			// healthy resume (or the user aborted it): clear, reset budget
			this.retryScheduled = false;
			this.pokeCount = 0;
			this.wake = null;
			return false;
		}
		if (this.pokeCount >= this.maxPokes) {
			// out of attempts for this episode
			this.retryScheduled = false;
			this.wake = null;
			return false;
		}
		if (this.now - this.lastPostCompactPokeAt < this.cooldownMs) {
			// too soon after the last poke: retry when the cooldown expires
			this.retryScheduled = true;
			return false;
		}
		this.pokeCount++;
		this.lastPostCompactPokeAt = this.now;
		this.pokes.push("poke");
		this.retryScheduled = false;
		// wake is KEPT: the poke message will start a turn (turn_start -> watching)
		// so a failed resume can be retried under the anti-loop budget
		return true;
	}
	// The cooldown timer fired: validate and poke if still appropriate.
	retryFires(): boolean {
		if (!this.retryScheduled || !this.wake) return false;
		this.retryScheduled = false;
		if (this.pokeCount >= this.maxPokes) {
			this.wake = null;
			return false;
		}
		if (this.now - this.lastPostCompactPokeAt < this.cooldownMs) return false;
		this.pokeCount++;
		this.lastPostCompactPokeAt = this.now;
		this.pokes.push("poke");
		return true;
	}
}

// ============ Orphaned-tool auto-poke ============
// Mirrors maybePokeOrphanedTool() + the wake-less agent_settled episode reset
// from src/index.ts: the long-tool auto-poke only fires on real stall evidence
// (agent idle + last run interrupted + an overdue tool still running).
class OrphanSim {
	runPhase: Phase = "idle";
	lastRunStopReason: string | undefined;
	lastPokeAt = 0;
	pokeCount = 0;
	cooldownMs = 30_000;
	maxPokes = 2;
	pokes: string[] = [];
	now = Date.now();
	// the overdue tool is still pending; one poke per tool
	toolPending = false;
	toolPokeSent = false;

	agent_start() {
		this.runPhase = "running";
		this.lastRunStopReason = undefined;
	}
	agent_end(stopReason: string) {
		this.runPhase = "between_runs";
		this.lastRunStopReason = stopReason;
	}
	settle() {
		this.runPhase = "idle";
		// wake-less settle: closes the poke episode unless it is an interrupted
		// stall with an overdue (not yet poked) orphaned tool
		const stalledOrphan = this.toolPending && !this.toolPokeSent;
		if (!isInterruptedStopReason(this.lastRunStopReason) || !stalledOrphan) {
			this.pokeCount = 0;
		}
	}
	toolStart() {
		this.toolPending = true;
		this.toolPokeSent = false;
	}
	toolEnd() {
		this.toolPending = false;
	}
	monitorTick(): boolean {
		if (this.runPhase !== "idle") return false;
		if (!isInterruptedStopReason(this.lastRunStopReason)) return false;
		if (!this.toolPending || this.toolPokeSent) return false;
		if (this.now - this.lastPokeAt < this.cooldownMs || this.pokeCount >= this.maxPokes) return false;
		this.toolPokeSent = true;
		this.pokeCount++;
		this.lastPokeAt = this.now;
		this.pokes.push("poke");
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

// ============ Scenario 11: manual /poke cancels the pending wake ============
console.log("\n[11] Manual /poke (user kick) cancels a pending automatic wake");
{
	const s = new PokeSim();
	s.agent_start();
	s.agent_end("error");
	s.compact(false);            // stalled after compaction, auto-poke pending
	check("wake armed", s.wake?.phase === "armed");
	s.manualPoke();              // the user types /poke
	check("wake cancelled by manual poke", s.wake === null);
	check("anti-loop counter reset", s.pokeCount === 0);
	check("settle -> no automatic poke (user took control)", s.settled() === false);
}

// ============ Scenario 12: orphaned-tool auto-poke ============
// The run dies while a tool is still running past the threshold -> poke once.
console.log("\n[12] Auto-poke only on stall evidence (run died with tool pending)");
{
	// Healthy slow tool in a live run: never poked
	const healthy = new OrphanSim();
	healthy.agent_start();
	healthy.toolStart();
	check("healthy run + long tool: no poke (run still alive)", healthy.monitorTick() === false);
	healthy.toolEnd();
	healthy.agent_end("stop");
	healthy.settle();
	check("healthy completion: no poke", healthy.pokes.length === 0);

	// The stall: run dies interrupted while the tool is still pending
	const s = new OrphanSim();
	s.agent_start();
	s.toolStart();
	s.agent_end("error");       // run dies mid-tool
	s.settle();
	check("settle keeps episode open (stalled orphan)", s.pokeCount === 0);
	check("idle + interrupted + orphan overdue -> poke", s.monitorTick() === true);
	check("one poke sent", s.pokes.length === 1);
	// Same orphan still pending: no second poke (per-tool latch)
	s.agent_start(); s.agent_end("error"); s.settle();
	check("same orphan: no re-poke", s.monitorTick() === false);
	// Tool completes; healthy cycle closes the episode
	s.toolEnd();
	s.agent_start(); s.agent_end("stop"); s.settle();
	check("healthy settle resets the poke budget", s.pokeCount === 0);
	// New stall episode can poke again
	s.toolStart();
	s.agent_end("error"); s.settle();
	s.now += 31_000;            // cooldown passes
	check("new episode pokes again", s.monitorTick() === true);
	check("two pokes total", s.pokes.length === 2);

	// Anti-loop: max pokes per episode with repeated stalled tools
	const loop = new OrphanSim();
	for (let i = 0; i < 3; i++) {
		loop.agent_start();
		loop.toolStart();
		loop.agent_end("length");
		loop.settle();
		loop.now += 31_000;
		loop.monitorTick();
	}
	check("max 2 pokes per stalled episode", loop.pokes.length === 2);
}

// ============ Scenario 13: the reported bug — poke resume fails again ============
// Post-compaction poke #1 is sent, its own resumed turn ALSO fails (timeout).
// Poke must not give up: it retries once the cooldown expires, like a manual
// "continue" would — instead of leaving the session hung until the user types.
console.log("\n[13] Poke resume fails again -> scheduled retry after the cooldown");
{
	const s = new PokeSim();
	s.agent_start();
	s.agent_end("error");       // "Request timed out."
	s.compact(false);            // auto threshold compaction -> armed
	check("wake armed", s.wake?.phase === "armed");
	check("poke #1", s.settled() === true);
	check("wake kept (watches the poke's own resume)", s.wake !== null);
	s.turn_start();              // the poke message starts a turn
	check("phase -> watching", s.wake?.phase === "watching");
	s.agent_end("error");       // the resumed turn times out too
	check("fresh failure within cooldown: no instant 2nd poke", s.settled() === false);
	check("retry scheduled", s.retryScheduled === true);
	check("still only 1 poke", s.pokes.length === 1);
	s.now += 31_000;             // cooldown expires
	check("scheduled retry fires", s.retryFires() === true);
	check("2 pokes total", s.pokes.length === 2);
	s.turn_start();
	s.agent_end("stop");        // the retry resumes and completes
	check("healthy resume clears wake + budget", s.settled() === false && s.wake === null && s.pokeCount === 0);
}

// ============ Scenario 14: extension input does not cancel the wake ============
console.log("\n[14] Extension-source input (own pokes) does not cancel the wake");
{
	const s = new PokeSim();
	s.agent_start();
	s.agent_end("error");
	s.compact(false);
	check("poke #1", s.settled() === true);
	s.inputFromExtension();      // the poke's sendUserMessage re-enters as input
	check("wake survives extension input", s.wake !== null);
	check("budget survives extension input", s.pokeCount === 1);
	s.turn_start();
	s.agent_end("error");       // poke resume fails
	check("failed poke-resume still schedules a retry", s.settled() === false && s.retryScheduled === true);
	s.input();                   // the user finally types -> full reset
	check("user input cancels wake and retry", s.wake === null && s.retryScheduled === false && s.pokeCount === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

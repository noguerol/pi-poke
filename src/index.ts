/**
 * Poke extension for pi
 *
 * Detects tool calls that take too long and notifies the user or aborts
 * execution. Configuration is persisted per session (session entry) with an
 * optional `poke` block in settings.json.
 *
 * Additional case: post-compaction wake-up. With local models (and sometimes
 * remote APIs), when the agent compacts the context mid-turn or after an
 * error, the work turn sometimes dies ("Error: This operation was aborted")
 * and the agent sits idle without continuing. Poke detects this and restarts
 * the turn by asking the model to continue.
 *
 * Commands:
 *   /poke config - Open the extension configuration dialog
 *   /poke status - Show current state
 *   /poke enable / /poke disable - Enable/disable auto-poke
 *   /poke threshold <seconds> - Set the threshold in seconds
 *   /poke postcompact <on|off> - Toggle the post-compaction wake-up
 *
 * The TUI dialog (/poke config) and the settings.json reader live in
 * ./ui.ts and ./config.ts and are loaded lazily; this file registers the
 * command, the hooks and keeps the runtime state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// State persisted in the session
interface PokeState {
	enabled: boolean;
	thresholdSeconds: number;
	autoAbort: boolean;
	autoPoke: boolean;
	// Post-compaction wake-up
	postCompactPoke: boolean;
	postCompactCooldownSeconds: number;
	postCompactMaxPokes: number;
}

// Runtime state
interface RunningTool {
	toolCallId: string;
	toolName: string;
	startTime: number;
	notified: boolean;
}

/**
 * Pending wake after a compaction: the compaction interrupted a turn that
 * should have resumed (or the resume attempt itself failed).
 */
interface PostCompactWake {
	compactionAt: number;
	reason: "threshold" | "overflow" | "manual";
	willRetry: boolean;
	/** true when compaction failed (session_compact_failed) instead of completing */
	failed: boolean;
	errorMessage?: string;
	tokensBefore?: number;
	/**
	 * "armed"    -> compaction happened but no turn has resumed yet
	 * "watching" -> a turn started after the compaction; we watch how it ends
	 */
	phase: "armed" | "watching";
}

const DEFAULT_STATE: PokeState = {
	enabled: false,
	thresholdSeconds: 30,
	autoAbort: false,
	autoPoke: true,
	postCompactPoke: true,
	postCompactCooldownSeconds: 30,
	postCompactMaxPokes: 2,
};

export default function pokeExtension(pi: ExtensionAPI) {
	// Runtime state
	let state: PokeState = { ...DEFAULT_STATE };
	const runningTools: Map<string, RunningTool> = new Map();
	let checkInterval: NodeJS.Timeout | null = null;

	// --- Post-compaction wake-up state ---
	let wake: PostCompactWake | null = null;
	let runPhase: "idle" | "running" | "between_runs" = "idle";
	// stopReason of the last assistant message of the last run:
	// "stop" | "toolUse" | "error" | "aborted" | "length" | ...
	let lastRunStopReason: string | undefined;
	let lastRunErrorMessage: string | undefined;
	let postCompactPokeCount = 0;
	let lastPostCompactPokeAt = 0;
	// The session-bound API: the pi captured at load time, or the fresh context
	// received via withSession() after a session replacement (newSession, fork,
	// switchSession, /resume). After a replacement the captured pi is stale and
	// its sendUserMessage is undefined, so deferred work must use this instead.
	let sessionApi: ExtensionAPI | { sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void> } = pi;

	// Persist state in the session
	function persistState(ctx: ExtensionContext) {
		pi.appendEntry<PokeState>("poke-config", {
			enabled: state.enabled,
			thresholdSeconds: state.thresholdSeconds,
			autoAbort: state.autoAbort,
			autoPoke: state.autoPoke,
			postCompactPoke: state.postCompactPoke,
			postCompactCooldownSeconds: state.postCompactCooldownSeconds,
			postCompactMaxPokes: state.postCompactMaxPokes,
		});
	}

	// Restore state from the session or settings.json
	async function restoreState(ctx: ExtensionContext) {
		// First load from settings.json (if present) — lazy lib
		const { loadConfigFromSettings } = await import("./config.ts");
		const settingsConfig = loadConfigFromSettings(ctx);

		// Then load from the session (overrides)
		const branchEntries = ctx.sessionManager.getBranch();
		let savedState: PokeState | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "poke-config") {
				const data = entry.data as PokeState | undefined;
				if (data) {
					savedState = data;
				}
			}
		}

		// Merge: DEFAULT <- settings.json <- session
		state = { ...DEFAULT_STATE, ...settingsConfig, ...savedState };
	}

	// Reset the post-compaction wake-up state
	function resetPostCompactState() {
		wake = null;
		runPhase = "idle";
		lastRunStopReason = undefined;
		lastRunErrorMessage = undefined;
		postCompactPokeCount = 0;
		lastPostCompactPokeAt = 0;
	}

	// ------------------------------------------------------------------
	// Footer status: always visible, compact — 📌 p:on / 📌 p:off,
	// with an optional transient suffix (running tool, warning, watching…)
	// that falls back to the base state when cleared.
	// ------------------------------------------------------------------
	function pokeStatusText(ctx: ExtensionContext, suffix?: string): string {
		const base = state.enabled
			? ctx.ui.theme.fg("success", "📌 p:on")
			: ctx.ui.theme.fg("dim", "📌 p:off");
		return suffix ? `${base} ${suffix}` : base;
	}

	function setPokeStatus(ctx: ExtensionContext, suffix?: string) {
		ctx.ui.setStatus("poke", pokeStatusText(ctx, suffix));
	}

	/**
	 * Arm the post-compaction wake. Only armed when the compaction interrupted
	 * in-flight work that should continue:
	 *   - willRetry (overflow recovery): the turn must be retried no matter what
	 *   - compaction happened inside an active run (mid-run threshold)
	 *   - the last run ended with error/aborted/length (threshold after agent_end)
	 */
	function armWake(
		params: Pick<PostCompactWake, "reason" | "willRetry" | "failed"> & {
			errorMessage?: string;
			tokensBefore?: number;
		},
		ctx: ExtensionContext,
	) {
		wake = {
			compactionAt: Date.now(),
			reason: params.reason,
			willRetry: params.willRetry,
			failed: params.failed,
			errorMessage: params.errorMessage,
			tokensBefore: params.tokensBefore,
			phase: "armed",
		};
		ctx.ui.setStatus("poke", pokeStatusText(ctx, ctx.ui.theme.fg("warning", "👀 post-compact")));
	}

	/**
	 * Did the run end interrupted (used to arm the wake)? error/aborted/length
	 * mean the work did not complete.
	 */
	function isInterruptedStopReason(reason: string | undefined): boolean {
		return reason === "error" || reason === "aborted" || reason === "length";
	}

	/**
	 * Did the run fail on its own (used to decide poking in "watching" phase)?
	 * Excludes "aborted": if the user pressed Esc during the resume attempt,
	 * we respect their decision and do not re-poke.
	 */
	function isFailedStopReason(reason: string | undefined): boolean {
		return reason === "error" || reason === "length";
	}

	function wakeInterrupted(willRetry: boolean): boolean {
		return willRetry || runPhase === "running" || isInterruptedStopReason(lastRunStopReason);
	}

	function buildPostCompactPokeMessage(w: PostCompactWake): string {
		const err = w.errorMessage ?? lastRunErrorMessage;
		const errSuffix = err ? ` (error: "${err}")` : "";
		const tokens = w.tokensBefore ? ` (~${Math.round(w.tokensBefore / 1000)}k tokens compacted)` : "";

		if (w.failed) {
			return [
				`[Poke] Automatic context compaction failed${errSuffix} and the previous work turn was interrupted.`,
				`Resume the work where it left off: review the current state and continue the last task in progress.`,
				`If the context is still too full, compact manually with /compact or reduce the scope of the task.`,
			].join("\n");
		}

		return [
			`[Poke] Context compaction finished${tokens}, but the previous work turn was interrupted${errSuffix} and did not resume automatically.`,
			`Resume the work where it left off: review the compaction summary and continue the last task in progress.`,
			`If the work was already complete, reply briefly with the final state.`,
		].join("\n");
	}

	// Start the monitoring interval
	function startMonitoring(ctx: ExtensionContext) {
		if (checkInterval) {
			return;
		}

		checkInterval = setInterval(() => {
			if (!state.enabled || runningTools.size === 0) {
				return;
			}

			const now = Date.now();
			const thresholdMs = state.thresholdSeconds * 1000;

			for (const [toolCallId, tool] of runningTools.entries()) {
				const elapsed = now - tool.startTime;

				// Tool call exceeds the threshold
				if (elapsed >= thresholdMs && !tool.notified) {
					tool.notified = true;

					const elapsedSec = Math.round(elapsed / 1000);
					const message = `⚠️ Tool call '${tool.toolName}' (${toolCallId}) has been running for ${elapsedSec}s (threshold: ${state.thresholdSeconds}s)`;

					ctx.ui.notify(message, "warning");
					ctx.ui.setStatus("poke", pokeStatusText(ctx, ctx.ui.theme.fg("warning", `⚠️ ${tool.toolName} ${elapsedSec}s`)));

					// Auto-abort when enabled
					if (state.autoAbort) {
						ctx.ui.notify(`🔴 Aborting tool call '${tool.toolName}' due to timeout`, "error");
						ctx.abort();
						runningTools.delete(toolCallId);
					}

					// Auto-poke when enabled
					if (state.autoPoke && !state.autoAbort) {
						const pokeMessage = `[Poke] The tool call '${tool.toolName}' is taking too long (${elapsedSec}s). Is it still in progress?`;
						pi.sendUserMessage(pokeMessage, { deliverAs: "steer" });
						ctx.ui.notify(`📌 Auto-poke sent: ${pokeMessage}`, "info");
					}
				}
			}

			// Restore the base footer status when no tools are running
			if (runningTools.size === 0) {
				setPokeStatus(ctx);
			}
		}, 1000); // Check every second
	}

	// Stop the monitoring
	function stopMonitoring() {
		if (checkInterval) {
			clearInterval(checkInterval);
			checkInterval = null;
		}
	}

	// Register the /poke command
	pi.registerCommand("poke", {
		description: "Configure auto-poke for long tool calls and the post-compaction wake-up",
		getArgumentCompletions: (prefix) => {
			const subs = ["config", "enable", "disable", "status", "threshold", "postcompact"];
			const first = prefix.trim().split(/\s+/)[0]?.toLowerCase();
			const second = prefix.trim().split(/\s+/)[1]?.toLowerCase();
			// After "threshold": suggest a few common values
			if (first === "threshold" && second !== undefined) {
				const values = ["10", "30", "60", "120", "300"];
				const filtered = values.filter((v) => v.startsWith(second));
				return filtered.map((v) => ({ value: v, label: v }));
			}
			// After "postcompact": suggest on/off
			if (first === "postcompact" && second !== undefined) {
				const values = ["on", "off"];
				const filtered = values.filter((v) => v.startsWith(second));
				return filtered.map((v) => ({ value: v, label: v }));
			}
			const filtered = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();

			switch (subcommand) {
				case "config":
					// TUI dialog — lazy lib
					const { showConfigDialog } = await import("./ui.ts");
					await showConfigDialog(ctx, state, persistState);
					break;

				case "enable":
					state.enabled = true;
					persistState(ctx);
					ctx.ui.notify("✅ Auto-poke enabled", "success");
					setPokeStatus(ctx);
					break;

				case "disable":
					state.enabled = false;
					persistState(ctx);
					ctx.ui.notify("⏸️ Auto-poke disabled", "info");
					setPokeStatus(ctx);
					break;

				case "threshold": {
					const seconds = parseInt(parts[1], 10);
					if (isNaN(seconds) || seconds < 1) {
						ctx.ui.notify("Usage: /poke threshold <seconds> (e.g. 30)", "error");
						return;
					}
					state.thresholdSeconds = seconds;
					persistState(ctx);
					ctx.ui.notify(`⏱️ Threshold set: ${seconds}s`, "info");
					break;
				}

				case "postcompact": {
					const sub = parts[1]?.toLowerCase();
					if (sub === "on") {
						state.postCompactPoke = true;
						persistState(ctx);
						ctx.ui.notify("✅ Post-compaction poke enabled", "success");
					} else if (sub === "off") {
						state.postCompactPoke = false;
						persistState(ctx);
						ctx.ui.notify("⏸️ Post-compaction poke disabled", "info");
					} else {
						ctx.ui.notify(
							`Usage: /poke postcompact <on|off> (current: ${state.postCompactPoke ? "on" : "off"})`,
							"info",
						);
					}
					break;
				}

				case "status":
				default:
					const statusText = [
						"⚡ Poke Extension Status",
						`  Enabled: ${state.enabled ? "✅ yes" : "❌ no"}`,
						`  Threshold: ${state.thresholdSeconds}s`,
						`  Auto-abort: ${state.autoAbort ? "✅ yes" : "❌ no"}`,
						`  Auto-poke: ${state.autoPoke ? "✅ yes" : "❌ no"}`,
						`  Post-compaction poke: ${state.postCompactPoke ? "✅ yes" : "❌ no"}`,
						`  Post-compaction cooldown: ${state.postCompactCooldownSeconds}s (max ${state.postCompactMaxPokes} pokes)`,
						`  Tools running: ${runningTools.size}`,
					].join("\n");
					ctx.ui.notify(statusText, "info");
			}
		},
	});

	// Monitor tool call starts
	pi.on("tool_execution_start", async (event, ctx) => {
		if (!state.enabled) {
			return;
		}

		runningTools.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			startTime: Date.now(),
			notified: false,
		});

		if (ctx.mode === "tui") {
			ctx.ui.setStatus("poke", pokeStatusText(ctx, ctx.ui.theme.fg("dim", `⏳ ${event.toolName}`)));
		}
	});

	// Monitor tool call ends
	pi.on("tool_execution_end", async (event, ctx) => {
		const tool = runningTools.get(event.toolCallId);
		if (tool) {
			const elapsed = Math.round((Date.now() - tool.startTime) / 1000);
			runningTools.delete(event.toolCallId);

			if (ctx.mode === "tui" && runningTools.size === 0) {
				setPokeStatus(ctx);
			}

			// Notify if it was a long tool call (even though it finished)
			if (elapsed >= state.thresholdSeconds && state.enabled) {
				ctx.ui.notify(
					`⏱️ Tool call '${event.toolName}' completed after ${elapsed}s (threshold: ${state.thresholdSeconds}s)`,
					"warning",
				);
			}
		}
	});

	// =========================================================================
	// Post-compaction wake-up
	//
	// Problem: with local models (and sometimes APIs), after a compaction the
	// run can die (e.g. "Error: This operation was aborted") and the agent sits
	// idle without continuing. Poke detects that the compaction interrupted a
	// turn that never resumed and restarts the work by asking the model to
	// continue.
	//
	// Signals:
	//   - session_compact / session_compact_failed: compaction (auto)
	//   - turn_start: a turn resumed -> we watch how it ends
	//   - agent_end: outcome of the last run (error? abort? ok)
	//   - agent_settled: the run fully settled -> decide poke or clean up
	//   - input: the user took control -> cancel
	// =========================================================================

	// A new run starts (prompt or continue)
	pi.on("agent_start", async (_event, _ctx) => {
		runPhase = "running";
		lastRunStopReason = undefined;
		lastRunErrorMessage = undefined;
	});

	// A run ends (low-level); look at the stopReason of its last message
	pi.on("agent_end", async (event, _ctx) => {
		runPhase = "between_runs";
		const msgs = event.messages ?? [];
		const lastAssistant = [...msgs].reverse().find((m) => m && m.role === "assistant");
		if (lastAssistant) {
			lastRunStopReason = lastAssistant.stopReason;
			lastRunErrorMessage = lastAssistant.errorMessage;
		}
	});

	// A turn starts: if a wake was armed, switch to watching
	pi.on("turn_start", async (_event, _ctx) => {
		if (wake && wake.phase === "armed") {
			wake.phase = "watching";
		}
	});

	// Compaction completed
	pi.on("session_compact", async (event, ctx) => {
		if (!state.enabled || !state.postCompactPoke) {
			return;
		}
		// Only automatic compaction that interrupted in-flight work
		if (event.reason !== "manual" && wakeInterrupted(event.willRetry)) {
			armWake(
				{
					reason: event.reason,
					willRetry: event.willRetry,
					failed: false,
					tokensBefore: event.compactionEntry?.tokensBefore,
				},
				ctx,
			);
		}
	});

	// Compaction failed (not aborted by the user)
	pi.on("session_compact_failed", async (event, ctx) => {
		if (!state.enabled || !state.postCompactPoke) {
			return;
		}
		if (event.aborted || event.reason === "manual") {
			return;
		}
		if (wakeInterrupted(event.willRetry)) {
			armWake(
				{
					reason: event.reason,
					willRetry: event.willRetry,
					failed: true,
					errorMessage: event.errorMessage,
				},
				ctx,
			);
		}
	});

	// The agent fully settled (idle). Time to decide.
	pi.on("agent_settled", async (_event, ctx) => {
		runPhase = "idle";

		if (!state.enabled || !state.postCompactPoke || !wake) {
			return;
		}

		const now = Date.now();

		let shouldPoke = false;
		if (wake.phase === "armed") {
			// No turn ever resumed after the compaction: the run died.
			shouldPoke = true;
		} else if (wake.phase === "watching") {
			// The resume turn started but the run ended failed (error or
			// truncated). An "aborted" here means the user pressed Esc during
			// the resume: do not poke.
			shouldPoke = isFailedStopReason(lastRunStopReason);
		}

		if (!shouldPoke) {
			// The work continued and finished fine: nothing to do. A healthy
			// cycle resets the poke counter for future episodes.
			postCompactPokeCount = 0;
			setPokeStatus(ctx);
			wake = null;
			return;
		}

		// Anti-loop limits: they apply only to real pokes. If we poked recently
		// or ran out of attempts, stop insisting (the local model might be truly
		// broken); a later healthy cycle does reset the counter.
		const cooldownMs = state.postCompactCooldownSeconds * 1000;
		if (now - lastPostCompactPokeAt < cooldownMs || postCompactPokeCount >= state.postCompactMaxPokes) {
			setPokeStatus(ctx);
			wake = null;
			return;
		}

		// Non-interactive modes: do not restart the agent on our own.
		if (ctx.mode === "print" || ctx.mode === "json") {
			setPokeStatus(ctx);
			wake = null;
			return;
		}

		postCompactPokeCount++;
		lastPostCompactPokeAt = now;

		const message = buildPostCompactPokeMessage(wake);
		wake = null; // clear before sending to avoid loops

		ctx.ui.setStatus("poke", pokeStatusText(ctx, ctx.ui.theme.fg("warning", "📤 resume")));
		ctx.ui.notify("📌 Sending post-compaction poke: resume interrupted turn", "info");

		setTimeout(() => {
			// The user may have disabled it meanwhile
			if (!state.enabled || !state.postCompactPoke) {
				return;
			}
			// sessionApi is always bound to the current session (rebound via
			// withSession on replacements), so a deferred poke targets the live
			// session even if it changed while the timer was pending.
			// The pi API types sendUserMessage as void, but the runtime returns a
			// Promise: guard it so a stale or broken binding cannot crash pi.
			let result: unknown;
			try {
				result = sessionApi.sendUserMessage(message);
			} catch (err) {
				const messageText = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`⚠️ Post-compaction poke failed: ${messageText}`, "error");
				return;
			}
			if (result && typeof (result as Promise<void>).catch === "function") {
				(result as Promise<void>).catch((err: unknown) => {
					const messageText = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`⚠️ Post-compaction poke failed: ${messageText}`, "error");
				});
			}
		}, 300);
	});

	// The user (or another extension) sent input: they took control, cancel wake
	pi.on("input", async (_event, _ctx) => {
		wake = null;
		// New user direction: reset the poke counter
		postCompactPokeCount = 0;
	});

	// Initialize on session_start
	pi.on("session_start", async (_event, ctx) => {
		resetPostCompactState();
		await restoreState(ctx);

		if (state.enabled) {
			startMonitoring(ctx);
		} else {
			stopMonitoring();
		}
		setPokeStatus(ctx);
	});

	// Cleanup on session_shutdown
	pi.on("session_shutdown", async (_event, _ctx) => {
		stopMonitoring();
		runningTools.clear();
		resetPostCompactState();
	});

	// Handle session tree changes
	pi.on("session_tree", async (_event, ctx) => {
		resetPostCompactState();
		await restoreState(ctx);

		if (state.enabled) {
			startMonitoring(ctx);
		} else {
			stopMonitoring();
		}
		setPokeStatus(ctx);
	});
}

<p align="center">
  <img src="https://raw.githubusercontent.com/noguerol/pi-poke/main/docs/banner.jpeg" alt="poke — wake up the pi agent when it gets stuck" width="100%" />
</p>

<h1 align="center">poke</h1>

<p align="center">
  <b>Wake up the pi agent when it gets stuck.</b><br />
  Long tool calls · post-compaction stalls (local models)
</p>

<p align="center">
  <a href="https://github.com/noguerol/pi-poke/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/noguerol/pi-poke"><img src="https://img.shields.io/badge/pi-extension-7c3aed.svg" alt="pi extension" /></a>
  <img src="https://img.shields.io/badge/status-production--ready-2ea44f.svg" alt="Production ready" />
  <img src="https://img.shields.io/badge/footprint-%7E18%20KB-4c1d95.svg" alt="Minimal footprint" />
</p>

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Use cases](#use-cases)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [Development](#development)
- [Testing](#testing)
- [Security & privacy](#security--privacy)
- [Limitations](#limitations)
- [License](#license)

---

## Overview

**poke** is an extension for [pi](https://github.com/earendil-works/pi) that watches for situations where the agent stops making progress and "pokes" it back into action:

1. **Long tool calls** — a tool call (bash, network, file operation) runs far beyond a reasonable threshold. poke stays silent while it watches; only when it **enters into action** does it speak up: it can abort the overdue tool (`autoAbort`) or, when the run that owned the tool died with it still running, ask the model to resume the orphaned work (`autoPoke`). A tool that merely takes long and completes on its own is never reported.
2. **Post-compaction stalls** — a context compaction interrupts the work turn and the agent never resumes. This is a known failure mode with **local models** (ollama, llama.cpp, llama-server, etc.): the run dies with `Error: This operation was aborted` right after `[compaction]`, and pi sits idle. poke detects the stall and restarts the turn by asking the model to continue.

The extension is designed to be **invisible when things work** and **only speak up when things stall** — with built-in anti-loop safeguards so a broken model cannot trigger a poke storm.

## Features

| Feature | Description |
|---|---|
| ⏱️ **Real-time monitoring** | Checks tool call duration every second; compact footer indicator (`📌 p:on/off`). Silent watch: notifies **only when poke acts** (auto-abort / auto-poke / post-compaction resume) |
| 🔴 **Auto-abort** | Optionally aborts a tool call that exceeds the threshold (configurable) |
| 💬 **Auto-poke** | Sends a resume message when a tool call outlives its run (agent settled, run interrupted, tool still running past the threshold) |
| 📌 **Post-compaction wake-up** | Detects a compaction that killed the work turn and asks the model to continue |
| 🛡️ **Anti-loop safeguards** | Cooldown + max-pokes-per-episode prevent poke storms with broken models |
| 🧠 **Context-aware** | Never pokes after manual `/compact`, user aborts (Esc), or runs that finish fine |
| 💾 **Persistent config** | Survives reloads, tree navigation and session switches |
| ⚡ **Minimal footprint** | ~19 KB source; internals are lazy-loaded, only the entry is parsed at startup |

## Requirements

- **pi** — any recent version (uses the standard `ExtensionAPI` surface: `tool_execution_start/end`, `session_compact(_failed)`, `turn_start`, `agent_end`, `agent_settled`, `input`).
- **Node.js** — whatever pi itself runs on (no external dependencies).

> 💡 No external npm packages, no network calls, no telemetry. Poke is self-contained.

## Installation

### Via `pi install` (recommended)

```bash
pi install git:github.com/noguerol/pi-poke
```

### Manual (global — all projects)

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn /path/to/pi-poke/src ~/.pi/agent/extensions/poke
```

### Manual (project-local)

```bash
mkdir -p .pi/extensions
ln -sfn /path/to/pi-poke/src .pi/extensions/poke
```

After installing, reload extensions:

```bash
/reload
```

## Quick start

```bash
# 1. Enable poke
/poke enable

# 2. (optional) tune the threshold for your workflow
/poke threshold 60

# 3. verify
/poke status
```

When the agent looks stuck at any moment — even with auto-poke off — type
`/poke` (no arguments) for a **manual poke**: it sends the model a "resume the
work" message and kicks the turn back into action.

The **post-compaction wake-up is enabled by default** once poke is enabled — nothing else to do. For local-model workflows this is the setting that matters most.

## Configuration

Configuration is resolved with the following priority (highest wins):

```
session  >  project settings.json  >  global settings.json  >  defaults
```

### Settings reference

All options can live in the `poke` block of `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project), or be changed at runtime via commands / the dialog.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Master switch for the whole extension |
| `thresholdSeconds` | `number` | `30` | A tool call running longer than this is considered "long" |
| `autoAbort` | `boolean` | `false` | Abort the tool call when the threshold is exceeded |
| `autoPoke` | `boolean` | `true` | Send a resume message only when a tool call outlives its run (agent settled, last run interrupted, tool still running past the threshold) |
| `postCompactPoke` | `boolean` | `true` | Enable the post-compaction wake-up |
| `postCompactCooldownSeconds` | `number` | `30` | Minimum seconds between post-compaction pokes (anti-loop) |
| `postCompactMaxPokes` | `number` | `2` | Max pokes per stall episode (anti-loop) |

### Example: `~/.pi/agent/settings.json`

```json
{
  "poke": {
    "enabled": true,
    "thresholdSeconds": 60,
    "autoAbort": false,
    "autoPoke": true,
    "postCompactPoke": true,
    "postCompactCooldownSeconds": 30,
    "postCompactMaxPokes": 2
  }
}
```

> A ready-to-copy template lives in [`config.example.json`](./config.example.json).

## Commands

| Command | Description |
|---|---|
| `/poke` (no args) | **Manual poke** — send a "resume the work" message to the model when the agent looks stuck or idle. Works even if auto-poke is off; cancels any pending automatic wake |
| `/poke enable` | Enable the extension |
| `/poke disable` | Disable the extension |
| `/poke status` | Show current configuration and live state |
| `/poke config` | Interactive TUI dialog — all 7 options (toggle keys, free numeric input, fuzzy search) |
| `/poke threshold <seconds>` | Set the tool-call threshold |
| `/poke postcompact <on\|off>` | Toggle the post-compaction wake-up |

> 💡 `/poke config` opens pi's native settings dialog (the same `SettingsList`
> component pi uses for its own settings): Enter/Space cycles toggles, Enter on
a numeric option opens a free-form input pre-filled with the current value,
and typing filters options by fuzzy search. All changes persist to the session
immediately.

### Footer indicator

Poke keeps a **compact, always-visible status in the footer**: `📌 p:on`
(green) when enabled, `📌 p:off` (dim) when disabled. During activity it
gains a short transient suffix that disappears when the situation clears:

| Footer | Meaning |
|---|---|
| `📌 p:on` | Enabled, idle |
| `📌 p:off` | Disabled (extension loaded) |
| `📌 p:on ⏳ bash` | A tool call is running |
| `📌 p:on ⚠️ bash 45s` | Tool call exceeded the threshold |
| `📌 p:on 👀 post-compact` | Post-compaction wake armed, watching |
| `📌 p:on 📤 resume` | Post-compaction poke sent |

Examples:

```bash
/poke enable
/poke threshold 120        # warn only after 2 minutes
/poke postcompact off      # disable the wake-up (e.g. while debugging)
/poke                      # manual kick if the agent looks stuck
/poke status
```

## How it works

### 1. Long tool call monitoring

```
tool_execution_start ──► runningTools[callId] = { start, notified:false, pokeSent:false }
                              │
                              ▼  every 1s (setInterval)
                         elapsed >= threshold?
                              │ yes ── footer: 📌 p:on ⚠️ bash 45s (silent watch)
                              └─► autoAbort?  ──► notify + ctx.abort()      (action)
                              │ (auto-poke is NOT fired here — a tool merely
                              │  running long in a healthy run is not a stall)
                              │
                              ▼  stall evidence check (see below)
                         agent settled (idle) + last run interrupted
                         + a tool STILL running past the threshold?
                              │ yes ──► auto-poke: notify + sendUserMessage (action)
                              ▼
tool_execution_end   ──► runningTools.delete(callId) — silent: the tool
                         finished on its own, the run continues normally
```

The **auto-poke only fires on real stall evidence**: the agent has fully
settled (no automatic retry or continuation left), the last run was
interrupted (`error` / `aborted` / `length`), and a tool call is **still
running past the threshold** — that tool's result is orphaned and the work
would never resume on its own. A slow-but-healthy `bash` call in a live run is
never poked.

> **Notification policy:** poke never announces observations (a tool *started*,
> a tool *finished late*). Every user-facing notification corresponds to an
> actual poke action: an auto-abort, an auto-poke sent to the model, or a
> post-compaction resume. Healthy workflows — even with many slow `bash` calls
> — stay completely quiet.

### 1b. Manual poke (`/poke`)

Sometimes you can see a stall the heuristics cannot: the agent sits idle in
the middle of a task. Typing `/poke` with no arguments is the manual override
— it sends the model a `[Poke] Manual poke… resume the work` message:

- The message is a **silent custom message** (`display: false`): it stays in
  the LLM context and starts the response, but it does **not** appear in the
  transcript as if the user had typed it — no context pollution.
- **Idle agent** → `triggerTurn` starts a new turn immediately.
- **Busy agent** (e.g. a long tool is still running) → the message is queued
  as a `steer` and delivered once the current assistant turn finishes its tool
  calls.
- It works regardless of the `enabled` / `autoPoke` / `postCompactPoke`
  toggles, and it cancels any pending automatic wake: the user took control.

`/poke status` still shows the configuration.

### 2. Post-compaction wake-up (state machine)

The tricky part: distinguishing *"compaction happened and the turn should keep going"* from *"compaction happened and everything is fine, leave it alone"*.

Poke listens to the pi lifecycle events and runs a tiny state machine:

```
 session_compact / session_compact_failed (automatic: threshold | overflow)
        │  was in-flight work interrupted?
        │  (willRetry ∨ run active ∨ last run ended error/aborted/length)
        ▼
    wake = "armed"   ── turn_start ──►  wake = "watching"
        │                                   │
        │  agent_settled (no turn resumed)  │  agent_settled
        ▼                                   ├─ run ended ok ──► clear (no poke)
     POKE "resume the work"                 └─ run ended error/length ──► POKE
```

| Event | Role in the state machine |
|---|---|
| `session_compact` / `session_compact_failed` | Arms the wake if automatic compaction interrupted in-flight work |
| `turn_start` | A turn resumed → switch from *armed* to *watching* |
| `agent_end` | Records how the last run ended (`stopReason`: `error`, `aborted`, `length`, …) |
| `agent_settled` | The agent is fully idle → decide: poke, or clear the wake |
| `input` | The user took control → cancel the wake |

**When does it poke?**

- The wake is **armed** and the agent settles **without any turn resuming** → the run died after compaction → poke immediately.
- The wake is **watching** and the resumed run **ends in `error` or `length`** (truncated) → the continuation also failed → poke again (bounded).
- A run ends with `aborted` (user pressed Esc) → **never** pokes; the user's decision is respected.

**When does it stay silent?**

- Manual compaction (`/compact`) — the user asked for it; nothing was interrupted.
- Compaction after a run that completed successfully — the work is done.
- Any user input — the user is in control; the wake is cancelled.

### 3. Anti-loop safeguards

A genuinely broken local model could otherwise cause an endless poke cycle:

- **Cooldown** (`postCompactCooldownSeconds`, default 30s) — at least N seconds between pokes.
- **Max pokes per episode** (`postCompactMaxPokes`, default 2) — after 2 failed recovery attempts poke stops insisting.
- The poke counter **resets** after a healthy cycle (work completes) or when the user sends new input.
- Deferred pokes are cancelled if the **session changes** (`/new`, `/resume`, `/tree`) while a poke is scheduled.

## Use cases

### Local models that stall after compaction (the main one)

```bash
/poke enable
/poke postcompact on
```

If a local model drops the request mid-turn after a compaction, the agent used to sit idle until you typed something. Now poke restarts the turn automatically:

```
Error: This operation was aborted

[compaction]

Compacted from 120.734 tokens (ctrl+o to expand)
        │
        ▼  (poke, a few seconds later)
[Poke] Context compaction finished (~121k tokens compacted), but the previous
work turn was interrupted (error: "This operation was aborted") and did not
resume automatically. Resume the work where it left off…
```

### Hang protection for tool calls

```bash
/poke enable
/poke threshold 30
/poke config        # enable auto-abort
```

Aborts bash commands, network calls or accidental infinite processes that run past 30s.

### Stalled runs with an orphaned tool

```bash
/poke enable
/poke config        # auto-poke on (default), auto-abort off
```

If the model crashes while a tool call is still executing (a local model that
drops the stream mid-tool, with or without compaction), the run settles but
the tool keeps running past the threshold — its result would be orphaned.
poke detects that the agent is idle with an interrupted last run and a tool
still running, and asks the model to resume the work.

### Manual kick when the agent looks stuck

Whatever the configuration, if the agent is sitting idle in the middle of a
task, kick it:

```bash
/poke
```

Sends the model a `[Poke] Manual poke… resume the work where it left off`
message as a **silent custom message** (it does not clutter the transcript as
if the user had typed it) and starts a new turn. Useful right after the stall
scenario above when the automatic post-compaction poke already gave up
(anti-loop), or any time you spot an idle agent before the heuristics do.

## Troubleshooting & FAQ

**Q: I ran `/poke enable` but nothing happens on long tool calls.**
The threshold might be too high for your workflow, or no tool call has crossed
it yet. Keep in mind that a slow-but-healthy tool in a live run is **never**
auto-poked by design — the run picks the result up and continues. To test the
actions: enable auto-abort (`/poke config`), set `/poke threshold 10` and run
`!sleep 30` (it aborts at 10s); or reproduce the post-compaction/orphan stall
scenarios from the use cases. `!sleep 15` above the threshold just completes
normally and stays silent.

**Q: I ran a slow `bash` command and poke didn't say anything. Is it broken?**
No. That is by design: a tool that finishes on its own — even after the
threshold — is not a stall, and poke stays silent. Poke only notifies when it
enters into action: it aborts an overdue tool (`autoAbort`), sends an auto-poke
when a tool call outlives its interrupted run (`autoPoke`), or resumes the turn
after a compaction stall. The auto-poke deliberately never fires for a slow
but healthy tool in a live run — that run will pick the result up and continue
by itself. If you only want the post-compaction wake-up, disable both to watch
quietly (the footer still marks overdue tools with `⚠️ tool 45s`).

**Q: Why didn't poke fire after my `/compact`?**
By design. Manual compaction never interrupts work — poke only reacts to *automatic* compaction (threshold/overflow) that cut an in-flight turn.

**Q: I pressed Esc and poke still fired.**
It shouldn't. If a poke arrives after a user abort, it means the abort did *not* stop the run (`stopReason` was `error`, not `aborted` — the local model dropped the stream). That is exactly the stall poke is meant to recover from. If you find it noisy, use `/poke postcompact off`.

**Q: Poke stopped after a couple of attempts. Is it broken?**
No — that's the anti-loop safeguard. If the model keeps failing after 2 pokes, poke gives up on that episode to avoid a poke storm. It resumes on the next stall episode once a healthy cycle (or new input) resets the counter.

**Q: Will poke run the agent while I'm away doing something else?**
Only in the narrow stall scenario above, and bounded by the anti-loop limits. It never executes tools by itself — it only sends a text message asking the model to continue.

## Development

```
pi-poke/
├── src/
│   ├── index.ts     # entry point — command, hooks, runtime state (loaded at startup)
│   ├── config.ts    # settings.json reader (lazy — only on session restore)
│   └── ui.ts        # /poke config TUI dialog (lazy — only when opened)
├── test/
│   └── sim-postcompact.ts   # state-machine simulator, 42 assertions, no TUI needed
├── docs/            # banner + preview images
├── config.example.json
├── package.json
└── TEST.md
```

**Footprint discipline** — the pi startup cost is what matters: only `src/index.ts` is parsed when pi loads. `config.ts` and `ui.ts` are dynamically imported on demand, and the simulator lives outside the runtime scope entirely.

## Testing

```bash
npm test
# or: node --experimental-strip-types test/sim-postcompact.ts
# Expect: "42 passed, 0 failed"
```

The simulator replicates the exact wake-up state machine and validates the key scenarios: the reported stall bug, overflow recovery (success/failure), mid-run compaction, healthy completion, manual compaction, user aborts, anti-loop limits, user-input cancellation, failed compaction, and post-run threshold compaction.

For interactive/TUI scenarios (status bar, notifications, dialog), see [`TEST.md`](./TEST.md).

## Security & privacy

- **No network access.** Poke never makes HTTP requests; the only "message" it sends goes through pi's own `sendUserMessage` to the model.
- **No secrets.** The extension reads no API keys, tokens or credentials.
- **No telemetry.** Nothing leaves your machine.
- **Local state only.** Configuration is stored in your pi session entries and optional `settings.json` blocks — never sent anywhere.

## Limitations

- **Cannot pause/resume tool calls** — a tool call either completes or is aborted.
- **Auto-abort stops the whole agent**, not just the offending tool call.
- **The wake-up does not fix the model error** — it restarts the turn; if the model keeps failing, the anti-loop limits take over.
- **The `/poke config` dialog requires TUI mode** — in RPC/print modes use commands or settings.json.

## License

[MIT](./LICENSE) © Javier Noguerol

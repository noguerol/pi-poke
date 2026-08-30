# Poke for pi

An extension that "wakes up" the pi model when it gets stuck:

1. **Long tool calls** — detects tool calls that take too long and notifies the user or aborts execution automatically.
2. **Post-compaction wake-up** — when a compaction interrupts a work turn and the agent does not continue (typical with local models: `Error: This operation was aborted` after `[compaction]`), it restarts the turn by asking the model to continue.

## Installation

```bash
pi install git:github.com/noguerol/pi-poke
```

Or manually: place the extension in `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local):

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/src" ~/.pi/agent/extensions/poke
```

Reload with `/reload` or restart pi.

## Configuration

### Option 1: Interactive dialog (recommended)
```bash
/poke config
```

### Option 2: Commands
```bash
/poke enable
/poke threshold 60
/poke postcompact on
```

### Option 3: settings.json (persistent, global)
Edit `~/.pi/agent/settings.json`:
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

### Option 4: settings.json (project)
Edit `.pi/settings.json` in your project:
```json
{
  "poke": {
    "enabled": true,
    "thresholdSeconds": 30,
    "autoAbort": true,
    "postCompactPoke": true
  }
}
```

**Configuration priority:**
1. Session configuration (from `/poke config` or commands)
2. Project settings.json
3. Global settings.json
4. Defaults

## Commands

### `/poke config`
Opens an interactive dialog to configure:
- Enable/disable auto-poke
- Threshold in seconds (10, 30, 60, 120, 300)
- Auto-abort on timeout
- Auto-poke the agent
- Post-compaction auto-poke

### `/poke enable`
Enables monitoring of long tool calls and the post-compaction wake-up.

### `/poke disable`
Temporarily disables monitoring.

### `/poke threshold <seconds>`
Sets the threshold in seconds:
```bash
/poke threshold 60  # Notify after 60 seconds
```

### `/poke postcompact <on|off>`
Enables or disables the post-compaction wake-up:
```bash
/poke postcompact on
```

### `/poke status`
Shows the current configuration.

## Features

### Real-time monitoring
- Checks tool call durations every second
- Visual notification in the status bar
- Notifications when the threshold is exceeded

### Auto-abort
When enabled, automatically aborts tool calls that exceed the threshold. Useful for:
- Bash commands that hang
- Network operations that time out
- Accidental infinite processes

### Auto-poke
Sends a "steering" message to the agent asking whether it is still in progress. This:
- "Wakes up" the agent if it is waiting
- Lets the user decide whether to continue
- Does not interrupt the current execution

### Post-compaction wake-up
**Problem:** with local models (and sometimes remote APIs), when the agent compacts the context — mid-turn or after an error — the run can die and pi sits idle without continuing. On screen it looks like this:

```
Error: This operation was aborted

[compaction]

Compacted from 120.734 tokens (ctrl+o to expand)
```

**Solution:** poke detects that the compaction interrupted a turn that never resumed and restarts the turn by sending a message to the model asking it to continue the work.

How it works internally:
- Listens for `session_compact` / `session_compact_failed` (automatic compaction only: threshold or overflow).
- Arms a "wake" only if the compaction interrupted in-flight work: overflow recovery (`willRetry`), compaction inside an active run, or a run that ended with error/aborted (`stopReason === "error"`).
- If `turn_start` appears after the compaction, it switches to watching how that run ends: if it ends fine, nothing happens; if it fails, poke.
- If the agent settles (`agent_settled`) without any turn resuming, it sends the poke right away.
- The poke is sent with `pi.sendUserMessage(...)` as a normal prompt (the agent is idle).

**Anti-loop protections:**
- No poke after manual compaction (`/compact`) or when the user presses Esc (abort).
- Configurable cooldown between pokes (`postCompactCooldownSeconds`, default 30s).
- Maximum pokes per episode (`postCompactMaxPokes`, default 2). The counter resets when the work completes fine or when the user sends new input.
- If the user types anything (or switches session/tree), the pending wake is cancelled.

### Persistence
Configuration is saved in the session and survives:
- Reloads (`/reload`)
- Tree navigation (`/tree`)
- Session switches

## Default configuration

```typescript
{
  enabled: false,                    // Disabled by default
  thresholdSeconds: 30,              // 30 seconds
  autoAbort: false,                  // Do not abort automatically
  autoPoke: true,                    // Send poke to the agent
  postCompactPoke: true,             // Post-compaction wake-up active
  postCompactCooldownSeconds: 30,    // 30s between post-compaction pokes
  postCompactMaxPokes: 2,            // Max 2 pokes per episode
}
```

## Use cases

### 1. Passive monitoring
```bash
/poke enable
/poke threshold 60
```
Only notifies when a tool call takes longer than 60s.

### 2. Hang protection
```bash
/poke enable
/poke threshold 30
/poke config  # Enable auto-abort
```
Automatically aborts tool calls that take longer than 30s.

### 3. Agent assistance
```bash
/poke enable
/poke threshold 120
/poke config  # Enable auto-poke, disable auto-abort
```
Sends a message to the agent after 2 minutes to "wake it up".

### 4. Local models that stall after compaction
```bash
/poke enable
/poke postcompact on
```
If the local model fails during/after compaction and the turn does not resume, poke restarts the turn asking it to continue. Ideal for ollama, llama.cpp, etc.

## Limitations

- **Cannot pause/resume tool calls**: once a tool call starts, it must run to completion or be aborted.
- **Auto-abort stops the whole agent**: not just the problematic tool call, but the entire current execution.
- **The post-compaction wake-up does not fix the model error**: it only restarts the turn asking it to continue; if the model keeps failing, the cooldown and max pokes prevent infinite loops.
- **TUI mode required**: the configuration dialog only works in interactive mode.

## Architecture

The extension uses:
- `tool_execution_start` / `tool_execution_end`: register/clean up running tool calls
- `setInterval`: check elapsed time every second
- `ctx.abort()`: abort execution when configured
- `pi.sendUserMessage()`: send poke to the agent
- `session_compact` / `session_compact_failed`: detect automatic compactions
- `turn_start` / `agent_end` / `agent_settled`: follow the agent lifecycle to know whether the turn resumed or died
- `input`: cancel the wake when the user takes control
- `ctx.ui.*`: notifications and UI

## Development

Run the state-machine simulator (no TUI required):

```bash
npm test
# or: node --experimental-strip-types test/sim-postcompact.ts
# Expect: "28 passed, 0 failed"
```

To load the extension for a quick test:
```bash
pi -e src/index.ts
```

## License

MIT

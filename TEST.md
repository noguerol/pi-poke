# Test Plan for the Poke Extension

## Manual tests

### 1. Extension load
```bash
# Start pi with the extension
pi -e src/index.ts

# Verify it loads correctly
# It should appear in the extensions list in the header
```

### 2. Basic commands
```bash
# Check initial status
/poke status

# Enable
/poke enable

# Change threshold
/poke threshold 10

# Check updated status
/poke status

# Disable
/poke disable
```

### 3. Configuration dialog (TUI)
```bash
# Open the configuration dialog
/poke config

# Test:
# - Toggle enabled/disabled
# - Enter on "Tool-call threshold" -> type any number (e.g. 45) + Enter
# - Toggle auto-abort
# - Toggle auto-poke
# - Toggle post-compaction auto-poke
# - Enter on "Post-compaction cooldown" -> type any number (e.g. 45) + Enter
# - Enter on "Max pokes per episode" -> type any number (e.g. 3) + Enter
# - Type to fuzzy-search options (e.g. "cooldown")
# - Esc closes the dialog (or cancels a numeric submenu)
```

### 4. Tool call monitoring
```bash
# Enable with a low threshold for testing
/poke enable
/poke threshold 5

# Run a long command
!sleep 10

# A notification should appear after 5s
```

### 5. Auto-abort
```bash
# Configure auto-abort
/poke config  # Enable auto-abort, threshold 5s

# Run a long command
!sleep 30

# Should abort after 5s
```

### 6. Auto-poke
```bash
# Configure auto-poke (without auto-abort)
/poke config  # Enable auto-poke, threshold 5s

# Run a long command
!sleep 15

# Should send a poke message after 5s
```

### 7. Session persistence
```bash
# Configure
/poke enable
/poke threshold 60

# Reload
/reload

# Verify the configuration persists
/poke status
```

### 8. Configuration from settings.json
```bash
# Edit settings.json
echo '{"poke": {"enabled": true, "thresholdSeconds": 45}}' >> ~/.pi/agent/settings.json

# Restart pi
pi

# Verify configuration
/poke status  # Should show threshold 45s
```

### 9. Tree navigation
```bash
# Configure poke
/poke enable

# Navigate the tree
/tree  # Select a previous point

# Verify the configuration persists
/poke status
```

### 10. Session shutdown
```bash
# Enable poke
/poke enable

# Exit pi
/quit

# Verify no errors on shutdown
```

## Post-compaction wake-up tests

### 11. Basic configuration
```bash
/poke enable
/poke status
# Should show: Post-compaction poke: ✅ yes
# Cooldown: 30s (max 2 pokes)

# Toggle on/off
/poke postcompact off
/poke status  # Post-compaction poke: ❌ no
/poke postcompact on
```

### 11b. Logic simulator (automated)
```bash
# Runs the state machine in isolation (no TUI) and validates 28 assertions
npm test
# or: node --experimental-strip-types test/sim-postcompact.ts
# Expect: "28 passed, 0 failed"
```

### 12. Bug scenario: error after compaction (local model)
> Reproduce with a local model (ollama/llama.cpp) and a large context that
> forces automatic compaction.

1. Ask for a long task that fills the context (or use a low `compactThreshold`).
2. Wait for:
   ```
   Error: This operation was aborted

   [compaction]

   Compacted from X tokens (ctrl+o to expand)
   ```
3. **Expected result:** previously, the agent stayed idle. With poke, after a
   few seconds the turn restarts with a `[Poke] Context compaction finished...
   Resume the work where it left off...` message and the model continues the
   task.

### 13. No poke on manual compaction or idle
```bash
# With the agent idle, compact manually
/compact

# Expected result: NO poke is sent (no interrupted work)
```

### 14. No poke when the user aborts (Esc)
1. Start a task and press Esc during the model response.
2. **Expected result:** no automatic poke (the user initiated the abort).

### 15. Turn resumes normally after compacting -> no poke
1. With a healthy model, force a mid-run compaction.
2. **Expected result:** the turn continues normally, the work finishes and NO
   poke appears.

### 16. Anti-loop
1. With a broken local model, force the bug scenario repeatedly.
2. **Expected result:** at most 2 pokes 30s apart; then poke stops insisting
   until the work completes or the user sends input.

### 17. User input cancels the pending wake
1. Force the bug scenario (12).
2. As soon as the error/compaction appears, type any prompt.
3. **Expected result:** no poke arrives (the user input cancelled the wake).

## Acceptance criteria

- [ ] The extension loads without errors
- [ ] All commands work correctly (`config`, `status`, `enable`, `disable`,
      `threshold`, `postcompact`)
- [ ] The configuration dialog is usable and includes the post-compaction toggle
- [ ] Notifications appear at the right time
- [ ] The status bar shows updated information
- [ ] Configuration persists across reloads
- [ ] Configuration from settings.json works (including the new fields)
- [ ] Auto-abort stops execution correctly
- [ ] Auto-poke sends messages to the agent
- [ ] The post-compaction wake-up resumes the turn after the bug scenario
- [ ] No poke on manual compaction, user aborts, or runs that finish fine
- [ ] Anti-loop (cooldown + max pokes) works
- [ ] No memory leaks (runningTools is cleaned up correctly)

## Known bugs / Limitations

1. Auto-abort stops the whole agent, not just the problematic tool call
2. Individual tool calls cannot be paused/resumed
3. The configuration dialog only works in TUI mode
4. The post-compaction wake-up does not fix the model error: it restarts the
   turn asking it to continue; if the model keeps failing, the anti-loop
   limits prevent infinite loops

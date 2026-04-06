<!-- Source: fundamentals.md lines 1769-1793 -->
### Checkpointing / Undo

Every mutating turn is a potential mistake. The agent must be able to rewind file system changes without corrupting the user's git history, conversation state, or mental model. Scope is workspace files only — non-file side effects (package installs, API calls) are tracked and warned about but never promised as reversible.

**Foundational decisions:**
- **Storage: shadow refs in the user's git repo** — checkpoint commits live under `refs/aca/checkpoints/<session-id>/`, invisible to `git branch`, `git log`, and normal workflows. Leverages git's content-addressing and delta compression without polluting user history. No separate repo, no stash manipulation, no filesystem snapshots. If no git repo exists, auto-init one
- **Granularity: per-turn, lazy** — checkpoint created before the first workspace-write tool in a turn. Read-only turns produce no checkpoint. The event log records per-tool-call mutations for finer audit, but undo operates at turn level
- **Before/after pair** — each mutating turn records `beforeTurn` (pre-mutation) and `afterTurn` (post-completion). Enables divergence detection: compare live workspace against last `afterTurn` to detect manual edits between turns. Indeterminate `mutationState` marks `afterTurn` as uncertain
- **Conversation stays append-only** — undo rewinds files, not history. Restore events are appended to the log
- **User interface** — `/undo` reverts last mutating turn. `/undo N` reverts last N. `/checkpoints` lists recent checkpoints. `/restore <id>` jumps to specific checkpoint. All restores show preview and require confirmation
- **Conflict handling** — detects manual edits since last `afterTurn` via divergence. Default: block and explain. User can force-overwrite. Never silently discard manual edits
- **Non-file side effects: warn, don't undo** — turns with `exec_command` or delegation carry `externalEffects: true`. On undo, files restore but agent warns about shell commands that may need manual reversal
- **Executor mode** — checkpoint/restore available as structured delegation operations. Caller decides whether to enable. Event log always records mutations regardless

**Deferred:**
- Selective per-file restore
- Named/tagged checkpoints
- Redo after undo
- Checkpoint retention policies and GC
- Automatic reverse-command inference
- Visual diff preview before restore
- Conversation history forking

**Cross-reference note:** Blocks 17-20 extend the surfaces defined in earlier blocks. Before implementation, the following earlier sections should be updated for consistency: Block 5's turn outcome list should include `budget_exceeded` (9th outcome, from Block 19). Block 9's `provider` config schema should reference the `providers` array (Block 17). Block 10's command tree should include `aca stats` (Block 19) and its slash commands should include `/reindex` (Block 20) and `/budget` (Block 19). The Project Awareness section should reference `indexStatus` (Block 20). These are additive extensions, not changes to existing behavior.

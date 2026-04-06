- High, lines 43, 80-83, 91-93: Browser turns are marked as a checkpointing exclusion, but the same section requires browser tools like `screenshot` to create workspace files. If browser turns are excluded from checkpointing, `/undo` cannot reliably roll back those file writes. This still needs a rule like “checkpoint local workspace writes, but mark the turn `externalEffects: true` for warning.”

- High, lines 86, 98-99: The force/divergence rule is only specified for `/restore`, but the tests require force-override behavior for `/undo`. `/undo` is therefore still underspecified under divergence.

- Medium, lines 122-123, 136: `aca describe --json` is defined as a singular “capability descriptor” with a singular “capability name,” while the test expects `capabilities`. One schema is still wrong.

- Medium, lines 106, 112: Requiring exact `0600` permissions for `~/.aca/secrets.json` is Unix-specific. For a Windows-capable CLI spec, this is not portable as written and makes the test unsatisfiable without a platform-specific ACL equivalent.
- High — `05-milestone5-provider-obs.md:70,80` Cost math is still inconsistent. The checklist says `tokens * costPerMillion / 1_000_000`, but Block 19 and the test at line 80 both require separate input/output pricing. If someone implements the checklist literally, mixed-rate models will be costed incorrectly and budget enforcement will drift.

- High — `05-milestone5-provider-obs.md:72,76,85` Daily-budget enforcement is still incomplete. You have a `sessionCostAccumulator` and a startup SQLite query, but no explicit “today spent before this session” baseline carried forward into per-response checks, and no test for crossing the daily cap mid-session. A session can start under budget and then run past the daily limit.

- Medium — `05-milestone5-provider-obs.md:31,33` The alias-resolution test hardcodes `claude-sonnet` to the NanoGPT driver, but the same section says provider selection is priority-based when multiple providers serve the same model. That test will be wrong whenever a higher-priority direct provider is configured.

- Medium — `05-milestone5-provider-obs.md:29-30` The provider stream tests still only verify text/tool delta normalization. They do not require the final `done` event to preserve `finishReason` and `usage`, which M5.4 depends on for token accounting, cost tracking, and budgets.

- Medium — `05-milestone5-provider-obs.md:53-115` Block 19 remains incomplete in this milestone file: the opt-in remote telemetry/export path from the source block is still missing entirely from both steps and tests.
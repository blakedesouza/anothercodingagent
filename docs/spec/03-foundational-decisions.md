<!-- Source: fundamentals.md lines 364-378 -->
## Foundational Decisions (locked)

| Decision | Answer | Why now |
|---|---|---|
| Single-turn vs multi-turn | **Multi-turn** | Changes the core unit from "one prompt" to "a session with accumulated state" |
| Tools as core identity | **LLM-driven tool selection** | The model decides which tools to call and when — not hardcoded scripts. Without this, it's automation, not agency |
| Tool state in conversation | **First-class** | Tool calls and results live inside the message history the model reasons over. This is structural bedrock — if wrong, everything above rewrites |
| Sync vs async tool execution | **Sync-first** | Simpler foundation with clear turn boundaries and obvious failure modes. Async patterns can layer on later without rewriting the core |
| User authority | **User has final say** | The agent proposes, the user approves destructive or ambiguous actions. The user is in charge when there's conflict |
| Delegation contract | **Universal capability shape** | One contract for all pluggable capabilities (local tools, remote APIs, external agents). Bidirectional: same shape for calling out and being called in |
| Delegation state | **First-class conversation state** | Delegation invocations/results enter the model's reasoning context, same as local tool calls |
| Delegation failure | **Isolated and typed** | External failures are contained, structured, and non-corrupting to agent state |
| Tool surface philosophy | **Small and deep** | 22 built-in tools. Workflow commands (git, test, lint) use exec_command. External integrations surface as dynamic capabilities via delegation contract |
| Tool approval | **Classified by effect** | Read-only auto-approves. Workspace writes may need confirmation. External effects always need confirmation unless pre-authorized |

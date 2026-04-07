# Security

ACA is an experimental local-first tool-using agent. It can read files, run tools, and call external model providers when configured. Use least-privilege tool grants and sandbox settings for untrusted repositories or prompts.

Do not commit API keys, `.env` files, `.aca/`, `.claude/`, `.codex`, `.mcp.json`, generated session logs, or local research outputs. Configure provider credentials through environment variables or local secret stores only.

Until a dedicated security contact exists, do not post secrets or private code in public issues. Report security problems with a minimal reproduction and redact sensitive paths, tokens, prompts, and tool outputs.

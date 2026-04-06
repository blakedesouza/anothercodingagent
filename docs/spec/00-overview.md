<!-- Source: fundamentals.md lines 1-15 -->
# Fundamentals

## What This Is

A CLI coding agent is an interactive, stateful command-line program that assists with software development tasks through a multi-turn conversation with an LLM, directly interacting with the local development environment to read, write, and execute code.

## Core Identity (irreducible)

- **Purpose** — assists with software development tasks. This is what makes it a *coding* agent, not a generic chat tool
- **Interactive** — the user and the model take turns in a live session
- **Stateful** — the conversation accumulates context across turns (not isolated one-shot prompts)
- **Command-line** — invoked from and lives in the terminal
- **LLM-backed** — the thinking is done by an LLM via API (at minimum, Anthropic Claude)
- **Tool-using** — the LLM selects and invokes tools (read files, edit files, run commands) as part of its reasoning. Tool calls and their results are first-class conversation state — the model reasons over them, not around them. This is what makes it an *agent*, not a chat client

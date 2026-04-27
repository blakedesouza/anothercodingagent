# ACA Audit Workflow

Use this when the task is to audit, harden, or improve the ACA repository itself. For product workflows such as `aca consult`, `aca invoke`, or `aca rp-research`, route through `aca methods` instead.

## Entry Checklist

1. Confirm the request is repo work, not a request to run an ACA workflow.
2. Read `AGENTS.md`, `CONTEXT.md` when present, the relevant `docs/dev/` note, and the smallest relevant source/test slices.
3. Pick the applicable Superpowers workflow before editing:
   - `superpowers:systematic-debugging` for a reported bug or failing check.
   - `superpowers:test-driven-development` for a bugfix or feature.
   - `superpowers:writing-plans` for multi-step changes.
   - `superpowers:verification-before-completion` before calling work complete.
4. Classify the change with `docs/dev/anti-rot-checklist.md`.
5. State the strongest risk before edits.

## Audit Modes

- Findings-only: report grounded risks with file/line evidence and no edits.
- Implementing audit: fix meaningful issues as they are proven, then validate.
- Workflow audit: inspect docs, prompts, scripts, and method routing for drift.

## Required Search

For every changed symbol, schema, prompt, tool name, default, error code, or workflow contract, search producers and consumers:

```bash
rg -n "SymbolName|field_name|error.code|tool_name|old_shape|new_shape" src test docs
```

Also search semantic aliases when a behavior crosses layers.

## Fix Discipline

1. Write or update the focused failing test first when behavior changes.
2. Make the smallest effective edit.
3. Update producers, consumers, docs, prompts, and tests in the same slice when a contract changes.
4. Do not rewrite unrelated code while auditing.
5. Leave unrelated dirty worktree changes unstaged.

## Validation Ladder

Run the narrowest meaningful check first:

```bash
npx vitest run path/to/focused.test.ts
```

Then run the standard gate when the change is not documentation-only or when it changes workflow/scripts:

```bash
npm run verify
```

For provider, native-tool, or live workflow changes, add the relevant probe or bakeoff command from package scripts or `scripts/` before closeout.

## Closeout

Before reporting completion:

1. Re-run the required validation.
2. Review `git diff --stat` and `git diff --staged` if committing.
3. Update `CONTEXT.md` when it exists, or create a local one when durable state is needed for future sessions.
4. Summarize changed files, validation evidence, and residual risk.

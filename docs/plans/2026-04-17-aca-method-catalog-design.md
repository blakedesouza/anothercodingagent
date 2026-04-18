# ACA Method Catalog Design

Date: 2026-04-17
Scope: make ACA entrypoints discoverable to humans and automation without requiring `--help` scraping.

## Problem

ACA exposes several distinct entrypoints:

- `aca invoke`
- `aca consult`
- `aca rp-research`
- `aca describe`
- `aca witnesses`
- `aca debug-ui`

It also exposes important `invoke`-time profiles such as:

- `coder`
- `reviewer`
- `witness`
- `triage`
- `rp-researcher`

Today the low-level executor contract is machine-readable through `aca describe`, but the task-oriented workflow layer is not. That means callers can know ACA exists without knowing:

- which entrypoint they should prefer for a given task
- which subcommand takes normal CLI args versus stdin JSON
- which `context.profile` values are meaningful for `aca invoke`
- the key arguments for `consult` and `rp-research`

## Goal

Add a stable method/workflow catalog that is:

- machine-readable for agents and wrappers
- human-readable for operators
- fast to access without booting the whole runtime

## Decision

Expose the same catalog in two places:

1. `aca methods`
2. `aca describe`

Why both:

- `aca methods` is the best operator-facing command
- `aca describe` is the best automation-facing discovery surface because structured callers already know about it

## Data Model

Each method entry should describe:

- stable ID
- invocation surface
- whether it is a CLI subcommand or an `invoke` profile
- short summary
- when to use it
- key args or key `context` fields
- one or more concrete examples

## Initial Coverage

Initial catalog should cover:

- `describe`
- `methods`
- `invoke`
- `invoke` with `coder`
- `invoke` with `rp-researcher`
- `consult`
- `rp-research`
- `witnesses`
- `debug-ui`

## Non-Goals

- not a full replacement for `--help`
- not a complete schema for every single CLI flag in every command
- not dynamic runtime introspection of all Commander options

The first version should focus on the workflows an agent actually needs to choose between.

## Success Criteria

- `aca methods --json` returns a stable workflow catalog
- `aca methods` returns a readable task-oriented summary
- `aca describe` includes the same workflow catalog as an additive, non-breaking field
- tests prove the built CLI exposes the new surface

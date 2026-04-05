# AGENTS.md instructions for /Users/james/Documents/GitHub/harbor

This repository is standalone and not a Brian workspace.

## Mission
Harbor is a standalone TypeScript agent orchestration platform with harness-first runtime guarantees.

## Fast Entry Points
- [`README.md`](README.md): repository overview and local commands.
- [`docs/README.md`](docs/README.md): documentation index and canonical paths.
- [`docs/strategy/vision.md`](docs/strategy/vision.md): locked decisions and non-negotiable invariants.
- [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md): package boundaries and dependency flow.
- [`docs/getting-started.md`](docs/getting-started.md): milestone cadence and validation checklist.

## Project-Scoped Only
- Use only repository-local rules and skills.
- Never rely on global `~/.cursor` or `~/.codex` skills/rules.

## Core Invariants
- Every workflow node must define `owner`, `timeoutMs`, and `retryLimit`.
- Every deployment must run harness lint + tests.
- Critical harness lint findings block deployment.
- Prompt mutation is only allowed inside harness middleware.
- memU writes must include category/path and retention-aware metadata.
- API procedures must enforce `tenantId` and `workspaceId` scoping.
- Runs must be worktree-bound and able to build/run the full stack in isolation.
- Runs must emit to run-scoped ephemeral observability with explicit cleanup.

## Delivery Discipline
- New behavior requires at least one success-path and one failure-path test.
- Architectural decisions that change contracts must add/update an ADR in `docs/architecture/decision-records`.
- Milestone/phase changes must update `docs/getting-started.md` cadence metadata and pass `pnpm docs:check`.
- Agent legibility drift must pass `pnpm legibility:check` before merge.
- When proposing run-runtime architecture, always include worktree isolation and ephemeral observability recommendations.

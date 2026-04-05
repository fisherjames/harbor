# AGENTS.md instructions for /Users/james/Documents/GitHub/harbor

This repository is **not** a Brian workspace.

## Mission
Harbor is a standalone TypeScript agent orchestration platform with harness-first runtime guarantees.

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

## Delivery Discipline
- New behavior requires at least one success-path and one failure-path test.
- Architectural decisions that change contracts must add/update an ADR in `docs/architecture/decision-records`.

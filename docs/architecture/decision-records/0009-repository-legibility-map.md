# ADR 0009: Repository Legibility Map Contract

## Status
Accepted

## Context
Phase 2.5 focuses on repository legibility and drift prevention. Existing checks validate document presence and naming, but they do not encode a machine-readable map of canonical entrypoints and workspace anchors.

## Decision
- Add `docs/strategy/repository-legibility-map.json` as the machine-readable source of truth for:
  - global repository entrypoints,
  - workspace roots,
  - workspace README anchors,
  - key code entrypoints per workspace.
- Extend `scripts/agent-legibility-check.mjs` to validate repository map schema and coverage.
- Require the repository map as part of legibility contracts and docs index pointers.

## Consequences
- Agent onboarding context becomes deterministic and script-verifiable.
- Legibility drift now includes structural drift in workspace entrypoints.
- Maintenance overhead increases slightly when moving workspace entry files.

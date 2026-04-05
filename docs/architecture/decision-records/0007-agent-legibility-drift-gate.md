# ADR 0007: Agent Legibility Drift Gate

## Status
Accepted

## Context
Harness engineering requires the repository itself to be legible to coding agents. Without enforced structure, prompt context becomes noisy and navigation cost rises as the codebase grows.

## Decision
- Add an explicit repository legibility contract in `docs/strategy/agent-legibility-contract.json`.
- Add an automated drift gate (`pnpm legibility:check`) that validates:
  - required doc entrypoints and indices,
  - AGENTS.md size and pointer integrity,
  - workspace README presence and required sections,
  - naming conventions for docs and workspace/package naming alignment.
- Include the legibility gate in `pnpm check` so merge readiness requires legibility compliance.

## Consequences
- The repo remains navigable for both humans and coding agents as phases expand.
- Contract and docs maintenance overhead increases slightly.
- Drift to ad hoc naming or missing entry docs is caught early in CI/local checks.

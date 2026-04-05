# ADR 0001: Harness-First Runtime with memU-backed Memory

## Status
Accepted

## Context
Harbor must provide reliable multi-stage agent execution with explicit controls and observability.

## Decision
- Harbor executes workflows using a fixed stage machine: `plan -> execute -> verify -> fix`.
- Harness linting runs before execution and blocks on critical violations.
- Non-critical findings inject remediation steps into prompts under `## Harness Resolution Steps`.
- memU is the default long-term memory backend via `@harbor/memu` adapter.

## Consequences
- Execution behavior is deterministic and inspectable.
- Deploy safety improves via mechanical enforcement.
- Additional upfront contract work is required for every new node type.

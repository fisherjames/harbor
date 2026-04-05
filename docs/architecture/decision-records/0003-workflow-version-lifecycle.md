# ADR 0003: Workflow Version Lifecycle and Publish Gate

## Status
Accepted

## Context
Phase 2 requires a draft/publish workflow lifecycle with enforceable harness safety before releases.

## Decision
- Add tenancy-scoped workflow version contracts in `@harbor/database` via `WorkflowRegistry`.
- Expose typed tRPC procedures for `saveWorkflowVersion`, `listWorkflowVersions`, `getWorkflowVersion`, and `publishWorkflowVersion`.
- Enforce deploy-grade harness lint before publish; blocked lint returns findings and prevents state promotion.
- Add a visual workflow builder route that edits typed workflow nodes and submits draft/publish actions through tRPC contracts.

## Consequences
- Workflow promotion now has explicit, auditable version state transitions.
- Builder UX can safely evolve without bypassing harness enforcement.
- Runtime and UI complexity increase slightly due to version persistence and publish checks.

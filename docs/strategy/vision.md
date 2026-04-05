# Harbor Vision

## Mission
Harbor is a TypeScript-native agent orchestration platform that turns raw LLM calls into reliable, observable, harness-governed workflows with memU-native long-term memory.

## Product Promise
- Build workflows visually and in code with typed contracts.
- Execute with durable, staged orchestration (`plan -> execute -> verify -> fix`).
- Execute each run inside its own isolated git worktree context.
- Enforce safety and quality through harness lint and policy gates.
- Require deploy/publish promotion gates with eval smoke checks and GitHub check-status parity.
- Preserve context and reduce token waste with memU-backed retrieval/writeback.
- Support multi-tenant operation with strict tenancy boundaries and auditability.
- Provide per-run ephemeral observability so traces/log pipelines are isolated and disposable by run.
- Keep the repository legible to coding agents with indexed docs, stable naming, and machine-checked structure.

## Locked Decisions
- Durable runtime: Inngest first.
- Auth/tenancy: Clerk orgs.
- API contracts: tRPC everywhere.
- Model strategy: OpenAI-first with provider abstraction.
- Launch posture: self-serve cloud first.
- memU posture: managed memU first, adapter-ready for self-host later.
- Git integration scope: GitHub only for MVP/polished production.
- Linter policy: block on critical, inject remediation steps for non-critical findings.
- Run isolation policy: every run is worktree-bound and can boot the whole stack in isolation.
- Observability policy: each run owns an ephemeral observability envelope with explicit retention.
- Legibility policy: repository structure and naming conventions are enforced by an automated drift gate.
- Enterprise baseline: SOC2 readiness, SAML, SCIM, immutable audit trail.

## Phase Targets
1. Phase 1 (MVP Core): reliable end-to-end execution path with observability and memU context.
2. Phase 2 (MVP Complete): visual builder, typed node graph lifecycle, tool orchestration, and promotion workflows.
3. Phase 2.5 (Harness + Legibility Hardening): convert proven improvements into enforceable contracts and drift gates.
4. Phase 3 (Polished Production): reliability hardening, stronger product UX, and security baseline.
5. Phase 4 (Enterprise Foundation): identity, compliance controls, and policy governance.
6. Phase 5 (Full Enterprise Product): deployment modes, HA operations, and enterprise governance features.

## Non-Negotiable Invariants
- API procedures must enforce `tenantId`, `workspaceId`, and `actorId` scoping.
- Critical harness lint findings block deployment/publish.
- Deploy/publish paths require passing eval gates and GitHub promotion checks before state promotion.
- Prompt mutations happen only through harness middleware pathways.
- Workflow nodes carry explicit ownership and execution budgets.
- Tool-call nodes carry explicit tool scopes plus `toolCallPolicy` (`timeoutMs`, `retryLimit`, `maxCalls`).
- memU writes include category/path and retention-aware metadata.
- Every run binds to a dedicated worktree and can build/run the full stack without sharing mutable runtime state.
- Every run emits to a run-scoped ephemeral observability channel with deterministic cleanup.
- Repository entry docs and workspace README maps must stay synchronized and pass legibility drift checks.
- New behavior includes success-path and failure-path tests.

# Harbor Vision

## Mission
Harbor is a TypeScript-native agent orchestration platform that turns raw LLM calls into reliable, observable, harness-governed workflows with memU-native long-term memory.

## Product Promise
- Build workflows visually and in code with typed contracts.
- Execute with durable, staged orchestration (`plan -> execute -> verify -> fix`).
- Enforce safety and quality through harness lint and policy gates.
- Preserve context and reduce token waste with memU-backed retrieval/writeback.
- Support multi-tenant operation with strict tenancy boundaries and auditability.

## Locked Decisions
- Durable runtime: Inngest first.
- Auth/tenancy: Clerk orgs.
- API contracts: tRPC everywhere.
- Model strategy: OpenAI-first with provider abstraction.
- Launch posture: self-serve cloud first.
- memU posture: managed memU first, adapter-ready for self-host later.
- Git integration scope: GitHub only for MVP/polished production.
- Linter policy: block on critical, inject remediation steps for non-critical findings.
- Enterprise baseline: SOC2 readiness, SAML, SCIM, immutable audit trail.

## Phase Targets
1. Phase 1 (MVP Core): reliable end-to-end execution path with observability and memU context.
2. Phase 2 (MVP Complete): visual builder, typed node graph lifecycle, tool orchestration, and promotion workflows.
3. Phase 3 (Polished Production): reliability hardening, stronger product UX, and security baseline.
4. Phase 4 (Enterprise Foundation): identity, compliance controls, and policy governance.
5. Phase 5 (Full Enterprise Product): deployment modes, HA operations, and enterprise governance features.

## Non-Negotiable Invariants
- API procedures must enforce `tenantId`, `workspaceId`, and `actorId` scoping.
- Critical harness lint findings block deployment/publish.
- Prompt mutations happen only through harness middleware pathways.
- Workflow nodes carry explicit ownership and execution budgets.
- Tool-call nodes carry explicit tool scopes plus `toolCallPolicy` (`timeoutMs`, `retryLimit`, `maxCalls`).
- memU writes include category/path and retention-aware metadata.
- New behavior includes success-path and failure-path tests.

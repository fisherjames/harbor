# Generation Standard

## Role Definition
Act as a senior Harbor engineer generating new code that fits current architecture and contracts.

## Context Requirements
- Relevant package README and local module entrypoints.
- Existing typed contracts (`@harbor/api`, `@harbor/engine`, `@harbor/harness`).
- Current phase goals and non-negotiable invariants.

## Categorized Standards
### Critical (must follow)
- Preserve tenancy boundaries (`tenantId`, `workspaceId`, `actorId`) in all API-facing flows.
- Keep end-to-end type safety through tRPC/Zod contracts.
- Ensure every new behavior has one success-path and one failure-path test.
- Avoid hidden prompt mutation outside harness middleware.
- Satisfy HAR001 by ensuring verifier-stage acceptance criteria are explicit.
- Satisfy HAR003 and HAR005 by assigning timeout/retry/max-call budgets.
- Satisfy HAR004 by defining valid memU retrieval/writeback and retention policy.

### Important (should follow)
- Prefer small, composable modules with explicit dependency boundaries.
- Reuse existing contracts and adapters instead of introducing parallel abstractions.
- Keep error messages actionable and deterministic.

### Advisory (nice to have)
- Add concise comments only where intent would otherwise be unclear.
- Include low-overhead observability hooks on new critical paths.

## Output Format
- Concise change summary.
- File-by-file implementation list.
- Verification steps run.
- Risks/assumptions if any.

## Scope Boundary
Single purpose: standards for creating new code only, not for code review decisions.

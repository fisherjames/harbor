# Phase 2.8: Harness Principles Addendum

## Purpose
Capture high-leverage harness tactics that are not explicitly covered in the current MVP-to-enterprise plan, then integrate them without a catastrophic rewrite.

## Scope
- Stay additive and incremental over the current architecture.
- Prefer policy and middleware expansion over runtime replacement.
- Keep all changes tenancy-scoped, worktree-bound, and trace-visible.

## Close-Out Snapshot (2026-04-06)
- Stream C complete: replay manifests, divergence taxonomy artifacts, and `pnpm replay:verify` are implemented.
- Stream G complete: versioned policy document, signature/checksum verification on deploy/run paths, and policy provenance artifacts are implemented.
- Stream A complete: stage confidence contracts, runtime confidence gating, and confidence-gate artifacts are implemented with verify-stage default policy.
- Stream B complete: tool side-effect modes (`read|propose|commit`), HAR010 lint enforcement, runtime two-phase ordering checks, and preview/commit hash artifacts are implemented.
- Stream F complete: deterministic adversarial smoke/nightly scenario packs are implemented in `@harbor/harness`, nightly scheduled execution is wired in `@harbor/worker`, and vulnerability taxonomy reports are enforced via `pnpm adversarial:check`.
- Stream H complete: memU trust metadata, runtime conflict filtering, conflict artifacts, observability metrics extraction, and run-detail dashboard surfacing are implemented.
- Stream D complete: typed `active|canary|shadow` rollout modes, shadow-gate deploy/publish/promotion enforcement, and comparison artifact contracts are implemented in API + web dependencies.
- Stream E complete: evaluator calibration contracts (`rubricVersion`, agreement/drift scores), deploy-time drift blocking, and `pnpm evaluator:check` monthly calibration drift reporting are implemented.
- Phase 2.8 is closed and archived; Phase 3 now tracks operational hardening.

## Streams

### Stream A: Confidence-Gated Autonomy
Owner: `packages/engine` + `packages/harness`

Tasks:
1. Add stage output contract with `confidence` field (`0-1`) and optional rationale.
2. Add harness rule to require explicit confidence output format for `plan`, `verify`, and `fix`.
3. Add runtime gate: if confidence is below policy threshold, set run status to `needs_human`.
4. Persist `confidence-gate` artifact with threshold, stage, and trigger reason.

Definition of done:
1. Low-confidence stage outputs consistently trigger escalation.
2. Run trace shows confidence values and gate decisions.
3. Unit tests cover pass/fail thresholds and false-positive safeguards.

Risk register:
1. Risk: Over-escalation hurts throughput.
Mitigation: Start with verify-stage gating only, then expand by config.

KPIs:
1. Human-escalation rate by workflow version.
2. Post-escalation correction rate.

Rollback:
1. Disable confidence gate via policy flag while retaining telemetry.

### Stream B: Two-Phase Side-Effect Protocol
Owner: `packages/engine` + `packages/harness` + tool runner surfaces

Tasks:
1. Introduce side-effect mode in tool contract: `read`, `propose`, `commit`.
2. Enforce runtime sequence for mutating tools: `propose -> preview artifact -> commit`.
3. Add linter rule for workflows that call mutating tools without two-phase policy.
4. Capture preview artifact hash and commit confirmation hash.

Definition of done:
1. Mutating tools cannot execute directly in single-step mode.
2. Auditable preview artifact appears before commit in traces.
3. Unauthorized commit attempts are blocked and audited.

Risk register:
1. Risk: Added latency for write operations.
Mitigation: Allow policy-based bypass for explicitly low-risk internal tools.

KPIs:
1. Direct-write blocks per week.
2. Commit rejection reasons distribution.

Rollback:
1. Per-tool override to allow legacy single-step mode during migration window.

### Stream C: Deterministic Replay Bundles
Owner: `packages/engine` + `packages/database` + `packages/observability`

Tasks:
1. Persist replay bundle manifest per run with:
- prompt envelope hash
- harness policy hash
- model settings
- tool call I/O hashes
- memory context snapshot references
2. Add replay verifier command to compare rerun parity against manifest.
3. Emit replay divergence taxonomy (`prompt`, `tool`, `memory`, `model`, `timing`).

Definition of done:
1. Replay bundle exists for every completed run.
2. Replay verifier can classify divergence causes.
3. Dashboard exposes parity status per run.

Risk register:
1. Risk: Storage growth.
Mitigation: store hashes and references, not full payload duplication.

KPIs:
1. Replay parity rate by workflow.
2. Top replay divergence categories.

Rollback:
1. Drop optional manifests for non-production runs first.

### Stream D: Canary + Shadow Harness Rollout
Owner: `packages/api` + `apps/worker` + deploy workflow

Tasks:
1. Add harness version selector with `active`, `canary`, and `shadow`.
2. Run shadow evaluations on sampled traffic without side effects.
3. Block promotion when shadow performance regresses beyond threshold.
4. Record canary/shadow comparison artifacts for each deploy.

Definition of done:
1. Every harness upgrade can run shadow mode before promotion.
2. Promotion gate includes shadow regression checks.
3. Rollback is one-click to previous harness version.

Risk register:
1. Risk: Cost increase from dual execution.
Mitigation: sampling rate and budget caps by tenant/workflow.

KPIs:
1. Shadow regression detection rate.
2. Failed promotions prevented by shadow gate.

Rollback:
1. Disable shadow gate, keep passive telemetry only.

### Stream E: Evaluator/Judge Calibration Loop
Owner: `packages/harness` + evaluation harness surfaces

Tasks:
1. Track evaluator agreement on shared benchmark set.
2. Add monthly rubric recalibration and drift report.
3. Gate deploys if evaluator drift exceeds threshold.
4. Persist rubric version used for each eval decision.

Definition of done:
1. Evaluator drift metrics are visible and trended.
2. Deploy decision is attributable to rubric version.
3. Drift threshold breach blocks promotion until recalibration.

Risk register:
1. Risk: Gate instability due to rubric churn.
Mitigation: versioned rubrics and freeze windows.

KPIs:
1. Evaluator agreement score.
2. Calibration interval compliance.

Rollback:
1. Fall back to prior rubric version and re-run pending gates.

### Stream F: Adversarial Harness Test Suite
Owner: `packages/harness` + `packages/engine` + CI

Tasks:
1. Add adversarial scenarios for:
- prompt injection
- tool permission escalation
- cross-tenant access attempts
- memory poisoning/contradiction
2. Run adversarial smoke suite on deploy and nightly full suite.
3. Publish vulnerability taxonomy in artifacts.

Definition of done:
1. Adversarial suite runs in CI and is versioned.
2. Critical adversarial failures block deploy.
3. Findings map to remediation steps under `Harness Resolution Steps`.

Risk register:
1. Risk: flaky security tests.
Mitigation: deterministic fixtures and fixed-seed simulation.

KPIs:
1. Adversarial pass rate.
2. Mean time to remediate critical adversarial finding.

Rollback:
1. Move failing non-critical scenarios to warning mode with tracked debt.

### Stream G: Policy-as-Code With Signed Versions
Owner: `packages/harness` + `packages/api` + `packages/database`

Tasks:
1. Extract runtime policies into versioned policy documents.
2. Add signature/checksum verification before deploy/run.
3. Record `policyVersion` and `policySignature` in run/deploy artifacts.
4. Add API enforcement to reject unsigned/untrusted policy payloads.

Definition of done:
1. Policies are immutable/versioned and signature-validated.
2. Run/deploy records are traceable to policy version and signature.
3. Unauthorized policy edits are blocked.

Risk register:
1. Risk: operator friction during policy updates.
Mitigation: CLI helper to sign and validate policy bundles.

KPIs:
1. Unsigned policy rejection count.
2. Policy provenance completeness rate.

Rollback:
1. Temporary trusted-dev signature list with explicit expiration.

### Stream H: Memory Trust + Conflict Controls
Owner: `packages/memu` + `packages/harness` + `packages/engine`

Tasks:
1. Add memory item trust metadata (`source`, `confidence`, `lastValidatedAt`).
2. Detect contradictions during retrieval and mark low-trust candidates.
3. Prefer high-trust memory in `reason` mode; compact stale/low-trust entries.
4. Emit memory conflict artifact and include remediation step injection.

Definition of done:
1. Retrieval ranking incorporates trust/conflict scoring.
2. Contradictory memory items are flagged, not blindly injected.
3. Memory conflict metrics appear in observability dashboards.

Risk register:
1. Risk: useful low-trust memory suppressed.
Mitigation: retain fallback retrieval path with explicit provenance labels.

KPIs:
1. Memory conflict rate.
2. Verification failures attributable to stale memory.

Rollback:
1. Revert to legacy retrieval ranking while preserving trust metadata collection.

## Rollout Order
1. Stream C (deterministic replay) and Stream G (policy signing).
2. Stream A (confidence gates) and Stream B (two-phase side effects).
3. Stream F (adversarial suite) and Stream H (memory trust/conflicts).
4. Stream D (canary/shadow) and Stream E (evaluator calibration).

## Exit Criteria
1. All stream definitions of done are met.
2. Deploy gate includes replay parity, adversarial smoke, and shadow regression checks.
3. Every run records confidence, policy provenance, and replay bundle references.
4. Memory trust/conflict controls are active with dashboard visibility.

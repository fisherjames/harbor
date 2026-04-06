import {
  DEFAULT_PLATFORM_SYSTEM_PROMPT,
  assembleStagePrompt,
  filterFindingsForPrompt,
  generateRemediationRecommendations,
  runLintAtExecutionPoint,
  resolveStageDirective,
  summarizePostRunFindings,
  type LintFinding,
  type WorkflowDefinition
} from "@harbor/harness";
import type { MemuContextItem, MemuWriteInput } from "@harbor/memu";
import type { RunIsolationSession, WorkflowRunnerDependencies } from "../contracts/runtime.js";
import type { RunContext, RunStage, RunStatus, WorkflowRunRequest, WorkflowRunResult } from "../contracts/types.js";
import { createWorkflowPolicyVerifier, hashPayload } from "./policy.js";
import { withRetry } from "./retry.js";

const PROMPT_STAGES: RunStage[] = ["plan", "execute", "verify", "fix"];
const DEFAULT_CONFIDENCE_GATE_STAGES: RunStage[] = ["verify"];
type ReplayDivergenceCategory = "prompt" | "tool" | "memory" | "model" | "timing" | "policy";

interface ReplayStagePromptHash {
  stage: RunStage;
  hash: string;
}

interface ReplayMemoryReadSnapshot {
  stage: RunStage;
  mode: "monitor" | "reason";
  itemCount: number;
  contextHash: string;
  source: "compressed_prompt" | "items";
}

interface ReplayMemoryWriteSnapshot {
  stage: RunStage;
  memoryId: string;
}

interface ReplayCollector {
  stagePromptHashes: ReplayStagePromptHash[];
  memoryReads: ReplayMemoryReadSnapshot[];
  memoryWrites: ReplayMemoryWriteSnapshot[];
}

interface ResolvedMemoryContext {
  prompt: string;
  snapshot: ReplayMemoryReadSnapshot;
  conflictSummary?: MemoryConflictSummary | undefined;
}

interface MemoryConflictEntry {
  title: string;
  preferredMemoryId: string;
  conflictingMemoryIds: string[];
  droppedMemoryIds: string[];
  reason: "contradictory_content";
}

interface MemoryConflictSummary {
  conflicts: MemoryConflictEntry[];
  droppedMemoryIds: string[];
  resolutionSteps: string[];
}

interface StageExecutionResult {
  output: string;
  confidence: number;
  confidenceRationale?: string | undefined;
  confidenceSource: "model" | "inferred";
}

interface ConfidenceGatePolicy {
  threshold: number;
  stages: RunStage[];
}

function resolvePlatformSystemPrompt(dependencies: WorkflowRunnerDependencies): string {
  const override = dependencies.promptEnvelopePolicy?.platformSystemPrompt?.trim();
  if (override && override.length > 0) {
    return override;
  }

  return DEFAULT_PLATFORM_SYSTEM_PROMPT;
}

function resolveWorkflowSystemPrompt(
  workflow: WorkflowDefinition,
  dependencies: WorkflowRunnerDependencies
): string {
  const override = dependencies.promptEnvelopePolicy?.workflowSystemPrompt?.trim();
  if (override && override.length > 0) {
    return override;
  }

  return workflow.systemPrompt;
}

function resolveStageDirectiveForRun(stage: RunStage, dependencies: WorkflowRunnerDependencies): string {
  const override = dependencies.promptEnvelopePolicy?.stageDirectives?.[stage];
  return resolveStageDirective(stage, override);
}

function toolPolicySnapshot(workflow: WorkflowDefinition): Array<{
  nodeId: string;
  scope: string[];
  timeoutMs: number | null;
  retryLimit: number | null;
  maxCalls: number | null;
  sideEffectMode: "read" | "propose" | "commit";
  phaseGroup: string | null;
}> {
  return workflow.nodes
    .filter((node) => node.type === "tool_call")
    .map((node) => ({
      nodeId: node.id,
      scope: node.toolPermissionScope ?? [],
      timeoutMs: node.toolCallPolicy?.timeoutMs ?? null,
      retryLimit: node.toolCallPolicy?.retryLimit ?? null,
      maxCalls: node.toolCallPolicy?.maxCalls ?? null,
      sideEffectMode: node.toolCallPolicy?.sideEffectMode ?? "read",
      phaseGroup: node.toolCallPolicy?.phaseGroup?.trim() ?? null
    }));
}

interface TwoPhaseValidationGroup {
  group: string;
  proposeNodeIds: string[];
  commitNodeIds: string[];
  proposeFirstIndex: number;
  commitFirstIndex: number;
}

interface TwoPhaseValidationResult {
  valid: boolean;
  reasons: string[];
  groups: TwoPhaseValidationGroup[];
}

function sanitizeArtifactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

function validateTwoPhaseSideEffects(workflow: WorkflowDefinition): TwoPhaseValidationResult {
  const grouped = new Map<
    string,
    {
      proposeNodeIds: string[];
      commitNodeIds: string[];
      proposeFirstIndex: number;
      commitFirstIndex: number;
    }
  >();
  const reasons: string[] = [];

  workflow.nodes.forEach((node, index) => {
    if (node.type !== "tool_call") {
      return;
    }

    const mode = node.toolCallPolicy?.sideEffectMode ?? "read";
    if (mode === "read") {
      return;
    }

    const group = node.toolCallPolicy?.phaseGroup?.trim();
    if (!group) {
      reasons.push(`Tool node ${node.id} uses sideEffectMode='${mode}' without phaseGroup.`);
      return;
    }

    const existing = grouped.get(group) ?? {
      proposeNodeIds: [],
      commitNodeIds: [],
      proposeFirstIndex: Number.POSITIVE_INFINITY,
      commitFirstIndex: Number.POSITIVE_INFINITY
    };
    if (mode === "propose") {
      existing.proposeNodeIds.push(node.id);
      existing.proposeFirstIndex = Math.min(existing.proposeFirstIndex, index);
    }
    if (mode === "commit") {
      existing.commitNodeIds.push(node.id);
      existing.commitFirstIndex = Math.min(existing.commitFirstIndex, index);
    }
    grouped.set(group, existing);
  });

  const groups: TwoPhaseValidationGroup[] = [];
  for (const [group, state] of grouped.entries()) {
    if (state.commitNodeIds.length === 0) {
      continue;
    }
    if (state.proposeNodeIds.length === 0) {
      reasons.push(`Commit phaseGroup '${group}' is missing a propose node.`);
      continue;
    }
    if (state.commitFirstIndex < state.proposeFirstIndex) {
      reasons.push(`Commit phaseGroup '${group}' appears before propose stage in workflow node order.`);
      continue;
    }

    groups.push({
      group,
      proposeNodeIds: state.proposeNodeIds,
      commitNodeIds: state.commitNodeIds,
      proposeFirstIndex: state.proposeFirstIndex,
      commitFirstIndex: state.commitFirstIndex
    });
  }

  return {
    valid: reasons.length === 0,
    reasons,
    groups
  };
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function resolutionStepsFromFindings(findings: ReturnType<typeof filterFindingsForPrompt>): string[] {
  return uniquePreserveOrder(findings.flatMap((finding) => finding.resolutionSteps));
}

function remediationPromptSectionToFinding(): LintFinding {
  return {
    findingId: "HAR-STANDARDS-TREND",
    ruleId: "HAR-STANDARDS-TREND",
    severity: "warning",
    message: "Apply standards trend remediation steps.",
    resolutionSteps: [],
    promptPatch: {
      section: "verification",
      operation: "append",
      content: "Confirm trend remediation steps were applied before final PASS."
    }
  };
}

function stageNodeType(stage: RunStage): "planner" | "executor" | "verifier" {
  if (stage === "plan") {
    return "planner";
  }

  if (stage === "verify") {
    return "verifier";
  }

  return "executor";
}

function verifyPassed(output: string): boolean {
  const normalized = output.toUpperCase();
  return normalized.includes("PASS") && !normalized.includes("FAIL");
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return Number(value.toFixed(4));
}

function inferConfidence(stage: RunStage, output: string): number {
  const normalized = output.toUpperCase();
  if (normalized.includes("FAIL")) {
    return 0.15;
  }

  if (stage === "verify" && normalized.includes("PASS")) {
    return 0.95;
  }

  if (stage === "fix") {
    return 0.7;
  }

  return 0.8;
}

function resolveConfidence(execution: {
  output: string;
  confidence?: number | undefined;
  confidenceRationale?: string | undefined;
}, stage: RunStage): StageExecutionResult {
  let confidenceValue: number;
  let hasModelConfidence = false;
  if (typeof execution.confidence === "number") {
    confidenceValue = execution.confidence;
    hasModelConfidence = true;
  } else {
    confidenceValue = inferConfidence(stage, execution.output);
  }
  const confidence = clampConfidence(confidenceValue);

  return {
    output: execution.output,
    confidence,
    confidenceSource: hasModelConfidence ? "model" : "inferred",
    ...(execution.confidenceRationale?.trim()
      ? {
          confidenceRationale: execution.confidenceRationale.trim()
        }
      : {})
  };
}

function statusTransitionKey(status: RunStatus, reason?: string): string {
  if (!reason) {
    return `status:${status}`;
  }

  return `status:${status}:${reason}`;
}

function normalizedMemoryTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedMemoryContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseValidationDate(value: string | undefined): number | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function memoryTrustScore(item: MemuContextItem): number {
  const raw = typeof item.trust?.confidence === "number" ? item.trust.confidence : item.relevance;
  return clampConfidence(raw);
}

function isStaleMemory(item: MemuContextItem): boolean {
  const validatedAt = parseValidationDate(item.trust?.lastValidatedAt);
  if (!validatedAt) {
    return false;
  }

  const maxAgeMs = 1000 * 60 * 60 * 24 * 30;
  return Date.now() - validatedAt > maxAgeMs;
}

function analyzeMemoryTrust(
  items: MemuContextItem[],
  mode: "monitor" | "reason"
): {
  items: MemuContextItem[];
  conflictSummary?: MemoryConflictSummary | undefined;
} {
  if (items.length === 0) {
    return {
      items
    };
  }

  const byTitle = new Map<string, MemuContextItem[]>();
  for (const item of items) {
    const titleKey = normalizedMemoryTitle(item.title);
    const group = byTitle.get(titleKey) ?? [];
    group.push(item);
    byTitle.set(titleKey, group);
  }

  const droppedMemoryIds = new Set<string>();
  const conflicts: MemoryConflictEntry[] = [];

  for (const group of byTitle.values()) {
    if (group.length < 2) {
      continue;
    }

    const uniqueContents = new Set(group.map((item) => normalizedMemoryContent(item.content)));
    if (uniqueContents.size < 2) {
      continue;
    }

    const ranked = [...group].sort(
      (left, right) => memoryTrustScore(right) - memoryTrustScore(left) || right.relevance - left.relevance
    );
    const preferred = ranked[0] as MemuContextItem;

    const droppedInGroup =
      mode === "reason"
        ? ranked
            .slice(1)
            .filter((item) => {
              const score = memoryTrustScore(item);
              return score < memoryTrustScore(preferred) || score < 0.45 || isStaleMemory(item);
            })
            .map((item) => item.id)
        : [];

    for (const memoryId of droppedInGroup) {
      droppedMemoryIds.add(memoryId);
    }

    conflicts.push({
      title: preferred.title,
      preferredMemoryId: preferred.id,
      conflictingMemoryIds: ranked.slice(1).map((item) => item.id),
      droppedMemoryIds: droppedInGroup,
      reason: "contradictory_content"
    });
  }

  const filtered =
    mode === "reason"
      ? items
          .filter((item) => !droppedMemoryIds.has(item.id))
          .sort((left, right) => memoryTrustScore(right) - memoryTrustScore(left) || right.relevance - left.relevance)
      : items;

  if (conflicts.length === 0) {
    return {
      items: filtered
    };
  }

  return {
    items: filtered,
    conflictSummary: {
      conflicts,
      droppedMemoryIds: [...droppedMemoryIds],
      resolutionSteps: [
        "Resolve contradictory memory items by preferring higher-trust evidence and explicitly stating rejected alternatives.",
        "Request human confirmation before relying on unresolved low-trust memory conflicts."
      ]
    }
  };
}

function mergeResolutionSections(...sections: Array<string | undefined>): string {
  const merged = sections
    .map((section) => section?.trim() ?? "")
    .filter((section) => section.length > 0)
    .join("\n\n");

  return merged;
}

function buildReplayDivergenceTaxonomy(): Record<ReplayDivergenceCategory, number> {
  return {
    prompt: 0,
    tool: 0,
    memory: 0,
    model: 0,
    timing: 0,
    policy: 0
  };
}

function buildReplayBundleManifest(input: {
  runId: string;
  workflow: WorkflowDefinition;
  promptEnvelopeHash: string;
  harnessPolicyHash: string;
  modelSettings: Record<string, unknown>;
  toolPolicies: Array<{
    nodeId: string;
    scope: string[];
    timeoutMs: number | null;
    retryLimit: number | null;
    maxCalls: number | null;
    sideEffectMode: "read" | "propose" | "commit";
    phaseGroup: string | null;
  }>;
  replayCollector: ReplayCollector;
  policyVersion?: string | undefined;
  policySignature?: string | undefined;
}): Record<string, unknown> {
  return {
    version: 1,
    runId: input.runId,
    workflowId: input.workflow.id,
    workflowVersion: input.workflow.version,
    promptEnvelopeHash: input.promptEnvelopeHash,
    harnessPolicyHash: input.harnessPolicyHash,
    modelSettings: input.modelSettings,
    modelSettingsHash: hashPayload(input.modelSettings),
    toolPolicyHash: hashPayload(input.toolPolicies),
    toolIoHashes: [],
    stagePromptHashes: input.replayCollector.stagePromptHashes,
    memoryReadSnapshots: input.replayCollector.memoryReads,
    memoryWriteRefs: input.replayCollector.memoryWrites,
    ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    ...(input.policySignature ? { policySignature: input.policySignature } : {})
  };
}

async function readMemoryContext(
  stage: RunStage,
  context: RunContext,
  dependencies: WorkflowRunnerDependencies
): Promise<ResolvedMemoryContext | undefined> {
  const policy = context.workflow.memoryPolicy;

  if (!policy) {
    return undefined;
  }

  if (stage !== "plan" && stage !== "verify") {
    return undefined;
  }

  const response = await dependencies.memu.readContext({
    tenantId: context.request.tenantId,
    workspaceId: context.request.workspaceId,
    agentId: context.workflow.id,
    runId: context.runId,
    query: context.workflow.objective,
    mode: policy.retrievalMode,
    maxItems: policy.maxContextItems
  });
  const memoryTrust = analyzeMemoryTrust(response.items, policy.retrievalMode);
  const shouldUseCompressedPrompt =
    policy.retrievalMode === "monitor" && !memoryTrust.conflictSummary && Boolean(response.compressedPrompt);
  const source: ReplayMemoryReadSnapshot["source"] = shouldUseCompressedPrompt ? "compressed_prompt" : "items";
  const prompt = shouldUseCompressedPrompt
    ? (response.compressedPrompt as string)
    : memoryTrust.items.map((item) => `- ${item.title}: ${item.content}`).join("\n");

  return {
    prompt,
    snapshot: {
      stage,
      mode: policy.retrievalMode,
      itemCount: memoryTrust.items.length,
      contextHash: hashPayload(prompt),
      source
    },
    ...(memoryTrust.conflictSummary ? { conflictSummary: memoryTrust.conflictSummary } : {})
  };
}

async function writeMemory(
  stage: RunStage,
  output: string,
  confidence: number,
  context: RunContext,
  dependencies: WorkflowRunnerDependencies
): Promise<string | undefined> {
  const policy = context.workflow.memoryPolicy;
  if (!policy?.writebackEnabled || (stage !== "execute" && stage !== "fix")) {
    return undefined;
  }

  const input: MemuWriteInput = {
    tenantId: context.request.tenantId,
    workspaceId: context.request.workspaceId,
    agentId: context.workflow.id,
    category: "workflow-runs",
    path: `${context.workflow.id}/${context.runId}/${stage}.md`,
    content: output,
    metadata: {
      stage,
      piiRetention: policy.piiRetention,
      trigger: context.request.trigger,
      trustSource: `runtime:${stage}`,
      trustConfidence: confidence,
      lastValidatedAt: new Date().toISOString()
    }
  };

  const result = await dependencies.memu.writeMemory(input);
  return result.memoryId;
}

async function runSingleStage(
  stage: RunStage,
  context: RunContext,
  dependencies: WorkflowRunnerDependencies,
  nonBlockingFindings: ReturnType<typeof filterFindingsForPrompt>,
  stageTransitionKey: string,
  replayCollector: ReplayCollector,
  resolutionSectionAppendix?: string
): Promise<StageExecutionResult> {
  if (dependencies.persistence.resolveStageReplay) {
    const replay = await dependencies.persistence.resolveStageReplay(context.runId, stageTransitionKey);
    if (replay) {
      dependencies.tracer.finding({
        runId: context.runId,
        workflowId: context.workflow.id,
        stage,
        message: "Stage replay deduplicated by transition key",
        metadata: {
          transitionKey: stageTransitionKey,
          attempts: replay.attempts
        }
      });

      replayCollector.stagePromptHashes.push({
        stage,
        hash: hashPayload(replay.prompt)
      });

      return {
        output: replay.output,
        confidence: clampConfidence(replay.confidence ?? inferConfidence(stage, replay.output)),
        confidenceSource: typeof replay.confidence === "number" ? "model" : "inferred",
        ...(replay.confidenceRationale
          ? {
              confidenceRationale: replay.confidenceRationale
            }
          : {})
      };
    }
  }

  const startedAt = new Date().toISOString();
  const nodeType = stageNodeType(stage);
  const node = context.workflow.nodes.find((workflowNode) => workflowNode.type === nodeType);
  const retries = node?.retryLimit ?? 0;
  const timeoutMs = node?.timeoutMs ?? 5_000;

  const memoryContext = await readMemoryContext(stage, context, dependencies);
  if (memoryContext) {
    replayCollector.memoryReads.push(memoryContext.snapshot);
  }

  let stageResolutionSection = resolutionSectionAppendix;
  if (memoryContext?.conflictSummary) {
    const stageMemoryConflictKey = sanitizeArtifactKey(stageTransitionKey);
    await dependencies.persistence.storeArtifact(
      context.runId,
      `memory-conflict-${stageMemoryConflictKey}`,
      JSON.stringify({
        stage,
        mode: memoryContext.snapshot.mode,
        ...memoryContext.conflictSummary
      })
    );
    await dependencies.persistence.storeArtifact(
      context.runId,
      "memory-conflict-latest",
      JSON.stringify({
        stage,
        mode: memoryContext.snapshot.mode,
        ...memoryContext.conflictSummary
      })
    );

    const conflictSteps = memoryContext.conflictSummary.resolutionSteps
      .map((step, index) => `${index + 1}. ${step}`)
      .join("\n");
    stageResolutionSection = mergeResolutionSections(
      resolutionSectionAppendix,
      `Memory trust conflicts detected for this stage:\n${conflictSteps}`
    );
  }

  const promptInput = {
    stage,
    workflow: context.workflow,
    platformSystemPrompt: resolvePlatformSystemPrompt(dependencies),
    workflowSystemPrompt: resolveWorkflowSystemPrompt(context.workflow, dependencies),
    stageDirective: resolveStageDirectiveForRun(stage, dependencies),
    baseTask: `Input: ${JSON.stringify(context.request.input)}`,
    lintFindings: nonBlockingFindings,
    ...(stageResolutionSection ? { resolutionSectionAppendix: stageResolutionSection } : {}),
    ...(memoryContext ? { memoryContext: memoryContext.prompt } : {})
  } as const;

  const prompt = assembleStagePrompt(promptInput);
  replayCollector.stagePromptHashes.push({
    stage,
    hash: hashPayload(prompt)
  });

  dependencies.tracer.stageStart({
    runId: context.runId,
    workflowId: context.workflow.id,
    stage,
    message: "Stage started",
    metadata: {
      timeoutMs,
      retries
    }
  });

  const execution = await withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await dependencies.model.generate({
        stage,
        prompt,
        context
      });
    } finally {
      clearTimeout(timer);
    }
  }, retries, 120);

  const stageResult = resolveConfidence(execution.value, stage);
  const stageRecord = {
    stage,
    startedAt,
    completedAt: new Date().toISOString(),
    prompt,
    output: stageResult.output,
    confidence: stageResult.confidence,
    ...(stageResult.confidenceRationale ? { confidenceRationale: stageResult.confidenceRationale } : {}),
    attempts: execution.attempts,
    lintFindings: nonBlockingFindings,
    ...(execution.value.tokenUsage ? { tokenUsage: execution.value.tokenUsage } : {})
  };

  await dependencies.persistence.appendStage(context.runId, stageRecord, stageTransitionKey);

  const memoryId = await writeMemory(stage, stageResult.output, stageResult.confidence, context, dependencies);
  if (memoryId) {
    replayCollector.memoryWrites.push({
      stage,
      memoryId
    });
  }

  dependencies.tracer.stageEnd({
    runId: context.runId,
    workflowId: context.workflow.id,
    stage,
    message: "Stage completed",
    metadata: {
      attempts: execution.attempts,
      latencyMs: execution.value.latencyMs,
      totalTokens: execution.value.tokenUsage?.totalTokens ?? 0,
      confidence: stageResult.confidence
    }
  });

  return stageResult;
}

export function createWorkflowRunner(dependencies: WorkflowRunnerDependencies) {
  const maxFixAttempts = dependencies.maxFixAttempts ?? 1;
  const policyVerifier = dependencies.policyVerifier ?? createWorkflowPolicyVerifier({ requireBundle: false });
  const confidenceGatePolicy: ConfidenceGatePolicy = {
    threshold: clampConfidence(dependencies.confidenceGatePolicy?.threshold ?? 0.6),
    stages: dependencies.confidenceGatePolicy?.stages ?? DEFAULT_CONFIDENCE_GATE_STAGES
  };

  return {
    async runWorkflow(request: WorkflowRunRequest, workflow: WorkflowDefinition): Promise<WorkflowRunResult> {
      if (request.idempotencyKey && dependencies.persistence.resolveIdempotentRun) {
        const deduped = await dependencies.persistence.resolveIdempotentRun(request);
        if (deduped) {
          dependencies.tracer.finding({
            runId: deduped.runId,
            workflowId: workflow.id,
            message: "Idempotent run request deduplicated",
            metadata: {
              status: deduped.status
            }
          });

          return {
            runId: deduped.runId,
            status: deduped.status,
            ...(deduped.details ? { finalOutput: deduped.details } : {})
          };
        }
      }

      const runId = await dependencies.persistence.createRun(request, workflow);

      await dependencies.persistence.updateStatus(runId, "running", undefined, statusTransitionKey("running"));

      const context: RunContext = {
        request,
        workflow,
        runId
      };
      const replayCollector: ReplayCollector = {
        stagePromptHashes: [],
        memoryReads: [],
        memoryWrites: []
      };
      let isolationSession: RunIsolationSession | undefined;
      let outcome: RunStatus = "running";
      let stageTransitionIndex = 0;
      const nextStageTransitionKey = (stage: RunStage): string => {
        stageTransitionIndex += 1;
        return `stage:${stage}:${stageTransitionIndex}`;
      };
      const teardownIsolation = async (): Promise<void> => {
        if (!isolationSession) {
          return;
        }

        try {
          await dependencies.runIsolation!.teardown(context, isolationSession, outcome);
        } catch (error) {
          const err = error as Error;

          dependencies.tracer.error({
            runId,
            workflowId: workflow.id,
            message: "Run isolation teardown failed",
            error: err
          });

          await dependencies.persistence
            .storeArtifact(runId, "run-isolation-teardown-error", err.message)
            .catch(() => undefined);
        }
      };

      if (dependencies.runIsolation) {
        try {
          isolationSession = await dependencies.runIsolation.setup(context);
          await dependencies.persistence.storeArtifact(runId, "run-isolation-session", JSON.stringify(isolationSession));
        } catch (error) {
          const err = error as Error;
          outcome = "failed";

          dependencies.tracer.error({
            runId,
            workflowId: workflow.id,
            message: "Run isolation setup failed",
            error: err
          });

          await dependencies.persistence.storeArtifact(runId, "run-isolation-setup-error", err.message);
          await dependencies.persistence.updateStatus(runId, "failed", {
            reason: "run_isolation_setup_failed",
            detail: err.message
          }, statusTransitionKey("failed", "run_isolation_setup_failed"));
          await teardownIsolation();

          return {
            runId,
            status: "failed",
            finalOutput: {
              reason: "run_isolation_setup_failed",
              detail: err.message
            }
          };
        }
      }

      try {
        const policyVerification = policyVerifier.verify(workflow);
        await dependencies.persistence.storeArtifact(runId, "policy-verification", JSON.stringify(policyVerification));

        if (policyVerification.policyVersion) {
          await dependencies.persistence.storeArtifact(runId, "policy-version", policyVerification.policyVersion);
        }

        if (policyVerification.signature) {
          await dependencies.persistence.storeArtifact(runId, "policy-signature", policyVerification.signature);
        }

        if (!policyVerification.valid) {
          const replayManifest = buildReplayBundleManifest({
            runId,
            workflow,
            promptEnvelopeHash: "",
            harnessPolicyHash: "",
            modelSettings: {
              provider: "unknown"
            },
            toolPolicies: [],
            replayCollector,
            policyVersion: policyVerification.policyVersion,
            policySignature: policyVerification.signature
          });
          await dependencies.persistence.storeArtifact(runId, "replay-bundle-manifest", JSON.stringify(replayManifest));
          await dependencies.persistence.storeArtifact(
            runId,
            "replay-divergence-taxonomy",
            JSON.stringify(buildReplayDivergenceTaxonomy())
          );

          outcome = "failed";
          await dependencies.persistence.updateStatus(runId, "failed", {
            reason: "invalid_policy_bundle",
            details: policyVerification.reasons
          }, statusTransitionKey("failed", "invalid_policy_bundle"));
          await teardownIsolation();

          return {
            runId,
            status: "failed",
            finalOutput: {
              reason: "invalid_policy_bundle",
              details: policyVerification.reasons
            }
          };
        }

        const lintReport = runLintAtExecutionPoint("runtime-pre-stage", workflow).report;
        await dependencies.persistence.addLintFindings(runId, lintReport.findings);

        for (const finding of lintReport.findings) {
          dependencies.tracer.finding({
            runId,
            workflowId: workflow.id,
            message: finding.message,
            metadata: {
              ruleId: finding.ruleId,
              severity: finding.severity
            }
          });
        }

        const toolPolicies = toolPolicySnapshot(workflow);
        const modelSettings = dependencies.model.describe?.() ?? {
          provider: "unknown"
        };
        await dependencies.persistence.storeArtifact(runId, "confidence-gate-policy", JSON.stringify(confidenceGatePolicy));
        const promptEnvelopeSnapshot = {
          platformSystemPrompt: resolvePlatformSystemPrompt(dependencies),
          workflowSystemPrompt: resolveWorkflowSystemPrompt(workflow, dependencies),
          stageDirectives: Object.fromEntries(
            PROMPT_STAGES.map((stage) => [stage, resolveStageDirectiveForRun(stage, dependencies)])
          ) as Record<RunStage, string>
        };
        const harnessPolicySnapshot = {
          memoryPolicy: workflow.memoryPolicy ?? null,
          nodeBudgets: workflow.nodes.map((node) => ({
            nodeId: node.id,
            nodeType: node.type,
            owner: node.owner ?? null,
            timeoutMs: node.timeoutMs ?? null,
            retryLimit: node.retryLimit ?? null
          })),
          toolPolicies,
          policyVersion: policyVerification.policyVersion ?? null
        };
        const promptEnvelopeHash = hashPayload(promptEnvelopeSnapshot);
        const harnessPolicyHash = hashPayload(harnessPolicySnapshot);

        await dependencies.persistence.storeArtifact(
          runId,
          "prompt-envelope-snapshot",
          JSON.stringify(promptEnvelopeSnapshot)
        );
        await dependencies.persistence.storeArtifact(runId, "prompt-envelope-hash", promptEnvelopeHash);
        await dependencies.persistence.storeArtifact(
          runId,
          "harness-policy-snapshot",
          JSON.stringify(harnessPolicySnapshot)
        );
        await dependencies.persistence.storeArtifact(runId, "harness-policy-hash", harnessPolicyHash);
        await dependencies.persistence.storeArtifact(runId, "model-settings", JSON.stringify(modelSettings));

        if (toolPolicies.length > 0) {
          await dependencies.persistence.storeArtifact(runId, "tool-execution-policy", JSON.stringify(toolPolicies));
        }

        const twoPhaseValidation = validateTwoPhaseSideEffects(workflow);
        await dependencies.persistence.storeArtifact(runId, "two-phase-validation", JSON.stringify(twoPhaseValidation));
        if (!twoPhaseValidation.valid) {
          const replayManifest = buildReplayBundleManifest({
            runId,
            workflow,
            promptEnvelopeHash,
            harnessPolicyHash,
            modelSettings,
            toolPolicies,
            replayCollector,
            policyVersion: policyVerification.policyVersion,
            policySignature: policyVerification.signature
          });
          await dependencies.persistence.storeArtifact(runId, "replay-bundle-manifest", JSON.stringify(replayManifest));
          await dependencies.persistence.storeArtifact(
            runId,
            "replay-divergence-taxonomy",
            JSON.stringify(buildReplayDivergenceTaxonomy())
          );

          outcome = "failed";
          await dependencies.persistence.updateStatus(runId, "failed", {
            reason: "two_phase_violation",
            details: twoPhaseValidation.reasons
          }, statusTransitionKey("failed", "two_phase_violation"));
          await teardownIsolation();

          return {
            runId,
            status: "failed",
            finalOutput: {
              reason: "two_phase_violation",
              details: twoPhaseValidation.reasons
            }
          };
        }

        for (const group of twoPhaseValidation.groups) {
          const previewHash = hashPayload({
            workflowId: workflow.id,
            workflowVersion: workflow.version,
            group: group.group,
            proposeNodeIds: group.proposeNodeIds
          });
          const commitConfirmationHash = hashPayload({
            runId,
            workflowId: workflow.id,
            group: group.group,
            commitNodeIds: group.commitNodeIds,
            previewHash
          });
          const groupKey = sanitizeArtifactKey(group.group);
          await dependencies.persistence.storeArtifact(
            runId,
            `two-phase-preview-${groupKey}`,
            JSON.stringify({
              group: group.group,
              proposeNodeIds: group.proposeNodeIds,
              previewHash
            })
          );
          await dependencies.persistence.storeArtifact(
            runId,
            `two-phase-commit-${groupKey}`,
            JSON.stringify({
              group: group.group,
              commitNodeIds: group.commitNodeIds,
              previewHash,
              commitConfirmationHash
            })
          );
        }

        if (lintReport.blocked) {
          const replayManifest = buildReplayBundleManifest({
            runId,
            workflow,
            promptEnvelopeHash,
            harnessPolicyHash,
            modelSettings,
            toolPolicies,
            replayCollector,
            policyVersion: policyVerification.policyVersion,
            policySignature: policyVerification.signature
          });
          await dependencies.persistence.storeArtifact(runId, "replay-bundle-manifest", JSON.stringify(replayManifest));
          await dependencies.persistence.storeArtifact(
            runId,
            "replay-divergence-taxonomy",
            JSON.stringify(buildReplayDivergenceTaxonomy())
          );

          outcome = "failed";
          await dependencies.persistence.updateStatus(runId, "failed", {
            reason: "critical_lint_findings"
          }, statusTransitionKey("failed", "critical_lint_findings"));
          await teardownIsolation();

          return {
            runId,
            status: "failed",
            finalOutput: {
              reason: "critical_lint_findings",
              lintFindings: lintReport.findings
            }
          };
        }

        const nonBlockingFindings = filterFindingsForPrompt(lintReport.findings);
        let remediationPromptSection: string | undefined;
        if (dependencies.standardsRemediationProvider) {
          const remediationSnapshot = await dependencies.standardsRemediationProvider.load();
          if (remediationSnapshot?.promptSection) {
            remediationPromptSection = remediationSnapshot.promptSection;
            nonBlockingFindings.push(remediationPromptSectionToFinding());
            await dependencies.persistence.storeArtifact(
              runId,
              "standards-remediation-source",
              remediationSnapshot.sourcePath
            );
            await dependencies.persistence.storeArtifact(
              runId,
              "standards-remediation-prompt-section",
              remediationPromptSection
            );
            await dependencies.persistence.storeArtifact(
              runId,
              "standards-remediation-hash",
              hashPayload({
                sourcePath: remediationSnapshot.sourcePath,
                promptSection: remediationPromptSection
              })
            );
          }
        }
        const resolutionSteps = resolutionStepsFromFindings(nonBlockingFindings);

        if (resolutionSteps.length > 0) {
          await dependencies.persistence.storeArtifact(runId, "harness-resolution-steps", JSON.stringify(resolutionSteps));
        }

        const shouldEscalateForConfidence = async (stageResult: StageExecutionResult, stage: RunStage) => {
          const confidenceGateEnabled = confidenceGatePolicy.stages.includes(stage);
          if (
            !confidenceGateEnabled ||
            stageResult.confidenceSource !== "model" ||
            stageResult.confidence >= confidenceGatePolicy.threshold
          ) {
            return false;
          }

          const gateArtifact = {
            stage,
            threshold: confidenceGatePolicy.threshold,
            confidence: stageResult.confidence,
            reason: "confidence_below_threshold",
            ...(stageResult.confidenceRationale
              ? {
                  confidenceRationale: stageResult.confidenceRationale
                }
              : {})
          };
          const replayManifest = buildReplayBundleManifest({
            runId,
            workflow,
            promptEnvelopeHash,
            harnessPolicyHash,
            modelSettings,
            toolPolicies,
            replayCollector,
            policyVersion: policyVerification.policyVersion,
            policySignature: policyVerification.signature
          });
          await dependencies.persistence.storeArtifact(runId, "replay-bundle-manifest", JSON.stringify(replayManifest));
          await dependencies.persistence.storeArtifact(
            runId,
            "replay-divergence-taxonomy",
            JSON.stringify(buildReplayDivergenceTaxonomy())
          );
          await dependencies.persistence.storeArtifact(runId, "confidence-gate", JSON.stringify(gateArtifact));
          outcome = "needs_human";
          await dependencies.persistence.updateStatus(runId, "needs_human", gateArtifact, statusTransitionKey("needs_human", "confidence_gate"));
          await teardownIsolation();

          return true;
        };

        const planResult = await runSingleStage(
          "plan",
          context,
          dependencies,
          nonBlockingFindings,
          nextStageTransitionKey("plan"),
          replayCollector,
          remediationPromptSection
        );
        if (await shouldEscalateForConfidence(planResult, "plan")) {
          return {
            runId,
            status: "needs_human",
            finalOutput: {
              reason: "confidence_gate",
              stage: "plan",
              threshold: confidenceGatePolicy.threshold,
              confidence: planResult.confidence
            }
          };
        }

        const executeResult = await runSingleStage(
          "execute",
          context,
          dependencies,
          nonBlockingFindings,
          nextStageTransitionKey("execute"),
          replayCollector,
          remediationPromptSection
        );
        if (await shouldEscalateForConfidence(executeResult, "execute")) {
          return {
            runId,
            status: "needs_human",
            finalOutput: {
              reason: "confidence_gate",
              stage: "execute",
              threshold: confidenceGatePolicy.threshold,
              confidence: executeResult.confidence
            }
          };
        }

        let verifyResult = await runSingleStage(
          "verify",
          context,
          dependencies,
          nonBlockingFindings,
          nextStageTransitionKey("verify"),
          replayCollector,
          remediationPromptSection
        );
        if (await shouldEscalateForConfidence(verifyResult, "verify")) {
          return {
            runId,
            status: "needs_human",
            finalOutput: {
              reason: "confidence_gate",
              stage: "verify",
              threshold: confidenceGatePolicy.threshold,
              confidence: verifyResult.confidence
            }
          };
        }

        if (!verifyPassed(verifyResult.output)) {
          for (let fixAttempt = 0; fixAttempt < maxFixAttempts; fixAttempt += 1) {
            await dependencies.persistence.storeArtifact(
              runId,
              `verify-failure-${fixAttempt + 1}`,
              verifyResult.output
            );

            const fixResult = await runSingleStage(
              "fix",
              context,
              dependencies,
              nonBlockingFindings,
              nextStageTransitionKey("fix"),
              replayCollector,
              remediationPromptSection
            );
            if (await shouldEscalateForConfidence(fixResult, "fix")) {
              return {
                runId,
                status: "needs_human",
                finalOutput: {
                  reason: "confidence_gate",
                  stage: "fix",
                  threshold: confidenceGatePolicy.threshold,
                  confidence: fixResult.confidence
                }
              };
            }

            verifyResult = await runSingleStage(
              "verify",
              context,
              dependencies,
              nonBlockingFindings,
              nextStageTransitionKey("verify"),
              replayCollector,
              remediationPromptSection
            );
            if (await shouldEscalateForConfidence(verifyResult, "verify")) {
              return {
                runId,
                status: "needs_human",
                finalOutput: {
                  reason: "confidence_gate",
                  stage: "verify",
                  threshold: confidenceGatePolicy.threshold,
                  confidence: verifyResult.confidence
                }
              };
            }

            if (verifyPassed(verifyResult.output)) {
              break;
            }
          }
        }

        if (!verifyPassed(verifyResult.output)) {
          const replayManifest = buildReplayBundleManifest({
            runId,
            workflow,
            promptEnvelopeHash,
            harnessPolicyHash,
            modelSettings,
            toolPolicies,
            replayCollector,
            policyVersion: policyVerification.policyVersion,
            policySignature: policyVerification.signature
          });
          await dependencies.persistence.storeArtifact(runId, "replay-bundle-manifest", JSON.stringify(replayManifest));
          await dependencies.persistence.storeArtifact(
            runId,
            "replay-divergence-taxonomy",
            JSON.stringify(buildReplayDivergenceTaxonomy())
          );

          outcome = "needs_human";
          await dependencies.persistence.updateStatus(runId, "needs_human", {
            reason: "verification_failed"
          }, statusTransitionKey("needs_human", "verification_failed"));
          await teardownIsolation();

          return {
            runId,
            status: "needs_human",
            finalOutput: {
              reason: "verification_failed"
            }
          };
        }

        const postRunSummary = summarizePostRunFindings([
          {
            workflowVersion: workflow.version,
            findings: lintReport.findings
          }
        ]);

        await dependencies.persistence.storeArtifact(runId, "post-run-lint-summary", JSON.stringify(postRunSummary));
        await dependencies.persistence.storeArtifact(
          runId,
          "post-run-remediation-recommendations",
          JSON.stringify(generateRemediationRecommendations(postRunSummary))
        );
        const replayManifest = buildReplayBundleManifest({
          runId,
          workflow,
          promptEnvelopeHash,
          harnessPolicyHash,
          modelSettings,
          toolPolicies,
          replayCollector,
          policyVersion: policyVerification.policyVersion,
          policySignature: policyVerification.signature
        });
        await dependencies.persistence.storeArtifact(runId, "replay-bundle-manifest", JSON.stringify(replayManifest));
        await dependencies.persistence.storeArtifact(
          runId,
          "replay-divergence-taxonomy",
          JSON.stringify(buildReplayDivergenceTaxonomy())
        );

        await dependencies.persistence.updateStatus(runId, "completed", undefined, statusTransitionKey("completed"));
        outcome = "completed";
        await teardownIsolation();

        return {
          runId,
          status: "completed",
          finalOutput: {
            output: executeResult.output,
            verification: verifyResult.output
          }
        };
      } catch (error) {
        const err = error as Error;

        dependencies.tracer.error({
          runId,
          workflowId: workflow.id,
          message: "Workflow run failed",
          error: err
        });
        const replayManifest = buildReplayBundleManifest({
          runId,
          workflow,
          promptEnvelopeHash: "",
          harnessPolicyHash: "",
          modelSettings: { provider: "unknown" },
          toolPolicies: toolPolicySnapshot(workflow),
          replayCollector
        });
        await dependencies.persistence.storeArtifact(runId, "replay-bundle-manifest", JSON.stringify(replayManifest));
        await dependencies.persistence.storeArtifact(
          runId,
          "replay-divergence-taxonomy",
          JSON.stringify(buildReplayDivergenceTaxonomy())
        );

        await dependencies.persistence.updateStatus(runId, "failed", {
          reason: err.message
        }, statusTransitionKey("failed", "runtime_error"));
        outcome = "failed";
        await teardownIsolation();

        return {
          runId,
          status: "failed",
          finalOutput: {
            reason: err.message
          }
        };
      }
    }
  };
}

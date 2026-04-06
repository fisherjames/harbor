import { createHash, createHmac } from "node:crypto";
import type { HarnessPolicyBundle, HarnessPolicyDocument, WorkflowDefinition } from "@harbor/harness";

export const DEFAULT_HARBOR_POLICY_DOCUMENT: HarnessPolicyDocument = {
  version: "policy-v1",
  issuedAt: "2026-04-05T00:00:00.000Z",
  constraints: {
    requireNodeOwner: true,
    requireNodeBudget: true,
    requireToolPolicy: true,
    requireMemoryPolicy: true,
    allowPromptMutationsOnlyInHarness: true
  },
  runtime: {
    blockOnCriticalLint: true,
    maxFixAttempts: 1,
    requireReplayBundle: true
  }
};

export const DEFAULT_HARBOR_POLICY_BUNDLE = createWorkflowPolicyBundle(DEFAULT_HARBOR_POLICY_DOCUMENT);
export const DEFAULT_HARBOR_POLICY_SIGNATURE = DEFAULT_HARBOR_POLICY_BUNDLE.signature;

export interface CreateWorkflowPolicyBundleOptions {
  policyVersion?: string | undefined;
  signingSecret?: string | undefined;
}

export interface PolicyVerificationOptions {
  requireBundle?: boolean | undefined;
  trustedSignatures?: string[] | undefined;
  signingSecret?: string | undefined;
}

export interface PolicyVerificationResult {
  valid: boolean;
  reasons: string[];
  policyVersion?: string | undefined;
  signature?: string | undefined;
  computedChecksum?: string | undefined;
}

export interface WorkflowPolicyVerifier {
  verify(workflow: WorkflowDefinition): PolicyVerificationResult;
}

export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  const renderedEntries = entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);
  return `{${renderedEntries.join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashPayload(value: unknown): string {
  return sha256Hex(stableSerialize(value));
}

function signPayload(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function parseTrustedSignatures(value?: string): string[] {
  if (!value?.trim()) {
    return [];
  }

  const normalized = value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return [...new Set(normalized)];
}

export function createWorkflowPolicyBundle(
  document: HarnessPolicyDocument,
  options: CreateWorkflowPolicyBundleOptions = {}
): HarnessPolicyBundle {
  const canonicalDocument = stableSerialize(document);
  const checksum = sha256Hex(canonicalDocument);
  const signature = options.signingSecret ? signPayload(canonicalDocument, options.signingSecret) : checksum;

  return {
    policyVersion: options.policyVersion ?? document.version,
    algorithm: "sha256",
    checksum,
    signature,
    document: structuredClone(document)
  };
}

export function verifyWorkflowPolicyBundle(
  workflow: WorkflowDefinition,
  options: PolicyVerificationOptions = {}
): PolicyVerificationResult {
  const bundle = workflow.policyBundle;
  const reasons: string[] = [];

  if (!bundle) {
    if (options.requireBundle) {
      reasons.push("Workflow is missing policyBundle.");
    }

    return {
      valid: reasons.length === 0,
      reasons
    };
  }

  if (bundle.algorithm !== "sha256") {
    reasons.push(`Unsupported policy signature algorithm '${bundle.algorithm}'.`);
  }

  const canonicalDocument = stableSerialize(bundle.document);
  const computedChecksum = sha256Hex(canonicalDocument);
  if (bundle.checksum !== computedChecksum) {
    reasons.push("Policy checksum does not match policy document.");
  }

  if (bundle.policyVersion !== bundle.document.version) {
    reasons.push("policyBundle.policyVersion must match policyBundle.document.version.");
  }

  const expectedSignature = options.signingSecret ? signPayload(canonicalDocument, options.signingSecret) : computedChecksum;
  if (bundle.signature !== expectedSignature) {
    reasons.push("Policy signature verification failed.");
  }

  const trustedSignatures = options.trustedSignatures ?? [];
  if (trustedSignatures.length > 0 && !trustedSignatures.includes(bundle.signature)) {
    reasons.push("Policy signature is not in trusted signature allow-list.");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    policyVersion: bundle.policyVersion,
    signature: bundle.signature,
    computedChecksum
  };
}

export function createWorkflowPolicyVerifier(options: PolicyVerificationOptions = {}): WorkflowPolicyVerifier {
  return {
    verify(workflow) {
      return verifyWorkflowPolicyBundle(workflow, options);
    }
  };
}

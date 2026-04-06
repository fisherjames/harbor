import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@harbor/harness";
import {
  DEFAULT_HARBOR_POLICY_BUNDLE,
  DEFAULT_HARBOR_POLICY_DOCUMENT,
  DEFAULT_HARBOR_POLICY_SIGNATURE,
  createWorkflowPolicyBundle,
  createWorkflowPolicyVerifier,
  hashPayload,
  parseTrustedSignatures,
  sha256Hex,
  stableSerialize,
  verifyWorkflowPolicyBundle
} from "../src/index.js";

const workflowBase: WorkflowDefinition = {
  id: "wf_policy",
  name: "Policy workflow",
  version: 1,
  objective: "obj",
  systemPrompt: "You must follow constraints and return PASS or FAIL.",
  memoryPolicy: {
    retrievalMode: "monitor",
    maxContextItems: 4,
    writebackEnabled: true,
    piiRetention: "redacted"
  },
  nodes: [
    { id: "plan", type: "planner", owner: "ops", timeoutMs: 100, retryLimit: 0 },
    { id: "execute", type: "executor", owner: "ops", timeoutMs: 100, retryLimit: 0 },
    { id: "verify", type: "verifier", owner: "ops", timeoutMs: 100, retryLimit: 0 }
  ]
};

describe("policy helpers", () => {
  it("creates deterministic checksum/signature for policy bundles", () => {
    const bundle = createWorkflowPolicyBundle(DEFAULT_HARBOR_POLICY_DOCUMENT);
    const canonical = stableSerialize(DEFAULT_HARBOR_POLICY_DOCUMENT);
    const checksum = sha256Hex(canonical);

    expect(bundle.algorithm).toBe("sha256");
    expect(bundle.checksum).toBe(checksum);
    expect(bundle.signature).toBe(checksum);
    expect(bundle.policyVersion).toBe(DEFAULT_HARBOR_POLICY_DOCUMENT.version);
    expect(hashPayload(bundle.document)).toBe(checksum);
    expect(DEFAULT_HARBOR_POLICY_BUNDLE.signature).toBe(DEFAULT_HARBOR_POLICY_SIGNATURE);
    expect(DEFAULT_HARBOR_POLICY_BUNDLE.checksum).toBe(checksum);
  });

  it("parses trusted signatures from comma/newline env strings", () => {
    const signatures = parseTrustedSignatures("sig-a, sig-b\nsig-a\n");

    expect(signatures).toEqual(["sig-a", "sig-b"]);
    expect(parseTrustedSignatures("   ")).toEqual([]);
    expect(parseTrustedSignatures(undefined)).toEqual([]);
  });

  it("verifies valid bundles and supports verifier wrapper", () => {
    const bundle = createWorkflowPolicyBundle(DEFAULT_HARBOR_POLICY_DOCUMENT);
    const workflow: WorkflowDefinition = {
      ...workflowBase,
      policyBundle: bundle
    };

    const direct = verifyWorkflowPolicyBundle(workflow, {
      requireBundle: true,
      trustedSignatures: [bundle.signature]
    });
    const wrapped = createWorkflowPolicyVerifier({
      requireBundle: true,
      trustedSignatures: [bundle.signature]
    }).verify(workflow);

    expect(direct.valid).toBe(true);
    expect(wrapped.valid).toBe(true);
    expect(direct.policyVersion).toBe(bundle.policyVersion);
    expect(direct.signature).toBe(bundle.signature);
    expect(direct.computedChecksum).toBe(bundle.checksum);
  });

  it("flags missing bundle when requireBundle is enabled", () => {
    const result = verifyWorkflowPolicyBundle(workflowBase, { requireBundle: true });

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(["Workflow is missing policyBundle."]);
  });

  it("flags unsupported algorithms, version mismatch, and checksum mismatch", () => {
    const bundle = createWorkflowPolicyBundle(DEFAULT_HARBOR_POLICY_DOCUMENT);
    const result = verifyWorkflowPolicyBundle(
      {
        ...workflowBase,
        policyBundle: {
          ...bundle,
          algorithm: "sha256x" as "sha256",
          policyVersion: "mismatch",
          checksum: "0".repeat(64)
        }
      },
      { requireBundle: true }
    );

    expect(result.valid).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("Unsupported policy signature algorithm"))).toBe(true);
    expect(result.reasons).toContain("policyBundle.policyVersion must match policyBundle.document.version.");
    expect(result.reasons).toContain("Policy checksum does not match policy document.");
  });

  it("flags signature mismatch when signing secret is configured", () => {
    const signedBundle = createWorkflowPolicyBundle(DEFAULT_HARBOR_POLICY_DOCUMENT, {
      signingSecret: "secret-v1"
    });
    const unsignedBundle = createWorkflowPolicyBundle(DEFAULT_HARBOR_POLICY_DOCUMENT);
    const workflow: WorkflowDefinition = {
      ...workflowBase,
      policyBundle: {
        ...signedBundle,
        signature: unsignedBundle.signature
      }
    };

    const result = verifyWorkflowPolicyBundle(workflow, {
      requireBundle: true,
      signingSecret: "secret-v1"
    });

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("Policy signature verification failed.");
  });

  it("flags untrusted signatures when allow-list is configured", () => {
    const bundle = createWorkflowPolicyBundle(DEFAULT_HARBOR_POLICY_DOCUMENT);
    const workflow: WorkflowDefinition = {
      ...workflowBase,
      policyBundle: bundle
    };

    const result = verifyWorkflowPolicyBundle(workflow, {
      requireBundle: true,
      trustedSignatures: ["different-signature"]
    });

    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("Policy signature is not in trusted signature allow-list.");
  });
});

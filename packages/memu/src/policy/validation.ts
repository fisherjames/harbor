import { z } from "zod";
import type { MemoryPolicy } from "../types.js";

const memoryPolicySchema = z.object({
  retrievalMode: z.enum(["monitor", "reason"]),
  maxContextItems: z.number().int().min(1).max(200),
  writebackEnabled: z.boolean(),
  piiRetention: z.enum(["forbidden", "redacted", "allowed"])
});

export interface MemoryPolicyValidation {
  valid: boolean;
  errors: string[];
}

export function validateMemoryPolicy(policy: MemoryPolicy): MemoryPolicyValidation {
  const result = memoryPolicySchema.safeParse(policy);

  if (result.success) {
    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
  };
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  retrievalMode: "monitor",
  maxContextItems: 8,
  writebackEnabled: true,
  piiRetention: "redacted"
};

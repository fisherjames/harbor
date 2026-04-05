import type { ModelInvocation, ModelInvocationResult, ModelProvider } from "../contracts/runtime.js";

export class EchoModelProvider implements ModelProvider {
  async generate(input: ModelInvocation): Promise<ModelInvocationResult> {
    const started = Date.now();

    const content =
      input.stage === "verify"
        ? "PASS: verification checks satisfied"
        : `Stage ${input.stage} complete for workflow ${input.context.workflow.id}`;

    return {
      output: content,
      latencyMs: Date.now() - started,
      tokenUsage: {
        inputTokens: Math.max(1, Math.ceil(input.prompt.length / 4)),
        outputTokens: Math.max(1, Math.ceil(content.length / 4)),
        totalTokens: Math.max(2, Math.ceil((input.prompt.length + content.length) / 4))
      }
    };
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EchoModelProvider,
  OpenAIChatModelProvider,
  createModelProviderFromEnv
} from "../src/index.js";
import type { ModelInvocation } from "../src/contracts/runtime.js";

function createInvocation(stage: ModelInvocation["stage"] = "plan"): ModelInvocation {
  return {
    stage,
    prompt: `run ${stage}`,
    context: {
      runId: "run_1",
      request: {
        tenantId: "tenant_1",
        workspaceId: "workspace_1",
        workflowId: "wf_1",
        trigger: "manual",
        input: {},
        actorId: "actor_1"
      },
      workflow: {
        id: "wf_1",
        name: "Workflow",
        version: 1,
        objective: "objective",
        systemPrompt: "system",
        nodes: []
      }
    }
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("EchoModelProvider", () => {
  it("describes deterministic echo model settings", () => {
    const model = new EchoModelProvider();
    const description = model.describe();

    expect(description.provider).toBe("echo");
    expect(description.model).toBe("echo-v1");
    expect(description.deterministic).toBe(true);
  });

  it("returns verification pass content for verify stage", async () => {
    const model = new EchoModelProvider();
    const result = await model.generate(createInvocation("verify"));

    expect(result.output).toContain("PASS");
    expect(result.tokenUsage?.totalTokens).toBeGreaterThan(0);
  });

  it("returns stage-aware output for non-verify stages", async () => {
    const model = new EchoModelProvider();
    const result = await model.generate(createInvocation("plan"));

    expect(result.output).toContain("Stage plan complete");
  });
});

describe("OpenAIChatModelProvider", () => {
  it("throws when api key is missing", () => {
    expect(() => new OpenAIChatModelProvider({ apiKey: "   " })).toThrow(
      "OpenAIChatModelProviderOptions.apiKey is required."
    );
  });

  it("describes configured provider settings", () => {
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      model: "gpt-test",
      baseUrl: "https://api.example.test/v1",
      temperature: 0
    });

    expect(model.describe()).toEqual({
      provider: "openai",
      model: "gpt-test",
      endpoint: "https://api.example.test",
      temperature: 0,
      deterministic: true
    });
  });

  it("generates output and token usage from string content", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "structured output" } }],
          usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
        }),
        { status: 200 }
      )
    );

    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      model: "gpt-test",
      fetchImpl,
      retries: 0,
      timeoutMs: 500
    });

    const result = await model.generate(createInvocation("execute"));
    expect(result.output).toBe("structured output");
    expect(result.tokenUsage).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fills missing usage token fields with zeros", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "usage fallback" } }],
          usage: { prompt_tokens: 3, completion_tokens: 8 }
        }),
        { status: 200 }
      )
    );

    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 0,
      timeoutMs: 500
    });

    const result = await model.generate(createInvocation("execute"));
    expect(result.tokenUsage).toEqual({
      inputTokens: 3,
      outputTokens: 8,
      totalTokens: 0
    });
  });

  it("fills missing prompt/completion usage fields with zeros", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "usage prompt completion fallback" } }],
          usage: { total_tokens: 9 }
        }),
        { status: 200 }
      )
    );

    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 0,
      timeoutMs: 500
    });

    const result = await model.generate(createInvocation("execute"));
    expect(result.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 9
    });
  });

  it("supports array-style content blocks", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  "unexpected",
                  { type: "text", text: "line 1" },
                  { type: "text", text: { value: "line 2" } },
                  { type: "text", text: { value: 7 } },
                  { type: "output_text", text: "ignored" },
                  { type: "text", text: 42 }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      )
    );

    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 0,
      timeoutMs: 500
    });

    const result = await model.generate(createInvocation("plan"));
    expect(result.output).toBe("line 1\nline 2");
    expect(result.tokenUsage).toBeUndefined();
  });

  it("retries once on 500 and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok after retry" } }]
          }),
          { status: 200 }
        )
      );

    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 1,
      retryJitterMs: 0,
      timeoutMs: 500
    });

    const result = await model.generate(createInvocation("verify"));
    expect(result.output).toBe("ok after retry");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on network type errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "network recovered" } }]
          }),
          { status: 200 }
        )
      );

    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 1,
      retryJitterMs: 0,
      timeoutMs: 500
    });

    const result = await model.generate(createInvocation("execute"));
    expect(result.output).toBe("network recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on abort errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("aborted", "AbortError"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "abort recovered" } }]
          }),
          { status: 200 }
        )
      );

    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 1,
      retryJitterMs: 0,
      timeoutMs: 500
    });

    const result = await model.generate(createInvocation("execute"));
    expect(result.output).toBe("abort recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 400 }));
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 2,
      timeoutMs: 500
    });

    await expect(model.generate(createInvocation("plan"))).rejects.toThrow("OpenAI request failed (400)");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses default unknown error text when upstream body is empty", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 0,
      timeoutMs: 500
    });

    await expect(model.generate(createInvocation("plan"))).rejects.toThrow("OpenAI request failed (429): unknown error");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry unknown non-retryable thrown errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("unexpected");
    });
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 2,
      timeoutMs: 500
    });

    await expect(model.generate(createInvocation("plan"))).rejects.toThrow("unexpected");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails when response JSON is invalid", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 1,
      timeoutMs: 500
    });

    await expect(model.generate(createInvocation("plan"))).rejects.toThrow("OpenAI response is not valid JSON.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails when response payload has no choices", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 0,
      timeoutMs: 500
    });

    await expect(model.generate(createInvocation("plan"))).rejects.toThrow("OpenAI response is missing choices.");
  });

  it("fails when response payload is not an object", async () => {
    const fetchImpl = vi.fn(async () => new Response("null", { status: 200 }));
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 0,
      timeoutMs: 500
    });

    await expect(model.generate(createInvocation("plan"))).rejects.toThrow("OpenAI response payload is not an object.");
  });

  it("fails when model output is empty after normalization", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: [{ type: "output_text", text: "ignored" }] } }]
        }),
        { status: 200 }
      )
    );
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 0,
      timeoutMs: 500
    });

    await expect(model.generate(createInvocation("plan"))).rejects.toThrow("OpenAI response returned empty model output.");
  });

  it("fails when content is not string or array", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: { value: "unexpected-object" } } }]
        }),
        { status: 200 }
      )
    );
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 0,
      timeoutMs: 500
    });

    await expect(model.generate(createInvocation("plan"))).rejects.toThrow("OpenAI response returned empty model output.");
  });

  it("exhausts retries on repeated server failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("server error", { status: 503 }));
    const model = new OpenAIChatModelProvider({
      apiKey: "key",
      fetchImpl,
      retries: 2,
      retryJitterMs: 0,
      timeoutMs: 500
    });

    await expect(model.generate(createInvocation("execute"))).rejects.toThrow("OpenAI request failed (503)");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("createModelProviderFromEnv", () => {
  it("reads from process.env when env override is omitted", () => {
    vi.stubEnv("HARBOR_MODEL_PROVIDER", "");
    vi.stubEnv("OPENAI_API_KEY", "");

    const provider = createModelProviderFromEnv();
    expect(provider).toBeInstanceOf(EchoModelProvider);
  });

  it("defaults to echo provider", () => {
    const provider = createModelProviderFromEnv({ env: {} });
    expect(provider).toBeInstanceOf(EchoModelProvider);
  });

  it("falls back to echo when openai provider has no key", () => {
    const provider = createModelProviderFromEnv({
      env: {
        HARBOR_MODEL_PROVIDER: "openai"
      }
    });

    expect(provider).toBeInstanceOf(EchoModelProvider);
  });

  it("uses openai provider when configured", () => {
    const provider = createModelProviderFromEnv({
      env: {
        HARBOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "key",
        HARBOR_OPENAI_MODEL: "gpt-custom",
        HARBOR_OPENAI_BASE_URL: "https://api.example.test/v1",
        HARBOR_OPENAI_TIMEOUT_MS: "3333",
        HARBOR_OPENAI_RETRIES: "3",
        HARBOR_OPENAI_RETRY_JITTER_MS: "77",
        HARBOR_OPENAI_TEMPERATURE: "0.4"
      }
    });

    expect(provider).toBeInstanceOf(OpenAIChatModelProvider);
    expect(provider.describe?.()).toMatchObject({
      provider: "openai",
      model: "gpt-custom",
      endpoint: "https://api.example.test",
      temperature: 0.4
    });
  });

  it("normalizes invalid numeric env values", () => {
    const nonFinite = createModelProviderFromEnv({
      env: {
        HARBOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "key",
        HARBOR_OPENAI_TIMEOUT_MS: "not-a-number",
        HARBOR_OPENAI_RETRIES: "-1",
        HARBOR_OPENAI_RETRY_JITTER_MS: "-2",
        HARBOR_OPENAI_TEMPERATURE: "NaN"
      }
    });

    expect(nonFinite).toBeInstanceOf(OpenAIChatModelProvider);
    expect(nonFinite.describe?.()).toMatchObject({
      temperature: 0.2
    });
  });

  it("clamps out-of-range temperatures", () => {
    const belowRange = createModelProviderFromEnv({
      env: {
        HARBOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "key",
        HARBOR_OPENAI_TEMPERATURE: "-5"
      }
    });

    const aboveRange = createModelProviderFromEnv({
      env: {
        HARBOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "key",
        HARBOR_OPENAI_TEMPERATURE: "9"
      }
    });

    expect(belowRange.describe?.()).toMatchObject({
      temperature: 0
    });
    expect(aboveRange.describe?.()).toMatchObject({
      temperature: 2
    });
  });

  it("uses default temperature when unset and applies explicit fetch override", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "override fetch" } }]
        }),
        { status: 200 }
      )
    );

    const provider = createModelProviderFromEnv({
      env: {
        HARBOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "key",
        HARBOR_OPENAI_TIMEOUT_MS: "",
        HARBOR_OPENAI_RETRIES: "",
        HARBOR_OPENAI_RETRY_JITTER_MS: ""
      },
      fetchImpl
    });

    expect(provider.describe?.()).toMatchObject({
      temperature: 0.2
    });

    await expect(provider.generate(createInvocation("execute"))).resolves.toMatchObject({
      output: "override fetch"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats unknown provider values as echo", () => {
    const provider = createModelProviderFromEnv({
      env: {
        HARBOR_MODEL_PROVIDER: "other",
        OPENAI_API_KEY: "key"
      }
    });

    expect(provider).toBeInstanceOf(EchoModelProvider);
  });
});

import type { ModelInvocation, ModelInvocationResult, ModelProvider } from "../contracts/runtime.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_OPENAI_TIMEOUT_MS = 20_000;
const DEFAULT_OPENAI_RETRIES = 2;
const DEFAULT_OPENAI_RETRY_JITTER_MS = 120;
const DEFAULT_OPENAI_TEMPERATURE = 0.2;

type OpenAIChatRole = "system" | "user";

interface OpenAIChatMessage {
  role: OpenAIChatRole;
  content: string;
}

interface OpenAIChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIChatCompletionMessage {
  content?: unknown;
}

interface OpenAIChatCompletionChoice {
  message?: OpenAIChatCompletionMessage;
}

interface OpenAIChatCompletionResponse {
  choices?: OpenAIChatCompletionChoice[];
  usage?: OpenAIChatCompletionUsage;
}

interface RetryableError extends Error {
  retryable: boolean;
}

export interface OpenAIChatModelProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryJitterMs?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

export interface CreateModelProviderFromEnvOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

function createRetryableError(message: string, retryable: boolean): RetryableError {
  const error = new Error(message) as RetryableError;
  error.retryable = retryable;
  return error;
}

function shouldRetry(error: unknown): boolean {
  if (error && typeof error === "object" && "retryable" in error) {
    return Boolean((error as { retryable?: unknown }).retryable);
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return false;
}

function normalizeOpenAITextPart(part: unknown): string {
  if (!part || typeof part !== "object") {
    return "";
  }

  const record = part as { type?: unknown; text?: unknown };
  if (record.type !== "text") {
    return "";
  }

  if (typeof record.text === "string") {
    return record.text;
  }

  if (record.text && typeof record.text === "object" && "value" in record.text) {
    const value = (record.text as { value?: unknown }).value;
    return typeof value === "string" ? value : "";
  }

  return "";
}

function normalizeOpenAIMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const combined = content.map((part) => normalizeOpenAITextPart(part)).filter((part) => part.length > 0).join("\n");
  return combined.trim();
}

function parseOpenAIResponse(payload: unknown): OpenAIChatCompletionResponse {
  if (!payload || typeof payload !== "object") {
    throw createRetryableError("OpenAI response payload is not an object.", false);
  }

  const response = payload as OpenAIChatCompletionResponse;
  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw createRetryableError("OpenAI response is missing choices.", false);
  }

  return response;
}

function parsePositiveInteger(raw: string | undefined, fallback: number, minimum: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }

  return parsed;
}

function parseTemperature(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (parsed < 0) {
    return 0;
  }

  if (parsed > 2) {
    return 2;
  }

  return parsed;
}

function normalizeProvider(raw: string | undefined): "echo" | "openai" {
  return raw?.trim().toLowerCase() === "openai" ? "openai" : "echo";
}

export class EchoModelProvider implements ModelProvider {
  describe(): Record<string, unknown> {
    return {
      provider: "echo",
      model: "echo-v1",
      deterministic: true
    };
  }

  async generate(input: ModelInvocation): Promise<ModelInvocationResult> {
    const started = Date.now();

    const content =
      input.stage === "verify"
        ? "PASS: verification checks satisfied"
        : `Stage ${input.stage} complete for workflow ${input.context.workflow.id}`;

    return {
      output: content,
      latencyMs: Date.now() - started,
      confidence: input.stage === "verify" ? 0.96 : 0.84,
      ...(input.stage === "verify"
        ? {
            confidenceRationale: "Verification stage follows deterministic PASS/FAIL output pattern."
          }
        : {}),
      tokenUsage: {
        inputTokens: Math.max(1, Math.ceil(input.prompt.length / 4)),
        outputTokens: Math.max(1, Math.ceil(content.length / 4)),
        totalTokens: Math.max(2, Math.ceil((input.prompt.length + content.length) / 4))
      }
    };
  }
}

export class OpenAIChatModelProvider implements ModelProvider {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryJitterMs: number;

  private readonly model: string;
  private readonly temperature: number;

  constructor(private readonly options: OpenAIChatModelProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("OpenAIChatModelProviderOptions.apiKey is required.");
    }

    const baseUrl = options.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
    this.endpoint = new URL("/chat/completions", baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_OPENAI_RETRIES;
    this.retryJitterMs = options.retryJitterMs ?? DEFAULT_OPENAI_RETRY_JITTER_MS;
    this.model = options.model?.trim() || DEFAULT_OPENAI_MODEL;
    this.temperature = options.temperature ?? DEFAULT_OPENAI_TEMPERATURE;
  }

  describe(): Record<string, unknown> {
    return {
      provider: "openai",
      model: this.model,
      endpoint: this.endpoint.origin,
      temperature: this.temperature,
      deterministic: this.temperature === 0
    };
  }

  async generate(input: ModelInvocation): Promise<ModelInvocationResult> {
    const started = Date.now();

    const response = await this.request({
      model: this.model,
      temperature: this.temperature,
      messages: this.messagesForInput(input)
    });

    const choice = response.choices?.[0];
    const output = normalizeOpenAIMessageContent(choice?.message?.content);
    if (!output) {
      throw createRetryableError("OpenAI response returned empty model output.", false);
    }

    const usage = response.usage;
    const tokenUsage = usage
      ? {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0
        }
      : undefined;

    return {
      output,
      latencyMs: Date.now() - started,
      ...(tokenUsage ? { tokenUsage } : {})
    };
  }

  private messagesForInput(input: ModelInvocation): OpenAIChatMessage[] {
    return [
      {
        role: "system",
        content:
          "You are the Harbor runtime stage executor. Follow harness constraints, preserve intent, and return concise actionable output."
      },
      {
        role: "user",
        content: input.prompt
      }
    ];
  }

  private async request(payload: {
    model: string;
    temperature: number;
    messages: OpenAIChatMessage[];
  }): Promise<OpenAIChatCompletionResponse> {
    let lastError: unknown = createRetryableError("OpenAI request failed after retries.", true);

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          const retryable = response.status === 429 || response.status >= 500;
          throw createRetryableError(
            `OpenAI request failed (${response.status}): ${errorText || "unknown error"}`,
            retryable
          );
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw createRetryableError("OpenAI response is not valid JSON.", false);
        }

        return parseOpenAIResponse(body);
      } catch (error) {
        lastError = error;
        const retryable = shouldRetry(error);
        if (!retryable || attempt >= this.retries) {
          throw error;
        }

        await this.backoff(attempt);
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw lastError;
  }

  private async backoff(attempt: number): Promise<void> {
    const baseDelay = 2 ** attempt * 120;
    const jitter = Math.floor(Math.random() * this.retryJitterMs);
    const delayMs = baseDelay + jitter;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export function createModelProviderFromEnv(options: CreateModelProviderFromEnvOptions = {}): ModelProvider {
  const env = options.env ?? process.env;
  const provider = normalizeProvider(env.HARBOR_MODEL_PROVIDER);

  if (provider !== "openai") {
    return new EchoModelProvider();
  }

  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return new EchoModelProvider();
  }

  const configuredModel = env.HARBOR_OPENAI_MODEL?.trim();
  const configuredBaseUrl = env.HARBOR_OPENAI_BASE_URL?.trim();

  return new OpenAIChatModelProvider({
    apiKey,
    model: configuredModel && configuredModel.length > 0 ? configuredModel : DEFAULT_OPENAI_MODEL,
    baseUrl: configuredBaseUrl && configuredBaseUrl.length > 0 ? configuredBaseUrl : DEFAULT_OPENAI_BASE_URL,
    timeoutMs: parsePositiveInteger(env.HARBOR_OPENAI_TIMEOUT_MS, DEFAULT_OPENAI_TIMEOUT_MS, 100),
    retries: parsePositiveInteger(env.HARBOR_OPENAI_RETRIES, DEFAULT_OPENAI_RETRIES, 0),
    retryJitterMs: parsePositiveInteger(env.HARBOR_OPENAI_RETRY_JITTER_MS, DEFAULT_OPENAI_RETRY_JITTER_MS, 0),
    temperature: parseTemperature(env.HARBOR_OPENAI_TEMPERATURE, DEFAULT_OPENAI_TEMPERATURE),
    ...(options.fetchImpl
      ? {
          fetchImpl: options.fetchImpl
        }
      : {})
  });
}

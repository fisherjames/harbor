import crypto from "node:crypto";
import { z } from "zod";
import type {
  MemuClient,
  MemuClientOptions,
  MemuContextRequest,
  MemuContextResponse,
  MemuHealthcheck,
  MemuWriteInput,
  MemuWriteResult
} from "../types.js";

const contextResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      relevance: z.number(),
      source: z.string().optional()
    })
  ),
  compressedPrompt: z.string().optional()
});

const writeResultSchema = z.object({
  memoryId: z.string()
});

const healthcheckSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number()
});

export class HttpMemuClient implements MemuClient {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly retryJitterMs: number;
  private readonly userAgent: string;

  constructor(private readonly options: MemuClientOptions) {
    if (!options.endpoint.trim()) {
      throw new Error("MemuClientOptions.endpoint is required.");
    }

    this.endpoint = new URL(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.retryJitterMs = options.retryJitterMs ?? 150;
    this.userAgent = options.userAgent ?? "harbor-memu-client/0.1.0";
  }

  async readContext(request: MemuContextRequest): Promise<MemuContextResponse> {
    const response = await this.request("/v1/context/read", "POST", request);
    return contextResponseSchema.parse(response);
  }

  async writeMemory(input: MemuWriteInput): Promise<MemuWriteResult> {
    const response = await this.request("/v1/memory/write", "POST", input);
    return writeResultSchema.parse(response);
  }

  async healthcheck(): Promise<MemuHealthcheck> {
    const response = await this.request("/v1/health", "GET");
    return healthcheckSchema.parse(response);
  }

  private async request(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    const requestUrl = new URL(path, this.endpoint);
    const payload = body ? JSON.stringify(body) : "";
    const headers = this.createHeaders(payload);

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(requestUrl, {
          method,
          headers,
          body: payload || null,
          signal: controller.signal
        });

        if (!response.ok) {
          const text = await response.text();
          if (response.status >= 500 && attempt < this.retries) {
            await this.backoff(attempt);
            continue;
          }

          throw new Error(`memU request failed (${response.status}): ${text || "unknown error"}`);
        }

        if (response.status === 204) {
          return {};
        }

        return await response.json();
      } catch (error) {
        if (attempt >= this.retries) {
          throw error;
        }
        await this.backoff(attempt);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error("memU request failed after retries");
  }

  private createHeaders(payload: string): Record<string, string> {
    const timestamp = new Date().toISOString();

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-harbor-timestamp": timestamp,
      "user-agent": this.userAgent
    };

    if (this.options.apiKey) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }

    if (this.options.signingSecret) {
      headers["x-harbor-signature"] = this.signPayload(payload, timestamp, this.options.signingSecret);
    }

    return headers;
  }

  private signPayload(payload: string, timestamp: string, secret: string): string {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(`${timestamp}.${payload}`);
    return hmac.digest("hex");
  }

  private async backoff(attempt: number): Promise<void> {
    const baseDelay = 2 ** attempt * 120;
    const jitter = Math.floor(Math.random() * this.retryJitterMs);
    const delayMs = baseDelay + jitter;

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

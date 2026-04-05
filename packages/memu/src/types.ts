export type MemuMode = "monitor" | "reason";

export interface MemuContextRequest {
  tenantId: string;
  workspaceId: string;
  agentId: string;
  runId?: string;
  query: string;
  mode?: MemuMode;
  maxItems?: number;
}

export interface MemuContextItem {
  id: string;
  title: string;
  content: string;
  relevance: number;
  source?: string | undefined;
}

export interface MemuContextResponse {
  items: MemuContextItem[];
  compressedPrompt?: string | undefined;
}

export interface MemuWriteInput {
  tenantId: string;
  workspaceId: string;
  agentId: string;
  category: string;
  path: string;
  content: string;
  links?: string[];
  metadata?: Record<string, string | number | boolean | null>;
}

export interface MemuWriteResult {
  memoryId: string;
}

export interface MemuHealthcheck {
  ok: boolean;
  latencyMs: number;
}

export interface MemoryPolicy {
  retrievalMode: MemuMode;
  maxContextItems: number;
  writebackEnabled: boolean;
  piiRetention: "forbidden" | "redacted" | "allowed";
}

export interface MemuClient {
  readContext(request: MemuContextRequest): Promise<MemuContextResponse>;
  writeMemory(input: MemuWriteInput): Promise<MemuWriteResult>;
  healthcheck(): Promise<MemuHealthcheck>;
}

export interface MemuClientOptions {
  endpoint: string;
  apiKey?: string | undefined;
  signingSecret?: string | undefined;
  timeoutMs?: number | undefined;
  retries?: number | undefined;
  retryJitterMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  userAgent?: string | undefined;
}

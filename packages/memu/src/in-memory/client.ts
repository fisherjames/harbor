import { randomUUID } from "node:crypto";
import type {
  MemuClient,
  MemuContextRequest,
  MemuContextResponse,
  MemuHealthcheck,
  MemuTrustMetadata,
  MemuWriteInput,
  MemuWriteResult
} from "../types.js";

interface StoredMemory {
  id: string;
  tenantId: string;
  workspaceId: string;
  agentId: string;
  category: string;
  path: string;
  content: string;
  trust: MemuTrustMetadata;
}

function defaultTrust(): MemuTrustMetadata {
  return {
    source: "in-memory",
    confidence: 0.75
  };
}

function parseTrustMetadata(metadata: MemuWriteInput["metadata"]): MemuTrustMetadata {
  const base = defaultTrust();

  if (!metadata) {
    return base;
  }

  const rawSource = metadata["trustSource"];
  const rawConfidence = metadata["trustConfidence"];
  const rawLastValidatedAt = metadata["lastValidatedAt"];

  const source = typeof rawSource === "string" && rawSource.trim().length > 0 ? rawSource : base.source;
  const confidence =
    typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, Number(rawConfidence.toFixed(4))))
      : base.confidence;
  const lastValidatedAt =
    typeof rawLastValidatedAt === "string" && rawLastValidatedAt.trim().length > 0 ? rawLastValidatedAt : undefined;

  return {
    source,
    confidence,
    ...(lastValidatedAt ? { lastValidatedAt } : {})
  };
}

export class InMemoryMemuClient implements MemuClient {
  private readonly entries: StoredMemory[] = [];

  async readContext(request: MemuContextRequest): Promise<MemuContextResponse> {
    const query = request.query.toLowerCase();
    const maxItems = request.maxItems ?? 8;

    const items = this.entries
      .filter(
        (entry) =>
          entry.tenantId === request.tenantId &&
          entry.workspaceId === request.workspaceId &&
          entry.agentId === request.agentId &&
          (entry.content.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query))
      )
      .slice(0, maxItems)
      .map((entry) => ({
        id: entry.id,
        title: `${entry.category}:${entry.path}`,
        content: entry.content,
        relevance: 0.75,
        source: "in-memory",
        trust: entry.trust
      }));

    return {
      items,
      ...(items.length > 0
        ? {
            compressedPrompt: items
              .map((item) => `- ${item.title}: ${item.content}`)
              .join("\n")
          }
        : {})
    };
  }

  async writeMemory(input: MemuWriteInput): Promise<MemuWriteResult> {
    const id = `mem_${randomUUID()}`;

    this.entries.push({
      id,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      category: input.category,
      path: input.path,
      content: input.content,
      trust: parseTrustMetadata(input.metadata)
    });

    return {
      memoryId: id
    };
  }

  async healthcheck(): Promise<MemuHealthcheck> {
    return {
      ok: true,
      latencyMs: 1
    };
  }
}

export function createInMemoryMemuClient(): MemuClient {
  return new InMemoryMemuClient();
}

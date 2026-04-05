export type {
  MemuMode,
  MemuContextRequest,
  MemuContextItem,
  MemuContextResponse,
  MemuWriteInput,
  MemuWriteResult,
  MemuHealthcheck,
  MemuClient,
  MemuClientOptions,
  MemoryPolicy
} from "./types.js";
export { validateMemoryPolicy, DEFAULT_MEMORY_POLICY } from "./policy/validation.js";
export { HttpMemuClient } from "./http/client.js";
export { InMemoryMemuClient, createInMemoryMemuClient } from "./in-memory/client.js";

import type { MemuClient, MemuClientOptions } from "./types.js";
import { HttpMemuClient } from "./http/client.js";

export function createMemuClient(options: MemuClientOptions): MemuClient {
  return new HttpMemuClient(options);
}

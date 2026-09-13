import { buildPiSearchBackendCacheKey, createPiSearchBackend } from "./adapters/create";
import type { PiSearchBackend } from "./contract/interface";
import type { PiSearchExtensionConfig } from "../config";

export type PiSearchBackendCacheKeyBuilder = (
  cwd: string,
  config: PiSearchExtensionConfig,
) => string;

export type PiSearchBackendFactory = (
  cwd: string,
  config: PiSearchExtensionConfig,
) => PiSearchBackend;

export type PiSearchBackendRuntimeOptions = {
  buildCacheKey?: PiSearchBackendCacheKeyBuilder;
  createBackend?: PiSearchBackendFactory;
};

export class PiSearchBackendRuntime {
  private readonly backendByKey = new Map<string, PiSearchBackend>();
  private readonly buildCacheKey: PiSearchBackendCacheKeyBuilder;
  private readonly createBackend: PiSearchBackendFactory;

  constructor(
    private readonly config: PiSearchExtensionConfig,
    options: PiSearchBackendRuntimeOptions = {},
  ) {
    this.buildCacheKey = options.buildCacheKey ?? buildPiSearchBackendCacheKey;
    this.createBackend = options.createBackend ?? createPiSearchBackend;
  }

  getBackend(cwd: string): PiSearchBackend {
    const key = this.buildCacheKey(cwd, this.config);
    let backend = this.backendByKey.get(key);
    if (!backend) {
      backend = this.createBackend(cwd, this.config);
      this.backendByKey.set(key, backend);
    }
    return backend;
  }

  dispose(): void {
    for (const backend of this.backendByKey.values()) {
      void backend.close?.();
    }
    this.backendByKey.clear();
  }
}

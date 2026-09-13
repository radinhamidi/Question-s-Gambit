import { resolve } from "node:path";
import type { PiSearchBackend } from "../contract/interface";
import type { PiSearchExtensionConfig } from "../../config";
import { HttpJsonSearchBackend } from "./http_json/adapter";
import { MockSearchBackend } from "./mock/adapter";

export function buildPiSearchBackendCacheKey(cwd: string, config: PiSearchExtensionConfig): string {
  if (config.backend.kind === "mock") {
    return `mock:${JSON.stringify(config.backend.documents)}`;
  }
  if (config.backend.kind === "http-json") {
    return `http-json:${config.backend.endpoints.searchUrl}:${config.backend.endpoints.readDocumentUrl}`;
  }
  if (config.backend.transport.kind === "tcp") {
    return `anserini-bm25:tcp:${config.backend.transport.host}:${config.backend.transport.port}`;
  }
  return `anserini-bm25:stdio:${resolve(cwd, config.backend.transport.indexPath)}`;
}

export function createPiSearchBackend(
  _cwd: string,
  config: PiSearchExtensionConfig,
): PiSearchBackend {
  if (config.backend.kind === "mock") {
    return new MockSearchBackend(config.backend.documents);
  }
  if (config.backend.kind === "http-json") {
    return new HttpJsonSearchBackend(config.backend);
  }
  throw new Error(
    "Anserini BM25 backend creation now requires caller-owned transport integration. Inject a repo-local backend factory from the caller instead of constructing BM25 runtime details inside pi-search.",
  );
}

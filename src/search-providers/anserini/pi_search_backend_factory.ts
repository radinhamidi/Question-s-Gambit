import { resolve } from "node:path";
import { Bm25StdioRpcClient } from "./bm25_stdio_rpc_client";
import { Bm25TcpRpcClient } from "./bm25_tcp_rpc_client";
import type { PiSearchExtensionConfig } from "../../pi-search/config";
import type { PiSearchBackend } from "../../pi-search/searcher/contract/interface";
import { createPiSearchBackend } from "../../pi-search/searcher/adapters/create";
import { AnseriniBm25Backend } from "../../pi-search/searcher/adapters/anserini_bm25/adapter";
import type { AnseriniBm25HelperTransport } from "../../pi-search/searcher/adapters/anserini_bm25/helper_transport";

function createAnseriniBm25Helper(
  cwd: string,
  config: PiSearchExtensionConfig,
): AnseriniBm25HelperTransport {
  if (config.backend.kind !== "anserini-bm25") {
    throw new Error(`Unsupported pi-search backend kind: ${String(config.backend.kind)}`);
  }
  if (config.backend.transport.kind === "tcp") {
    return new Bm25TcpRpcClient({
      host: config.backend.transport.host,
      port: config.backend.transport.port,
    });
  }
  return new Bm25StdioRpcClient({
    cwd,
    indexPath: resolve(cwd, config.backend.transport.indexPath),
    env: process.env,
  });
}

export function createRepoPiSearchBackend(
  cwd: string,
  config: PiSearchExtensionConfig,
): PiSearchBackend {
  if (config.backend.kind !== "anserini-bm25") {
    return createPiSearchBackend(cwd, config);
  }
  return new AnseriniBm25Backend(createAnseriniBm25Helper(cwd, config));
}

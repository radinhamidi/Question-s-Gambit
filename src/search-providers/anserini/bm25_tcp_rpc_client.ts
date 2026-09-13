import { connect } from "node:net";
import { attachJsonlLineReader, serializeJsonLine } from "../../runtime/jsonl";
import {
  createBm25RequestAbortError,
  parseBm25HelperResponse,
  resolveBm25HelperResponse,
  type Bm25RpcClient,
} from "./bm25_rpc_client";

export type Bm25TcpRpcClientOptions = {
  host: string;
  port: number;
};

export class Bm25TcpRpcClient implements Bm25RpcClient {
  private readonly host: string;
  private readonly port: number;
  private nextRequestId = 1;

  constructor(options: Bm25TcpRpcClientOptions) {
    this.host = options.host;
    this.port = options.port;
  }

  async request(
    commandType: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw createBm25RequestAbortError(commandType, "before dispatch");
    }
    const id = this.nextRequestId++;
    return await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let settled = false;
      let sawResponse = false;

      const onAbort = () => {
        cleanup(createBm25RequestAbortError(commandType, "during request"));
      };

      const cleanup = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        stopReading();
        signal?.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
        if (!socket.destroyed) {
          socket.destroy();
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(value ?? "{}");
      };

      const stopReading = attachJsonlLineReader(socket, (line) => {
        const trimmed = line.trim();
        if (!trimmed || settled) return;
        try {
          const response = parseBm25HelperResponse(trimmed);
          sawResponse = true;
          cleanup(undefined, resolveBm25HelperResponse(response, id, commandType));
        } catch (error) {
          cleanup(error instanceof Error ? error : new Error(String(error)));
        }
      });

      signal?.addEventListener("abort", onAbort, { once: true });

      socket.on("connect", () => {
        socket.write(serializeJsonLine({ id, type: commandType, ...params }));
      });
      socket.on("error", (error) => {
        cleanup(error instanceof Error ? error : new Error(String(error)));
      });
      socket.on("close", () => {
        if (!settled && !sawResponse) {
          cleanup(
            new Error(`BM25 helper RPC connection closed before response for ${commandType}.`),
          );
        }
      });
    });
  }
}

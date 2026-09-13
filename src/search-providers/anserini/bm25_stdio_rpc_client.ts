import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "../../runtime/jsonl";
import {
  createBm25RequestAbortError,
  parseBm25HelperResponse,
  parseBm25PingResponse,
  resolveBm25HelperResponse,
  type Bm25RpcClient,
} from "./bm25_rpc_client";
import {
  startBm25ServerStdio,
  type Bm25ServerStdioLaunchOptions,
  type StartedBm25StdioServer,
} from "./bm25_server_process";

type PendingRequest = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

export type Bm25StdioRpcLauncher = (
  options: Bm25ServerStdioLaunchOptions,
) => StartedBm25StdioServer;

export type Bm25StdioRpcClientOptions = {
  cwd: string;
  indexPath: string;
  env?: NodeJS.ProcessEnv;
  launcher?: Bm25StdioRpcLauncher;
};

export class Bm25StdioRpcClient implements Bm25RpcClient {
  private readonly cwd: string;
  private readonly indexPath: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly launcher: Bm25StdioRpcLauncher;
  private child?: ChildProcessWithoutNullStreams;
  private startedServer?: StartedBm25StdioServer;
  private stopReadingStdout?: () => void;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private startPromise?: Promise<void>;

  constructor(options: Bm25StdioRpcClientOptions) {
    this.cwd = options.cwd;
    this.indexPath = options.indexPath;
    this.env = options.env;
    this.launcher = options.launcher ?? startBm25ServerStdio;
  }

  async request(
    commandType: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw createBm25RequestAbortError(commandType, "before dispatch");
    }
    await this.ensureStarted();
    return await this.dispatchRequest(commandType, params, signal);
  }

  dispose(): void {
    this.reset();
  }

  private async dispatchRequest(
    commandType: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error("BM25 helper is not available.");
    }

    const id = this.nextRequestId++;
    return await new Promise<string>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;
      this.pending.set(id, {
        resolve: (value) => {
          if (abortHandler) signal?.removeEventListener("abort", abortHandler);
          resolve(value);
        },
        reject: (error) => {
          if (abortHandler) signal?.removeEventListener("abort", abortHandler);
          reject(error);
        },
      });

      abortHandler = () => {
        this.pending.delete(id);
        reject(createBm25RequestAbortError(commandType, "during request"));
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      child.stdin.write(serializeJsonLine({ id, type: commandType, ...params }));
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.stopReadingStdout) return;
    if (!this.startPromise) {
      this.startPromise = this.start();
    }
    try {
      await this.startPromise;
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  private async start(): Promise<void> {
    const startedServer = this.launcher({
      cwd: this.cwd,
      indexPath: this.indexPath,
      env: this.env,
    });
    const child = startedServer.child;
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const stopReadingStdout = attachJsonlLineReader(child.stdout, (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let response;
      try {
        response = parseBm25HelperResponse(trimmed);
      } catch (error) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const id = typeof response.id === "number" ? response.id : undefined;
      if (id === undefined) {
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);
      try {
        pending.resolve(resolveBm25HelperResponse(response, id, "request"));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.on("error", (error) => {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      this.reset();
    });

    child.on("close", (code, signal) => {
      const stderrSuffix = stderr.trim() ? `\n${stderr.trim()}` : "";
      this.rejectAll(
        new Error(
          `BM25 helper daemon exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).${stderrSuffix}`,
        ),
      );
      this.reset();
    });

    this.startedServer = startedServer;
    this.child = child;
    this.stopReadingStdout = stopReadingStdout;
    const pingOutput = await this.dispatchRequest("ping", {});
    const ping = parseBm25PingResponse(pingOutput);
    if (!ping.ok) {
      throw new Error("BM25 helper daemon failed ping handshake.");
    }
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private reset() {
    this.stopReadingStdout?.();
    this.stopReadingStdout = undefined;
    this.startedServer?.stop();
    this.startedServer = undefined;
    this.child = undefined;
    this.startPromise = undefined;
  }
}

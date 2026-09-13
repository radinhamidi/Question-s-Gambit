import { createWriteStream, mkdirSync } from "node:fs";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { attachJsonlLineReader } from "../../runtime/jsonl";
import { createJsonValidator } from "../../lib/json_validation";

export type Bm25ServerReadyEndpoint = {
  host: string;
  port: number;
  initMs?: number;
};

export type Bm25ServerTcpLaunchOptions = {
  cwd: string;
  indexPath: string;
  host: string;
  port: number;
  logPath: string;
  env?: NodeJS.ProcessEnv;
  readinessTimeoutMs?: number;
};

export type Bm25ServerStdioLaunchOptions = {
  cwd: string;
  indexPath: string;
  env?: NodeJS.ProcessEnv;
};

export type StartedBm25TcpServer = {
  child: ChildProcess;
  endpoint: Bm25ServerReadyEndpoint;
  stop: () => void;
};

export type StartedBm25StdioServer = {
  child: ChildProcessWithoutNullStreams;
  stop: () => void;
};

const Bm25RpcReadyMessageSchema = Type.Object(
  {
    type: Type.String(),
    transport: Type.String(),
    host: Type.String(),
    port: Type.Number(),
    timing_ms: Type.Optional(
      Type.Object(
        {
          init: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const bm25RpcReadyMessageValidator = createJsonValidator(Bm25RpcReadyMessageSchema);

type Bm25RpcReadyMessage = Static<typeof Bm25RpcReadyMessageSchema>;

function getTuningArg(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return env[name]?.trim() || fallback;
}

export function resolveBm25ServerScriptPath(cwd: string): string {
  return join(cwd, "scripts", "bm25_server.sh");
}

export function buildBm25ServerStdioArgs(
  indexPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    "scripts/bm25_server.sh",
    "--index-path",
    indexPath,
    "--k1",
    getTuningArg(env, "PI_BM25_K1", "25"),
    "--b",
    getTuningArg(env, "PI_BM25_B", "1"),
    "--threads",
    getTuningArg(env, "PI_BM25_THREADS", "1"),
  ];
}

export function buildBm25ServerTcpArgs(
  indexPath: string,
  host: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...buildBm25ServerStdioArgs(indexPath, env),
    "--transport",
    "tcp",
    "--host",
    host,
    "--port",
    String(port),
  ];
}

export function startBm25ServerStdio(
  options: Bm25ServerStdioLaunchOptions,
): StartedBm25StdioServer {
  const env = options.env ?? process.env;
  const [command, ...args] = buildBm25ServerStdioArgs(options.indexPath, env);
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const stdout = child.stdout;
  const stderr = child.stderr;
  const stdin = child.stdin;
  if (!stdin || !stdout || !stderr) {
    throw new Error("Failed to capture BM25 helper stdin/stdout/stderr");
  }

  return {
    child,
    stop: () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}

export function parseBm25RpcReadyMessage(text: string, label: string): Bm25RpcReadyMessage {
  return bm25RpcReadyMessageValidator.parse(text.trim(), label);
}

export async function startBm25ServerTcp(
  options: Bm25ServerTcpLaunchOptions,
): Promise<StartedBm25TcpServer> {
  const env = options.env ?? process.env;
  mkdirSync(dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: "a" });
  const [command, ...args] = buildBm25ServerTcpArgs(
    options.indexPath,
    options.host,
    options.port,
    env,
  );
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    log.end();
    throw new Error("Failed to capture BM25 server stdout/stderr");
  }

  stdout.on("data", (chunk) => {
    log.write(chunk);
  });
  stderr.on("data", (chunk) => {
    log.write(chunk);
  });

  const stop = () => {
    if (!child.killed) {
      child.kill();
    }
    log.end();
  };

  try {
    const endpoint = await new Promise<Bm25ServerReadyEndpoint>((resolvePromise, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(
          new Error(
            `Timed out waiting for shared BM25 RPC daemon readiness. Log: ${options.logPath}`,
          ),
        );
      }, options.readinessTimeoutMs ?? 120_000);

      const finish = (error?: Error, endpoint?: Bm25ServerReadyEndpoint) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stopReading();
        if (error) {
          reject(error);
          return;
        }
        if (!endpoint) {
          reject(new Error("BM25 server readiness finished without endpoint metadata."));
          return;
        }
        resolvePromise(endpoint);
      };

      const handleLine = (line: string, source: "line" | "trailing") => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: Bm25RpcReadyMessage;
        try {
          parsed = parseBm25RpcReadyMessage(
            trimmed,
            source === "trailing"
              ? "BM25 RPC daemon trailing readiness line"
              : "BM25 RPC daemon readiness line",
          );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (parsed.type !== "server_ready" || parsed.transport !== "tcp") {
          finish(new Error(`Unexpected BM25 RPC daemon readiness payload: ${trimmed}`));
          return;
        }
        finish(undefined, {
          host: parsed.host,
          port: parsed.port,
          initMs: parsed.timing_ms?.init,
        });
      };

      const stopReading = attachJsonlLineReader(stdout, (line) => handleLine(line, "line"), {
        onTrailingLine: (line) => handleLine(line, "trailing"),
      });

      child.once("error", (error) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
      child.once("close", (code, signal) => {
        finish(
          new Error(
            `Shared BM25 RPC daemon exited before readiness (code=${code ?? "null"}, signal=${signal ?? "null"}). Log: ${options.logPath}`,
          ),
        );
      });
    });

    return { child, endpoint, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

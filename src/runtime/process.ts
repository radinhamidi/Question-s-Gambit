import { closeSync, openSync } from "node:fs";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnSyncOptions,
} from "node:child_process";

export function runInheritedCommandSync(
  command: readonly string[],
  options: SpawnSyncOptions = {},
  label = command[0] ?? "command",
): void {
  if (command.length === 0) {
    throw new Error("runInheritedCommandSync requires a non-empty command");
  }

  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    env: process.env,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${label} exited with signal ${result.signal}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function spawnPipedCommand(
  command: readonly string[],
  options: SpawnOptions = {},
  label = command[0] ?? "command",
): ChildProcessWithoutNullStreams {
  if (command.length === 0) {
    throw new Error("spawnPipedCommand requires a non-empty command");
  }

  const child = spawn(command[0], command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    ...options,
  });
  if (!child.stdout || !child.stderr) {
    throw new Error(`Failed to spawn ${label} with piped stdout/stderr`);
  }
  return child as ChildProcessWithoutNullStreams;
}

export function spawnDetachedCommand(
  command: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdoutPath: string;
    stderrPath: string;
  },
  label = command[0] ?? "command",
): ChildProcess {
  if (command.length === 0) {
    throw new Error("spawnDetachedCommand requires a non-empty command");
  }

  const stdoutFd = openSync(options.stdoutPath, "a");
  const stderrFd = openSync(options.stderrPath, "a");
  try {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    if (!child.pid) {
      throw new Error(`Failed to spawn detached ${label}`);
    }
    child.unref();
    return child;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

export async function waitForChildExit(child: ChildProcess, label: string): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    child.once("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${label} exited with signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

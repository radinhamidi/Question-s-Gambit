import { spawn, type ChildProcess } from "node:child_process";

export type StartPiJsonProcessOptions = {
  piBinary: string;
  model: string;
  thinking: string;
  prompt: string;
  isolatedAgentDir: string;
  extensionPath?: string;
  extraEnv?: NodeJS.ProcessEnv;
  cwd?: string;
};

export type PiProcessTimeoutController = {
  clear: () => void;
  wasTriggered: () => boolean;
};

export function buildPiJsonCommandArgs(options: {
  model: string;
  thinking: string;
  prompt: string;
  extensionPath?: string;
}): string[] {
  const args = [
    options.extensionPath ? "--no-builtin-tools" : "--no-tools",
    "--no-session",
    "--no-skills",
  ];
  if (options.extensionPath) {
    args.push("-e", options.extensionPath);
  }
  args.push(
    "--mode",
    "json",
    "--model",
    options.model,
    "--thinking",
    options.thinking,
    options.prompt,
  );
  return args;
}

export function startPiJsonProcess(options: StartPiJsonProcessOptions): ChildProcess {
  return spawn(
    options.piBinary,
    buildPiJsonCommandArgs({
      model: options.model,
      thinking: options.thinking,
      prompt: options.prompt,
      extensionPath: options.extensionPath,
    }),
    {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: options.isolatedAgentDir,
        ...options.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export function startPiProcessTimeout(options: {
  child: ChildProcess;
  timeoutSeconds: number;
  onTimeout?: () => void;
  killGracePeriodMs?: number;
}): PiProcessTimeoutController {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    options.onTimeout?.();
    options.child.kill("SIGTERM");
    setTimeout(() => {
      if (!options.child.killed) {
        options.child.kill("SIGKILL");
      }
    }, options.killGracePeriodMs ?? 5_000);
  }, options.timeoutSeconds * 1000);

  return {
    clear: () => clearTimeout(timeout),
    wasTriggered: () => timedOut,
  };
}

import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ISOLATED_AGENT_FILENAMES = ["auth.json", "oauth.json", "models.json"] as const;

export function resolveDefaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const envAgentDir = env.PI_CODING_AGENT_DIR;
  if (envAgentDir) {
    if (envAgentDir === "~") return homedir();
    if (envAgentDir.startsWith("~/")) return join(homedir(), envAgentDir.slice(2));
    return envAgentDir;
  }
  return join(homedir(), ".pi", "agent");
}

function sanitizeTempPrefixPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "agent-run";
}

export function prepareIsolatedAgentDir(
  artifactRoot: string,
  options: {
    env?: NodeJS.ProcessEnv;
    tempRoot?: string;
  } = {},
): string {
  const env = options.env ?? process.env;
  const sourceAgentDir = resolveDefaultAgentDir(env);
  const tempRoot = options.tempRoot ?? tmpdir();
  mkdirSync(tempRoot, { recursive: true });

  const prefix = `pi-agent-${sanitizeTempPrefixPart(basename(resolve(artifactRoot)))}-`;
  const isolatedAgentDir = mkdtempSync(join(tempRoot, prefix));

  for (const filename of ISOLATED_AGENT_FILENAMES) {
    const sourcePath = join(sourceAgentDir, filename);
    const targetPath = join(isolatedAgentDir, filename);
    if (!existsSync(sourcePath)) continue;
    copyFileSync(sourcePath, targetPath);
  }

  return isolatedAgentDir;
}

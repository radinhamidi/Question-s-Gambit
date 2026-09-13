import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export type GitCommitProvenance = {
  gitCommit?: string;
  gitCommitShort?: string;
};

export function resolveGitCommitProvenance(cwd = process.cwd()): GitCommitProvenance {
  const repoCwd = resolve(cwd);
  const full = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoCwd,
    encoding: "utf8",
  });
  if (full.status !== 0) {
    return {};
  }
  const gitCommit = full.stdout.trim();
  if (!gitCommit) {
    return {};
  }

  const short = spawnSync("git", ["rev-parse", "--short=6", "HEAD"], {
    cwd: repoCwd,
    encoding: "utf8",
  });
  const gitCommitShort = short.status === 0 ? short.stdout.trim() : gitCommit.slice(0, 6);
  return {
    gitCommit,
    gitCommitShort: gitCommitShort || gitCommit.slice(0, 6),
  };
}

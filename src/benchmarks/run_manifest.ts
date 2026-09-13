import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { BenchmarkManifestSnapshot } from "./types";

type RunManifestLookup = {
  runRoot: string;
  snapshotPath: string;
  snapshot: BenchmarkManifestSnapshot;
};

export function resolveRunRoot(path: string): string {
  const resolved = resolve(path);
  return basename(resolved) === "merged" ? dirname(resolved) : resolved;
}

export function detectBenchmarkManifestSnapshot(runPath: string): RunManifestLookup | null {
  const runRoot = resolveRunRoot(runPath);
  const snapshotPath = resolve(runRoot, "benchmark_manifest_snapshot.json");
  if (!existsSync(snapshotPath)) {
    return null;
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as BenchmarkManifestSnapshot;
  if (!snapshot.benchmark_id) {
    return null;
  }
  return { runRoot, snapshotPath, snapshot };
}

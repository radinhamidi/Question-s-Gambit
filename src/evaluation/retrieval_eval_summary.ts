import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";

import type { BenchmarkNdcgGainMode } from "../benchmarks/types";

export type RetrievalEvalMetricSummary = {
  metric: string;
  scope: string;
  value: number;
  stdout?: string;
};

export type RetrievalEvalMetricSemanticsSummary = {
  ndcgGainMode: BenchmarkNdcgGainMode;
  recallRelevantThreshold: number;
  binaryRelevantThreshold: number;
};

export type RetrievalEvalSummary = {
  benchmarkId: string;
  querySetId: string;
  backend: "internal" | "trec_eval";
  sourceType: "run-file" | "run-dir";
  sourcePath: string;
  qrelsPath: string;
  secondaryQrelsPath?: string;
  queryCount?: number;
  metricSemantics: RetrievalEvalMetricSemanticsSummary;
  metrics: RetrievalEvalMetricSummary[];
};

function splitPathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0);
}

function buildNestedSummaryParts(sourcePath: string): string[] {
  const resolvedSourcePath = resolve(sourcePath);
  const repoRelativePath = relative(resolve(process.cwd()), resolvedSourcePath);
  const sourceParts = repoRelativePath.startsWith("..")
    ? ["external", ...splitPathParts(resolvedSourcePath)]
    : splitPathParts(repoRelativePath);
  if (sourceParts.length === 0) {
    return [basename(resolvedSourcePath, extname(resolvedSourcePath))];
  }
  const lastIndex = sourceParts.length - 1;
  sourceParts[lastIndex] = basename(sourceParts[lastIndex], extname(sourceParts[lastIndex]));
  return sourceParts;
}

export function buildLegacyRetrievalEvalSummaryPath(options: {
  benchmarkId: string;
  sourcePath: string;
  evalRoot?: string;
}): string {
  const evalRoot = resolve(options.evalRoot ?? "evals/retrieval");
  const sourceBase = basename(options.sourcePath, extname(options.sourcePath));
  return resolve(evalRoot, options.benchmarkId, `${sourceBase}.summary.json`);
}

export function buildRetrievalEvalSummaryPath(options: {
  benchmarkId: string;
  sourcePath: string;
  evalRoot?: string;
}): string {
  const evalRoot = resolve(options.evalRoot ?? "evals/retrieval");
  const sourceParts = buildNestedSummaryParts(options.sourcePath);
  const lastIndex = sourceParts.length - 1;
  sourceParts[lastIndex] = `${sourceParts[lastIndex]}.summary.json`;
  return resolve(evalRoot, options.benchmarkId, ...sourceParts);
}

export function getRetrievalEvalSummaryCandidates(options: {
  benchmarkId: string;
  sourcePath: string;
  evalRoot?: string;
}): string[] {
  const primaryPath = buildRetrievalEvalSummaryPath(options);
  const legacyPath = buildLegacyRetrievalEvalSummaryPath(options);
  return primaryPath === legacyPath ? [primaryPath] : [primaryPath, legacyPath];
}

export function writeRetrievalEvalSummary(path: string, summary: RetrievalEvalSummary): void {
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export function loadRetrievalEvalSummary(path: string): RetrievalEvalSummary {
  return JSON.parse(readFileSync(path, "utf8")) as RetrievalEvalSummary;
}

export function maybeLoadRetrievalEvalSummary(path?: string): RetrievalEvalSummary | undefined {
  if (!path) return undefined;
  const resolved = resolve(path);
  return existsSync(resolved) ? loadRetrievalEvalSummary(resolved) : undefined;
}

export function getRetrievalEvalMetricValue(
  summary: RetrievalEvalSummary,
  metric: string,
  scope = "all",
): number | undefined {
  return summary.metrics.find((entry) => entry.metric === metric && entry.scope === scope)?.value;
}

export function maybeLoadMatchingRetrievalEvalSummary(options: {
  benchmarkId: string;
  sourcePath: string;
  qrelsPath: string;
  sourceType?: RetrievalEvalSummary["sourceType"];
  querySetId?: string;
  queryCount?: number;
  requireQueryCountMatch?: boolean;
}): RetrievalEvalSummary | undefined {
  for (const candidatePath of getRetrievalEvalSummaryCandidates({
    benchmarkId: options.benchmarkId,
    sourcePath: options.sourcePath,
  })) {
    const summary = maybeLoadRetrievalEvalSummary(candidatePath);
    if (!summary) continue;
    if (summary.benchmarkId !== options.benchmarkId) continue;
    if (!summary.sourcePath || !summary.qrelsPath) continue;
    if (resolve(summary.sourcePath) !== resolve(options.sourcePath)) continue;
    if (resolve(summary.qrelsPath) !== resolve(options.qrelsPath)) continue;
    if (options.sourceType && summary.sourceType !== options.sourceType) continue;
    if (options.querySetId && summary.querySetId !== options.querySetId) continue;
    if (options.queryCount !== undefined) {
      if (summary.queryCount === undefined) {
        if (options.requireQueryCountMatch) continue;
      } else if (summary.queryCount !== options.queryCount) {
        continue;
      }
    }
    return summary;
  }
  return undefined;
}

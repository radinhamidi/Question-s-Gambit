import { basename, resolve } from "node:path";
import { resolveRunRoot } from "../benchmarks/run_manifest";
import { buildRetrievalEvalSummaryPath } from "../evaluation/retrieval_eval_summary";

function getPathParts(path: string): string[] {
  return resolve(path)
    .split("/")
    .filter((part) => part.length > 0);
}

export function getRunRelativeParts(runPath: string): string[] {
  const runRoot = resolveRunRoot(runPath);
  const parts = getPathParts(runRoot);
  const runsIndex = parts.lastIndexOf("runs");
  if (runsIndex >= 0 && runsIndex < parts.length - 1) {
    return parts.slice(runsIndex + 1);
  }
  return [basename(runRoot)];
}

export function resolveBenchmarkAwareSharedLogDir(benchmarkId: string, querySetId: string): string {
  return `runs/shared-bm25-${benchmarkId}-${querySetId}`;
}

export function resolveJudgeEvalOutputDir(options: {
  inputDir: string;
  evalRoot: string;
  benchmarkId: string;
}): string {
  return resolve(options.evalRoot, options.benchmarkId, ...getRunRelativeParts(options.inputDir));
}

export function resolveRetrievalEvalSummaryPath(options: {
  benchmarkId: string;
  sourcePath: string;
  evalRoot?: string;
}): string {
  return buildRetrievalEvalSummaryPath({
    benchmarkId: options.benchmarkId,
    sourcePath: options.sourcePath,
    evalRoot: options.evalRoot,
  });
}

export function getJudgeEvalSummaryCandidates(options: {
  runDir: string;
  benchmarkId: string;
  evalRoot?: string;
}): string[] {
  const runRoot = resolveRunRoot(options.runDir);
  const evalRoot = resolve(options.evalRoot ?? "evals/pi_judge");
  const runRelativeParts = getRunRelativeParts(runRoot);
  return [
    resolve(runRoot, "merged", "evaluation_summary.json"),
    resolve(runRoot, "evaluation_summary.json"),
    resolve(
      evalRoot,
      options.benchmarkId,
      ...runRelativeParts,
      "merged",
      "evaluation_summary.json",
    ),
    resolve(evalRoot, options.benchmarkId, ...runRelativeParts, "evaluation_summary.json"),
    resolve(evalRoot, ...runRelativeParts, "merged", "evaluation_summary.json"),
    resolve(evalRoot, ...runRelativeParts, "evaluation_summary.json"),
  ];
}

import { existsSync } from "node:fs";

import { resolveInternalRetrievalMetricSemantics } from "../benchmarks/registry";
import { readQrels } from "./retrieval_metrics";

export function loadJudgeEvalRelevantDocids(
  qrelPath: string,
  options: { benchmarkId: string },
): Map<string, string[]> {
  const qrels = new Map<string, string[]>();
  if (!existsSync(qrelPath)) {
    return qrels;
  }
  const parsed = readQrels(qrelPath);
  const semantics = resolveInternalRetrievalMetricSemantics(options.benchmarkId);
  const recallRelevantThreshold = Math.max(1, semantics.recallRelevantThreshold ?? 1);
  for (const [queryId, docs] of parsed) {
    const relevantDocids = [...docs.entries()]
      .filter(([, rel]) => rel >= recallRelevantThreshold)
      .map(([docid]) => docid);
    qrels.set(queryId, relevantDocids);
  }
  return qrels;
}

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BenchmarkNdcgGainMode } from "../benchmarks/types";
import { getSurfacedDocids } from "./run_docid_views";

export type RankingEntry = {
  docid: string;
  rank: number;
  score: number;
};

export type Qrels = Map<string, Map<string, number>>;
export type Rankings = Map<string, RankingEntry[]>;

export type EvaluationCutoffs = {
  recallCutoffs: number[];
  ndcgCutoffs: number[];
  mrrCutoffs: number[];
};

export type EvaluationMetricSemantics = {
  ndcgGainMode?: BenchmarkNdcgGainMode;
  recallRelevantThreshold?: number;
  binaryRelevantThreshold?: number;
};

export type EvaluationResult = {
  queryCount: number;
  macroRecallAll: number;
  microRecallAll: number;
  macroRecallByCutoff: Map<number, number>;
  microRecallByCutoff: Map<number, number>;
  ndcgByCutoff: Map<number, number>;
  mrrByCutoff: Map<number, number>;
  map: number;
};

export function parseIntegerCutoffs(value: string): number[] {
  const numbers = value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((part) => Number.isFinite(part) && part > 0);
  if (numbers.length === 0) {
    throw new Error(`Expected at least one positive integer cutoff, got: ${value}`);
  }
  return [...new Set(numbers)].sort((left, right) => left - right);
}

export function readQrels(path: string): Qrels {
  const qrels: Qrels = new Map();
  const text = readFileSync(path, "utf8");
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      throw new Error(`Invalid qrels line ${lineIndex + 1}: expected at least 4 columns`);
    }
    const [queryId, , docid, relRaw] = parts;
    const rel = Number.parseInt(relRaw, 10);
    if (!Number.isFinite(rel) || rel <= 0) continue;
    const docs = qrels.get(queryId) ?? new Map<string, number>();
    docs.set(docid, rel);
    qrels.set(queryId, docs);
  }
  return qrels;
}

export function readQueryIds(path: string): string[] {
  const ids: string[] = [];
  const text = readFileSync(path, "utf8");
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const [queryId] = line.split("\t", 1);
    if (!queryId) {
      throw new Error(`Invalid query TSV line ${lineIndex + 1}`);
    }
    ids.push(queryId);
  }
  return ids;
}

export function getRunFiles(runDir: string): string[] {
  return readdirSync(runDir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
}

export function resolveBenchmarkResultDir(runDir: string): string {
  const mergedDir = resolve(runDir, "merged");
  if (existsSync(mergedDir) && getRunFiles(mergedDir).length > 0) {
    return mergedDir;
  }
  return runDir;
}

export function readRunDir(runDir: string): Rankings {
  const rankings: Rankings = new Map();
  for (const fileName of getRunFiles(runDir)) {
    const path = resolve(runDir, fileName);
    const run = JSON.parse(readFileSync(path, "utf8")) as {
      query_id: string;
      surfaced_docids?: string[];
      retrieved_docids?: string[];
    };
    const queryId = String(run.query_id);
    const retrieved = getSurfacedDocids(run);
    rankings.set(
      queryId,
      retrieved.map((docid, index) => ({
        docid: String(docid),
        rank: index + 1,
        score: retrieved.length - index,
      })),
    );
  }
  return rankings;
}

export function readRunFile(path: string): Rankings {
  const rankings: Rankings = new Map();
  const text = readFileSync(path, "utf8");
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 6) {
      throw new Error(`Invalid run line ${lineIndex + 1}: expected 6 columns`);
    }
    const [queryId, , docid, rankRaw, scoreRaw] = parts;
    const rank = Number.parseInt(rankRaw, 10);
    const score = Number.parseFloat(scoreRaw);
    if (!Number.isFinite(rank) || rank <= 0) {
      throw new Error(`Invalid rank on line ${lineIndex + 1}: ${rankRaw}`);
    }
    const entries = rankings.get(queryId) ?? [];
    entries.push({ docid, rank, score: Number.isFinite(score) ? score : 0 });
    rankings.set(queryId, entries);
  }

  for (const [queryId, entries] of rankings) {
    entries.sort((left, right) => left.rank - right.rank || right.score - left.score);
    rankings.set(queryId, entries);
  }
  return rankings;
}

export function writeRunFile(path: string, rankings: Rankings, queryIds: string[]): void {
  const lines: string[] = [];
  for (const queryId of queryIds) {
    const entries = rankings.get(queryId) ?? [];
    for (const [index, entry] of entries.entries()) {
      lines.push(`${queryId} Q0 ${entry.docid} ${index + 1} ${entry.score.toFixed(6)} pi-serini`);
    }
  }
  writeFileSync(path, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
}

function gain(rel: number, mode: BenchmarkNdcgGainMode): number {
  return mode === "linear" ? rel : 2 ** rel - 1;
}

function dcg(relevances: number[], mode: BenchmarkNdcgGainMode): number {
  let total = 0;
  for (const [index, rel] of relevances.entries()) {
    total += gain(rel, mode) / Math.log2(index + 2);
  }
  return total;
}

export function roundMetric(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function evaluateRankings(
  qrels: Qrels,
  rankings: Rankings,
  queryIds: string[],
  cutoffs: EvaluationCutoffs,
  semantics: EvaluationMetricSemantics = {},
): EvaluationResult {
  const ndcgGainMode = semantics.ndcgGainMode ?? "exponential";
  const recallRelevantThreshold = Math.max(1, semantics.recallRelevantThreshold ?? 1);
  const binaryRelevantThreshold = Math.max(1, semantics.binaryRelevantThreshold ?? 1);

  const recallMacroSums = new Map<number, number>();
  const recallMicroHits = new Map<number, number>();
  const ndcgSums = new Map<number, number>();
  const mrrSums = new Map<number, number>();
  let allRecallMacroSum = 0;
  let allRecallMicroHits = 0;
  let mapSum = 0;
  let microGold = 0;

  for (const cutoff of cutoffs.recallCutoffs) {
    recallMacroSums.set(cutoff, 0);
    recallMicroHits.set(cutoff, 0);
  }
  for (const cutoff of cutoffs.ndcgCutoffs) ndcgSums.set(cutoff, 0);
  for (const cutoff of cutoffs.mrrCutoffs) mrrSums.set(cutoff, 0);

  for (const queryId of queryIds) {
    const relevant = qrels.get(queryId) ?? new Map<string, number>();
    const entries = rankings.get(queryId) ?? [];
    const uniqueDocids = new Set<string>();
    const rankedDocids: string[] = [];
    for (const entry of entries) {
      if (uniqueDocids.has(entry.docid)) continue;
      uniqueDocids.add(entry.docid);
      rankedDocids.push(entry.docid);
    }

    const recallRelevantDocids = new Set(
      [...relevant.entries()]
        .filter(([, rel]) => rel >= recallRelevantThreshold)
        .map(([docid]) => docid),
    );
    const binaryRelevantDocids = new Set(
      [...relevant.entries()]
        .filter(([, rel]) => rel >= binaryRelevantThreshold)
        .map(([docid]) => docid),
    );
    const goldCount = recallRelevantDocids.size;
    const binaryGoldCount = binaryRelevantDocids.size;
    microGold += goldCount;

    const allHits = rankedDocids.reduce(
      (count, docid) => count + (recallRelevantDocids.has(docid) ? 1 : 0),
      0,
    );
    allRecallMacroSum += goldCount > 0 ? allHits / goldCount : 0;
    allRecallMicroHits += allHits;

    for (const cutoff of cutoffs.recallCutoffs) {
      const hits = rankedDocids
        .slice(0, cutoff)
        .reduce((count, docid) => count + (recallRelevantDocids.has(docid) ? 1 : 0), 0);
      recallMacroSums.set(
        cutoff,
        (recallMacroSums.get(cutoff) ?? 0) + (goldCount > 0 ? hits / goldCount : 0),
      );
      recallMicroHits.set(cutoff, (recallMicroHits.get(cutoff) ?? 0) + hits);
    }

    for (const cutoff of cutoffs.ndcgCutoffs) {
      const actual = rankedDocids.slice(0, cutoff).map((docid) => relevant.get(docid) ?? 0);
      const ideal = [...relevant.values()].sort((left, right) => right - left).slice(0, cutoff);
      const idealDcg = dcg(ideal, ndcgGainMode);
      ndcgSums.set(
        cutoff,
        (ndcgSums.get(cutoff) ?? 0) + (idealDcg > 0 ? dcg(actual, ndcgGainMode) / idealDcg : 0),
      );
    }

    for (const cutoff of cutoffs.mrrCutoffs) {
      let rr = 0;
      for (const [index, docid] of rankedDocids.slice(0, cutoff).entries()) {
        if (binaryRelevantDocids.has(docid)) {
          rr = 1 / (index + 1);
          break;
        }
      }
      mrrSums.set(cutoff, (mrrSums.get(cutoff) ?? 0) + rr);
    }

    let hits = 0;
    let precisionSum = 0;
    for (const [index, docid] of rankedDocids.entries()) {
      if (!binaryRelevantDocids.has(docid)) continue;
      hits += 1;
      precisionSum += hits / (index + 1);
    }
    mapSum += binaryGoldCount > 0 ? precisionSum / binaryGoldCount : 0;
  }

  const queryCount = queryIds.length;
  const macroRecallByCutoff = new Map<number, number>();
  const microRecallByCutoff = new Map<number, number>();
  const ndcgByCutoff = new Map<number, number>();
  const mrrByCutoff = new Map<number, number>();

  for (const cutoff of cutoffs.recallCutoffs) {
    const macro = (recallMacroSums.get(cutoff) ?? 0) / Math.max(queryCount, 1);
    const microHits = recallMicroHits.get(cutoff) ?? 0;
    const micro = microGold > 0 ? microHits / microGold : 0;
    macroRecallByCutoff.set(cutoff, macro);
    microRecallByCutoff.set(cutoff, micro);
  }

  for (const cutoff of cutoffs.ndcgCutoffs) {
    ndcgByCutoff.set(cutoff, (ndcgSums.get(cutoff) ?? 0) / Math.max(queryCount, 1));
  }

  for (const cutoff of cutoffs.mrrCutoffs) {
    mrrByCutoff.set(cutoff, (mrrSums.get(cutoff) ?? 0) / Math.max(queryCount, 1));
  }

  return {
    queryCount,
    macroRecallAll: allRecallMacroSum / Math.max(queryCount, 1),
    microRecallAll: microGold > 0 ? allRecallMicroHits / microGold : 0,
    macroRecallByCutoff,
    microRecallByCutoff,
    ndcgByCutoff,
    mrrByCutoff,
    map: mapSum / Math.max(queryCount, 1),
  };
}

export function getMetricValue(result: EvaluationResult, metric: string): number {
  if (metric === "macro_recall@all") return result.macroRecallAll;
  if (metric === "micro_recall@all") return result.microRecallAll;
  if (metric === "map") return result.map;

  const recallMatch = /^macro_recall@(\d+)$/.exec(metric);
  if (recallMatch) {
    return result.macroRecallByCutoff.get(Number.parseInt(recallMatch[1], 10)) ?? 0;
  }

  const microRecallMatch = /^micro_recall@(\d+)$/.exec(metric);
  if (microRecallMatch) {
    return result.microRecallByCutoff.get(Number.parseInt(microRecallMatch[1], 10)) ?? 0;
  }

  const trecRecallMatch = /^recall_(\d+)$/.exec(metric);
  if (trecRecallMatch) {
    return result.macroRecallByCutoff.get(Number.parseInt(trecRecallMatch[1], 10)) ?? 0;
  }

  const ndcgMatch = /^ndcg_cut_(\d+)$/.exec(metric);
  if (ndcgMatch) {
    return result.ndcgByCutoff.get(Number.parseInt(ndcgMatch[1], 10)) ?? 0;
  }

  const mrrMatch = /^recip_rank_(\d+)$/.exec(metric);
  if (mrrMatch) {
    return result.mrrByCutoff.get(Number.parseInt(mrrMatch[1], 10)) ?? 0;
  }

  throw new Error(`Unsupported metric: ${metric}`);
}

export function formatEvaluationOutput(
  result: EvaluationResult,
  sourcePath: string,
  qrelsPath: string,
  cutoffs: EvaluationCutoffs,
): string[] {
  const lines = [
    `Queries: ${result.queryCount}`,
    `Source: ${resolve(sourcePath)}`,
    `Qrels: ${resolve(qrelsPath)}`,
    "System-surfaced evaluation semantics: metrics are computed per query from the final accumulated surfaced_docids sequence (deduplicated union of docids surfaced by search and browse across the full run, ordered by first encounter). macro_recall@all and micro_recall@all are full-sequence coverage metrics. recall@k, ndcg@k, mrr@k, and map are prefix-of-surfaced-set metrics computed on the first k docs of that same final sequence. These are not per-call retrieval metrics.",
    `macro_recall@all\t${roundMetric(result.macroRecallAll)}`,
    `micro_recall@all\t${roundMetric(result.microRecallAll)}`,
  ];

  for (const cutoff of cutoffs.recallCutoffs) {
    const macro = result.macroRecallByCutoff.get(cutoff) ?? 0;
    const micro = result.microRecallByCutoff.get(cutoff) ?? 0;
    lines.push(`macro_recall@${cutoff}\t${roundMetric(macro)}`);
    lines.push(`micro_recall@${cutoff}\t${roundMetric(micro)}`);
    lines.push(`recall_${cutoff}\tall\t${roundMetric(macro)}`);
  }

  for (const cutoff of cutoffs.ndcgCutoffs) {
    lines.push(`ndcg_cut_${cutoff}\tall\t${roundMetric(result.ndcgByCutoff.get(cutoff) ?? 0)}`);
  }

  for (const cutoff of cutoffs.mrrCutoffs) {
    lines.push(`recip_rank_${cutoff}\tall\t${roundMetric(result.mrrByCutoff.get(cutoff) ?? 0)}`);
  }

  lines.push(`map\tall\t${roundMetric(result.map)}`);
  return lines;
}

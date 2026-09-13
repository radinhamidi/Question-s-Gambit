/**
 * Compute Surfaced / Previewed / Opened / Cited Recall (macro + micro) over an
 * existing pi_judge per-query directory against an arbitrary qrels file.
 *
 * This is an additive post-processor — it does NOT re-invoke the LLM judge.
 * It reads the docid sets already saved in each per-query `*_eval.json`
 * (under `retrieval.{surfaced,previewed,opened,cited}_docids`) and computes
 * recall against the supplied qrels file.
 *
 * Use case: the canonical Stage 2 judge eval computes recall against
 * qrel_evidence.txt. This script gives the parallel recall panel against
 * qrel_gold.txt with one extra second of compute.
 *
 * Usage:
 *   npx tsx scripts/recall_against_qrels.ts \
 *     --perQueryDir evals/pi_judge/<benchmark>/<arm>/per-query \
 *     --qrels data/browsecomp-plus/qrels/qrel_gold.txt \
 *     --label gold \
 *     --output evals/pi_judge_gold/<benchmark>/<arm>/recall_summary.json
 *
 * Env equivalents: PER_QUERY_DIR, QRELS_PATH, LABEL, OUTPUT_PATH.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

type Args = {
  perQueryDir: string;
  qrelsPath: string;
  label: string;
  outputPath: string;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value) throw new Error(`Missing value for --${key}`);
    (out as Record<string, string>)[key] = value;
    i += 1;
  }
  const a: Args = {
    perQueryDir: out.perQueryDir ?? process.env.PER_QUERY_DIR ?? "",
    qrelsPath: out.qrelsPath ?? process.env.QRELS_PATH ?? "",
    label: out.label ?? process.env.LABEL ?? "secondary",
    outputPath: out.outputPath ?? process.env.OUTPUT_PATH ?? "",
  };
  if (!a.perQueryDir || !a.qrelsPath || !a.outputPath) {
    throw new Error(
      "Required: --perQueryDir, --qrels, --output (or env PER_QUERY_DIR, QRELS_PATH, OUTPUT_PATH)",
    );
  }
  return a;
}

function loadQrels(path: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4) continue;
    const [qid, _, docid, rel] = t;
    if (Number.parseInt(rel, 10) <= 0) continue;
    if (!map.has(qid)) map.set(qid, new Set());
    map.get(qid)!.add(docid);
  }
  return map;
}

type Coverage = { hits: number; total: number; recall: number };
function coverage(retrieved: string[], relevant: Set<string>): Coverage {
  let hits = 0;
  for (const d of retrieved) if (relevant.has(d)) hits += 1;
  return {
    hits,
    total: relevant.size,
    recall: relevant.size > 0 ? hits / relevant.size : 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.perQueryDir)) {
    throw new Error(`perQueryDir not found: ${args.perQueryDir}`);
  }
  if (!existsSync(args.qrelsPath)) {
    throw new Error(`qrels file not found: ${args.qrelsPath}`);
  }

  const qrels = loadQrels(args.qrelsPath);
  const tiers = ["surfaced", "previewed", "opened", "cited"] as const;
  type Tier = (typeof tiers)[number];
  const macroAccum: Record<Tier, number[]> = {
    surfaced: [],
    previewed: [],
    opened: [],
    cited: [],
  };
  const microHits: Record<Tier, number> = { surfaced: 0, previewed: 0, opened: 0, cited: 0 };
  const microPos: Record<Tier, number> = { surfaced: 0, previewed: 0, opened: 0, cited: 0 };
  const perQuery: Array<Record<string, unknown>> = [];

  const evalFiles = readdirSync(args.perQueryDir)
    .filter((f) => f.endsWith("_eval.json"))
    .sort();

  let queriesWithQrels = 0;
  let queriesNoQrels = 0;
  for (const f of evalFiles) {
    const d = JSON.parse(readFileSync(resolve(args.perQueryDir, f), "utf8")) as {
      query_id?: string | number;
      retrieval?: {
        surfaced_docids?: string[];
        previewed_docids?: string[];
        opened_docids?: string[];
        cited_docids?: string[];
      };
    };
    const qid = String(d.query_id ?? "");
    if (!qid) continue;
    const relevant = qrels.get(qid);
    if (!relevant || relevant.size === 0) {
      queriesNoQrels += 1;
      continue;
    }
    queriesWithQrels += 1;
    const retr = d.retrieval ?? {};
    const row: Record<string, unknown> = { query_id: qid };
    for (const t of tiers) {
      const docids = (retr[`${t}_docids` as keyof typeof retr] as string[]) ?? [];
      const c = coverage(docids, relevant);
      macroAccum[t].push(c.recall);
      microHits[t] += c.hits;
      microPos[t] += c.total;
      row[`${t}_recall`] = c.recall;
      row[`${t}_hits`] = c.hits;
      row[`${t}_total`] = c.total;
    }
    perQuery.push(row);
  }

  const summary: Record<string, unknown> = {
    label: args.label,
    qrels_path: args.qrelsPath,
    per_query_dir: args.perQueryDir,
    queries_with_qrels: queriesWithQrels,
    queries_no_qrels: queriesNoQrels,
    queries_total: evalFiles.length,
  };
  for (const t of tiers) {
    const macro = macroAccum[t];
    const macroPct = macro.length
      ? (macro.reduce((a, b) => a + b, 0) / macro.length) * 100
      : 0;
    const microPct = microPos[t] > 0 ? (microHits[t] / microPos[t]) * 100 : 0;
    const labelTitle = t.charAt(0).toUpperCase() + t.slice(1);
    summary[`${labelTitle} Recall Macro (%)`] = Number(macroPct.toFixed(4));
    summary[`${labelTitle} Recall Micro (%)`] = Number(microPct.toFixed(4));
  }
  summary.per_query = perQuery;

  mkdirSync(dirname(args.outputPath), { recursive: true });
  writeFileSync(args.outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`Wrote recall summary (${args.label}): ${args.outputPath}`);
  console.log(
    `  queries: ${queriesWithQrels} with qrels (${queriesNoQrels} without)`,
  );
  for (const t of tiers) {
    const macro = summary[`${t.charAt(0).toUpperCase() + t.slice(1)} Recall Macro (%)`];
    const micro = summary[`${t.charAt(0).toUpperCase() + t.slice(1)} Recall Micro (%)`];
    console.log(`  ${t.padEnd(10)}  macro=${(macro as number).toFixed(2)}  micro=${(micro as number).toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { startBm25ServerTcp } from "../search-providers/anserini/bm25_server_process";
import { spawnPipedCommand, waitForChildExit } from "../runtime/process";
import { buildTsxCommand } from "../runtime/tsx";
import {
  parseInteger,
  readEnv,
  resolveBenchmarkQuerySetLaunchPlan,
  type BenchmarkQuerySetLaunchPlan,
} from "./benchmark_query_set_launch";
import {
  createBenchmarkManifestSnapshot,
  getDefaultBenchmarkId,
  listBenchmarks,
  resolveBenchmarkConfig,
} from "../benchmarks/registry";
import { resolveGitCommitProvenance } from "../runtime/git";

type Args = {
  benchmarkId?: string;
  querySetId?: string;
  shardCount?: number;
  model?: string;
  promptVariant?: string;
  outputDir?: string;
  timeoutSeconds?: number;
  thinking?: string;
  piBin?: string;
  extensionPath?: string;
  queryPath?: string;
  qrelsPath?: string;
  indexPath?: string;
  host?: string;
  port?: number;
  autoSummarizeOnMerge?: boolean;
  autoEvaluateOnMerge?: boolean;
  evaluateForce?: boolean;
  evaluateLimit?: number;
  maxShardAttempts?: number;
  shardRetryMode?: "auto" | "manual";
  dryRun: boolean;
};

type ShardedLaunchPlan = BenchmarkQuerySetLaunchPlan & {
  shardCount: number;
  host: string;
  port: number;
  outputRoot: string;
  logDir: string;
  bm25LogPath: string;
  shardQueryDir: string;
  shardOutputRoot: string;
  mergedOutputDir: string;
  controlDir: string;
  retryRequestPath: string;
  retryApprovalPath: string;
  autoSummarizeOnMerge: boolean;
  autoEvaluateOnMerge: boolean;
  evaluateForce: boolean;
  evaluateLimit: number;
  maxShardAttempts: number;
  shardRetryMode: "auto" | "manual";
  modelTag: string;
  runStamp: string;
  resolvedIndexPath: string;
};

type ShardFile = {
  shardName: string;
  path: string;
  queryCount: number;
};

type PersistedRunSetup = {
  slice?: string;
  model?: string;
  queryFile?: string;
  qrelsFile?: string;
  shardCount?: string;
  totalQueries?: string;
  timeoutSeconds?: string;
  indexPath?: string;
  bm25K1?: string;
  bm25B?: string;
  bm25Threads?: string;
  maxShardAttempts?: string;
  shardRetryMode?: string;
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`Expected 0 or 1, received ${value}`);
}

function formatRunStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("") +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function sanitizeModelTag(model: string): string {
  return model
    .replace(/^openai-codex\//, "")
    .replace(/^openai\//, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--benchmark":
        if (!next) throw new Error(`${arg} requires a value`);
        args.benchmarkId = next;
        index += 1;
        break;
      case "--querySet":
      case "--query-set":
        if (!next) throw new Error(`${arg} requires a value`);
        args.querySetId = next;
        index += 1;
        break;
      case "--shardCount":
      case "--shard-count":
        if (!next) throw new Error(`${arg} requires a value`);
        args.shardCount = parseInteger(next, "shardCount");
        index += 1;
        break;
      case "--model":
        if (!next) throw new Error(`${arg} requires a value`);
        args.model = next;
        index += 1;
        break;
      case "--promptVariant":
      case "--prompt-variant":
        if (!next) throw new Error(`${arg} requires a value`);
        args.promptVariant = next;
        index += 1;
        break;
      case "--outputDir":
      case "--output-dir":
      case "--outputRoot":
      case "--output-root":
        if (!next) throw new Error(`${arg} requires a value`);
        args.outputDir = next;
        index += 1;
        break;
      case "--timeoutSeconds":
      case "--timeout-seconds":
        if (!next) throw new Error(`${arg} requires a value`);
        args.timeoutSeconds = parseInteger(next, "timeoutSeconds");
        index += 1;
        break;
      case "--thinking":
        if (!next) throw new Error(`${arg} requires a value`);
        args.thinking = next;
        index += 1;
        break;
      case "--pi":
        if (!next) throw new Error(`${arg} requires a value`);
        args.piBin = next;
        index += 1;
        break;
      case "--extension":
        if (!next) throw new Error(`${arg} requires a value`);
        args.extensionPath = next;
        index += 1;
        break;
      case "--query":
      case "--queryFile":
      case "--query-file":
        if (!next) throw new Error(`${arg} requires a value`);
        args.queryPath = next;
        index += 1;
        break;
      case "--qrels":
        if (!next) throw new Error(`${arg} requires a value`);
        args.qrelsPath = next;
        index += 1;
        break;
      case "--indexPath":
      case "--index-path":
        if (!next) throw new Error(`${arg} requires a value`);
        args.indexPath = next;
        index += 1;
        break;
      case "--host":
        if (!next) throw new Error(`${arg} requires a value`);
        args.host = next;
        index += 1;
        break;
      case "--port":
        if (!next) throw new Error(`${arg} requires a value`);
        args.port = parseInteger(next, "port");
        index += 1;
        break;
      case "--autoSummarizeOnMerge":
      case "--auto-summarize-on-merge":
        args.autoSummarizeOnMerge = true;
        break;
      case "--noAutoSummarizeOnMerge":
      case "--no-auto-summarize-on-merge":
        args.autoSummarizeOnMerge = false;
        break;
      case "--autoEvaluateOnMerge":
      case "--auto-evaluate-on-merge":
        args.autoEvaluateOnMerge = true;
        break;
      case "--noAutoEvaluateOnMerge":
      case "--no-auto-evaluate-on-merge":
        args.autoEvaluateOnMerge = false;
        break;
      case "--evaluateForce":
      case "--evaluate-force":
        args.evaluateForce = true;
        break;
      case "--evaluateLimit":
      case "--evaluate-limit":
        if (!next) throw new Error(`${arg} requires a value`);
        args.evaluateLimit = parseInteger(next, "evaluateLimit");
        index += 1;
        break;
      case "--maxShardAttempts":
      case "--max-shard-attempts":
        if (!next) throw new Error(`${arg} requires a value`);
        args.maxShardAttempts = parseInteger(next, "maxShardAttempts");
        index += 1;
        break;
      case "--shardRetryMode":
      case "--shard-retry-mode":
        if (!next) throw new Error(`${arg} requires a value`);
        if (next !== "auto" && next !== "manual") {
          throw new Error(`shardRetryMode must be auto or manual; received ${next}`);
        }
        args.shardRetryMode = next;
        index += 1;
        break;
      case "--dryRun":
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Preferred package entrypoint: npm run run:benchmark:query-set:sharded-shared-bm25 -- [options]
Compatibility alias: npm run run:benchmark:query-set:sharded -- [options]
Low-level direct command: npx tsx src/orchestration/query_set_sharded_shared_bm25.ts [options]

Options:
  --benchmark <id>               Benchmark manifest id (default: ${getDefaultBenchmarkId()}; supported: ${listBenchmarks()
    .map((benchmark) => benchmark.id)
    .join(", ")})
  --query-set <id>               Query set id for the selected benchmark (default: benchmark default query set)
  --shard-count <n>
  --model <model>
  --prompt-variant <variant>
  --output-root <dir>
  --timeout-seconds <seconds>
  --thinking <level>
  --pi <path>
  --extension <path>
  --query-file <path>            Explicit override; wins over benchmark defaults
  --qrels <path>                 Explicit override; wins over benchmark defaults
  --index-path <path>            Explicit override; wins over benchmark defaults
  --host <host>
  --port <port>
  --max-shard-attempts <n>
  --shard-retry-mode <auto|manual>
  --auto-summarize-on-merge
  --no-auto-summarize-on-merge
  --auto-evaluate-on-merge
  --no-auto-evaluate-on-merge
  --evaluate-force
  --evaluate-limit <n>
  --dry-run
`);
}

async function resolveShardedLaunchPlan(args: Args): Promise<ShardedLaunchPlan> {
  const benchmarkPlan = resolveBenchmarkQuerySetLaunchPlan({
    benchmarkId: args.benchmarkId,
    querySetId: args.querySetId,
    model: args.model,
    promptVariant: args.promptVariant,
    timeoutSeconds: args.timeoutSeconds,
    thinking: args.thinking,
    piBin: args.piBin,
    extensionPath: args.extensionPath,
    queryPath: args.queryPath,
    qrelsPath: args.qrelsPath,
    indexPath: args.indexPath,
  });
  const shardCount =
    args.shardCount ??
    (readEnv("SHARD_COUNT") ? parseInteger(readEnv("SHARD_COUNT") as string, "SHARD_COUNT") : 4);
  if (shardCount <= 0) {
    throw new Error(`SHARD_COUNT must be a positive integer; got ${shardCount}`);
  }

  const host = args.host ?? readEnv("PI_BM25_RPC_HOST") ?? "127.0.0.1";
  // If PI_BM25_RPC_PORT is set (or args.port is provided), honor it exactly
  // and fail loudly on collision. Otherwise pick a random free port in
  // [50000, 60000) — avoids parallel-jobs-on-same-node port collisions.
  const explicitPort =
    args.port ??
    (readEnv("PI_BM25_RPC_PORT")
      ? parseInteger(readEnv("PI_BM25_RPC_PORT") as string, "PI_BM25_RPC_PORT")
      : undefined);
  const port = explicitPort ?? (await pickFreePort(host));
  const maxShardAttempts =
    args.maxShardAttempts ??
    (readEnv("MAX_SHARD_ATTEMPTS")
      ? parseInteger(readEnv("MAX_SHARD_ATTEMPTS") as string, "MAX_SHARD_ATTEMPTS")
      : 2);
  if (maxShardAttempts <= 0) {
    throw new Error(`MAX_SHARD_ATTEMPTS must be a positive integer; got ${maxShardAttempts}`);
  }

  const rawShardRetryMode = args.shardRetryMode ?? readEnv("SHARD_RETRY_MODE");
  const shardRetryMode = (rawShardRetryMode as "auto" | "manual" | undefined) ?? "auto";
  if (shardRetryMode !== "auto" && shardRetryMode !== "manual") {
    throw new Error(
      `SHARD_RETRY_MODE must be 'auto' or 'manual'; got ${String(rawShardRetryMode)}`,
    );
  }

  const modelTag = sanitizeModelTag(benchmarkPlan.model);
  const runStamp = formatRunStamp(new Date());
  const outputRoot =
    args.outputDir ??
    readEnv("OUTPUT_DIR") ??
    `runs/pi_bm25_${benchmarkPlan.benchmarkId}_${benchmarkPlan.querySetId}_${benchmarkPlan.piSearchPromptVariant}_${modelTag}_shared${shardCount}_${runStamp}`;
  const logDir = readEnv("LOG_DIR") ?? `${outputRoot}/logs`;

  return {
    ...benchmarkPlan,
    shardCount,
    host,
    port,
    outputRoot,
    logDir,
    bm25LogPath: resolve(REPO_ROOT, logDir, "bm25_server.log"),
    shardQueryDir: `${outputRoot}/shard-queries`,
    shardOutputRoot: `${outputRoot}/shard-runs`,
    mergedOutputDir: `${outputRoot}/merged`,
    controlDir: `${outputRoot}/_control`,
    retryRequestPath: `${outputRoot}/_control/shard_retry_request.json`,
    retryApprovalPath: `${outputRoot}/_control/shard_retry_approval.json`,
    autoSummarizeOnMerge:
      args.autoSummarizeOnMerge ?? parseBooleanFlag(readEnv("AUTO_SUMMARIZE_ON_MERGE"), true),
    autoEvaluateOnMerge:
      args.autoEvaluateOnMerge ?? parseBooleanFlag(readEnv("AUTO_EVALUATE_ON_MERGE"), false),
    evaluateForce: args.evaluateForce ?? parseBooleanFlag(readEnv("EVALUATE_FORCE"), false),
    evaluateLimit:
      args.evaluateLimit ??
      (readEnv("EVALUATE_LIMIT")
        ? parseInteger(readEnv("EVALUATE_LIMIT") as string, "EVALUATE_LIMIT")
        : 0),
    maxShardAttempts,
    shardRetryMode,
    modelTag,
    runStamp,
    resolvedIndexPath: resolve(REPO_ROOT, benchmarkPlan.indexPath),
  };
}

function printShardedLaunchPlan(plan: ShardedLaunchPlan): void {
  console.log(`BENCHMARK=${plan.benchmarkId}`);
  console.log(`QUERY_SET=${plan.querySetId}`);
  console.log(`PROMPT_VARIANT=${plan.piSearchPromptVariant}`);
  console.log(`MODEL=${plan.model}`);
  console.log(`QUERY_FILE=${plan.queryPath}`);
  console.log(`QRELS_FILE=${plan.qrelsPath}`);
  console.log(`EXTENSION=${plan.extensionPath}`);
  console.log(`OUTPUT_ROOT=${plan.outputRoot}`);
  console.log(`LOG_DIR=${plan.logDir}`);
  console.log(`INDEX_PATH=${plan.indexPath}`);
  console.log(`SHARD_COUNT=${plan.shardCount}`);
  console.log(`BM25_THREADS=${process.env.PI_BM25_THREADS?.trim() || "1"}`);
}

function ensureFileExists(path: string, label: string): void {
  if (!existsSync(resolve(REPO_ROOT, path))) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function ensureEmptyDirectory(path: string): void {
  const absolutePath = resolve(REPO_ROOT, path);
  if (!existsSync(absolutePath)) return;
  if (!statSync(absolutePath).isDirectory()) {
    throw new Error(`Refusing to reuse non-directory benchmark artifact path: ${path}`);
  }
  if (readdirSync(absolutePath).length > 0) {
    throw new Error(`Refusing to reuse non-empty benchmark artifact directory: ${path}`);
  }
}

function logLine(path: string, message: string): void {
  appendFileSync(resolve(REPO_ROOT, path), `${message}\n`, "utf8");
}

function readQueryLines(path: string): string[] {
  return readFileSync(resolve(REPO_ROOT, path), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      if (!line.includes("\t")) {
        throw new Error(`Invalid query TSV line ${index + 1}: expected query_id<TAB>query`);
      }
      return line;
    });
}

/** Exported for unit tests / smoke tests only — not intended for external use. */
export const __resumeInternals = {
  get scanCompletedQueryIds() {
    return scanCompletedQueryIds;
  },
  get scrubPartialRunArtifacts() {
    return scrubPartialRunArtifacts;
  },
};

/**
 * Scan shard-runs/ for already-finished queries — used by SKIP_EXISTING=1
 * resume mode. A query is considered "finished" if its `<qid>.json` exists
 * under any shard subdirectory AND has a recognised terminal status
 * ("completed" or "timeout"). Failed/crashed runs are not skipped.
 */
function scanCompletedQueryIds(plan: ShardedLaunchPlan): Set<string> {
  const done = new Set<string>();
  const shardRunsAbs = resolve(REPO_ROOT, plan.shardOutputRoot);
  if (!existsSync(shardRunsAbs)) return done;
  for (const shardEntry of readdirSync(shardRunsAbs, { withFileTypes: true })) {
    if (!shardEntry.isDirectory()) continue;
    const shardDir = resolve(shardRunsAbs, shardEntry.name);
    for (const file of readdirSync(shardDir)) {
      if (!file.endsWith(".json")) continue;
      if (file.includes("manifest") || file.includes("setup")) continue;
      try {
        const raw = JSON.parse(readFileSync(resolve(shardDir, file), "utf8")) as {
          query_id?: string | number;
          status?: string;
        };
        const qid = String(raw.query_id ?? file.replace(/\.json$/, ""));
        if (raw.status === "completed" || raw.status === "timeout") {
          done.add(qid);
        }
      } catch {
        // Corrupt JSON — treat as unfinished.
      }
    }
  }
  return done;
}

/**
 * Remove partial / in-flight per-query artifacts left behind by a previously
 * interrupted run. Required before the resume Stage 1 spawn so that:
 *   (a) the resume re-runs those queries cleanly (otherwise scanCompletedQueryIds
 *       wouldn't mark them done, but stale partial files would still be on disk);
 *   (b) if the resume's re-split assigns a re-run query to a DIFFERENT shard
 *       than the interrupted pass, mergeShardOutputs won't trip its
 *       conflicting-artifact check (the partial copy gets nuked first).
 *
 * Two pass scrub, per shard directory:
 *   Pass 1: walk `<qid>.json` files. For any with non-terminal / corrupt status,
 *           delete the .json + matching raw-events/<qid>.jsonl + stderr/<qid>.log.
 *   Pass 2: walk raw-events/*.jsonl + stderr/*.log. For any orphan whose qid has
 *           NO terminal-status .json in the same shard, delete it (this catches
 *           the "pi was killed mid-stream before writing the per-query JSON"
 *           case — only raw-events/<qid>.jsonl + stderr/<qid>.log exist, no .json).
 *
 * Returns the union of qids touched by either pass.
 */
function scrubPartialRunArtifacts(plan: ShardedLaunchPlan): Set<string> {
  const scrubbed = new Set<string>();
  const shardRunsAbs = resolve(REPO_ROOT, plan.shardOutputRoot);
  if (!existsSync(shardRunsAbs)) return scrubbed;

  for (const shardEntry of readdirSync(shardRunsAbs, { withFileTypes: true })) {
    if (!shardEntry.isDirectory()) continue;
    const shardDir = resolve(shardRunsAbs, shardEntry.name);

    // --- Pass 1: non-terminal / corrupt per-query JSONs.
    const terminalQids = new Set<string>(); // qids that survive Pass 1 (status=completed|timeout)
    for (const file of readdirSync(shardDir)) {
      if (!file.endsWith(".json")) continue;
      if (file.includes("manifest") || file.includes("setup")) continue;
      const jsonPath = resolve(shardDir, file);
      const qidFromName = file.replace(/\.json$/, "");
      let isTerminal = false;
      let qid = qidFromName;
      try {
        const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as {
          query_id?: string | number;
          status?: string;
        };
        qid = String(raw.query_id ?? qidFromName);
        isTerminal = raw.status === "completed" || raw.status === "timeout";
      } catch {
        // Corrupt → treat as partial → scrub.
      }
      if (isTerminal) {
        terminalQids.add(qid);
        terminalQids.add(qidFromName);
        continue;
      }
      rmSync(jsonPath, { force: true });
      rmSync(resolve(shardDir, "raw-events", `${qid}.jsonl`), { force: true });
      rmSync(resolve(shardDir, "raw-events", `${qidFromName}.jsonl`), { force: true });
      rmSync(resolve(shardDir, "stderr", `${qid}.log`), { force: true });
      rmSync(resolve(shardDir, "stderr", `${qidFromName}.log`), { force: true });
      scrubbed.add(qid);
    }

    // --- Pass 2: orphan raw-events / stderr files with no matching terminal JSON.
    const rawEventsDir = resolve(shardDir, "raw-events");
    if (existsSync(rawEventsDir)) {
      for (const f of readdirSync(rawEventsDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const qid = f.replace(/\.jsonl$/, "");
        if (terminalQids.has(qid)) continue;
        rmSync(resolve(rawEventsDir, f), { force: true });
        rmSync(resolve(shardDir, "stderr", `${qid}.log`), { force: true });
        scrubbed.add(qid);
      }
    }
    const stderrDir = resolve(shardDir, "stderr");
    if (existsSync(stderrDir)) {
      for (const f of readdirSync(stderrDir)) {
        if (!f.endsWith(".log")) continue;
        const qid = f.replace(/\.log$/, "");
        if (terminalQids.has(qid)) continue;
        rmSync(resolve(stderrDir, f), { force: true });
        scrubbed.add(qid);
      }
    }
  }
  return scrubbed;
}

function splitQueries(plan: ShardedLaunchPlan): ShardFile[] {
  const allQueries = readQueryLines(plan.queryPath);
  if (allQueries.length === 0) {
    throw new Error(`Input query TSV is empty: ${plan.queryPath}`);
  }

  // SKIP_EXISTING=1: filter out queries already complete from a prior interrupted
  // run. Output dirs are preserved (see main() — ensureEmptyDirectory is gated).
  const skipExisting = process.env.SKIP_EXISTING?.trim() === "1";
  let queries = allQueries;
  if (skipExisting) {
    const done = scanCompletedQueryIds(plan);
    if (done.size > 0) {
      queries = allQueries.filter((line) => {
        const qid = line.split("\t")[0];
        return !done.has(qid);
      });
      console.log(
        `SKIP_EXISTING=1: ${done.size}/${allQueries.length} queries already complete; ` +
          `processing ${queries.length} remaining.`,
      );
    } else {
      console.log("SKIP_EXISTING=1: no prior completed queries found; processing all.");
    }
  }

  mkdirSync(resolve(REPO_ROOT, plan.shardQueryDir), { recursive: true });
  const shards = Array.from({ length: plan.shardCount }, () => [] as string[]);
  queries.forEach((line, index) => {
    shards[index % plan.shardCount].push(line);
  });
  const files: ShardFile[] = [];
  shards.forEach((lines, index) => {
    const shardName = `shard_${String(index + 1).padStart(2, "0")}`;
    const relativePath = `${plan.shardQueryDir}/${shardName}.tsv`;
    writeFileSync(resolve(REPO_ROOT, relativePath), `${lines.join("\n")}\n`, "utf8");
    files.push({ shardName, path: relativePath, queryCount: lines.length });
  });
  return files;
}

function copyUniqueFile(sourcePath: string, destinationPath: string): void {
  const source = resolve(REPO_ROOT, sourcePath);
  const destination = resolve(REPO_ROOT, destinationPath);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    const left = readFileSync(source);
    const right = readFileSync(destination);
    if (!left.equals(right)) {
      throw new Error(`Conflicting artifact for ${destinationPath}`);
    }
    return;
  }
  copyFileSync(source, destination);
}

function collectRelativeFiles(rootPath: string): string[] {
  const absoluteRoot = resolve(REPO_ROOT, rootPath);
  if (!existsSync(absoluteRoot)) {
    return [];
  }
  const results: string[] = [];
  const walk = (currentRelative: string) => {
    const currentAbsolute = resolve(REPO_ROOT, currentRelative);
    for (const entry of readdirSync(currentAbsolute, { withFileTypes: true })) {
      const nextRelative = join(currentRelative, entry.name);
      if (entry.isDirectory()) {
        walk(nextRelative);
      } else {
        results.push(nextRelative);
      }
    }
  };
  walk(rootPath);
  return results;
}

function resolveEnvValue(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  return fallback;
}

function buildPersistedRunSetup(args: {
  querySetId: string;
  model: string;
  queryPath: string;
  qrelsPath: string;
  totalQueries: number;
  timeoutSeconds: number;
  indexPath: string;
}): PersistedRunSetup {
  return {
    slice: args.querySetId,
    model: args.model,
    queryFile: args.queryPath,
    qrelsFile: args.qrelsPath,
    shardCount: resolveEnvValue("SHARD_COUNT"),
    totalQueries: String(args.totalQueries),
    timeoutSeconds: String(args.timeoutSeconds),
    indexPath: args.indexPath,
    bm25K1: resolveEnvValue("PI_BM25_K1", "25"),
    bm25B: resolveEnvValue("PI_BM25_B", "1"),
    bm25Threads: resolveEnvValue("PI_BM25_THREADS", "1"),
    maxShardAttempts: resolveEnvValue("MAX_SHARD_ATTEMPTS"),
    shardRetryMode: resolveEnvValue("SHARD_RETRY_MODE"),
  };
}

function writeMergedRunMetadata(plan: ShardedLaunchPlan, totalQueries: number): void {
  const benchmarkConfig = resolveBenchmarkConfig({
    benchmarkId: plan.benchmarkId,
    querySetId: plan.querySetId,
    queryPath: plan.queryPath,
    qrelsPath: plan.qrelsPath,
    indexPath: plan.indexPath,
  });
  const benchmarkManifestSnapshot = createBenchmarkManifestSnapshot(
    benchmarkConfig,
    resolveGitCommitProvenance(REPO_ROOT),
  );
  writeFileSync(
    resolve(REPO_ROOT, plan.mergedOutputDir, "benchmark_manifest_snapshot.json"),
    `${JSON.stringify(benchmarkManifestSnapshot, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    resolve(REPO_ROOT, plan.mergedOutputDir, "run_setup.json"),
    `${JSON.stringify(
      buildPersistedRunSetup({
        querySetId: plan.querySetId,
        model: plan.model,
        queryPath: plan.queryPath,
        qrelsPath: plan.qrelsPath,
        totalQueries,
        timeoutSeconds: plan.timeoutSeconds,
        indexPath: plan.indexPath,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function mergeShardOutputs(
  plan: ShardedLaunchPlan,
  shardNames: string[],
  totalQueries: number,
): void {
  mkdirSync(resolve(REPO_ROOT, plan.mergedOutputDir), { recursive: true });
  for (const shardName of shardNames) {
    const shardRoot = `${plan.shardOutputRoot}/${shardName}`;
    for (const relativePath of collectRelativeFiles(shardRoot)) {
      const fromShard = relativePath.slice(`${shardRoot}/`.length);
      const allowedTopLevelQueryJson =
        /^[^/]+\.json$/u.test(fromShard) &&
        !fromShard.includes("/") &&
        fromShard !== "benchmark_manifest_snapshot.json" &&
        fromShard !== "run_setup.json";
      const allowed =
        allowedTopLevelQueryJson ||
        /^raw-events\/[^/]+\.jsonl$/u.test(fromShard) ||
        /^stderr\/[^/]+\.log$/u.test(fromShard);
      if (!allowed) continue;
      copyUniqueFile(relativePath, `${plan.mergedOutputDir}/${fromShard}`);
    }
  }
  writeMergedRunMetadata(plan, totalQueries);
}

async function isTcpPortListening(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = net.createConnection({ host, port });
    const finish = (listening: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(listening);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Find a free TCP port in the [50000, 60000) range. Used when the caller
 * didn't explicitly set PI_BM25_RPC_PORT — picks a random starting point and
 * scans up to N candidates. Avoids collision when multiple parallel SLURM
 * jobs land on the same node (they'd otherwise all try to bind the same
 * default port and all but the first would fail).
 */
async function pickFreePort(host: string, attempts = 20): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    // Random port in [50000, 60000); the first try is purely random so two
    // parallel processes are unlikely to collide.
    const candidate = 50000 + Math.floor(Math.random() * 10000);
    // eslint-disable-next-line no-await-in-loop
    if (!(await isTcpPortListening(host, candidate))) return candidate;
  }
  throw new Error(
    `pickFreePort: could not find a free port on ${host} in ${attempts} attempts (range 50000-59999)`,
  );
}

async function startBm25Server(plan: ShardedLaunchPlan) {
  return await startBm25ServerTcp({
    cwd: REPO_ROOT,
    indexPath: plan.resolvedIndexPath,
    host: plan.host,
    port: plan.port,
    logPath: plan.bm25LogPath,
    env: process.env,
  });
}

function spawnShard(plan: ShardedLaunchPlan, shard: ShardFile, attempt: number): ChildProcess {
  const shardOutputDir = `${plan.shardOutputRoot}/${shard.shardName}`;
  mkdirSync(resolve(REPO_ROOT, shardOutputDir), { recursive: true });
  const shardLogPath = resolve(REPO_ROOT, plan.logDir, `${shard.shardName}.log`);
  const args = buildTsxCommand("src/orchestration/query_set.ts", [
    "--benchmark",
    plan.benchmarkId,
    "--query-set",
    plan.querySetId,
    "--query-file",
    shard.path,
    "--output-dir",
    shardOutputDir,
    "--model",
    plan.model,
    "--thinking",
    plan.thinking,
    "--extension",
    plan.extensionPath,
    "--pi",
    plan.piBin,
    "--timeout-seconds",
    String(plan.timeoutSeconds),
    "--prompt-variant",
    plan.piSearchPromptVariant,
    "--qrels",
    plan.qrelsPath,
    "--index-path",
    plan.indexPath,
  ]);
  const child = spawnPipedCommand(
    args,
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PI_BM25_RPC_HOST: plan.host,
        PI_BM25_RPC_PORT: String(plan.port),
        BENCHMARK: plan.benchmarkId,
        QUERY_SET: plan.querySetId,
        BENCH_MANAGED_RUN_ID: process.env.BENCH_MANAGED_RUN_ID ?? "",
        BENCH_EVENTS_PATH: process.env.BENCH_EVENTS_PATH ?? "",
      },
    },
    shard.shardName,
  );
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    throw new Error(`Failed to capture shard output for ${shard.shardName}`);
  }
  if (attempt > 1) {
    appendFileSync(
      shardLogPath,
      `\n===== retry attempt ${attempt}/${plan.maxShardAttempts} for ${shard.shardName} =====\n`,
      "utf8",
    );
  }
  stdout.on("data", (chunk) => {
    appendFileSync(shardLogPath, chunk);
  });
  stderr.on("data", (chunk) => {
    appendFileSync(shardLogPath, chunk);
  });
  return child;
}

function writeRetryRequest(plan: ShardedLaunchPlan, round: number, shards: string[]): void {
  writeFileSync(
    resolve(REPO_ROOT, plan.retryRequestPath),
    `${JSON.stringify(
      {
        requested_at: Math.floor(Date.now() / 1000),
        round,
        shards,
        max_attempts: plan.maxShardAttempts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function waitForRetryApproval(
  plan: ShardedLaunchPlan,
  round: number,
  shards: string[],
): Promise<void> {
  writeRetryRequest(plan, round, shards);
  rmSync(resolve(REPO_ROOT, plan.retryApprovalPath), { force: true });
  logLine(
    plan.logDir + "/run.log",
    `Waiting for retry approval for failed shards: ${shards.join(" ")}`,
  );
  while (true) {
    if (existsSync(resolve(REPO_ROOT, plan.retryApprovalPath))) {
      rmSync(resolve(REPO_ROOT, plan.retryRequestPath), { force: true });
      rmSync(resolve(REPO_ROOT, plan.retryApprovalPath), { force: true });
      logLine(plan.logDir + "/run.log", `Retry approved for shards: ${shards.join(" ")}`);
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
}

async function runSummarize(plan: ShardedLaunchPlan): Promise<void> {
  const summarizeLog = resolve(REPO_ROOT, plan.logDir, "summarize.log");
  const args = buildTsxCommand("src/evaluation/summarize_run.ts", [
    "--benchmark",
    plan.benchmarkId,
    "--runDir",
    plan.outputRoot,
    "--qrels",
    plan.qrelsPath,
  ]);
  const child = spawnPipedCommand(
    args,
    {
      cwd: REPO_ROOT,
      env: process.env,
    },
    "summarize run",
  );
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) throw new Error("Failed to capture summarize output");
  stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    appendFileSync(summarizeLog, chunk);
  });
  stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(summarizeLog, chunk);
  });
  const status = await waitForChildExit(child, "summarize run");
  if (status !== 0) {
    throw new Error(`summarize run exited with status ${status}`);
  }
}

async function runEvaluate(plan: ShardedLaunchPlan): Promise<void> {
  const evaluateLog = resolve(REPO_ROOT, plan.logDir, "evaluate.log");
  const args = buildTsxCommand("src/evaluation/evaluate_run_with_pi.ts", [
    "--benchmark",
    plan.benchmarkId,
    "--inputDir",
    plan.outputRoot,
    "--model",
    plan.model,
    "--thinking",
    plan.thinking,
    "--pi",
    plan.piBin,
  ]);
  if (plan.evaluateForce) {
    args.push("--force");
  }
  if (plan.evaluateLimit !== 0) {
    args.push("--limit", String(plan.evaluateLimit));
  }
  const child = spawnPipedCommand(
    args,
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BENCHMARK: plan.benchmarkId,
        QREL_EVIDENCE: plan.qrelsPath,
      },
    },
    "evaluate run",
  );
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) throw new Error("Failed to capture evaluate output");
  stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    appendFileSync(evaluateLog, chunk);
  });
  stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(evaluateLog, chunk);
  });
  const status = await waitForChildExit(child, "evaluate run");
  if (status !== 0) {
    throw new Error(`evaluate run exited with status ${status}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = await resolveShardedLaunchPlan(args);
  ensureFileExists(plan.queryPath, "Query file");
  ensureFileExists(plan.qrelsPath, "Qrels file");
  ensureFileExists(plan.extensionPath, "Extension path");
  printShardedLaunchPlan(plan);

  if (args.dryRun || readEnv("PI_SERINI_DRY_RUN") === "1") {
    return;
  }

  // SKIP_EXISTING=1: preserve shard-runs/ and merged/ from a prior run; only
  // wipe shard-queries/ since we'll re-emit it with only the not-yet-done IDs.
  const skipExistingForDirs = process.env.SKIP_EXISTING?.trim() === "1";
  if (skipExistingForDirs) {
    // shard-queries can be re-written; clean it.
    const shardQueriesAbs = resolve(REPO_ROOT, plan.shardQueryDir);
    if (existsSync(shardQueriesAbs)) {
      for (const f of readdirSync(shardQueriesAbs)) {
        rmSync(resolve(shardQueriesAbs, f), { force: true });
      }
    }
    mkdirSync(shardQueriesAbs, { recursive: true });
    mkdirSync(resolve(REPO_ROOT, plan.shardOutputRoot), { recursive: true });
    mkdirSync(resolve(REPO_ROOT, plan.mergedOutputDir), { recursive: true });
    console.log("SKIP_EXISTING=1: shard-runs/ and merged/ preserved for resume.");
    // Scrub partial / non-terminal per-query artifacts so the resume can
    // safely re-run those queries (avoids merge conflict if a re-run lands
    // on a different shard than the original pass).
    const scrubbed = scrubPartialRunArtifacts(plan);
    if (scrubbed.size > 0) {
      console.log(
        `SKIP_EXISTING=1: scrubbed ${scrubbed.size} partial/in-flight query artifact(s): ` +
          `${[...scrubbed].sort().slice(0, 10).join(",")}${scrubbed.size > 10 ? " …" : ""}`,
      );
    }
  } else {
    ensureEmptyDirectory(plan.shardQueryDir);
    ensureEmptyDirectory(plan.shardOutputRoot);
    ensureEmptyDirectory(plan.mergedOutputDir);
  }
  mkdirSync(resolve(REPO_ROOT, plan.logDir), { recursive: true });
  mkdirSync(resolve(REPO_ROOT, plan.controlDir), { recursive: true });

  if (await isTcpPortListening(plan.host, plan.port)) {
    throw new Error(
      `Port ${plan.port} is already in use. ` +
        (process.env.PI_BM25_RPC_PORT
          ? `PI_BM25_RPC_PORT was set explicitly; pick a different port or stop the existing listener.`
          : `Unexpected — a randomly chosen free port collided. Try again or set PI_BM25_RPC_PORT explicitly.`),
    );
  }

  const queries = readQueryLines(plan.queryPath);
  const runLogPath = `${plan.logDir}/run.log`;
  writeFileSync(resolve(REPO_ROOT, runLogPath), "", "utf8");
  logLine(runLogPath, `BENCHMARK=${plan.benchmarkId}`);
  logLine(runLogPath, `QUERY_SET=${plan.querySetId}`);
  logLine(runLogPath, `PROMPT_VARIANT=${plan.piSearchPromptVariant}`);
  logLine(runLogPath, `MODEL=${plan.model}`);
  logLine(runLogPath, `QUERY_FILE=${plan.queryPath}`);
  logLine(runLogPath, `QRELS_FILE=${plan.qrelsPath}`);
  logLine(runLogPath, `OUTPUT_ROOT=${plan.outputRoot}`);
  logLine(runLogPath, `OUTPUT_DIR=${plan.outputRoot}`);
  logLine(runLogPath, `MERGED_OUTPUT_DIR=${plan.mergedOutputDir}`);
  logLine(runLogPath, `SHARD_QUERY_DIR=${plan.shardQueryDir}`);
  logLine(runLogPath, `SHARD_OUTPUT_ROOT=${plan.shardOutputRoot}`);
  logLine(runLogPath, `SHARD_COUNT=${plan.shardCount}`);
  logLine(runLogPath, `TOTAL_QUERIES=${queries.length}`);
  logLine(runLogPath, `TIMEOUT_SECONDS=${plan.timeoutSeconds}`);
  logLine(runLogPath, `INDEX_PATH=${plan.indexPath}`);
  logLine(runLogPath, `BM25_K1=${process.env.PI_BM25_K1?.trim() || "25"}`);
  logLine(runLogPath, `BM25_B=${process.env.PI_BM25_B?.trim() || "1"}`);
  logLine(runLogPath, `BM25_THREADS=${process.env.PI_BM25_THREADS?.trim() || "1"}`);
  logLine(runLogPath, `MAX_SHARD_ATTEMPTS=${plan.maxShardAttempts}`);
  logLine(runLogPath, `SHARD_RETRY_MODE=${plan.shardRetryMode}`);

  logLine(runLogPath, `Splitting ${plan.queryPath} into ${plan.shardCount} shards`);
  const shardFiles = splitQueries(plan);
  appendFileSync(
    resolve(REPO_ROOT, plan.logDir, "shard_split.log"),
    `${shardFiles.map((file) => `${file.path}\t${file.queryCount}`).join("\n")}\n`,
    "utf8",
  );

  console.log(`Starting shared BM25 RPC daemon on ${plan.host}:${plan.port}`);
  console.log(`INDEX_PATH=${plan.resolvedIndexPath}`);
  console.log(`BM25_K1=${process.env.PI_BM25_K1?.trim() || "25"}`);
  console.log(`BM25_B=${process.env.PI_BM25_B?.trim() || "1"}`);
  console.log(`BM25_THREADS=${process.env.PI_BM25_THREADS?.trim() || "1"}`);

  let server: Awaited<ReturnType<typeof startBm25Server>> | undefined;
  const cleanup = () => {
    rmSync(resolve(REPO_ROOT, plan.retryRequestPath), { force: true });
    rmSync(resolve(REPO_ROOT, plan.retryApprovalPath), { force: true });
    server?.stop();
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  let status = 0;
  try {
    server = await startBm25Server(plan);
    logLine(runLogPath, `Shared BM25 RPC daemon ready. Log: ${plan.bm25LogPath}`);

    const attempts = new Map<string, number>(shardFiles.map((file) => [file.shardName, 1]));
    let pending = [...shardFiles];
    let round = 1;

    // Optional stagger between shard subprocess spawns. Used to test whether
    // concurrent gpt-5 API contention is the bottleneck on sharded runs.
    // env: PI_SHARD_LAUNCH_DELAY_MS (default 0 = simultaneous, original behavior)
    const shardLaunchDelayMs = Math.max(
      0,
      Number.parseInt(process.env.PI_SHARD_LAUNCH_DELAY_MS ?? "0", 10) || 0,
    );

    while (pending.length > 0) {
      logLine(runLogPath, `Starting shard execution round ${round} for ${pending.length} shard(s)`);
      if (shardLaunchDelayMs > 0) {
        logLine(
          runLogPath,
          `Staggering shard spawns by ${shardLaunchDelayMs}ms (PI_SHARD_LAUNCH_DELAY_MS)`,
        );
      }
      const launched: { shard: ShardFile; child: ChildProcess }[] = [];
      for (let i = 0; i < pending.length; i += 1) {
        const shard = pending[i];
        if (i > 0 && shardLaunchDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, shardLaunchDelayMs));
        }
        launched.push({
          shard,
          child: spawnShard(plan, shard, attempts.get(shard.shardName) ?? 1),
        });
      }
      const results = await Promise.all(
        launched.map(async ({ shard, child }) => ({
          shard,
          status: await waitForChildExit(child, shard.shardName),
        })),
      );

      const failed = results.filter((result) => result.status !== 0).map((result) => result.shard);
      if (failed.length === 0) {
        pending = [];
        break;
      }

      const nextPending: ShardFile[] = [];
      for (const shard of failed) {
        const attempt = attempts.get(shard.shardName) ?? 1;
        if (attempt < plan.maxShardAttempts) {
          attempts.set(shard.shardName, attempt + 1);
          nextPending.push(shard);
        } else {
          logLine(
            runLogPath,
            `Shard ${shard.shardName} failed after ${attempt}/${plan.maxShardAttempts} attempts`,
          );
          status = 1;
        }
      }

      if (nextPending.length > 0) {
        if (plan.shardRetryMode === "manual") {
          await waitForRetryApproval(
            plan,
            round,
            nextPending.map((shard) => shard.shardName),
          );
        } else {
          logLine(
            runLogPath,
            `Retrying failed shards: ${nextPending.map((shard) => shard.shardName).join(" ")}`,
          );
        }
      }
      pending = nextPending;
      round += 1;
    }

    mergeShardOutputs(
      plan,
      shardFiles.map((file) => file.shardName),
      shardFiles.reduce((sum, file) => sum + file.queryCount, 0),
    );
    logLine(runLogPath, `Merging shard outputs into ${plan.mergedOutputDir}`);
    appendFileSync(
      resolve(REPO_ROOT, plan.logDir, "merge.log"),
      `Merged ${shardFiles.length} shard directories into ${plan.mergedOutputDir}\n`,
      "utf8",
    );

    if (plan.autoSummarizeOnMerge) {
      logLine(runLogPath, `Summarizing merged run ${plan.outputRoot}`);
      await runSummarize(plan);
    }

    if (plan.autoEvaluateOnMerge) {
      if (status !== 0) {
        logLine(
          runLogPath,
          "Skipping AUTO_EVALUATE_ON_MERGE because one or more shard workers failed.",
        );
      } else {
        logLine(runLogPath, `Evaluating merged run ${plan.outputRoot}`);
        await runEvaluate(plan);
      }
    }

    logLine(runLogPath, `Finished sharded benchmark run status=${status}`);
    logLine(
      runLogPath,
      `Artifacts: output_root=${plan.outputRoot} merged=${plan.mergedOutputDir} logs=${plan.logDir}`,
    );
  } finally {
    cleanup();
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
  }

  process.exit(status);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

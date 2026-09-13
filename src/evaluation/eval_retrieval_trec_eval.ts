import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import { getDefaultBenchmarkId, resolveBenchmarkConfig } from "../benchmarks/registry";
import {
  buildTrecEvalCommands,
  parseTrecEvalMetricOutput,
  resolveAnseriniJarPath,
  validateTrecEvalInputs,
} from "./trec_eval_runner";
import { resolveRetrievalEvalSummaryPath } from "../runtime/output_layout";
import { writeRetrievalEvalSummary } from "./retrieval_eval_summary";
import { resolveBenchmarkRetrievalEvaluation } from "./benchmark_evaluation";

type Args = {
  benchmarkId: string;
  querySetId?: string;
  qrelsPath?: string;
  runFilePath: string;
  anseriniJarPath: string;
  summaryPath?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    benchmarkId: getDefaultBenchmarkId(),
    runFilePath: "",
    anseriniJarPath: resolveAnseriniJarPath(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--benchmark":
        if (!next) throw new Error(`${arg} requires a value`);
        args.benchmarkId = resolveBenchmarkConfig({ benchmarkId: next }).benchmark.id;
        index += 1;
        break;
      case "--querySet":
      case "--query-set":
        if (!next) throw new Error(`${arg} requires a value`);
        args.querySetId = next;
        index += 1;
        break;
      case "--qrels":
        if (!next) throw new Error(`${arg} requires a value`);
        args.qrelsPath = next;
        index += 1;
        break;
      case "--runFile":
      case "--run-file":
        if (!next) throw new Error(`${arg} requires a value`);
        args.runFilePath = next;
        index += 1;
        break;
      case "--anseriniJar":
      case "--anserini-jar":
        if (!next) throw new Error(`${arg} requires a value`);
        args.anseriniJarPath = next;
        index += 1;
        break;
      case "--summaryPath":
      case "--summary-path":
        if (!next) throw new Error(`${arg} requires a value`);
        args.summaryPath = next;
        index += 1;
        break;
      case "--help":
      case "-h":
        printHelpAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.runFilePath) {
    throw new Error("--runFile is required");
  }
  return args;
}

function printHelpAndExit(): never {
  console.log(`Usage: npx tsx src/evaluation/eval_retrieval_trec_eval.ts --benchmark <id> --runFile <path> [options]

Options:
  --benchmark                     Benchmark manifest id (default: ${getDefaultBenchmarkId()})
  --query-set                     Query set id for benchmark-specific qrels resolution
  --qrels                         Explicit qrels override
  --runFile, --run-file          TREC run file to evaluate with trec_eval
  --anseriniJar, --anserini-jar  Anserini fatjar path (default: vendor/anserini/anserini-1.6.0-fatjar.jar)
  --summaryPath, --summary-path  Optional JSON summary output path
  --help, -h                     Show this help
`);
  process.exit(0);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const benchmarkConfig = resolveBenchmarkConfig({
    benchmarkId: args.benchmarkId,
    querySetId: args.querySetId,
    qrelsPath: args.qrelsPath,
  });
  const retrievalEvaluation = resolveBenchmarkRetrievalEvaluation({
    benchmarkId: benchmarkConfig.benchmark.id,
    sourceType: "run-file",
  });
  if (retrievalEvaluation.selectedBackend !== "trec_eval" || !retrievalEvaluation.trecEvalMetrics) {
    throw new Error(
      `Benchmark ${benchmarkConfig.benchmark.id} is not configured for trec_eval run-file evaluation.`,
    );
  }

  validateTrecEvalInputs({
    anseriniJarPath: args.anseriniJarPath,
    qrelsPath: benchmarkConfig.qrelsPath,
    runFilePath: args.runFilePath,
  });

  const commands = buildTrecEvalCommands({
    anseriniJarPath: args.anseriniJarPath,
    qrelsPath: benchmarkConfig.qrelsPath,
    runFilePath: args.runFilePath,
    metrics: retrievalEvaluation.trecEvalMetrics,
  });

  const metricSemantics = retrievalEvaluation.internalMetricSemantics;

  const summaryPath = resolve(
    args.summaryPath ??
      resolveRetrievalEvalSummaryPath({
        benchmarkId: benchmarkConfig.benchmark.id,
        sourcePath: args.runFilePath,
      }),
  );
  const metrics = [];

  for (const { metricId, command } of commands) {
    console.log(`=== ${metricId} ===`);
    console.log(JSON.stringify(command));
    const result = spawnSync(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        [`trec_eval failed for metric ${metricId}`, result.stdout.trim(), result.stderr.trim()]
          .filter((part) => part.length > 0)
          .join("\n\n"),
      );
    }
    if (result.stdout.trim()) {
      console.log(result.stdout.trim());
      metrics.push(parseTrecEvalMetricOutput(result.stdout));
    }
    if (result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
    console.log("");
  }

  mkdirSync(dirname(summaryPath), { recursive: true });
  writeRetrievalEvalSummary(summaryPath, {
    benchmarkId: benchmarkConfig.benchmark.id,
    querySetId: benchmarkConfig.querySetId,
    backend: "trec_eval",
    sourceType: "run-file",
    sourcePath: resolve(args.runFilePath),
    qrelsPath: resolve(benchmarkConfig.qrelsPath),
    queryCount: undefined,
    metricSemantics: {
      ndcgGainMode: metricSemantics.ndcgGainMode,
      recallRelevantThreshold: metricSemantics.recallRelevantThreshold,
      binaryRelevantThreshold: metricSemantics.binaryRelevantThreshold,
    },
    metrics,
  });
  console.log(`SUMMARY_PATH=${summaryPath}`);
}

main();

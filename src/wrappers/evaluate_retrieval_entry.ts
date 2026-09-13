import {
  printCommandJson,
  printCommandPlan,
  readEnv,
  resolveRetrievalEvaluationSourcePath,
  resolveWrapperQrels,
} from "./downstream_tool_wrappers";
import { resolveRetrievalEvalSummaryPath } from "../runtime/output_layout";
import { resolveAnseriniJarPath } from "../evaluation/trec_eval_runner";
import { resolveBenchmarkRetrievalEvaluation } from "../evaluation/benchmark_evaluation";
import { buildTsxCommand } from "../runtime/tsx";
import { runInheritedCommandSync } from "../runtime/process";

type Args = {
  benchmarkId?: string;
  querySetId?: string;
  qrelsPath?: string;
  secondaryQrelsPath?: string;
  secondaryQrelsDisabled: boolean;
  runFile?: string;
  runDir?: string;
  queryTsv?: string;
  writeRunFile?: string;
  recallCutoffs?: string;
  ndcgCutoffs?: string;
  mrrCutoffs?: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { secondaryQrelsDisabled: false, dryRun: false };
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
      case "--qrels":
        if (!next) throw new Error(`${arg} requires a value`);
        args.qrelsPath = next;
        index += 1;
        break;
      case "--secondaryQrels":
      case "--secondary-qrels":
        if (!next) throw new Error(`${arg} requires a value`);
        args.secondaryQrelsPath = next;
        index += 1;
        break;
      case "--noSecondaryQrels":
      case "--no-secondary-qrels":
        args.secondaryQrelsDisabled = true;
        args.secondaryQrelsPath = undefined;
        break;
      case "--runFile":
      case "--run-file":
        if (!next) throw new Error(`${arg} requires a value`);
        args.runFile = next;
        index += 1;
        break;
      case "--runDir":
      case "--run-dir":
        if (!next) throw new Error(`${arg} requires a value`);
        args.runDir = next;
        index += 1;
        break;
      case "--queries":
      case "--queryTsv":
      case "--query-tsv":
        if (!next) throw new Error(`${arg} requires a value`);
        args.queryTsv = next;
        index += 1;
        break;
      case "--writeRunFile":
      case "--write-run-file":
        if (!next) throw new Error(`${arg} requires a value`);
        args.writeRunFile = next;
        index += 1;
        break;
      case "--recallCutoffs":
      case "--recall-cutoffs":
        if (!next) throw new Error(`${arg} requires a value`);
        args.recallCutoffs = next;
        index += 1;
        break;
      case "--ndcgCutoffs":
      case "--ndcg-cutoffs":
        if (!next) throw new Error(`${arg} requires a value`);
        args.ndcgCutoffs = next;
        index += 1;
        break;
      case "--mrrCutoffs":
      case "--mrr-cutoffs":
        if (!next) throw new Error(`${arg} requires a value`);
        args.mrrCutoffs = next;
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
  console.log(`Preferred package entrypoint: RUN_DIR=runs/<run> npm run evaluate:retrieval
Low-level direct command: npx tsx src/wrappers/evaluate_retrieval_entry.ts [options]

Options:
  --benchmark <id>
  --query-set <id>
  --qrels <path>
  --secondary-qrels <path>
  --no-secondary-qrels
  --run-file <path>
  --run-dir <path>
  --queries <path>
  --write-run-file <path>
  --recall-cutoffs <csv>
  --ndcg-cutoffs <csv>
  --mrr-cutoffs <csv>
  --dry-run

Semantics:
  Benchmarks may choose different retrieval-eval backends. For example, msmarco-v1-passage run-file evaluation
  uses trec_eval, while run-dir evaluation continues to use the repo's internal TypeScript agent-set metrics.
`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runFile = args.runFile ?? readEnv("RUN_FILE");
  const runDir = args.runDir ?? readEnv("RUN_DIR");
  if (!!runFile === !!runDir) {
    throw new Error("Specify exactly one of RUN_FILE or RUN_DIR");
  }

  const qrelsResolution = resolveWrapperQrels({
    benchmarkId: args.benchmarkId,
    querySetId: args.querySetId ?? readEnv("QUERY_SET"),
    runPath: runDir,
    qrelsPath: args.qrelsPath,
    secondaryQrelsPath: args.secondaryQrelsPath,
    secondaryQrelsDisabled: args.secondaryQrelsDisabled,
  });

  const queryTsv = args.queryTsv ?? readEnv("QUERY_TSV");
  const writeRunFile = args.writeRunFile ?? readEnv("WRITE_RUN_FILE");
  const retrievalEvaluation = resolveBenchmarkRetrievalEvaluation({
    benchmarkId: qrelsResolution.benchmarkId,
    sourceType: runFile ? "run-file" : "run-dir",
  });
  const useTrecEvalBackend = retrievalEvaluation.selectedBackend === "trec_eval";

  if (useTrecEvalBackend) {
    if (qrelsResolution.secondaryQrelsPath) {
      throw new Error(
        `Secondary qrels are not supported with trec_eval backend for benchmark ${qrelsResolution.benchmarkConfig.benchmark.id}.`,
      );
    }
    if (queryTsv) {
      throw new Error(
        `--queries is not supported with trec_eval backend for benchmark ${qrelsResolution.benchmarkConfig.benchmark.id}.`,
      );
    }
    if (writeRunFile) {
      throw new Error(
        `--writeRunFile is not supported with trec_eval backend for benchmark ${qrelsResolution.benchmarkConfig.benchmark.id}.`,
      );
    }
  }

  const retrievalSourcePath = resolveRetrievalEvaluationSourcePath({
    runFile,
    runDir,
  });
  const retrievalSummaryPath = resolveRetrievalEvalSummaryPath({
    benchmarkId: qrelsResolution.benchmarkConfig.benchmark.id,
    sourcePath: retrievalSourcePath,
  });

  const command = useTrecEvalBackend
    ? buildTsxCommand("src/evaluation/eval_retrieval_trec_eval.ts", [
        "--benchmark",
        qrelsResolution.benchmarkId,
        "--query-set",
        qrelsResolution.querySetId,
        "--qrels",
        qrelsResolution.qrelsPath,
        "--runFile",
        runFile ?? "",
        "--anserini-jar",
        resolveAnseriniJarPath(process.env),
        "--summary-path",
        retrievalSummaryPath ?? "",
      ])
    : buildTsxCommand("src/evaluation/eval_retrieval.ts", [
        "--benchmark",
        qrelsResolution.benchmarkId,
        "--query-set",
        qrelsResolution.querySetId,
        "--recallCutoffs",
        args.recallCutoffs ?? readEnv("RECALL_CUTOFFS") ?? "100,1000",
        "--ndcgCutoffs",
        args.ndcgCutoffs ?? readEnv("NDCG_CUTOFFS") ?? "10",
        "--mrrCutoffs",
        args.mrrCutoffs ?? readEnv("MRR_CUTOFFS") ?? "10",
      ]);

  if (!useTrecEvalBackend) {
    command.push("--summary-path", retrievalSummaryPath);
    if (qrelsResolution.includePrimaryQrelsOverride) {
      command.push("--qrels", qrelsResolution.qrelsPath);
    }
    if (qrelsResolution.secondaryQrelsPath) {
      command.push("--secondaryQrels", qrelsResolution.secondaryQrelsPath);
    }
    if (runFile) {
      command.push("--runFile", runFile);
    }
    if (runDir) {
      command.push("--runDir", retrievalSourcePath);
    }
    if (queryTsv) {
      command.push("--queries", queryTsv);
    }
    if (writeRunFile) {
      command.push("--writeRunFile", writeRunFile);
    }
  }

  printCommandPlan({
    BENCHMARK: qrelsResolution.benchmarkId,
    RUN_FILE: runFile,
    RUN_DIR: runDir,
    RETRIEVAL_SOURCE_PATH: retrievalSourcePath,
    QUERY_SET: qrelsResolution.querySetId,
    RETRIEVAL_EVAL_BACKEND: retrievalEvaluation.selectedBackend,
    USE_RUN_MANIFEST_DEFAULTS: qrelsResolution.manifestPresent,
    QRELS_FILE: useTrecEvalBackend
      ? qrelsResolution.qrelsPath
      : qrelsResolution.includePrimaryQrelsOverride
        ? qrelsResolution.qrelsPath
        : undefined,
    SECONDARY_QRELS_FILE: qrelsResolution.secondaryQrelsPath,
    RETRIEVAL_SUMMARY_PATH: retrievalSummaryPath,
  });
  printCommandJson(command);

  if (args.dryRun || readEnv("PI_SERINI_DRY_RUN") === "1") {
    return;
  }

  runInheritedCommandSync(command);
}

main();

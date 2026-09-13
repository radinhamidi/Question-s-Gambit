import {
  getBenchmarkDefinition,
  resolveInternalRetrievalMetricSemantics,
} from "../benchmarks/registry";
import type {
  BenchmarkJudgeEvalMode,
  BenchmarkRetrievalEvalBackend,
  BenchmarkTrecEvalMetricDefinition,
} from "../benchmarks/types";

export type BenchmarkRetrievalSourceType = "run-file" | "run-dir";

export type ResolvedBenchmarkRetrievalEvaluation = {
  benchmarkId: string;
  sourceType: BenchmarkRetrievalSourceType;
  selectedBackend: BenchmarkRetrievalEvalBackend;
  runFileBackend: BenchmarkRetrievalEvalBackend;
  runDirBackend: BenchmarkRetrievalEvalBackend;
  trecEvalMetrics?: BenchmarkTrecEvalMetricDefinition[];
  internalMetricSemantics: ReturnType<typeof resolveInternalRetrievalMetricSemantics>;
};

export type ResolvedBenchmarkJudgeEvaluation = {
  benchmarkId: string;
  supportedModes: BenchmarkJudgeEvalMode[];
  defaultMode: BenchmarkJudgeEvalMode;
};

export function resolveBenchmarkRetrievalEvaluation(options: {
  benchmarkId?: string;
  sourceType: BenchmarkRetrievalSourceType;
}): ResolvedBenchmarkRetrievalEvaluation {
  const benchmark = getBenchmarkDefinition(options.benchmarkId);
  const retrievalEvaluation = benchmark.retrievalEvaluation;
  return {
    benchmarkId: benchmark.id,
    sourceType: options.sourceType,
    selectedBackend:
      options.sourceType === "run-file"
        ? retrievalEvaluation.runFileBackend
        : retrievalEvaluation.runDirBackend,
    runFileBackend: retrievalEvaluation.runFileBackend,
    runDirBackend: retrievalEvaluation.runDirBackend,
    trecEvalMetrics: retrievalEvaluation.trecEvalMetrics,
    internalMetricSemantics: resolveInternalRetrievalMetricSemantics(benchmark.id),
  };
}

export function resolveBenchmarkJudgeEvaluation(options: {
  benchmarkId?: string;
  groundTruthConfigured?: boolean;
}): ResolvedBenchmarkJudgeEvaluation {
  const benchmark = getBenchmarkDefinition(options.benchmarkId);
  const configured = benchmark.judgeEvaluation;
  if (configured) {
    return {
      benchmarkId: benchmark.id,
      supportedModes: [...configured.supportedModes],
      defaultMode: configured.defaultMode,
    };
  }

  const fallbackDefaultMode = options.groundTruthConfigured ? "gold-answer" : "reference-free";
  return {
    benchmarkId: benchmark.id,
    supportedModes: [fallbackDefaultMode],
    defaultMode: fallbackDefaultMode,
  };
}

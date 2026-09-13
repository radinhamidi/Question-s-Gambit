import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDefaultBenchmarkId, resolveBenchmarkConfig } from "../benchmarks/registry";
import { detectBenchmarkManifestSnapshot } from "../benchmarks/run_manifest";
import type { ResolvedBenchmarkConfig } from "../benchmarks/types";
import { getJudgeEvalSummaryCandidates } from "../runtime/output_layout";
import { resolveBenchmarkResultDir } from "../evaluation/retrieval_metrics";

export function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function hasEnv(name: string): boolean {
  return Object.hasOwn(process.env, name);
}

export function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an integer; received ${value}`);
  }
  return parsed;
}

export function resolveBenchmarkIdFromRunPath(options: {
  benchmarkId?: string;
  runPath?: string;
}): {
  benchmarkId: string;
  querySetId?: string;
  manifestPresent: boolean;
} {
  const manifest = options.runPath ? detectBenchmarkManifestSnapshot(options.runPath) : null;
  if (manifest) {
    return {
      benchmarkId: manifest.snapshot.benchmark_id,
      querySetId: manifest.snapshot.query_set_id,
      manifestPresent: true,
    };
  }

  const benchmarkId = resolveBenchmarkConfig({
    benchmarkId: options.benchmarkId ?? readEnv("BENCHMARK") ?? getDefaultBenchmarkId(),
  }).benchmark.id;
  return { benchmarkId, querySetId: undefined, manifestPresent: false };
}

export function resolveSecondaryQrelsForWrapper(options: {
  benchmarkId: string;
  querySetId?: string;
  manifestPresent: boolean;
  explicitWasSet: boolean;
  explicitValue?: string;
}): string | undefined {
  if (options.explicitWasSet) {
    return options.explicitValue;
  }
  if (options.manifestPresent) {
    return undefined;
  }
  const secondaryPath = resolveBenchmarkConfig({
    benchmarkId: options.benchmarkId,
    querySetId: options.querySetId,
  }).secondaryQrelsPath;
  if (!secondaryPath) {
    return undefined;
  }
  return existsSync(resolve(secondaryPath)) ? secondaryPath : undefined;
}

export function detectShellCompatibleEvalSummary(
  runDir: string,
  benchmarkId: string,
  explicitPath?: string,
): string | undefined {
  if (explicitPath) {
    return explicitPath;
  }

  return getJudgeEvalSummaryCandidates({ runDir, benchmarkId }).find((candidate) =>
    existsSync(candidate),
  );
}

export function resolveRetrievalEvaluationSourcePath(options: {
  runFile?: string;
  runDir?: string;
}): string {
  if (options.runFile) {
    return resolve(options.runFile);
  }
  if (options.runDir) {
    return resolveBenchmarkResultDir(resolve(options.runDir));
  }
  throw new Error("Specify exactly one of runFile or runDir");
}

export function printCommandPlan(
  details: Record<string, string | number | boolean | undefined>,
): void {
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;
    console.log(`${key}=${String(value)}`);
  }
}

export function printCommandJson(command: string[]): void {
  console.log(`COMMAND_JSON=${JSON.stringify(command)}`);
}

export type ResolvedRunBenchmarkContext = {
  benchmarkId: string;
  querySetId: string;
  manifestPresent: boolean;
  benchmarkConfig: ResolvedBenchmarkConfig;
};

export function resolveRunBenchmarkContext(options: {
  benchmarkId?: string;
  querySetId?: string;
  runPath?: string;
}): ResolvedRunBenchmarkContext {
  const benchmarkResolution = resolveBenchmarkIdFromRunPath({
    benchmarkId: options.benchmarkId,
    runPath: options.runPath,
  });
  const querySetId = options.querySetId ?? benchmarkResolution.querySetId;
  const benchmarkConfig = resolveBenchmarkConfig({
    benchmarkId: benchmarkResolution.benchmarkId,
    querySetId,
  });
  return {
    benchmarkId: benchmarkResolution.benchmarkId,
    querySetId: benchmarkConfig.querySetId,
    manifestPresent: benchmarkResolution.manifestPresent,
    benchmarkConfig,
  };
}

export type ResolvedWrapperQrels = ResolvedRunBenchmarkContext & {
  qrelsWasSet: boolean;
  qrelsPath: string;
  includePrimaryQrelsOverride: boolean;
  secondaryQrelsWasSet: boolean;
  secondaryQrelsPath?: string;
};

export function resolveWrapperQrels(options: {
  benchmarkId?: string;
  querySetId?: string;
  runPath?: string;
  qrelsPath?: string;
  secondaryQrelsPath?: string;
  secondaryQrelsDisabled?: boolean;
  qrelsEnvName?: string;
  secondaryQrelsEnvName?: string;
}): ResolvedWrapperQrels {
  const qrelsEnvName = options.qrelsEnvName ?? "QRELS_FILE";
  const secondaryQrelsEnvName = options.secondaryQrelsEnvName ?? "SECONDARY_QRELS_FILE";
  const context = resolveRunBenchmarkContext({
    benchmarkId: options.benchmarkId,
    querySetId: options.querySetId,
    runPath: options.runPath,
  });
  const qrelsWasSet = options.qrelsPath !== undefined || hasEnv(qrelsEnvName);
  const qrelsPath = options.qrelsPath ?? readEnv(qrelsEnvName) ?? context.benchmarkConfig.qrelsPath;
  const secondaryQrelsWasSet =
    Boolean(options.secondaryQrelsDisabled) ||
    options.secondaryQrelsPath !== undefined ||
    hasEnv(secondaryQrelsEnvName);
  const secondaryQrelsPath = options.secondaryQrelsDisabled
    ? undefined
    : resolveSecondaryQrelsForWrapper({
        benchmarkId: context.benchmarkId,
        querySetId: context.querySetId,
        manifestPresent: context.manifestPresent,
        explicitWasSet: secondaryQrelsWasSet,
        explicitValue: options.secondaryQrelsPath ?? readEnv(secondaryQrelsEnvName),
      });

  return {
    ...context,
    qrelsWasSet,
    qrelsPath,
    includePrimaryQrelsOverride: !context.manifestPresent || qrelsWasSet,
    secondaryQrelsWasSet,
    secondaryQrelsPath,
  };
}

export type ResolvedJudgeWrapperInputs = ResolvedRunBenchmarkContext & {
  groundTruthWasSet: boolean;
  groundTruthPath: string;
  includeGroundTruthOverride: boolean;
  qrelEvidenceWasSet: boolean;
  qrelEvidencePath: string;
  includeQrelEvidenceOverride: boolean;
};

export function resolveJudgeWrapperInputs(options: {
  benchmarkId?: string;
  runPath?: string;
  groundTruthPath?: string;
  qrelEvidencePath?: string;
  groundTruthEnvName?: string;
  qrelEvidenceEnvName?: string;
}): ResolvedJudgeWrapperInputs {
  const groundTruthEnvName = options.groundTruthEnvName ?? "GROUND_TRUTH";
  const qrelEvidenceEnvName = options.qrelEvidenceEnvName ?? "QREL_EVIDENCE";
  const context = resolveRunBenchmarkContext({
    benchmarkId: options.benchmarkId,
    runPath: options.runPath,
  });
  const groundTruthWasSet = options.groundTruthPath !== undefined || hasEnv(groundTruthEnvName);
  const qrelEvidenceWasSet = options.qrelEvidencePath !== undefined || hasEnv(qrelEvidenceEnvName);
  const groundTruthPath =
    options.groundTruthPath ??
    readEnv(groundTruthEnvName) ??
    context.benchmarkConfig.groundTruthPath ??
    "";
  const qrelEvidencePath =
    options.qrelEvidencePath ?? readEnv(qrelEvidenceEnvName) ?? context.benchmarkConfig.qrelsPath;

  return {
    ...context,
    groundTruthWasSet,
    groundTruthPath,
    includeGroundTruthOverride: !context.manifestPresent || groundTruthWasSet,
    qrelEvidenceWasSet,
    qrelEvidencePath,
    includeQrelEvidenceOverride: !context.manifestPresent || qrelEvidenceWasSet,
  };
}

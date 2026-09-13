import type { PiSearchPromptVariant } from "../pi-search/agent_prompt";

export type BenchmarkManagedPresetLaunchMode = "shared" | "sharded";

export type BenchmarkManagedPresetDefinition = {
  id: string;
  querySetId: string;
  launchMode: BenchmarkManagedPresetLaunchMode;
  launcherScript: string;
  outputDirTemplate: string;
  logDirTemplate: string;
  launcherEnv?: Record<string, string>;
  defaultShardCount?: number;
};

export const BENCHMARK_SETUP_STEPS = ["setup", "ground-truth", "query-slices"] as const;

export type BenchmarkSetupStep = (typeof BENCHMARK_SETUP_STEPS)[number];

export function isBenchmarkSetupStep(value: string): value is BenchmarkSetupStep {
  return BENCHMARK_SETUP_STEPS.includes(value as BenchmarkSetupStep);
}

export type BenchmarkSetupDefinition = {
  steps: Partial<Record<BenchmarkSetupStep, string>>;
};

export type BenchmarkRetrievalEvalBackend = "internal" | "trec_eval";

export type BenchmarkTrecEvalMetricDefinition = {
  id: string;
  args: string[];
};

export type BenchmarkNdcgGainMode = "exponential" | "linear";

export type BenchmarkInternalRetrievalMetricSemantics = {
  ndcgGainMode?: BenchmarkNdcgGainMode;
  recallRelevantThreshold?: number;
  binaryRelevantThreshold?: number;
};

export type BenchmarkRetrievalEvaluationDefinition = {
  runFileBackend: BenchmarkRetrievalEvalBackend;
  runDirBackend: BenchmarkRetrievalEvalBackend;
  trecEvalMetrics?: BenchmarkTrecEvalMetricDefinition[];
  internalMetrics?: BenchmarkInternalRetrievalMetricSemantics;
};

export type BenchmarkJudgeEvalMode = "gold-answer" | "reference-free";

export type BenchmarkJudgeEvaluationDefinition = {
  supportedModes: BenchmarkJudgeEvalMode[];
  defaultMode: BenchmarkJudgeEvalMode;
};

export type BenchmarkQuerySetDefinition = {
  queryPath: string;
  qrelsPath?: string;
  secondaryQrelsPath?: string;
  groundTruthPath?: string;
  indexPath?: string;
  compareBaselineRunPath?: string;
};

export type BenchmarkDefinition = {
  id: string;
  aliases: string[];
  displayName: string;
  datasetId: string;
  piSearchPromptVariant: PiSearchPromptVariant;
  defaultQuerySetId: string;
  defaultQueryPath: string;
  querySets: Record<string, string | BenchmarkQuerySetDefinition>;
  defaultQrelsPath: string;
  defaultSecondaryQrelsPath?: string;
  defaultGroundTruthPath?: string;
  defaultIndexPath: string;
  defaultCompareQuerySetId?: string;
  defaultBaselineRunPath?: string;
  managedPresets: Record<string, BenchmarkManagedPresetDefinition>;
  setup: BenchmarkSetupDefinition;
  retrievalEvaluation: BenchmarkRetrievalEvaluationDefinition;
  judgeEvaluation?: BenchmarkJudgeEvaluationDefinition;
};

export type ResolvedBenchmarkConfig = {
  benchmark: BenchmarkDefinition;
  querySetId: string;
  queryPath: string;
  qrelsPath: string;
  secondaryQrelsPath?: string;
  groundTruthPath?: string;
  indexPath: string;
};

export type ResolvedBenchmarkCompareConfig = ResolvedBenchmarkConfig & {
  baselineRunPath?: string;
};

export type BenchmarkManifestInputHash = {
  exists: boolean;
  algorithm?: "sha256";
  sha256?: string;
  bytes?: number;
};

export type BenchmarkManifestInputHashes = {
  query: BenchmarkManifestInputHash;
  qrels: BenchmarkManifestInputHash;
  secondary_qrels?: BenchmarkManifestInputHash;
  ground_truth?: BenchmarkManifestInputHash;
};

export type BenchmarkManifestSnapshot = {
  benchmark_id: string;
  benchmark_display_name: string;
  dataset_id: string;
  query_set_id: string;
  prompt_variant: PiSearchPromptVariant;
  query_path: string;
  qrels_path: string;
  secondary_qrels_path?: string;
  ground_truth_path?: string;
  index_path: string;
  input_hashes?: BenchmarkManifestInputHashes;
  git_commit?: string;
  git_commit_short?: string;
};

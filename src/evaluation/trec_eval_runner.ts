import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { BenchmarkTrecEvalMetricDefinition } from "../benchmarks/types";
import type { RetrievalEvalMetricSummary, RetrievalEvalSummary } from "./retrieval_eval_summary";

export type TrecEvalCommandSpec = {
  metricId: string;
  command: string[];
};

export type TrecEvalMetricResult = RetrievalEvalMetricSummary;

export type TrecEvalSummary = RetrievalEvalSummary & {
  anseriniJarPath: string;
};

export function resolveAnseriniJarPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ANSERINI_JAR?.trim() || env.ANSERINI_FATJAR_PATH?.trim();
  return configured && configured.length > 0
    ? configured
    : "vendor/anserini/anserini-1.6.0-fatjar.jar";
}

export function buildTrecEvalCommands(options: {
  anseriniJarPath: string;
  qrelsPath: string;
  runFilePath: string;
  metrics: BenchmarkTrecEvalMetricDefinition[];
}): TrecEvalCommandSpec[] {
  const jarPath = resolve(options.anseriniJarPath);
  const qrelsPath = resolve(options.qrelsPath);
  const runFilePath = resolve(options.runFilePath);
  return options.metrics.map((metric) => ({
    metricId: metric.id,
    command: ["java", "-cp", jarPath, "trec_eval", ...metric.args, qrelsPath, runFilePath],
  }));
}

export function parseTrecEvalMetricOutput(stdout: string): TrecEvalMetricResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const metricLine = lines.find((line) => /\s+/.test(line));
  if (!metricLine) {
    throw new Error(`Could not parse trec_eval output: ${stdout}`);
  }
  const parts = metricLine.split(/\s+/);
  if (parts.length < 3) {
    throw new Error(`Could not parse trec_eval metric line: ${metricLine}`);
  }
  const [metric, scope, valueRaw] = parts;
  const value = Number.parseFloat(valueRaw);
  if (!Number.isFinite(value)) {
    throw new Error(`Could not parse trec_eval metric value from line: ${metricLine}`);
  }
  return {
    metric,
    scope,
    value,
    stdout: stdout.trim(),
  };
}

export function validateTrecEvalInputs(options: {
  anseriniJarPath: string;
  qrelsPath: string;
  runFilePath: string;
}): void {
  const missing: string[] = [];
  if (!existsSync(resolve(options.anseriniJarPath))) {
    missing.push(`Anserini fatjar does not exist: ${resolve(options.anseriniJarPath)}`);
  }
  if (!existsSync(resolve(options.qrelsPath))) {
    missing.push(`Qrels file does not exist: ${resolve(options.qrelsPath)}`);
  }
  if (!existsSync(resolve(options.runFilePath))) {
    missing.push(`Run file does not exist: ${resolve(options.runFilePath)}`);
  }
  if (missing.length > 0) {
    throw new Error(missing.join("\n"));
  }
}

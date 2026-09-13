/**
 * scripts/judge_arm_concurrent.ts
 *
 * Re-judge any arm's merged/ output via direct OpenAI API calls to /v1/responses,
 * with bounded concurrency. Output schema is byte-identical to the live judge so
 * the existing summary aggregator (evaluate_run_with_pi_entry.ts) can consume it.
 *
 * Why direct API (not pi subprocess):
 *   - Codex models (gpt-5.3-codex etc.) are NOT supported by pi's `openai/`
 *     provider via /v1/chat/completions ("not a chat model"), AND pi's
 *     `openai-codex/` provider requires ChatGPT Plus OAuth login (we don't have).
 *   - Codex models ARE supported via OpenAI's /v1/responses endpoint with a
 *     standard OPENAI_API_KEY. We just call it directly here — same model,
 *     same prompt, same parser as pi-serini's upstream live judge.
 *   - No subprocess overhead, easy to parallelize, easier to debug.
 *
 * Default judge model: `gpt-5.3-codex` (matches upstream pi-serini's default,
 * minus the `openai-codex/` namespace prefix which we don't need on /v1/responses).
 *
 * Usage:
 *   npx tsx scripts/judge_arm_concurrent.ts --armDir <path> [options]
 *
 * Required env: OPENAI_API_KEY
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { createJudgePrompt } from "../src/evaluation/judge_prompt";
import { parseJudgeResponse, type JudgeResult } from "../src/evaluation/judge_parse";
import {
  loadGroundTruth,
  loadQueryTexts,
  resolveQuestionText,
  getRunJsonPaths,
  getFinalResponse,
  computeCoverageMetrics,
  computeCitationMetrics,
  type RunResultRecord,
  type EvaluationRecord,
  type JudgeUsage,
} from "../src/evaluation/evaluate_run_with_pi";
import { loadJudgeEvalRelevantDocids } from "../src/evaluation/judge_eval_qrels";
import {
  getSurfacedDocids,
  getPreviewedDocids,
  getOpenedDocids,
  getCitedDocids,
  getAgentDocids,
} from "../src/evaluation/run_docid_views";
import {
  extractResponseSelfReportedConfidence,
  resolveResponseCalibrationConfidence,
} from "../src/evaluation/calibration";
import { getBenchmarkDefinition } from "../src/benchmarks/registry";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const OPENAI_API_BASE = "https://api.openai.com";

type CliArgs = {
  armDir: string;
  judgeModel: string;
  judgeModelDisplay: string;
  benchmark: string;
  judgeMode: "gold-answer" | "reference-free";
  evalDir: string;
  concurrency: number;
  timeoutSeconds: number;
  endpoint: string;
  smoke: number;
  force: boolean;
  noSummary: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  // Default model id = bare "gpt-5.3-codex" (what OpenAI's API expects).
  // The display id = "openai-codex/gpt-5.3-codex" so eval JSON model_info matches
  // upstream pi-serini's namespaced default for downstream comparison.
  const args: CliArgs = {
    armDir: "",
    judgeModel: "gpt-5.3-codex",
    judgeModelDisplay: "openai-codex/gpt-5.3-codex",
    benchmark: "browsecomp-plus",
    judgeMode: "gold-answer",
    evalDir: "",
    concurrency: 16,
    timeoutSeconds: 180,
    endpoint: "/v1/responses",
    smoke: 0,
    force: false,
    noSummary: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const n = argv[i + 1];
    switch (a) {
      case "--armDir":
      case "--arm-dir":
        args.armDir = n;
        i += 1;
        break;
      case "--judge-model":
        // Strip pi-style namespace prefix if user passes the upstream id.
        args.judgeModel = n.startsWith("openai-codex/") ? n.slice("openai-codex/".length) :
                         n.startsWith("openai/") ? n.slice("openai/".length) : n;
        i += 1;
        break;
      case "--judge-model-display":
        args.judgeModelDisplay = n;
        i += 1;
        break;
      case "--benchmark":
        args.benchmark = n;
        i += 1;
        break;
      case "--judge-mode":
        if (n !== "gold-answer" && n !== "reference-free") {
          throw new Error(`--judge-mode must be gold-answer or reference-free, got ${n}`);
        }
        args.judgeMode = n;
        i += 1;
        break;
      case "--eval-dir":
        args.evalDir = n;
        i += 1;
        break;
      case "--concurrency":
        args.concurrency = Math.max(1, Number.parseInt(n, 10));
        i += 1;
        break;
      case "--timeout-seconds":
        args.timeoutSeconds = Number.parseInt(n, 10);
        i += 1;
        break;
      case "--endpoint":
        args.endpoint = n;
        i += 1;
        break;
      case "--smoke":
        args.smoke = Number.parseInt(n, 10);
        i += 1;
        break;
      case "--force":
        args.force = true;
        break;
      case "--no-summary":
        args.noSummary = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "scripts/judge_arm_concurrent.ts — concurrent live-API judge via direct /v1/responses calls.",
            "",
            "Usage:",
            "  npx tsx scripts/judge_arm_concurrent.ts --armDir <path> [options]",
            "",
            "Options:",
            "  --armDir <path>              arm directory (must contain merged/<qid>.json)",
            "  --judge-model <id>           OpenAI API model id (default: gpt-5.3-codex)",
            "                               accepts upstream-style 'openai-codex/<id>' too — prefix is stripped",
            "  --judge-model-display <id>   recorded in eval JSON model_info (default: openai-codex/gpt-5.3-codex)",
            "  --benchmark <id>             default: browsecomp-plus",
            "  --judge-mode <mode>          gold-answer | reference-free (default: gold-answer)",
            "  --eval-dir <path>            default: evals/pi_judge_codex53/<bench>/<arm>",
            "  --concurrency <n>            parallel API calls (default: 16)",
            "  --timeout-seconds <n>        per-call timeout (default: 180)",
            "  --endpoint <url>             /v1/responses (default) or /v1/chat/completions",
            "  --smoke <n>                  only process first N queries (for testing)",
            "  --force                      re-judge queries even if eval JSON exists",
            "  --no-summary                 skip the final summary step",
            "",
            "Required env: OPENAI_API_KEY",
          ].join("\n"),
        );
        process.exit(0);
      default:
        throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (!args.armDir) throw new Error("--armDir is required");
  return args;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";

type DirectJudgeResult = {
  text: string;
  usage: { input: number; output: number; cacheRead: number };
  elapsedSeconds: number;
  timedOut: boolean;
  error?: string;
};

async function callJudgeApi(opts: {
  model: string;
  endpoint: string;
  prompt: string;
  timeoutSeconds: number;
}): Promise<DirectJudgeResult> {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY env var is required");
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutSeconds * 1000);
  let body: any;
  if (opts.endpoint === "/v1/responses") {
    body = { model: opts.model, input: opts.prompt };
  } else {
    body = {
      model: opts.model,
      messages: [{ role: "user", content: opts.prompt }],
    };
  }
  try {
    const res = await fetch(`${OPENAI_API_BASE}${opts.endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const elapsedSeconds = (Date.now() - t0) / 1000;
    if (!res.ok) {
      const errText = await res.text();
      return {
        text: "",
        usage: { input: 0, output: 0, cacheRead: 0 },
        elapsedSeconds,
        timedOut: false,
        error: `HTTP ${res.status}: ${errText.slice(0, 500)}`,
      };
    }
    const json: any = await res.json();
    return { ...extractJudgeText(json, opts.endpoint), elapsedSeconds, timedOut: false };
  } catch (err: any) {
    clearTimeout(timer);
    const elapsedSeconds = (Date.now() - t0) / 1000;
    const aborted = err?.name === "AbortError";
    return {
      text: "",
      usage: { input: 0, output: 0, cacheRead: 0 },
      elapsedSeconds,
      timedOut: aborted,
      error: aborted ? `timeout after ${opts.timeoutSeconds}s` : String(err?.message ?? err),
    };
  }
}

function extractJudgeText(
  responseBody: any,
  endpoint: string,
): { text: string; usage: { input: number; output: number; cacheRead: number } } {
  if (endpoint === "/v1/responses") {
    let text = "";
    if (typeof responseBody?.output_text === "string") {
      text = responseBody.output_text;
    } else {
      const output = responseBody?.output ?? [];
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item?.type === "message" && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
              else if (typeof c?.text === "string") text += c.text;
            }
          }
        }
      }
    }
    const usage = responseBody?.usage ?? {};
    return {
      text,
      usage: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.input_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
  // /v1/chat/completions
  const choices = responseBody?.choices ?? [];
  const text = choices[0]?.message?.content ?? "";
  const usage = responseBody?.usage ?? {};
  return {
    text: typeof text === "string" ? text : "",
    usage: {
      input: usage.prompt_tokens ?? 0,
      output: usage.completion_tokens ?? 0,
      cacheRead: usage.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

function makeEmptyJudgeUsage(): JudgeUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    assistantTurnsWithUsage: 0,
  };
}

type PerQueryBuildResult = {
  jsonPath: string;
  qid: string;
  baseRecord: Omit<EvaluationRecord, "judge_prompt" | "judge_response" | "judge_result" | "citations" | "question" | "judge_usage"> & {
    question: string;
  };
  judgePrompt: string;
  positives: string[];
  citedDocids: string[];
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Resolve any registered benchmark (browsecomp-plus, multihoprag, ...) so ground truth,
  // qrels and query paths come from the right dataset. Judging a MultiHop-RAG arm against
  // BrowseComp-Plus answers produces a plausible-looking but meaningless accuracy, so this
  // must never fall back to a fixed benchmark.
  const bench = getBenchmarkDefinition(args.benchmark);
  args.benchmark = bench.id;

  const armDirAbs = args.armDir.startsWith("/")
    ? args.armDir
    : resolvePath(REPO_ROOT, args.armDir);
  if (!existsSync(armDirAbs)) throw new Error(`armDir not found: ${armDirAbs}`);
  const armBasename = basename(armDirAbs);
  const mergedDir = resolvePath(armDirAbs, "merged");
  if (!existsSync(mergedDir)) {
    throw new Error(`merged/ not found in ${armDirAbs} — run finalize_arm.sh first`);
  }

  const evalDirRel = args.evalDir || `evals/pi_judge_codex53/${args.benchmark}/${armBasename}`;
  const evalDir = resolvePath(REPO_ROOT, evalDirRel);
  const perQueryDir = resolvePath(evalDir, "per-query");
  ensureDir(perQueryDir);

  const slugMatch = armBasename.match(new RegExp(`^pi_bm25_${args.benchmark}_(\\w+)_qg_dx`));
  const querySetId = slugMatch ? slugMatch[1] : "qfull";
  const queryPath =
    (bench.querySets as Record<string, string>)[querySetId] ?? bench.defaultQueryPath;
  const queryPathAbs = resolvePath(REPO_ROOT, queryPath);
  const groundTruthPath = resolvePath(REPO_ROOT, bench.defaultGroundTruthPath ?? "");
  const qrelsPath = resolvePath(REPO_ROOT, bench.defaultQrelsPath);

  console.log("=".repeat(60));
  console.log(`  judge_arm_concurrent (direct API, no pi subprocess)`);
  console.log(`  armDir:       ${armDirAbs}`);
  console.log(`  benchmark:    ${args.benchmark}  querySet=${querySetId}`);
  console.log(`  judge model:  ${args.judgeModel}  (display=${args.judgeModelDisplay})`);
  console.log(`  endpoint:     ${args.endpoint}`);
  console.log(`  judge mode:   ${args.judgeMode}`);
  console.log(`  concurrency:  ${args.concurrency}`);
  console.log(`  timeout:      ${args.timeoutSeconds}s per call`);
  console.log(`  eval dir:     ${evalDirRel}`);
  console.log(`  queryPath:    ${queryPath}`);
  console.log("=".repeat(60));

  const groundTruth =
    args.judgeMode === "gold-answer" ? await loadGroundTruth(groundTruthPath) : undefined;
  const queryTexts = loadQueryTexts(queryPathAbs);
  const qrelEvidence = loadJudgeEvalRelevantDocids(qrelsPath, { benchmarkId: args.benchmark });

  const jsonPaths = getRunJsonPaths(mergedDir, 0);
  if (jsonPaths.length === 0) throw new Error(`No JSONs in ${mergedDir}`);
  const limited = args.smoke > 0 ? jsonPaths.slice(0, args.smoke) : jsonPaths;
  console.log(
    `Found ${jsonPaths.length} merged JSONs; processing ${limited.length}` +
      (args.smoke > 0 ? ` (smoke=${args.smoke})` : ""),
  );

  // Pre-build records
  const queue: PerQueryBuildResult[] = [];
  let writtenIncomplete = 0;
  let skippedExisting = 0;
  for (const jsonPath of limited) {
    const qid = basename(jsonPath).replace(/\.json$/, "");
    const evalPath = resolvePath(perQueryDir, `${qid}_eval.json`);
    if (existsSync(evalPath) && !args.force) {
      skippedExisting += 1;
      continue;
    }

    const runData = JSON.parse(readFileSync(jsonPath, "utf8")) as RunResultRecord;
    const queryId = String(runData.query_id ?? qid);
    const gt = groundTruth?.get(queryId);
    if (args.judgeMode === "gold-answer" && !gt) {
      console.warn(`[${qid}] missing ground truth; skipping`);
      continue;
    }
    const question = resolveQuestionText({
      runData,
      queryId,
      queryTexts,
      groundTruth: gt,
    });
    if (!question) {
      console.warn(`[${qid}] missing question text; skipping`);
      continue;
    }
    const runModel =
      typeof runData.metadata?.model === "string" ? (runData.metadata.model as string) : null;
    const response = getFinalResponse(runData);
    const responseConfidence = extractResponseSelfReportedConfidence(response);
    const calibrationConfidence = resolveResponseCalibrationConfidence(response);
    const surfacedDocids = [...getSurfacedDocids(runData)].sort();
    const previewedDocids = [...getPreviewedDocids(runData)].sort();
    const openedDocids = [...getOpenedDocids(runData)].sort();
    const citedDocids = [...getCitedDocids(runData)].sort();
    const agentDocids = [...getAgentDocids(runData)].sort();
    const positives = qrelEvidence.get(queryId) ?? [];
    const surfaced = computeCoverageMetrics(surfacedDocids, positives);
    const previewed = computeCoverageMetrics(previewedDocids, positives);
    const agent = computeCoverageMetrics(agentDocids, positives);
    const opened = computeCoverageMetrics(openedDocids, positives);
    const cited = computeCoverageMetrics(citedDocids, positives);
    const isCompleted = runData.status === "completed";

    const baseRecord = {
      json_path: jsonPath,
      query_id: queryId,
      question,
      response,
      response_confidence: responseConfidence,
      calibration_confidence: calibrationConfidence,
      correct_answer: gt?.answer ?? "",
      judge_mode: args.judgeMode,
      is_completed: isCompleted,
      tool_call_counts: runData.tool_call_counts ?? {},
      retrieval: {
        surfaced_docids: surfacedDocids,
        previewed_docids: previewedDocids,
        agent_docids: agentDocids,
        opened_docids: openedDocids,
        cited_docids: citedDocids,
        surfaced_recall: surfaced.recall,
        previewed_recall: previewed.recall,
        agent_recall: agent.recall,
        opened_recall: opened.recall,
        cited_recall: cited.recall,
      },
      model_info: {
        judge_model: args.judgeModelDisplay,
        judge_thinking: "low",
        pi_bin: "(direct-api)",
        run_model: runModel,
      },
    };

    if (!isCompleted || !response) {
      const result: EvaluationRecord = {
        ...baseRecord,
        judge_prompt: null,
        judge_response: null,
        judge_result: {
          extracted_final_answer: null,
          correct_answer: gt?.answer ?? "",
          reasoning: "",
          correct: null,
          confidence: null,
          parse_error: true,
          error: "Response incomplete or unavailable for judging.",
        },
        citations: null,
      };
      writeFileSync(evalPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      writtenIncomplete += 1;
      continue;
    }

    const judgePrompt = createJudgePrompt({
      mode: args.judgeMode,
      question,
      response,
      correctAnswer: gt?.answer,
    });
    queue.push({ jsonPath, qid: queryId, baseRecord, judgePrompt, positives, citedDocids });
  }

  console.log(
    `Pre-built: queue=${queue.length} skipped_existing=${skippedExisting} incomplete_short_circuit=${writtenIncomplete}`,
  );

  if (queue.length === 0) {
    console.log("Nothing to judge. Running summary step.");
    if (!args.noSummary) runSummary({ armDirAbs, evalDirRel, args });
    return;
  }

  let nextIndex = 0;
  let completedCount = 0;
  let failedCount = 0;
  let parseErrorCount = 0;
  const totalCount = queue.length;
  const startTime = Date.now();
  const progressEvery = Math.max(1, Math.floor(totalCount / 40));

  const workerCount = Math.min(args.concurrency, queue.length);
  console.log(`Starting ${workerCount} workers…`);

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const myIndex = nextIndex;
      nextIndex += 1;
      if (myIndex >= queue.length) return;
      const item = queue[myIndex];
      const evalPath = resolvePath(perQueryDir, `${item.qid}_eval.json`);
      const phase = await callJudgeApi({
        model: args.judgeModel,
        endpoint: args.endpoint,
        prompt: item.judgePrompt,
        timeoutSeconds: args.timeoutSeconds,
      });
      const judgeResult: JudgeResult = phase.error
        ? {
            extracted_final_answer: null,
            correct_answer: item.baseRecord.correct_answer,
            reasoning: "",
            correct: null,
            confidence: null,
            parse_error: true,
            error: phase.error,
          }
        : parseJudgeResponse(phase.text, { mode: args.judgeMode });
      const citationMetrics = computeCitationMetrics(item.citedDocids, item.positives);
      const judgeUsage: JudgeUsage = {
        ...makeEmptyJudgeUsage(),
        input: phase.usage.input,
        output: phase.usage.output,
        cacheRead: phase.usage.cacheRead,
        totalTokens: phase.usage.input + phase.usage.output,
        assistantTurnsWithUsage: phase.text ? 1 : 0,
      };
      const result: EvaluationRecord = {
        ...item.baseRecord,
        judge_prompt: item.judgePrompt,
        judge_response: phase.text || null,
        judge_result: judgeResult,
        citations: {
          cited_docids: item.citedDocids,
          metrics: citationMetrics,
        },
        judge_usage: judgeUsage,
      };
      writeFileSync(evalPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      completedCount += 1;
      if (phase.error) failedCount += 1;
      if (judgeResult.parse_error && !phase.error) parseErrorCount += 1;
      if (completedCount % progressEvery === 0 || completedCount === totalCount) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = completedCount / Math.max(1, (Date.now() - startTime) / 1000);
        const etaSec = Math.round((totalCount - completedCount) / Math.max(0.01, rate));
        console.log(
          `[w${workerId}] done=${completedCount}/${totalCount} ` +
            `failed=${failedCount} parse_err=${parseErrorCount} ` +
            `last_qid=${item.qid} t=${phase.elapsedSeconds.toFixed(1)}s ` +
            `elapsed=${elapsed}s eta=${etaSec}s rate=${rate.toFixed(1)}q/s`,
        );
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w += 1) workers.push(worker(w + 1));
  await Promise.all(workers);

  const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `All workers finished. completed=${completedCount} failed=${failedCount} ` +
      `parse_errors=${parseErrorCount} total_wall=${totalSeconds}s`,
  );

  if (!args.noSummary) runSummary({ armDirAbs, evalDirRel, args });
}

function runSummary(opts: { armDirAbs: string; evalDirRel: string; args: CliArgs }): void {
  // resolveJudgeEvalOutputDir({evalRoot, benchmarkId, inputDir}) returns
  //   <evalRoot>/<benchmark>/<arm-from-runs>
  // So to land at our actual evalDirRel we must pass the ROOT (the part WITHOUT
  // the trailing /<benchmark>/<arm>), not the nested full path.
  const parts = opts.evalDirRel.split("/").filter(Boolean);
  const evalRoot = parts.slice(0, -2).join("/");
  console.log(`Running summary step via evaluate_run_with_pi_entry.ts (evalRoot=${evalRoot})…`);
  const mergedDir = resolvePath(opts.armDirAbs, "merged");
  const child = spawnSync(
    "npx",
    [
      "tsx",
      "src/wrappers/evaluate_run_with_pi_entry.ts",
      "--benchmark",
      opts.args.benchmark,
      "--inputDir",
      mergedDir,
      "--evalDir",
      evalRoot,
      "--judgeMode",
      opts.args.judgeMode,
      "--model",
      opts.args.judgeModelDisplay,
      "--timeout-seconds",
      "10",
    ],
    { cwd: REPO_ROOT, stdio: "inherit", env: { ...process.env } },
  );
  if (child.status !== 0) {
    console.warn(`Summary step exited non-zero (status=${child.status}). per-query eval JSONs were written; rerun this script with --no-summary to debug.`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

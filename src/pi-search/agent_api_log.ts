import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Per-call latency log for the AGENT model (e.g. gpt-5) — distinct from
 * `expansion_log.ts` which tracks clue expansion calls.
 *
 * Wired in `extension.ts` via `before_provider_request` and
 * `after_provider_response` event handlers: capture monotonic timestamp
 * on the request, compute latency on response, write one JSONL line per
 * agent API call to `${OUTPUT_DIR}/agent_api_calls/<session>.jsonl`.
 *
 * Designed to isolate "is the agent API itself slow under sharded
 * concurrency?" from "is BM25 / clue expansion slow?"
 */

const SESSION_ID = randomUUID();
const LOG_BASENAME = `${SESSION_ID}.jsonl`;

let resolvedLogPath: string | null = null;
let logResolved = false;
let outputDirWarned = false;
let callSeq = 0;

function resolveLogPath(): string | null {
  const outputDir = process.env.OUTPUT_DIR?.trim();
  if (!outputDir) {
    if (!outputDirWarned) {
      console.error("[agent-api] OUTPUT_DIR not set; per-call log disabled.");
      outputDirWarned = true;
    }
    return null;
  }
  const dir = join(outputDir, "agent_api_calls");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent-api] failed to create log dir ${dir}: ${msg}`);
    return null;
  }
  return join(dir, LOG_BASENAME);
}

export type AgentApiCallLogInput = {
  status?: number;
  request_at_ms: number;
  response_at_ms: number;
  latency_ms: number;
};

export type AgentApiCallLogEntry = AgentApiCallLogInput & {
  ts: string;
  session_id: string;
  pid: number;
  call_seq: number;
};

export function logAgentApiCall(entry: AgentApiCallLogInput): void {
  if (!logResolved) {
    resolvedLogPath = resolveLogPath();
    logResolved = true;
  }
  callSeq += 1;
  const full: AgentApiCallLogEntry = {
    ts: new Date().toISOString(),
    session_id: SESSION_ID,
    pid: process.pid,
    call_seq: callSeq,
    ...entry,
  };

  if (resolvedLogPath) {
    try {
      appendFileSync(resolvedLogPath, JSON.stringify(full) + "\n", "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[agent-api] failed to append log: ${msg}`);
    }
  }
}

export const AGENT_API_LOG_SESSION_ID = SESSION_ID;

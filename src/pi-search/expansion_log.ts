import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
      console.error("[expansion] OUTPUT_DIR not set; per-call log disabled.");
      outputDirWarned = true;
    }
    return null;
  }
  const dir = join(outputDir, "expansion_calls");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[expansion] failed to create log dir ${dir}: ${msg}`);
    return null;
  }
  return join(dir, LOG_BASENAME);
}

export type ExpansionCallLogInput = {
  candidate_query: string;
  wrapped_query_sent: string;
  original_question: string | null;
  grounded: boolean;
  method: string;
  model?: string;
  reformulated_text: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  credits_charged?: number;
  credits_remaining?: number;
  bm25_query_used: string;
  hits_top5_docids: string[];
  context_passages?: string[];
  pseudo_docs?: string[];
  repetition_times?: number;
};

export type ExpansionCallLogEntry = ExpansionCallLogInput & {
  ts: string;
  session_id: string;
  pid: number;
  call_seq: number;
};

export function logExpansionCall(entry: ExpansionCallLogInput): void {
  if (!logResolved) {
    resolvedLogPath = resolveLogPath();
    logResolved = true;
  }
  callSeq += 1;
  const full: ExpansionCallLogEntry = {
    ts: new Date().toISOString(),
    session_id: SESSION_ID,
    pid: process.pid,
    call_seq: callSeq,
    ...entry,
  };

  const tokIn = full.input_tokens ?? "-";
  const tokOut = full.output_tokens ?? "-";
  const ms = full.latency_ms ?? "-";
  const cred = full.credits_charged ?? "-";
  const ctxN = full.context_passages?.length ?? 0;
  console.error(
    `[expansion] seq=${callSeq} method=${full.method} model=${full.model ?? "-"} tok=${tokIn}/${tokOut} ms=${ms} cred=${cred} grounded=${full.grounded} ctx=${ctxN} top1=${full.hits_top5_docids[0] ?? "-"}`,
  );

  if (resolvedLogPath) {
    try {
      appendFileSync(resolvedLogPath, JSON.stringify(full) + "\n", "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[expansion] failed to append call log: ${msg}`);
    }
  }
}

export const EXPANSION_LOG_SESSION_ID = SESSION_ID;

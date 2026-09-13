/**
 * Cohere rerank (via OpenRouter) for live first_move.
 *
 * Ported from scripts/cohere_rerank.py — same chunked async pattern, same
 * 100-docs-per-call default (1 search unit billing boundary). Pointwise
 * cross-encoder paradigm: each (query, doc) pair scored independently;
 * Cohere's API accepts a list per call purely as batched I/O.
 *
 * Env (read by callers / extension.ts, passed in via opts):
 *   OPENROUTER_API_KEY     — required for the API call



 */
import { PiSearchToolExecutionError } from "./protocol/errors";
/** One candidate handed to the reranker: an id plus the text it is scored on. */
export type RerankCandidate = {
  docid: string;
  title?: string | null;
  /** The document's text. Section 3.2.3 scores documents, not retrieval snippets. */
  text?: string | null;
};

export type CohereRerankOptions = {
  /** OpenRouter model id, e.g. "cohere/rerank-4-pro". */
  model?: string;
  /** Docs per rerank request. Cohere bills 1 search unit per ≤100 docs; default 100. */
  docsPerCall?: number;
  /** Max in-flight HTTP requests. Cohere rate-limits aggressive concurrency. Default 5. */
  concurrency?: number;
  /**
   * Ceiling on characters sent per candidate (default 1500). The caller supplies the
   * document text it wants scored; this only guards the reranker's context window.
   */
  loadTextCap?: number;
  /** Cancellation. */
  signal?: AbortSignal;
};

const ENDPOINT = "https://openrouter.ai/api/v1/rerank";
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;

class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];
  constructor(initial: number) {
    this.available = Math.max(1, initial);
  }
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) w();
    else this.available += 1;
  }
}

function formatDoc(c: RerankCandidate, cap: number): string {
  const title = c.title ? String(c.title).slice(0, 120) : "";
  // The cap guards the reranker's context window; the intent is to send the document.
  const body = (c.text ?? "").slice(0, cap).replace(/\n+/g, " ").trim();
  if (title && body) return `${title}. ${body}`;
  return title || body || "";
}

type CohereResult = { index: number; relevance_score: number };

async function rerankOneCall(
  query: string,
  docs: string[],
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<{ scored: CohereResult[]; searchUnits: number; costUsd: number }> {
  const body = JSON.stringify({
    model,
    query,
    documents: docs,
    top_n: docs.length,
  });
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    const combined = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: combined,
      });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        // A permanent failure cannot be papered over with neutral scores: the pool would
        // then be returned in arbitrary order while still looking like a ranking.
        throw new PiSearchToolExecutionError(
          "rerank",
          `HTTP ${res.status} for model=${model}: ${text.slice(0, 200)}`,
        );
      }
      const payload = (await res.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
        usage?: { search_units?: number; cost?: number };
      };
      const scored: CohereResult[] = (payload.results ?? []).map((r) => ({
        index: Number(r.index),
        relevance_score: Number(r.relevance_score),
      }));
      const searchUnits = payload.usage?.search_units ?? 0;
      const costUsd = payload.usage?.cost ?? 0;
      return { scored, searchUnits, costUsd };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new PiSearchToolExecutionError(
    "rerank",
    `failed after ${MAX_ATTEMPTS} attempts for model=${model}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/**
 * Rerank `candidates` against `question` using Cohere via OpenRouter.
 * Chunks the pool into `docsPerCall`-sized batches and fires them in parallel
 * (semaphore-capped). Returns a docid array sorted by score descending, plus
 * cost/unit accounting.
 */
export async function rerankCoherePointwise(
  question: string,
  candidates: RerankCandidate[],
  opts: CohereRerankOptions = {},
): Promise<{
  ranking: string[];
  chunks: number;
  totalSearchUnits: number;
  totalCostUsd: number;
  rerankMs: number;
}> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new PiSearchToolExecutionError(
      "cohere_rerank",
      "OPENROUTER_API_KEY missing; Cohere rerank cannot run.",
    );
  }
  const model = opts.model ?? "cohere/rerank-4-pro";
  const docsPerCall = Math.max(1, opts.docsPerCall ?? 100);
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const loadTextCap = opts.loadTextCap ?? 1500;

  if (candidates.length === 0) {
    return { ranking: [], chunks: 0, totalSearchUnits: 0, totalCostUsd: 0, rerankMs: 0 };
  }

  const t0 = Date.now();
  const sem = new Semaphore(concurrency);
  const docsByGlobalIdx = candidates.map((c) => formatDoc(c, loadTextCap));

  // Split into chunks; remember original (global) indices per chunk.
  const chunks: { startIdx: number; docs: string[] }[] = [];
  for (let i = 0; i < candidates.length; i += docsPerCall) {
    chunks.push({
      startIdx: i,
      docs: docsByGlobalIdx.slice(i, i + docsPerCall),
    });
  }

  // Score each chunk concurrently through the semaphore.
  const runChunk = async (
    chunk: { startIdx: number; docs: string[] },
  ): Promise<{
    perDoc: Array<{ docid: string; score: number }>;
    searchUnits: number;
    costUsd: number;
  }> => {
    await sem.acquire();
    try {
      const { scored, searchUnits, costUsd } = await rerankOneCall(
        question,
        chunk.docs,
        apiKey,
        model,
        opts.signal,
      );
      const perDoc: Array<{ docid: string; score: number }> = [];
      for (const r of scored) {
        if (r.index >= 0 && r.index < chunk.docs.length) {
          const globalIdx = chunk.startIdx + r.index;
          if (globalIdx < candidates.length) {
            perDoc.push({
              docid: candidates[globalIdx].docid,
              score: r.relevance_score,
            });
          }
        }
      }
      return { perDoc, searchUnits, costUsd };
    } finally {
      sem.release();
    }
  };

  const chunkResults = await Promise.all(chunks.map(runChunk));

  // Aggregate: sort all (docid, score) descending; dedup keeping first.
  const flat: Array<{ docid: string; score: number }> = [];
  let totalSearchUnits = 0;
  let totalCostUsd = 0;
  for (const cr of chunkResults) {
    totalSearchUnits += cr.searchUnits;
    totalCostUsd += cr.costUsd;
    for (const x of cr.perDoc) flat.push(x);
  }
  flat.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const ranking: string[] = [];
  for (const x of flat) {
    if (!seen.has(x.docid)) {
      seen.add(x.docid);
      ranking.push(x.docid);
    }
  }
  // Append any candidates not in the scored set (defensive; shouldn't normally happen).
  for (const c of candidates) {
    if (!seen.has(c.docid)) {
      seen.add(c.docid);
      ranking.push(c.docid);
    }
  }

  return {
    ranking,
    chunks: chunks.length,
    totalSearchUnits,
    totalCostUsd,
    rerankMs: Date.now() - t0,
  };
}

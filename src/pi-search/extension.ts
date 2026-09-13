import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFirstMoveToolDescription } from "./agent_prompt";
import { resolvePiSearchExtensionConfigFromEnv, type PiSearchExtensionConfig } from "./config";
import {
  BENCHMARK_TIMEOUT_SECONDS,
  getSubmitNowDelayMs,
  stripBenchmarkIrrelevantSystemPromptSections,
  SUBMIT_NOW_STEER_MESSAGE,
  SUBMIT_NOW_TRIGGER_RATIO,
} from "./prompt_policy";
import {
  FirstMoveParamsSchema,
  PlainSearchParamsSchema,
  ReadDocumentParamsSchema,
  ReadSearchResultsParamsSchema,
} from "./protocol/schemas";
import { decomposeQuery } from "./constraint_decomp";
import type { RerankCandidate } from "./cohere_rerank";
import { rerankCoherePointwise } from "./cohere_rerank";
import { buildSearchPage, formatSearchPageText } from "./search_cache";
import type { SearchBackendSearchHit } from "./searcher/contract/types";
import { expandClue, resolveClueExpansionConfig } from "./clue_expansion";
import { logAgentApiCall } from "./agent_api_log";
import { logExpansionCall } from "./expansion_log";
import { SearchSessionStore } from "./search_cache";
import {
  PiSearchBackendRuntime,
  type PiSearchBackendFactory,
  type PiSearchBackendRuntimeOptions,
} from "./searcher/runtime";
import { ManagedTempSpillDir } from "./spill";
import {
  executeReadDocumentTool,
  executeReadSearchResultsTool,
  executeSearchTool,
  SEARCH_CACHE_K,
} from "./tool_handlers";

export type PiSearchExtensionOptions = {
  resolveConfig?: (env: NodeJS.ProcessEnv) => PiSearchExtensionConfig;
  backendRuntime?: PiSearchBackendRuntime;
  createBackend?: PiSearchBackendFactory;
  buildCacheKey?: PiSearchBackendRuntimeOptions["buildCacheKey"];
  spillDirPrefix?: string;
};

export function registerPiSearchExtension(
  pi: ExtensionAPI,
  options: PiSearchExtensionOptions = {},
): void {
  const extensionConfig =
    options.resolveConfig?.(process.env) ?? resolvePiSearchExtensionConfigFromEnv(process.env);
  const searchStore = new SearchSessionStore();
  const backendRuntime =
    options.backendRuntime ??
    new PiSearchBackendRuntime(extensionConfig, {
      buildCacheKey: options.buildCacheKey,
      createBackend: options.createBackend,
    });
  const spillDir = new ManagedTempSpillDir(options.spillDirPrefix ?? "pi-search-extension-");
  const submitNowDelayMs = getSubmitNowDelayMs();
  let spillSequence = 0;
  let submitNowTimer: ReturnType<typeof setTimeout> | null = null;
  let submitNowMode = false;
  let promptSnapshotWritten = false;
  let spillCleanupRegistered = false;

  const cleanupSpillDir = () => {
    backendRuntime.dispose();
    spillDir.cleanup();
  };

  const registerSpillCleanup = () => {
    if (spillCleanupRegistered) return;
    spillCleanupRegistered = true;
    process.once("exit", cleanupSpillDir);
    process.once("SIGINT", cleanupSpillDir);
    process.once("SIGTERM", cleanupSpillDir);
  };

  const nextSpillSequence = (): number => {
    spillSequence += 1;
    return spillSequence;
  };

  const toolDeps = {
    backendRuntime,
    searchStore,
    spillDir,
    nextSpillSequence,
  };

  registerSpillCleanup();

  function clearSubmitNowTimer() {
    if (submitNowTimer !== null) {
      clearTimeout(submitNowTimer);
      submitNowTimer = null;
    }
  }

  // D+E: prefer the orchestrator-provided env var; fall back to regex parsing
  // for direct pi invocations that don't go through our orchestrator. Each pi
  // process serves exactly one query, so this resolves at startup with no
  // staleness or cross-query leakage.
  let latestOriginalQuestion: string | undefined =
    process.env.PI_SEARCH_ORIGINAL_QUESTION?.trim() || undefined;


  // first_move knobs
  // top-K previews for the current question, keyed by PI_SEARCH_QUERY_ID.
  // Question's Gambit constants. These are the values reported in the paper; they are
  // fixed here rather than exposed as knobs so the released system is the evaluated one.
  const FIRST_MOVE_TOP_K = 5;              // size of the opening context
  const FEEDBACK_DOCS_PER_CLUE = 3;        // feedback documents per clue, for expansion
  const PER_CLUE_DEPTH = 1000;             // documents retrieved per expanded clue
  const RERANK_MODEL = "cohere/rerank-4-pro";
  const RERANK_DOCS_PER_CALL = 100;        // the rerank API's documents-per-request limit
  const RERANK_CONCURRENCY = 5;
  const ENRICH_CONCURRENCY = 32;           // parallel document reads when replacing snippets

  const firstMoveQueryId = process.env.PI_SEARCH_QUERY_ID?.trim();
  // Counter for first_move invocations within this pi process (per-query).
  let firstMoveCallSeq = 0;

  pi.on("before_agent_start", async (event) => {
    const strippedSystemPrompt = stripBenchmarkIrrelevantSystemPromptSections(event.systemPrompt);
    if (!promptSnapshotWritten) {
      promptSnapshotWritten = true;
    }
    if (!latestOriginalQuestion) {
      const match =
        typeof event.prompt === "string" ? event.prompt.match(/Question:\s*([\s\S]*?)$/) : null;
      if (match && match[1]) {
        latestOriginalQuestion = match[1].trim();
      }
    }
    if (strippedSystemPrompt === event.systemPrompt) {
      return;
    }
    return { systemPrompt: strippedSystemPrompt };
  });

  pi.on("agent_start", async (_event, ctx) => {
    clearSubmitNowTimer();
    submitNowMode = false;
    if (submitNowDelayMs === null) {
      return;
    }
    submitNowTimer = setTimeout(() => {
      if (submitNowMode || ctx.isIdle()) {
        return;
      }
      submitNowMode = true;
      try {
        console.error(
          `[pi-search] Time budget threshold reached at ${(submitNowDelayMs / 1000).toFixed(1)}s (${Math.round(SUBMIT_NOW_TRIGGER_RATIO * 100)}% of TIMEOUT_SECONDS=${BENCHMARK_TIMEOUT_SECONDS}); queueing submit-now steer and blocking further retrieval tools.`,
        );
        pi.sendUserMessage(SUBMIT_NOW_STEER_MESSAGE, { deliverAs: "steer" });
      } catch (error) {
        console.error(
          `[pi-search] Failed to queue submit-now steer: ${error instanceof Error ? error.message : String(error)}`,
        );
        submitNowMode = false;
      }
    }, submitNowDelayMs);
  });

  // Capture agent API latency to isolate "agent is slow" from "tool is slow"
  // when comparing sharded vs 1-shard runs. Wall time between
  // before_provider_request and after_provider_response is the wire latency
  // of one OpenAI call (request send → response headers received). Body
  // streaming continues after that, but the contention signal is in the
  // round-trip latency.
  let pendingApiRequestAtMs: number | null = null;
  pi.on("before_provider_request", async (_event) => {
    pendingApiRequestAtMs = Date.now();
  });
  pi.on("after_provider_response", async (event) => {
    if (pendingApiRequestAtMs === null) return;
    const requestAt = pendingApiRequestAtMs;
    pendingApiRequestAtMs = null;
    const responseAt = Date.now();
    try {
      logAgentApiCall({
        status: (event as { status?: number }).status,
        request_at_ms: requestAt,
        response_at_ms: responseAt,
        latency_ms: responseAt - requestAt,
      });
    } catch (err) {
      console.error(`[agent-api] log failure: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  pi.on("tool_call", async (event) => {
    if (!submitNowMode) {
      return;
    }
    if (
      event.toolName === "search" ||
      event.toolName === "read_search_results" ||
      event.toolName === "read_document" ||
      event.toolName === "reformulate_search" ||
      event.toolName === "benchmark_search" ||
      event.toolName === "constraint_search" ||
      event.toolName === "first_move"
    ) {
      console.error(
        `[pi-search] Blocking ${event.toolName} after timeout steer; model must submit final answer now.`,
      );
      return {
        block: true,
        reason:
          "Time budget is nearly exhausted. Do not use more retrieval tools; submit your final answer right now.",
      };
    }
  });

  pi.on("agent_end", async () => {
    clearSubmitNowTimer();
    submitNowMode = false;
  });

  pi.on("session_shutdown", async () => {
    clearSubmitNowTimer();
    submitNowMode = false;
    cleanupSpillDir();
  });

  const clueExpansionConfig = resolveClueExpansionConfig(process.env);
  // Optional: bake a clue expansion reformulation into every `search()` call.
  // Currently only "mugi" is supported. The agent never sees the
  // reformulated text — the tool just produces better hits transparently.
  pi.registerTool({
    name: "search",
    label: "Search",
    description:
      "Search the configured pi-search backend using a raw query string. The first argument must be reason, a brief rationale of at most 100 words.",
    promptSnippet:
      "Always supply reason first, under 100 words. Use query for a concise raw search string based on the original wording or one grounded refinement. The tool returns a search_id plus the first page of results.",
    promptGuidelines: [
      "Always provide reason first. Keep it specific and under 100 words.",
      "Use query as a short raw lexical query string, not a structured object and not raw Lucene syntax.",
      "Start close to the original wording, then make grounded refinements only after browsing or reading.",
      "If the current ranking looks partially relevant, browse it before rewriting.",
      "After browsing a ranking that surfaces plausible candidates, inspect one with read_document(docid).",
    ],
    parameters: PlainSearchParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeSearchTool(params, signal, ctx, toolDeps);
    },
  });

  // The agent prompt offers reformulate_search and benchmark_search as fallbacks for
  // follow-up, single-question lookups. They are registered so every tool the prompt names
  // is callable; each issues one BM25 retrieval, which is the RETRIEVE action of the
  // paper's action space.
  for (const alias of ["reformulate_search", "benchmark_search"] as const) {
    pi.registerTool({
      name: alias,
      label: alias === "reformulate_search" ? "Reformulate Search" : "Benchmark Search",
      description:
        "Single-question retrieval fallback: runs one BM25 search over the corpus for the supplied query. The first argument must be reason, a brief rationale of at most 100 words.",
      promptSnippet:
        "Always supply reason first, under 100 words. Use query for a concise search string. Returns a search_id plus the first page of results, like search.",
      promptGuidelines: [
        "Always provide reason as the first argument. Keep it specific and under 100 words.",
        "Use this for a follow-up, single-question lookup after reading a document.",
        "Results are BM25 rankings, not verified content — open a candidate with read_document before answering.",
      ],
      parameters: PlainSearchParamsSchema,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return executeSearchTool(params, signal, ctx, toolDeps);
      },
    });
  }

  pi.registerTool({
    name: "read_search_results",
    label: "Read Search Results",
    description:
      "Read a cached search result set by search_id. Supports offset and limit for paginated browsing of ranked hits, similar to the built-in read tool. The first argument must be reason, a brief rationale of at most 100 words.",
    promptSnippet:
      "Always supply reason first, with a brief rationale of at most 100 words. Then read a cached search result set by search_id in paginated ranked-hit chunks using offset and limit.",
    promptGuidelines: [
      "Always provide reason as the first argument. Keep it specific and under 100 words.",
      "Use read_search_results to browse deeper ranks from an existing search result set before rewriting the query.",
      "If the current ranking looks partly relevant, inspect more ranks here rather than issuing another search immediately.",
      "When browse surfaces plausible candidates, open one with read_document(docid).",
    ],
    parameters: ReadSearchResultsParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeReadSearchResultsTool(params, signal, ctx, toolDeps);
    },
  });

  // benchmark_search / constraint_search even when a clue expansion key is set.
  // Used by the first_move pipeline
  {
    pi.registerTool({
      name: "first_move",
      label: "First-Move",
      // The tool description IS the paper's "First-Move Tool Description" prompt, rendered
      // from the single template in agent_prompt.ts. Nothing else is added: no promptSnippet
      // and no promptGuidelines, so the text the agent reads about this tool is exactly the
      // text printed in the appendix.
      description: buildFirstMoveToolDescription(),
      parameters: FirstMoveParamsSchema,
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        firstMoveCallSeq += 1;
        const callSeq = firstMoveCallSeq;

        // clue decomposition → per-clue expansion + BM25 → pooled rerank
        {
          if (!latestOriginalQuestion) {
            throw new Error(
              "first_move (live) requires PI_SEARCH_ORIGINAL_QUESTION to be set " +
                "(orchestrator should export per-query).",
            );
          }
          if (!clueExpansionConfig) {
            throw new Error("first_move requires OPENAI_API_KEY for the clue-expansion step.");
          }
          const tStart = Date.now();
          const constraints = await decomposeQuery(latestOriginalQuestion, signal ?? undefined);
          if (constraints.length === 0) {
            throw new Error("first_move (live): decomposition returned 0 constraints");
          }
          const decompMs = Date.now() - tStart;
          const backend = toolDeps.backendRuntime.getBackend(ctx.cwd);

          const tMugi0 = Date.now();
          const subResults = await Promise.all(
            constraints.map(async (c) => {
              const prelim = await backend.search(
                { query: c, limit: FEEDBACK_DOCS_PER_CLUE },
                signal ?? undefined,
              );
              // Section 3.2.2: the feedback set is what the clue's retrieval returns. The
              // substitution of document text for the retrieval snippet is specified for the
              // reranking stage (3.2.3), not here.
              const passages = prelim.hits
                .slice(0, FEEDBACK_DOCS_PER_CLUE)
                .map((h) => {
                  const t = h.title ? String(h.title).trim() : "";
                  const sn = h.snippet ? String(h.snippet).trim() : "";
                  return t && sn ? `${t}. ${sn}` : t || sn || "";
                })
                .filter((p): p is string => p.length > 0);

              const refResult = await expandClue(
                clueExpansionConfig,
                c,
                passages,
                signal ?? undefined,
              );
              // The paper's search string for clue i: the clue, its expansion, then the question.
              const bm25Query = `${c} ${refResult.expansion} ${latestOriginalQuestion}`;
              const finalBm25 = await backend.search(
                { query: bm25Query, limit: PER_CLUE_DEPTH },
                signal ?? undefined,
              );
              logExpansionCall({
                candidate_query: c,
                wrapped_query_sent: c,
                original_question: latestOriginalQuestion ?? null,
                grounded: true,
                method: "mugi",
                model: clueExpansionConfig.model,
                reformulated_text: refResult.expansion,
                input_tokens: refResult.inputTokens,
                output_tokens: refResult.outputTokens,
                latency_ms: refResult.latencyMs,
                pseudo_docs: refResult.pseudoDocs,
                repetition_times: refResult.repetitionTimes,
                bm25_query_used: bm25Query,
                hits_top5_docids: finalBm25.hits.slice(0, 5).map((h) => h.docid),
                context_passages: passages,
              });
              return { constraint: c, hits: finalBm25.hits };
            }),
          );
          const mugiBm25Ms = Date.now() - tMugi0;

          // Union pool, deduplicating by docid (keeping the first occurrence's title/snippet).
          const poolMap = new Map<string, SearchBackendSearchHit>();
          for (const sr of subResults) {
            for (const h of sr.hits) {
              if (!poolMap.has(h.docid)) poolMap.set(h.docid, h);
            }
          }
          const pool = Array.from(poolMap.values());
          const poolSizeRaw = pool.length;
          if (pool.length === 0) {
            throw new Error(
              "first_move (live): empty candidate pool after constraint retrieval",
            );
          }

          // Enrich pool with full doc text so the reranker sees the same
          // content as the offline pipeline (~300-char body post-front-matter)
          // instead of the BM25 snippet (~200-char matched-term excerpt). This
          // closes the variance gap we identified on q36 where live's rerank
          // diverged from offline despite using the same model + prompt.
          //
          // Anserini snippets are matched-term centered (often start mid-word
          // and emphasize metadata over body content). The offline rerank
          // pipeline reads the actual doc text via bm25_server.read_document,
          // extracts the markdown front-matter title, and uses the first 300
          // chars of body. We mirror that here.
          //
          // Cost: ~poolSize × 1ms per read (Lucene-backed, in-memory). Capped
          // bounded so enrichment does not swamp the BM25 server.
          // Section 3.2.3: each candidate's retrieval snippet is replaced with its document
          // text before scoring, because a snippet is a short window around matched terms and
          // describes the document poorly. The replacement is the head of the document itself.
          const READ_TEXT_LINES = 50;
          const EXCERPT_CHARS = 300;
          const tEnrich0 = Date.now();
          const enrichSem = (() => {
            let avail = ENRICH_CONCURRENCY;
            const waiters: Array<() => void> = [];
            return {
              async acquire(): Promise<void> {
                if (avail > 0) {
                  avail -= 1;
                  return;
                }
                await new Promise<void>((r) => waiters.push(r));
              },
              release() {
                const w = waiters.shift();
                if (w) w();
                else avail += 1;
              },
            };
          })();
          const enrichOne = async (
            h: SearchBackendSearchHit,
          ): Promise<RerankCandidate> => {
            await enrichSem.acquire();
            try {
              const resp = await backend.readDocument(
                { docid: h.docid, offset: 1, limit: READ_TEXT_LINES },
                signal ?? undefined,
              );
              if (!resp.found) {
                return { docid: h.docid, title: h.title ?? null, text: h.snippet ?? "" };
              }
              const text = resp.text ?? "";
              let title = "";
              let body = text;
              if (text.startsWith("---")) {
                const end = text.indexOf("---", 3);
                if (end > 0) {
                  const front = text.substring(3, end);
                  for (const fline of front.split("\n")) {
                    if (fline.startsWith("title:")) {
                      title = fline.substring("title:".length).trim();
                      break;
                    }
                  }
                  body = text.substring(end + 3).trim();
                }
              }
              const excerpt = body.substring(0, EXCERPT_CHARS).replace(/\n+/g, " ").trim();
              return {
                docid: h.docid,
                // Prefer the parsed front-matter title; fall back to the hit's title.
                title: title || (h.title ?? null),
                text: excerpt || (h.snippet ?? ""),
              };
            } catch {
              // Best-effort: if a read fails, fall back to the retrieval snippet.
              return { docid: h.docid, title: h.title ?? null, text: h.snippet ?? "" };
            } finally {
              enrichSem.release();
            }
          };
          const rerankCandidates: RerankCandidate[] = await Promise.all(
            pool.map(enrichOne),
          );
          const enrichMs = Date.now() - tEnrich0;
          const phaseLogs: Array<{ phase: number; chunks: number; survivors: number; ms: number }> = [];
          let ranking: string[];
          let phases: number;
          let rerankMs: number;
          let cohereCostUsd = 0;
          let cohereSearchUnits = 0;
          let activeRerankerLabel: string;
          {
            const result = await rerankCoherePointwise(latestOriginalQuestion, rerankCandidates, {
              model: RERANK_MODEL,
              docsPerCall: RERANK_DOCS_PER_CALL,
              concurrency: RERANK_CONCURRENCY,
              loadTextCap: 1500,
              signal: signal ?? undefined,
            });
            ranking = result.ranking;
            phases = 1; // pointwise — no cascade
            rerankMs = result.rerankMs;
            cohereCostUsd = result.totalCostUsd;
            cohereSearchUnits = result.totalSearchUnits;
            activeRerankerLabel = RERANK_MODEL;
          }

          // Build top-K SearchBackendSearchHit[] using the enriched title +
          // 300-char body excerpt the reranker saw — NOT the BM25 hit's
          // matched-term snippet. This is what the offline (precomputed) path
          // shows the agent (parsed-front-matter title + body excerpt), and
          // we want live to surface the same information.
          const enrichedByDocid = new Map(rerankCandidates.map((c) => [c.docid, c]));
          const topKIds = ranking.slice(0, FIRST_MOVE_TOP_K);
          const fusedHits: SearchBackendSearchHit[] = topKIds.map((docid, idx) => {
            const enriched = enrichedByDocid.get(docid);
            const src = poolMap.get(docid);
            const title = enriched?.title ?? src?.title ?? null;
            // The tool description promises the agent a title and a ~300-char excerpt, so the
            // preview is cut from the document text the reranker scored.
            const snippet = (enriched?.text ?? src?.snippet ?? "").slice(0, 300);
            return {
              docid,
              score: 1.0 / (idx + 1),
              title,
              snippet,
              snippetTruncated: snippet.length >= 300,
            };
          });

          const cached = toolDeps.searchStore.createSearch(
            `[first_move of: ${latestOriginalQuestion.slice(0, 80)}...]`,
            "first_move_live",
            fusedHits,
            `[live constraint+mugi+rerank, top-${FIRST_MOVE_TOP_K} of ${ranking.length} ranked]`,
          );
          const page = buildSearchPage(cached, 1, FIRST_MOVE_TOP_K);
          const rendered = formatSearchPageText(page);
          const surfacedDocidsAll = ranking.slice(0, SEARCH_CACHE_K);
          const totalMs = Date.now() - tStart;
          const cohereCostStr =
            cohereSearchUnits > 0
              ? `, cohere=${cohereSearchUnits} units ($${cohereCostUsd.toFixed(4)})`
              : "";
          const summaryLine =
            `[first_move #${callSeq}: ${constraints.length} clues, ` +
            `pool=${poolSizeRaw}, ` +
            `reranker=${activeRerankerLabel}, decomp=${decompMs}ms, retrieval=${mugiBm25Ms}ms, ` +
            `enrich=${enrichMs}ms, rerank=${rerankMs}ms, total=${totalMs}ms${cohereCostStr}]`;

          console.error(summaryLine);
          return {
            // The observation is the opening context itself; run telemetry goes to stderr
            // and to details, not into the agent's context.
            content: [{ type: "text" as const, text: rendered }],
            details: {
              searchId: cached.searchId,
              rawQuery: latestOriginalQuestion,
              bm25Query: cached.bm25Query,
              queryMode: cached.queryMode,
              totalCached: fusedHits.length,
              previewedDocids: fusedHits.map((h) => h.docid),
              retrievedDocids: surfacedDocidsAll,
              firstMove: {
                callSeq,
                qid: firstMoveQueryId ?? null,
                topK: FIRST_MOVE_TOP_K,
                poolSize: ranking.length,
                poolSizeRaw,
                nConstraints: constraints.length,
                rerankModel: activeRerankerLabel,
                rerankPhases: phases,
                phaseLogs,
                cohereSearchUnits,
                cohereCostUsd,
                decompMs,
                mugiBm25Ms,
                enrichMs,
                rerankMs,
                totalMs,
              },
            },
          };
        }

      },
    });
  }

  pi.registerTool({
    name: "read_document",
    label: "Read Document",
    description:
      "Read a retrieved document by docid. Supports offset and limit for paginated line-based reading, similar to the built-in read tool. The first argument must be reason, a brief rationale of at most 100 words.",
    promptSnippet:
      "Always supply reason first, with a brief rationale of at most 100 words. Then read a retrieved document by docid in paginated line-based chunks using offset and limit.",
    promptGuidelines: [
      "Always provide reason as the first argument. Keep it specific and under 100 words.",
      "Use read_document to verify evidence from a specific docid before answering.",
      "Start with offset=1 and a moderate limit when first reading a document.",
      "If a document is truncated and still looks relevant, continue reading the same document with the suggested next offset before launching many new searches.",
    ],
    parameters: ReadDocumentParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeReadDocumentTool(params, signal, ctx, toolDeps);
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerPiSearchExtension(pi);
}

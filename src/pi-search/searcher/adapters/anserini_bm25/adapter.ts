import type { AnseriniBm25HelperTransport } from "./helper_transport";
import {
  parseReadDocumentPayload,
  parseRenderSearchResultsPayload,
  parseSearchPayload,
} from "../../../protocol/parse";
import type { PiSearchBackend } from "../../contract/interface";
import type {
  SearchBackendCapabilities,
  SearchBackendReadDocumentRequest,
  SearchBackendReadDocumentResponse,
  SearchBackendSearchHit,
  SearchBackendSearchRequest,
  SearchBackendSearchResponse,
} from "../../contract/types";

const ANSERINI_BM25_CAPABILITIES: SearchBackendCapabilities = {
  backendId: "anserini-bm25",
  supportsScore: true,
  supportsSnippets: true,
  supportsExactTotalHits: false,
};

const SEARCH_PREVIEW_WINDOW = 50;
const SEARCH_PREVIEW_MAX_CHARS = 220;

function buildHighlightClues(
  query: string,
): Array<{ text: string; category: "any"; boost: number }> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  return [{ text: trimmed, category: "any", boost: 1 }];
}

function mergeSearchHitPreviews(
  hits: SearchBackendSearchHit[],
  previews: Array<{
    docid: string;
    title?: string | null;
    excerpt: string;
    excerpt_truncated: boolean;
  }>,
): SearchBackendSearchHit[] {
  const previewsByDocid = new Map(previews.map((preview) => [preview.docid, preview]));
  return hits.map((hit) => {
    const preview = previewsByDocid.get(hit.docid);
    if (!preview) {
      return hit;
    }
    return {
      ...hit,
      title: preview.title ?? undefined,
      snippet: preview.excerpt || undefined,
      snippetTruncated: preview.excerpt_truncated,
    };
  });
}

export class AnseriniBm25Backend implements PiSearchBackend {
  readonly capabilities = ANSERINI_BM25_CAPABILITIES;

  constructor(private readonly helper: AnseriniBm25HelperTransport) {}

  async search(
    request: SearchBackendSearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendSearchResponse> {
    const output = await this.helper.request(
      "search",
      {
        query: request.query,
        query_mode: "plain",
        k: request.limit,
        rerank_clues: [],
      },
      signal,
    );

    const parsed = parseSearchPayload(output);
    const hits = (parsed.results ?? []).map(
      (result) =>
        ({
          docid: result.docid,
          score: result.score,
        }) satisfies SearchBackendSearchHit,
    );
    const previewHits = await this.renderSearchHitPreviews(hits, request.query, signal);

    return {
      hits: previewHits,
      hasMore: hits.length >= request.limit,
      timingMs: {
        request: parsed.timing_ms?.command,
        backendInit: parsed.timing_ms?.init,
        backendUptime: parsed.timing_ms?.server_uptime,
      },
    };
  }

  async readDocument(
    request: SearchBackendReadDocumentRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendReadDocumentResponse> {
    const offset = request.offset ?? 1;
    const limit = request.limit ?? 200;
    const output = await this.helper.request(
      "read_document",
      {
        docid: request.docid,
        offset,
        limit,
      },
      signal,
    );

    const parsed = parseReadDocumentPayload(output);
    const timingMs = {
      request: parsed.timing_ms?.command,
      backendInit: parsed.timing_ms?.init,
      backendUptime: parsed.timing_ms?.server_uptime,
    };

    if (parsed.found === false) {
      return {
        found: false,
        docid: parsed.docid ?? request.docid,
        timingMs,
      };
    }

    return {
      found: true,
      docid: parsed.docid ?? request.docid,
      text: parsed.text ?? "",
      offset: parsed.offset ?? offset,
      limit: parsed.limit ?? limit,
      totalUnits: parsed.total_lines,
      returnedOffsetStart: parsed.returned_line_start,
      returnedOffsetEnd: parsed.returned_line_end,
      truncated: parsed.truncated ?? false,
      nextOffset: parsed.next_offset ?? undefined,
      timingMs,
    };
  }

  private async renderSearchHitPreviews(
    hits: SearchBackendSearchHit[],
    query: string,
    signal?: AbortSignal,
  ): Promise<SearchBackendSearchHit[]> {
    const previewDocids = hits.slice(0, SEARCH_PREVIEW_WINDOW).map((hit) => hit.docid);
    if (previewDocids.length === 0) {
      return hits;
    }

    try {
      const output = await this.helper.request(
        "render_search_results",
        {
          docids: previewDocids,
          snippet_max_chars: SEARCH_PREVIEW_MAX_CHARS,
          inline_highlights: false,
          highlight_clues: buildHighlightClues(query),
        },
        signal,
      );
      const parsed = parseRenderSearchResultsPayload(output);
      return mergeSearchHitPreviews(hits, parsed.results ?? []);
    } catch {
      return hits;
    }
  }

  async close(): Promise<void> {
    this.helper.dispose?.();
  }
}

import type { PiSearchBackend } from "../../contract/interface";
import type {
  SearchBackendCapabilities,
  SearchBackendReadDocumentRequest,
  SearchBackendReadDocumentResponse,
  SearchBackendSearchHit,
  SearchBackendSearchRequest,
  SearchBackendSearchResponse,
} from "../../contract/types";
import type { PiSearchExtensionConfig } from "../../../config";

type MockDocument = Extract<
  PiSearchExtensionConfig["backend"],
  { kind: "mock" }
>["documents"][number];

const MOCK_BACKEND_CAPABILITIES: SearchBackendCapabilities = {
  backendId: "mock",
  supportsScore: true,
  supportsSnippets: true,
  supportsExactTotalHits: true,
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function scoreDocument(queryTokens: string[], document: MockDocument): number {
  const haystack = [document.title, document.snippet, document.text].map(normalizeText).join("\n");
  return queryTokens.reduce((score, token) => {
    if (!token) return score;
    return haystack.includes(token) ? score + 1 : score;
  }, 0);
}

function toSearchHit(document: MockDocument, score: number): SearchBackendSearchHit {
  return {
    docid: document.docid,
    score,
    title: document.title ?? undefined,
    snippet: document.snippet ?? document.text.split(/\r?\n/, 1)[0] ?? "",
    snippetTruncated: false,
  };
}

export class MockSearchBackend implements PiSearchBackend {
  readonly capabilities = MOCK_BACKEND_CAPABILITIES;

  constructor(private readonly documents: MockDocument[]) {}

  async search(
    request: SearchBackendSearchRequest,
    _signal?: AbortSignal,
  ): Promise<SearchBackendSearchResponse> {
    const queryTokens = normalizeText(request.query).split(/\s+/).filter(Boolean);
    const ranked = this.documents
      .map((document) => ({ document, score: scoreDocument(queryTokens, document) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.document.docid.localeCompare(right.document.docid),
      );
    const offset = request.offset ?? 1;
    const startIndex = Math.max(0, offset - 1);
    const hits = ranked.slice(startIndex, startIndex + request.limit).map(({ document, score }) => {
      return toSearchHit(document, score);
    });
    const endIndex = startIndex + hits.length;

    return {
      hits,
      totalHits: ranked.length,
      nextOffset: endIndex < ranked.length ? endIndex + 1 : undefined,
      hasMore: endIndex < ranked.length,
      timingMs: {
        request: 0,
      },
    };
  }

  async readDocument(
    request: SearchBackendReadDocumentRequest,
    _signal?: AbortSignal,
  ): Promise<SearchBackendReadDocumentResponse> {
    const document = this.documents.find((item) => item.docid === request.docid);
    if (!document) {
      return {
        found: false,
        docid: request.docid,
        timingMs: {
          request: 0,
        },
      };
    }

    const offset = request.offset ?? 1;
    const limit = request.limit ?? 200;
    const lines = document.text.split(/\r?\n/);
    const startIndex = Math.max(0, offset - 1);
    const selectedLines = lines.slice(startIndex, startIndex + limit);
    const returnedOffsetStart = selectedLines.length > 0 ? startIndex + 1 : offset;
    const returnedOffsetEnd = selectedLines.length > 0 ? startIndex + selectedLines.length : offset;
    const nextOffset =
      startIndex + selectedLines.length < lines.length ? returnedOffsetEnd + 1 : undefined;

    return {
      found: true,
      docid: document.docid,
      text: selectedLines.join("\n"),
      title: document.title ?? undefined,
      offset,
      limit,
      totalUnits: lines.length,
      returnedOffsetStart,
      returnedOffsetEnd,
      truncated: nextOffset !== undefined,
      nextOffset,
      timingMs: {
        request: 0,
      },
    };
  }
}

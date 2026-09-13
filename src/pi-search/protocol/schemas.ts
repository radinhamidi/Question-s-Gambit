import { Type, type Static } from "typebox";

export const PlainSearchParamsSchema = Type.Object({
  reason: Type.String({
    description:
      "Brief rationale for this search, maximum 100 words. Put the specific new clue, ranking gap, or follow-up goal first. Avoid generic filler like 'searching for more information'.",
  }),
  query: Type.String({
    description:
      "Raw query string. Use concise lexical clues instead of long natural-language rewrites.",
  }),
});

export const ReadSearchResultsParamsSchema = Type.Object({
  reason: Type.String({
    description:
      "Brief rationale for browsing this result set, maximum 100 words. State why the current ranking is worth inspecting before another rewrite.",
  }),
  search_id: Type.String({ description: "Search result set id returned by search(...)." }),
  offset: Type.Optional(Type.Number({ description: "Rank to start reading from (1-indexed)." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of ranked hits to read." })),
});

export const ReadDocumentParamsSchema = Type.Object({
  reason: Type.String({
    description:
      "Brief rationale for opening this document, maximum 100 words. State the candidate clue or fact you expect to verify in this doc.",
  }),
  docid: Type.String({ description: "Document id to retrieve" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)." }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
});

export const SearchResultLiteSchema = Type.Object(
  {
    docid: Type.String(),
    score: Type.Number(),
  },
  { additionalProperties: true },
);

export const SearchResultPreviewSchema = Type.Object(
  {
    docid: Type.String(),
    title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    matched_terms: Type.Optional(Type.Array(Type.String())),
    excerpt: Type.String(),
    excerpt_truncated: Type.Boolean(),
  },
  { additionalProperties: true },
);

export const RpcTimingMsSchema = Type.Object(
  {
    command: Type.Optional(Type.Number()),
    server_uptime: Type.Optional(Type.Number()),
    init: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

export const SearchPayloadSchema = Type.Object(
  {
    mode: Type.Optional(Type.String()),
    query: Type.Optional(Type.String()),
    query_mode: Type.Optional(Type.String()),
    k: Type.Optional(Type.Number()),
    results: Type.Optional(Type.Array(SearchResultLiteSchema)),
    timing_ms: Type.Optional(RpcTimingMsSchema),
  },
  { additionalProperties: true },
);

export const RenderSearchResultsPayloadSchema = Type.Object(
  {
    mode: Type.Optional(Type.String()),
    docids: Type.Optional(Type.Array(Type.String())),
    results: Type.Optional(Type.Array(SearchResultPreviewSchema)),
    timing_ms: Type.Optional(RpcTimingMsSchema),
  },
  { additionalProperties: true },
);

export const ReadDocumentPayloadSchema = Type.Object(
  {
    mode: Type.Optional(Type.String()),
    docid: Type.Optional(Type.String()),
    found: Type.Optional(Type.Boolean()),
    offset: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
    total_lines: Type.Optional(Type.Number()),
    returned_line_start: Type.Optional(Type.Number()),
    returned_line_end: Type.Optional(Type.Number()),
    truncated: Type.Optional(Type.Boolean()),
    next_offset: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    text: Type.Optional(Type.String()),
    timing_ms: Type.Optional(RpcTimingMsSchema),
  },
  { additionalProperties: true },
);

export const FirstMoveParamsSchema = Type.Object({
  reason: Type.String({
    description:
      "Brief rationale, maximum 100 words. State why a first_move ranking of relevant docs is the right starting move (typically: multi-clue question, need overall coverage before drilling in).",
  }),
});

export type PlainSearchParams = Static<typeof PlainSearchParamsSchema>;
export type ReadSearchResultsParams = Static<typeof ReadSearchResultsParamsSchema>;
export type ReadDocumentParams = Static<typeof ReadDocumentParamsSchema>;
export type FirstMoveParams = Static<typeof FirstMoveParamsSchema>;
export type SearchResultLite = Static<typeof SearchResultLiteSchema>;
export type SearchResultPreview = Static<typeof SearchResultPreviewSchema>;
export type RpcTimingMs = Static<typeof RpcTimingMsSchema>;
export type SearchPayload = Static<typeof SearchPayloadSchema>;
export type RenderSearchResultsPayload = Static<typeof RenderSearchResultsPayloadSchema>;
export type ReadDocumentPayload = Static<typeof ReadDocumentPayloadSchema>;

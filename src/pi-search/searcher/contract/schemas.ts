import { Type } from "typebox";

export const SearchBackendTimingMsSchema = Type.Object(
  {
    request: Type.Optional(Type.Number()),
    backendInit: Type.Optional(Type.Number()),
    backendUptime: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const SearchBackendCapabilitiesSchema = Type.Object(
  {
    backendId: Type.String(),
    supportsScore: Type.Boolean(),
    supportsSnippets: Type.Boolean(),
    supportsExactTotalHits: Type.Boolean(),
    maxPageSize: Type.Optional(Type.Number({ minimum: 1 })),
    maxReadLimit: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const SearchBackendSearchRequestSchema = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    offset: Type.Optional(Type.Number({ minimum: 1 })),
    limit: Type.Number({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const SearchBackendSearchHitSchema = Type.Object(
  {
    docid: Type.String({ minLength: 1 }),
    score: Type.Optional(Type.Number()),
    title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    snippet: Type.Optional(Type.String()),
    snippetTruncated: Type.Optional(Type.Boolean()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const SearchBackendSearchResponseSchema = Type.Object(
  {
    hits: Type.Array(SearchBackendSearchHitSchema),
    totalHits: Type.Optional(Type.Number({ minimum: 0 })),
    nextOffset: Type.Optional(Type.Number({ minimum: 1 })),
    hasMore: Type.Boolean(),
    timingMs: Type.Optional(SearchBackendTimingMsSchema),
  },
  { additionalProperties: false },
);

export const SearchBackendReadDocumentRequestSchema = Type.Object(
  {
    docid: Type.String({ minLength: 1 }),
    offset: Type.Optional(Type.Number({ minimum: 1 })),
    limit: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const SearchBackendReadDocumentNotFoundResponseSchema = Type.Object(
  {
    found: Type.Literal(false),
    docid: Type.String({ minLength: 1 }),
    timingMs: Type.Optional(SearchBackendTimingMsSchema),
  },
  { additionalProperties: false },
);

export const SearchBackendReadDocumentFoundResponseSchema = Type.Object(
  {
    found: Type.Literal(true),
    docid: Type.String({ minLength: 1 }),
    text: Type.String(),
    title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    offset: Type.Number({ minimum: 1 }),
    limit: Type.Number({ minimum: 1 }),
    totalUnits: Type.Optional(Type.Number({ minimum: 0 })),
    returnedOffsetStart: Type.Optional(Type.Number({ minimum: 1 })),
    returnedOffsetEnd: Type.Optional(Type.Number({ minimum: 1 })),
    truncated: Type.Boolean(),
    nextOffset: Type.Optional(Type.Number({ minimum: 1 })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    timingMs: Type.Optional(SearchBackendTimingMsSchema),
  },
  { additionalProperties: false },
);

export const SearchBackendReadDocumentResponseSchema = Type.Union([
  SearchBackendReadDocumentNotFoundResponseSchema,
  SearchBackendReadDocumentFoundResponseSchema,
]);

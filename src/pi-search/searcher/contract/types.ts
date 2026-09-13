import type { Static } from "typebox";
import {
  SearchBackendCapabilitiesSchema,
  SearchBackendReadDocumentFoundResponseSchema,
  SearchBackendReadDocumentNotFoundResponseSchema,
  SearchBackendReadDocumentRequestSchema,
  SearchBackendReadDocumentResponseSchema,
  SearchBackendSearchHitSchema,
  SearchBackendSearchRequestSchema,
  SearchBackendSearchResponseSchema,
  SearchBackendTimingMsSchema,
} from "./schemas";

export type SearchBackendTimingMs = Static<typeof SearchBackendTimingMsSchema>;
export type SearchBackendCapabilities = Static<typeof SearchBackendCapabilitiesSchema>;
export type SearchBackendSearchRequest = Static<typeof SearchBackendSearchRequestSchema>;
export type SearchBackendSearchHit = Static<typeof SearchBackendSearchHitSchema>;
export type SearchBackendSearchResponse = Static<typeof SearchBackendSearchResponseSchema>;
export type SearchBackendReadDocumentRequest = Static<
  typeof SearchBackendReadDocumentRequestSchema
>;
export type SearchBackendReadDocumentFoundResponse = Static<
  typeof SearchBackendReadDocumentFoundResponseSchema
>;
export type SearchBackendReadDocumentNotFoundResponse = Static<
  typeof SearchBackendReadDocumentNotFoundResponseSchema
>;
export type SearchBackendReadDocumentResponse = Static<
  typeof SearchBackendReadDocumentResponseSchema
>;

export type SearchBackendOperation = "search" | "readDocument";

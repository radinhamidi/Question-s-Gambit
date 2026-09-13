import type {
  SearchBackendCapabilities,
  SearchBackendReadDocumentRequest,
  SearchBackendReadDocumentResponse,
  SearchBackendSearchRequest,
  SearchBackendSearchResponse,
} from "./types";

export interface PiSearchBackend {
  readonly capabilities: SearchBackendCapabilities;

  search(
    request: SearchBackendSearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendSearchResponse>;

  readDocument(
    request: SearchBackendReadDocumentRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendReadDocumentResponse>;

  close?(): Promise<void>;
}

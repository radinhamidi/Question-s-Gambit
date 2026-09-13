import {
  PiSearchBackendExecutionError,
  PiSearchBackendUnavailableError,
} from "../../contract/errors";
import type { PiSearchBackend } from "../../contract/interface";
import {
  parseSearchBackendReadDocumentResponse,
  parseSearchBackendSearchResponse,
} from "../../contract/parse";
import type {
  SearchBackendReadDocumentRequest,
  SearchBackendReadDocumentResponse,
  SearchBackendSearchRequest,
  SearchBackendSearchResponse,
} from "../../contract/types";
import type { PiSearchExtensionConfig } from "../../../config";

type HttpJsonBackendConfig = Extract<PiSearchExtensionConfig["backend"], { kind: "http-json" }>;

async function postJson(
  backendId: string,
  operation: "search" | "readDocument",
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new PiSearchBackendUnavailableError(
      backendId,
      error instanceof Error ? error.message : String(error),
    );
  }

  const text = await response.text();

  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.stringify(JSON.parse(text));
    } catch {
      // Keep raw response text when the backend fails without valid JSON.
    }
    throw new PiSearchBackendExecutionError(
      backendId,
      operation,
      `HTTP ${response.status}: ${detail}`,
    );
  }

  return text;
}

export class HttpJsonSearchBackend implements PiSearchBackend {
  readonly capabilities;

  constructor(private readonly config: HttpJsonBackendConfig) {
    this.capabilities = config.capabilities;
  }

  async search(
    request: SearchBackendSearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendSearchResponse> {
    const text = await postJson(
      this.capabilities.backendId,
      "search",
      this.config.endpoints.searchUrl,
      request,
      signal,
    );
    return parseSearchBackendSearchResponse(text);
  }

  async readDocument(
    request: SearchBackendReadDocumentRequest,
    signal?: AbortSignal,
  ): Promise<SearchBackendReadDocumentResponse> {
    const text = await postJson(
      this.capabilities.backendId,
      "readDocument",
      this.config.endpoints.readDocumentUrl,
      request,
      signal,
    );
    return parseSearchBackendReadDocumentResponse(text);
  }
}

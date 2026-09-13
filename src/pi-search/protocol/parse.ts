import type { Static, TSchema } from "typebox";
import { compileJsonValidator } from "./validation";
import { PiSearchInvalidToolResultError, PiSearchMalformedJsonError } from "./errors";
import {
  ReadDocumentPayloadSchema,
  RenderSearchResultsPayloadSchema,
  SearchPayloadSchema,
} from "./schemas";

type ProtocolParserMetadata = {
  toolName: string;
  schemaName: string;
};

function createProtocolParser<TSchemaType extends TSchema>(
  schema: TSchemaType,
  metadata: ProtocolParserMetadata,
): (text: string, label: string) => Static<TSchemaType> {
  const validator = compileJsonValidator(schema);

  return (text: string, label: string): Static<TSchemaType> => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new PiSearchMalformedJsonError(label, text, error, {
        toolName: metadata.toolName,
        target: "payload",
        schemaName: metadata.schemaName,
      });
    }
    if (validator.check(value)) {
      return value;
    }
    throw new PiSearchInvalidToolResultError(label, validator.errors(value), {
      toolName: metadata.toolName,
      target: "payload",
      schemaName: metadata.schemaName,
    });
  };
}

const parseSearchPayloadText = createProtocolParser(SearchPayloadSchema, {
  toolName: "search",
  schemaName: "SearchPayloadSchema",
});
const parseRenderSearchResultsPayloadText = createProtocolParser(RenderSearchResultsPayloadSchema, {
  toolName: "read_search_results",
  schemaName: "RenderSearchResultsPayloadSchema",
});
const parseReadDocumentPayloadText = createProtocolParser(ReadDocumentPayloadSchema, {
  toolName: "read_document",
  schemaName: "ReadDocumentPayloadSchema",
});

export function parseSearchPayload(text: string) {
  return parseSearchPayloadText(text.trim(), "pi-search search response");
}

export function parseRenderSearchResultsPayload(text: string) {
  return parseRenderSearchResultsPayloadText(
    text.trim(),
    "pi-search render_search_results response",
  );
}

export function parseReadDocumentPayload(text: string) {
  return parseReadDocumentPayloadText(text.trim(), "pi-search read_document response");
}

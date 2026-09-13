import type { Static, TSchema } from "typebox";
import { compileJsonValidator } from "../../protocol/validation";
import { PiSearchBackendInvalidResponseError, PiSearchBackendMalformedJsonError } from "./errors";
import {
  SearchBackendCapabilitiesSchema,
  SearchBackendReadDocumentResponseSchema,
  SearchBackendSearchResponseSchema,
} from "./schemas";

function createBackendValidator<TSchemaType extends TSchema>(
  schema: TSchemaType,
): (value: unknown, label: string) => Static<TSchemaType> {
  const validator = compileJsonValidator(schema);

  return (value: unknown, label: string): Static<TSchemaType> => {
    if (validator.check(value)) {
      return value;
    }
    throw new PiSearchBackendInvalidResponseError(label, validator.errors(value));
  };
}

function createBackendParser<TSchemaType extends TSchema>(
  schema: TSchemaType,
): {
  validate: (value: unknown, label: string) => Static<TSchemaType>;
  parse: (text: string, label: string) => Static<TSchemaType>;
} {
  const validate = createBackendValidator(schema);

  return {
    validate,
    parse(text: string, label: string): Static<TSchemaType> {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new PiSearchBackendMalformedJsonError(label, text, error);
      }
      return validate(value, label);
    },
  };
}

const searchBackendCapabilitiesParser = createBackendParser(SearchBackendCapabilitiesSchema);
const searchBackendSearchResponseParser = createBackendParser(SearchBackendSearchResponseSchema);
const searchBackendReadDocumentResponseParser = createBackendParser(
  SearchBackendReadDocumentResponseSchema,
);

export function validateSearchBackendCapabilities(value: unknown) {
  return searchBackendCapabilitiesParser.validate(value, "pi-search backend capabilities");
}

export function parseSearchBackendCapabilities(text: string) {
  return searchBackendCapabilitiesParser.parse(text.trim(), "pi-search backend capabilities");
}

export function validateSearchBackendSearchResponse(value: unknown) {
  return searchBackendSearchResponseParser.validate(value, "pi-search backend search response");
}

export function parseSearchBackendSearchResponse(text: string) {
  return searchBackendSearchResponseParser.parse(text.trim(), "pi-search backend search response");
}

export function validateSearchBackendReadDocumentResponse(value: unknown) {
  return searchBackendReadDocumentResponseParser.validate(
    value,
    "pi-search backend readDocument response",
  );
}

export function parseSearchBackendReadDocumentResponse(text: string) {
  return searchBackendReadDocumentResponseParser.parse(
    text.trim(),
    "pi-search backend readDocument response",
  );
}

import { Type, type Static } from "typebox";
import { compileJsonValidator } from "./validation";

const SearchToolResultDetailsSchema = Type.Object(
  {
    retrievedDocids: Type.Array(Type.String()),
    previewedDocids: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

const searchToolResultDetailsValidator = compileJsonValidator(SearchToolResultDetailsSchema);

const PiSearchFailureMetadataSchema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("malformed_json"),
      Type.Literal("invalid_tool_arguments"),
      Type.Literal("invalid_tool_result"),
      Type.Literal("tool_execution_failed"),
    ]),
    toolName: Type.Optional(Type.String()),
    target: Type.Optional(
      Type.Union([Type.Literal("arguments"), Type.Literal("result"), Type.Literal("payload")]),
    ),
    schemaName: Type.Optional(Type.String()),
    fieldPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const PiSearchFailureToolResultDetailsSchema = Type.Object(
  {
    piSearchFailure: PiSearchFailureMetadataSchema,
  },
  { additionalProperties: true },
);

export type PiSearchFailureMetadata = Static<typeof PiSearchFailureMetadataSchema>;
const piSearchFailureToolResultDetailsValidator = compileJsonValidator(
  PiSearchFailureToolResultDetailsSchema,
);

export function extractRetrievedDocidsFromPiSearchToolDetails(details: unknown): string[] {
  if (!searchToolResultDetailsValidator.check(details)) {
    return [];
  }
  return details.retrievedDocids;
}

export function extractPreviewedDocidsFromPiSearchToolDetails(details: unknown): string[] {
  if (!searchToolResultDetailsValidator.check(details)) {
    return [];
  }
  return details.previewedDocids ?? [];
}

export function extractPiSearchFailureMetadata(details: unknown): PiSearchFailureMetadata | null {
  if (!piSearchFailureToolResultDetailsValidator.check(details)) {
    return null;
  }
  return details.piSearchFailure;
}

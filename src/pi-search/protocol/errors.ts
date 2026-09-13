import type { JsonValidationError } from "./validation";

export type PiSearchProtocolErrorCode =
  | "malformed_json"
  | "invalid_tool_arguments"
  | "invalid_tool_result"
  | "tool_execution_failed";

export type PiSearchProtocolErrorTarget = "arguments" | "result" | "payload";

export type PiSearchProtocolErrorMetadata = {
  toolName?: string;
  target?: PiSearchProtocolErrorTarget;
  schemaName?: string;
  fieldPath?: string;
};

function formatValidationErrors(errors: JsonValidationError[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "schema validation failed without detailed errors.";
  }
  return errors
    .map((error) => {
      const path = error.instancePath || "/";
      return `${path} ${error.message ?? "is invalid"}`.trim();
    })
    .join("; ");
}

function formatDetail(detail: string | JsonValidationError[] | null | undefined): string {
  if (typeof detail === "string") {
    return detail;
  }
  return formatValidationErrors(detail);
}

function extractFieldPath(
  detail: string | JsonValidationError[] | null | undefined,
): string | undefined {
  if (!detail || typeof detail === "string" || detail.length === 0) {
    return undefined;
  }
  return detail[0]?.instancePath || "/";
}

export class PiSearchProtocolValidationError extends Error {
  readonly code: PiSearchProtocolErrorCode;
  readonly toolName?: string;
  readonly target?: PiSearchProtocolErrorTarget;
  readonly schemaName?: string;
  readonly fieldPath?: string;

  constructor(
    code: PiSearchProtocolErrorCode,
    message: string,
    metadata: PiSearchProtocolErrorMetadata = {},
  ) {
    super(message);
    this.name = "PiSearchProtocolValidationError";
    this.code = code;
    this.toolName = metadata.toolName;
    this.target = metadata.target;
    this.schemaName = metadata.schemaName;
    this.fieldPath = metadata.fieldPath;
  }
}

export class PiSearchMalformedJsonError extends PiSearchProtocolValidationError {
  constructor(
    label: string,
    text: string,
    cause: unknown,
    metadata: PiSearchProtocolErrorMetadata = {},
  ) {
    super("malformed_json", `Failed to parse ${label}: ${text}\n${String(cause)}`, metadata);
    this.name = "PiSearchMalformedJsonError";
  }
}

export class PiSearchInvalidToolArgumentsError extends PiSearchProtocolValidationError {
  constructor(
    label: string,
    detail: string | JsonValidationError[] | null | undefined,
    metadata: PiSearchProtocolErrorMetadata = {},
  ) {
    super("invalid_tool_arguments", `Invalid ${label}: ${formatDetail(detail)}`, {
      ...metadata,
      target: metadata.target ?? "arguments",
      fieldPath: metadata.fieldPath ?? extractFieldPath(detail),
    });
    this.name = "PiSearchInvalidToolArgumentsError";
  }
}

export class PiSearchInvalidToolResultError extends PiSearchProtocolValidationError {
  constructor(
    label: string,
    detail: string | JsonValidationError[] | null | undefined,
    metadata: PiSearchProtocolErrorMetadata = {},
  ) {
    super("invalid_tool_result", `Invalid ${label}: ${formatDetail(detail)}`, {
      ...metadata,
      target: metadata.target ?? "result",
      fieldPath: metadata.fieldPath ?? extractFieldPath(detail),
    });
    this.name = "PiSearchInvalidToolResultError";
  }
}

export class PiSearchToolExecutionError extends PiSearchProtocolValidationError {
  constructor(toolName: string, detail: string, metadata: PiSearchProtocolErrorMetadata = {}) {
    super("tool_execution_failed", `${toolName} failed: ${detail}`, {
      ...metadata,
      toolName,
    });
    this.name = "PiSearchToolExecutionError";
  }
}

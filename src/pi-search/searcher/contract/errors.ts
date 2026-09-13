import type { JsonValidationError } from "../../protocol/validation";

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

export class PiSearchBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSearchBackendError";
  }
}

export class PiSearchBackendMalformedJsonError extends PiSearchBackendError {
  constructor(label: string, text: string, cause: unknown) {
    super(`Failed to parse ${label}: ${text}\n${String(cause)}`);
    this.name = "PiSearchBackendMalformedJsonError";
  }
}

export class PiSearchBackendInvalidResponseError extends PiSearchBackendError {
  constructor(label: string, detail: string | JsonValidationError[] | null | undefined) {
    super(`Invalid ${label}: ${formatDetail(detail)}`);
    this.name = "PiSearchBackendInvalidResponseError";
  }
}

export class PiSearchBackendUnavailableError extends PiSearchBackendError {
  constructor(backendId: string, detail: string) {
    super(`${backendId} backend unavailable: ${detail}`);
    this.name = "PiSearchBackendUnavailableError";
  }
}

export class PiSearchBackendCapabilityMismatchError extends PiSearchBackendError {
  constructor(backendId: string, detail: string) {
    super(`${backendId} backend capability mismatch: ${detail}`);
    this.name = "PiSearchBackendCapabilityMismatchError";
  }
}

export class PiSearchBackendExecutionError extends PiSearchBackendError {
  constructor(backendId: string, operation: string, detail: string) {
    super(`${backendId} backend ${operation} failed: ${detail}`);
    this.name = "PiSearchBackendExecutionError";
  }
}

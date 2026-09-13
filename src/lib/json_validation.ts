import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";

export type JsonValidationError = {
  instancePath: string;
  message?: string;
};

export type CompiledJsonValidator<T> = {
  check: (value: unknown) => value is T;
  errors: (value: unknown) => JsonValidationError[];
  validate: (value: unknown, label: string) => T;
};

function normalizeJsonValidationErrors(
  errors: Iterable<TLocalizedValidationError> | null | undefined,
): JsonValidationError[] {
  if (!errors) {
    return [];
  }
  return Array.from(errors, (error) => ({
    instancePath: error.instancePath || "/",
    message: error.message,
  }));
}

export function formatJsonValidationError(
  errors: JsonValidationError[] | null | undefined,
): string {
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

function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${label}: ${text}\n${String(error)}`);
  }
}

export type JsonValidator<T> = {
  validate: (value: unknown, label: string) => T;
  parse: (text: string, label: string) => T;
};

export function compileJsonValidator<TSchemaType extends TSchema>(
  schema: TSchemaType,
): CompiledJsonValidator<Static<TSchemaType>> {
  const validator = Compile(schema);

  const errors = (value: unknown): JsonValidationError[] =>
    normalizeJsonValidationErrors(validator.Errors(value));

  const validate = (value: unknown, label: string): Static<TSchemaType> => {
    if (validator.Check(value)) {
      return value as Static<TSchemaType>;
    }
    throw new Error(`Invalid ${label}: ${formatJsonValidationError(errors(value))}`);
  };

  return {
    check(value: unknown): value is Static<TSchemaType> {
      return validator.Check(value);
    },
    errors,
    validate,
  };
}

export function createJsonValidator<TSchemaType extends TSchema>(
  schema: TSchemaType,
): JsonValidator<Static<TSchemaType>> {
  const validator = compileJsonValidator(schema);

  return {
    validate: validator.validate,
    parse(text: string, label: string): Static<TSchemaType> {
      return validator.validate(parseJsonText(text, label), label);
    },
  };
}

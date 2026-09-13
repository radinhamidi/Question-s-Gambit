import { Type, type Static } from "typebox";
import { createJsonValidator } from "../../lib/json_validation";

const Bm25HelperResponseSchema = Type.Object(
  {
    id: Type.Optional(Type.Number()),
    type: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    success: Type.Optional(Type.Boolean()),
    data: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const PingResponseSchema = Type.Object(
  {
    ok: Type.Boolean(),
  },
  { additionalProperties: true },
);

const bm25HelperResponseValidator = createJsonValidator(Bm25HelperResponseSchema);
const pingResponseValidator = createJsonValidator(PingResponseSchema);

export type Bm25HelperResponse = Static<typeof Bm25HelperResponseSchema>;
export type Bm25PingResponse = Static<typeof PingResponseSchema>;

export interface Bm25RpcClient {
  request(
    commandType: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
  dispose?(): void;
}

export function createBm25RequestAbortError(
  commandType: string,
  phase: "before dispatch" | "during request",
): Error {
  return new Error(`BM25 helper request aborted ${phase} for ${commandType}.`);
}

export function parseBm25HelperResponse(line: string): Bm25HelperResponse {
  const trimmed = line.trim();
  return bm25HelperResponseValidator.parse(trimmed, "BM25 helper RPC response");
}

export function parseBm25PingResponse(text: string): Bm25PingResponse {
  const trimmed = text.trim();
  return pingResponseValidator.parse(trimmed, "BM25 helper ping response");
}

export function resolveBm25HelperResponse(
  response: Bm25HelperResponse,
  expectedId: number,
  commandType: string,
): string {
  if (response.id !== expectedId) {
    throw new Error(
      `BM25 helper RPC response ID mismatch: expected ${expectedId}, received ${String(response.id)}`,
    );
  }
  if (response.type === "response" && response.success) {
    return JSON.stringify(response.data ?? {});
  }
  throw new Error(response.error ?? `BM25 helper RPC ${response.command ?? commandType} failed.`);
}

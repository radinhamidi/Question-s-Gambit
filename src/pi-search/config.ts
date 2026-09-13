import { Type, type Static } from "typebox";
import { compileJsonValidator, type JsonValidationError } from "./protocol/validation";

const PiSearchSharedRpcBackendConfigSchema = Type.Object(
  {
    kind: Type.Literal("anserini-bm25"),
    transport: Type.Object(
      {
        kind: Type.Literal("tcp"),
        host: Type.String({ minLength: 1 }),
        port: Type.Number({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const PiSearchLocalStdioBackendConfigSchema = Type.Object(
  {
    kind: Type.Literal("anserini-bm25"),
    transport: Type.Object(
      {
        kind: Type.Literal("stdio"),
        indexPath: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const PiSearchHttpJsonBackendConfigSchema = Type.Object(
  {
    kind: Type.Literal("http-json"),
    capabilities: Type.Object(
      {
        backendId: Type.String({ minLength: 1 }),
        supportsScore: Type.Boolean(),
        supportsSnippets: Type.Boolean(),
        supportsExactTotalHits: Type.Boolean(),
        maxPageSize: Type.Optional(Type.Number({ minimum: 1 })),
        maxReadLimit: Type.Optional(Type.Number({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
    endpoints: Type.Object(
      {
        searchUrl: Type.String({ minLength: 1 }),
        readDocumentUrl: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const PiSearchMockBackendConfigSchema = Type.Object(
  {
    kind: Type.Literal("mock"),
    documents: Type.Array(
      Type.Object(
        {
          docid: Type.String({ minLength: 1 }),
          title: Type.Optional(Type.String()),
          snippet: Type.Optional(Type.String()),
          text: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const PiSearchExtensionConfigSchema = Type.Object(
  {
    backend: Type.Union([
      PiSearchSharedRpcBackendConfigSchema,
      PiSearchLocalStdioBackendConfigSchema,
      PiSearchHttpJsonBackendConfigSchema,
      PiSearchMockBackendConfigSchema,
    ]),
  },
  { additionalProperties: false },
);

export type PiSearchExtensionConfig = Static<typeof PiSearchExtensionConfigSchema>;

const piSearchExtensionConfigValidator = compileJsonValidator(PiSearchExtensionConfigSchema);

function formatValidationErrors(errors: JsonValidationError[]): string {
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

export function buildAnseriniBm25TcpExtensionConfig(options: {
  host: string;
  port: number;
}): PiSearchExtensionConfig {
  return {
    backend: {
      kind: "anserini-bm25",
      transport: {
        kind: "tcp",
        host: options.host,
        port: options.port,
      },
    },
  };
}

export function buildAnseriniBm25StdioExtensionConfig(options: {
  indexPath: string;
}): PiSearchExtensionConfig {
  return {
    backend: {
      kind: "anserini-bm25",
      transport: {
        kind: "stdio",
        indexPath: options.indexPath,
      },
    },
  };
}

export function buildHttpJsonExtensionConfig(options: {
  capabilities: {
    backendId: string;
    supportsScore: boolean;
    supportsSnippets: boolean;
    supportsExactTotalHits: boolean;
    maxPageSize?: number;
    maxReadLimit?: number;
  };
  searchUrl: string;
  readDocumentUrl: string;
}): PiSearchExtensionConfig {
  return {
    backend: {
      kind: "http-json",
      capabilities: options.capabilities,
      endpoints: {
        searchUrl: options.searchUrl,
        readDocumentUrl: options.readDocumentUrl,
      },
    },
  };
}

export function buildMockExtensionConfig(options: {
  documents: Array<{
    docid: string;
    title?: string;
    snippet?: string;
    text: string;
  }>;
}): PiSearchExtensionConfig {
  return {
    backend: {
      kind: "mock",
      documents: options.documents,
    },
  };
}

export function parsePiSearchExtensionConfig(text: string): PiSearchExtensionConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse PI_SEARCH_EXTENSION_CONFIG: ${text}\n${String(error)}`);
  }
  if (piSearchExtensionConfigValidator.check(value)) {
    return value;
  }
  throw new Error(
    `Invalid PI_SEARCH_EXTENSION_CONFIG: ${formatValidationErrors(
      piSearchExtensionConfigValidator.errors(value),
    )}`,
  );
}

export function resolvePiSearchExtensionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PiSearchExtensionConfig {
  const raw = env.PI_SEARCH_EXTENSION_CONFIG?.trim();
  if (!raw) {
    throw new Error(
      "Missing PI_SEARCH_EXTENSION_CONFIG. The pi-search extension now requires explicit backend config from its caller.",
    );
  }
  return parsePiSearchExtensionConfig(raw);
}

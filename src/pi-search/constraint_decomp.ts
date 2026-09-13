/**
 * Decompose a BrowseComp-Plus question into atomic factual constraints.
 *
 * Model selection (no silent fallback to gpt-5):
 *   process.env.MODEL — the agent's model id, so the
 *                                  decomp family always matches the agent's
 *                                  (gpt arms decompose with gpt; deepseek
 *                                  arms decompose with deepseek). This is
 *                                  intentional — no cross-family fallback.
 *   3. neither set → hard error (no silent default).
 *
 * Endpoint routing follows the resolved model id:
 *   - "openai/<model>" or bare id   → api.openai.com + OPENAI_API_KEY
 *   - "openrouter/<provider>/<model>" → openrouter.ai + OPENROUTER_API_KEY
 *   - "openrouter/deepseek/deepseek-v4-*" → also pins provider routing to Alibaba
 *
 * Per-process in-memory cache so repeated calls within one query's session
 * are free.
 */
import { PiSearchToolExecutionError } from "./protocol/errors";

const cache = new Map<string, string[]>();

export const DECOMP_PROMPT = `You are given a multi-clue question. Decompose it into a list of ATOMIC, INDEPENDENTLY-VERIFIABLE factual constraints that must ALL be true for the answer.

Each constraint should be:
- A single factual condition that can be checked in a document independently of the others.
- Phrased as a short, BM25-searchable claim (5-20 words), NOT a paraphrase of the whole question.
- Concrete: include any specific dates, ranges, names, numbers, or quoted phrases from the question.

Output STRICTLY a JSON object: {"constraints": ["...", "...", ...]} — nothing else.

Question: {Q}`;

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;

type DecompRoute = {
  endpoint: string;
  apiKey: string;
  modelId: string;
  provider?: { only?: string[]; order?: string[]; allow_fallbacks?: boolean };
};

function resolveDecompRoute(): DecompRoute {
  // Section 3.2.1: the decomposition comes from the agent model S itself, so the
  // decomposer always is the agent's model and there is nothing to configure.
  const raw = (process.env.MODEL?.trim() || "").trim();
  if (!raw) {
    throw new PiSearchToolExecutionError(
      "decompose",
      "MODEL is not set — cannot resolve the decomposition model.",
    );
  }

  // OpenRouter route: "openrouter/<provider>/<model>" — e.g. "openrouter/deepseek/deepseek-v4-pro"
  if (raw.startsWith("openrouter/")) {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      throw new PiSearchToolExecutionError(
        "decompose",
        "OPENROUTER_API_KEY missing; MODEL is openrouter/* but no OpenRouter key is set.",
      );
    }
    const modelId = raw.slice("openrouter/".length); // e.g. "deepseek/deepseek-v4-pro"
    // Pin DeepSeek to Alibaba (matches the agent's provider routing).
    const provider = modelId.startsWith("deepseek/")
      ? { only: ["alibaba"], allow_fallbacks: false }
      : undefined;
    return {
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey,
      modelId,
      provider,
    };
  }

  // Default: OpenAI direct. Accepts "openai/<id>" or bare id (e.g. "gpt-5", "gpt-5.4-mini").
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new PiSearchToolExecutionError(
      "decompose",
      "OPENAI_API_KEY missing; constraint decomposition cannot run.",
    );
  }
  const modelId = raw.startsWith("openai/") ? raw.slice("openai/".length) : raw;
  return {
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKey,
    modelId,
  };
}

export async function decomposeQuery(
  query: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const cached = cache.get(query);
  if (cached) return cached;

  const route = resolveDecompRoute();
  const requestPayload: Record<string, unknown> = {
    model: route.modelId,
    messages: [{ role: "user", content: DECOMP_PROMPT.replace("{Q}", query) }],
    response_format: { type: "json_object" },
  };
  if (route.provider) requestPayload.provider = route.provider;
  const body = JSON.stringify(requestPayload);

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    const combined = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const res = await fetch(route.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${route.apiKey}`,
        },
        body,
        signal: combined,
      });
      if (!res.ok) {
        const text = await res.text();
        // 429/5xx transient; rest permanent
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        throw new PiSearchToolExecutionError(
          "decompose",
          `HTTP ${res.status}: ${text.slice(0, 400)}`,
        );
      }
      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new PiSearchToolExecutionError(
          "decompose",
          `no content in ${route.modelId} response`,
        );
      }
      let parsed: { constraints?: unknown };
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new PiSearchToolExecutionError(
          "decompose",
          `model response was not JSON: ${content.slice(0, 200)}`,
        );
      }
      if (!Array.isArray(parsed.constraints)) {
        throw new PiSearchToolExecutionError(
          "decompose",
          `model did not return a constraints array: ${JSON.stringify(parsed).slice(0, 200)}`,
        );
      }
      const list: string[] = parsed.constraints
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      cache.set(query, list);
      return list;
    } catch (err) {
      lastErr = err;
      if (err instanceof PiSearchToolExecutionError) throw err;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new PiSearchToolExecutionError(
    "decompose",
    `decomposition failed after ${MAX_ATTEMPTS} attempts: ${msg}`,
  );
}

/** Only exported for tests / smoke. */
export function _clearDecomposeCache(): void {
  cache.clear();
}

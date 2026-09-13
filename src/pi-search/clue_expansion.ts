/**
 * Per-clue query expansion with MUGI (Zhang et al., 2024).
 *
 * Section 3.2.2: a clue on its own is short and underspecified, so before searching we let
 * the corpus show how the clue is actually worded. The raw clue is issued to the retriever,
 * the documents it returns become the feedback set F_i, and the expansion model rewrites the
 * clue conditioned on that feedback:  ĉ_i ← g(c_i, F_i).
 *
 * MUGI is multi-text generation integration. It generates several pseudo-documents for the
 * query, then concatenates the query back in, repeated in proportion to how much text was
 * generated. The repetition is the mechanism: a handful of pseudo-documents run to thousands
 * of characters, so without it the query's own terms are swamped when BM25 scores the
 * expanded string.
 *
 *   pseudo_docs      = [ g(query) x NUM_PSEUDO_DOCS ]      (temperature 1.0, for diversity)
 *   generated        = pseudo_docs joined by a space
 *   repetition_times = max(1, (len(generated) / len(query)) / ADAPTIVE_TIMES)
 *   expansion        = (query + " ") * repetition_times + generated
 *
 * The expansion model is a constant rather than a knob: Section 4.3 holds it fixed across
 * agents so expansion quality does not vary with the agent model. OPENAI_API_KEY is the
 * credential for it.
 */
import { PiSearchToolExecutionError } from "./protocol/errors";

export type ClueExpansionConfig = {
  model: string;
  apiBase: string;
  apiKey: string;
  timeoutMs: number;
};

export type ClueExpansionResult = {
  /** The expanded query. Treated as opaque text by the caller. */
  expansion: string;
  /** The generations behind it, kept for the per-call log. */
  pseudoDocs: string[];
  repetitionTimes: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
};

/** Expansion model, held fixed across agents (Section 4.3). */
const EXPANSION_MODEL = "gpt-4.1";
const API_BASE = "https://api.openai.com";
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

/** MUGI parameters. */
const NUM_PSEUDO_DOCS = 5;
const ADAPTIVE_TIMES = 5;
const GENERATION_TEMPERATURE = 1.0;
const GENERATION_MAX_TOKENS = 1024;
/** Guard against an unusually long retrieval result inflating the expanded query. */
const FEEDBACK_CHARS_PER_DOC = 1200;

const SYSTEM_PROMPT =
  "You are PassageGenGPT, an AI capable of generating concise, informative, and clear pseudo passages on specific topics.";
const USER_PROMPT =
  "Generate one passage that is relevant to the following query: '{query}'. The passage should be concise, informative, and clear";
/** Priming turn: the model continues this rather than answering afresh. */
const ASSISTANT_PRIMER = "Sure, here's a passage relevant to the query:";

export function resolveClueExpansionConfig(env: NodeJS.ProcessEnv): ClueExpansionConfig | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return { model: EXPANSION_MODEL, apiBase: API_BASE, apiKey, timeoutMs: REQUEST_TIMEOUT_MS };
}

async function generateOne(
  config: ClueExpansionConfig,
  query: string,
  signal?: AbortSignal,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), config.timeoutMs);
    try {
      const response = await fetch(`${config.apiBase}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          temperature: GENERATION_TEMPERATURE,
          max_tokens: GENERATION_MAX_TOKENS,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: USER_PROMPT.replace("{query}", query) },
            { role: "assistant", content: ASSISTANT_PRIMER },
          ],
        }),
        signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 400);
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < MAX_ATTEMPTS) {
          lastError = new Error(`HTTP ${response.status}: ${body}`);
          await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
          continue;
        }
        throw new PiSearchToolExecutionError("clue expansion", `HTTP ${response.status}: ${body}`);
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) {
        throw new PiSearchToolExecutionError("clue expansion", "empty generation returned");
      }
      return {
        // Each generation is stripped of wrapping quotes before the generations are combined.
        text: text.replace(/^["']+|["']+$/g, "").trim(),
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      };
    } catch (err) {
      if (err instanceof PiSearchToolExecutionError) throw err;
      lastError = err;
      if (attempt >= MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new PiSearchToolExecutionError(
    "clue expansion",
    `failed after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Expand one clue against the documents that clue retrieved.
 *
 * The clue and its feedback documents are concatenated into the query MUGI expands, so the
 * generations are grounded in the corpus's own wording rather than in the model's priors.
 */
export async function expandClue(
  config: ClueExpansionConfig,
  clue: string,
  feedback: string[],
  signal?: AbortSignal,
): Promise<ClueExpansionResult> {
  if (feedback.length === 0) {
    throw new PiSearchToolExecutionError(
      "clue expansion",
      "no feedback supplied — the expansion is conditioned on first-stage retrieval",
    );
  }
  const started = Date.now();
  const query = [
    clue,
    ...feedback.map((d) => d.replace(/\s+/g, " ").trim().slice(0, FEEDBACK_CHARS_PER_DOC)),
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  const generations = await Promise.all(
    Array.from({ length: NUM_PSEUDO_DOCS }, () => generateOne(config, query, signal)),
  );
  const pseudoDocs = generations.map((g) => g.text);
  const generated = pseudoDocs.join(" ");

  // Adaptive concatenation: repeat the query in proportion to how much was generated.
  const repetitionTimes = Math.max(
    1,
    Math.floor(Math.floor(generated.length / Math.max(1, query.length)) / ADAPTIVE_TIMES),
  );
  const expansion = `${`${query} `.repeat(repetitionTimes)}${generated}`;

  return {
    expansion,
    pseudoDocs,
    repetitionTimes,
    inputTokens: generations.reduce((n, g) => n + g.inputTokens, 0),
    outputTokens: generations.reduce((n, g) => n + g.outputTokens, 0),
    latencyMs: Date.now() - started,
  };
}

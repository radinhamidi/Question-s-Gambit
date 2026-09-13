import type { BenchmarkJudgeEvalMode } from "../benchmarks/types";

export type JudgeResult = {
  extracted_final_answer: string | null;
  correct_answer: string;
  reasoning: string;
  correct: boolean | null;
  confidence: number | null;
  parse_error: boolean;
  error?: string;
};

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function extractJsonCandidate(text: string): string {
  const stripped = stripMarkdownFences(text);
  if (stripped.startsWith("{") && stripped.endsWith("}")) {
    return stripped;
  }

  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return stripped.slice(firstBrace, lastBrace + 1);
  }

  return stripped;
}

function normalizeString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/%/g, "").trim());
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(100, parsed));
    }
  }
  return null;
}

export function parseJudgeResponse(
  judgeText: string,
  options: { mode: BenchmarkJudgeEvalMode },
): JudgeResult {
  if (!judgeText.trim()) {
    return {
      extracted_final_answer: null,
      correct_answer: "",
      reasoning: "",
      correct: null,
      confidence: null,
      parse_error: true,
      error: "Judge returned empty text.",
    };
  }

  const candidate = extractJsonCandidate(judgeText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      extracted_final_answer: null,
      correct_answer: "",
      reasoning: "",
      correct: null,
      confidence: null,
      parse_error: true,
      error: `Failed to parse judge JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      extracted_final_answer: null,
      correct_answer: "",
      reasoning: "",
      correct: null,
      confidence: null,
      parse_error: true,
      error: "Judge output was not a JSON object.",
    };
  }

  const record = parsed as Record<string, unknown>;
  const rawExtracted = record.extracted_final_answer;
  const extractedFinalAnswer =
    rawExtracted === null || rawExtracted === undefined
      ? null
      : normalizeString(rawExtracted) || null;
  const correctAnswer = normalizeString(record.correct_answer);
  const reasoning = normalizeString(record.reasoning);
  const confidence = normalizeConfidence(record.confidence);

  let correct: boolean | null = null;
  if (typeof record.correct === "boolean") {
    correct = record.correct;
  } else if (typeof record.correct === "string") {
    const lowered = record.correct.trim().toLowerCase();
    if (lowered === "true" || lowered === "yes") correct = true;
    if (lowered === "false" || lowered === "no") correct = false;
  }

  const requiresCorrectAnswer = options.mode === "gold-answer";
  const parseError =
    correct === null ||
    confidence === null ||
    reasoning.length === 0 ||
    (requiresCorrectAnswer && correctAnswer.length === 0);
  return {
    extracted_final_answer: extractedFinalAnswer,
    correct_answer: correctAnswer,
    reasoning,
    correct,
    confidence,
    parse_error: parseError,
    ...(parseError
      ? {
          error: requiresCorrectAnswer
            ? "Judge JSON was missing required fields or had invalid field types."
            : "Reference-free judge JSON was missing required fields or had invalid field types.",
        }
      : {}),
  };
}

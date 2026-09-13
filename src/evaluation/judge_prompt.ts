import type { BenchmarkJudgeEvalMode } from "../benchmarks/types";

export type JudgePromptInput = {
  mode: BenchmarkJudgeEvalMode;
  question: string;
  response: string;
  correctAnswer?: string;
};

export function createJudgePrompt(input: JudgePromptInput): string {
  if (input.mode === "reference-free") {
    return [
      "You are an evaluation judge.",
      "",
      "Your job is to determine whether the response's final answer appears correct for the question.",
      "You are operating in reference-free mode: no benchmark gold answer is provided.",
      "Use your own reasoning to judge whether the response's final answer is correct, responsive, and not materially contradicted by the question.",
      "If the response does not contain a final answer you can extract, set extracted_final_answer to null and correct to false.",
      "",
      "Return exactly one JSON object and nothing else.",
      "Do not wrap the JSON in markdown or code fences.",
      "Use this exact schema:",
      "{",
      '  "extracted_final_answer": string | null,',
      '  "reasoning": string,',
      '  "correct": boolean,',
      '  "confidence": number',
      "}",
      "",
      "Requirements:",
      "- confidence must be a number between 0 and 100",
      "- correct must be true or false",
      "- reasoning must explain only why the extracted final answer does or does not appear correct for the question",
      "",
      `Question: ${input.question}`,
      "",
      "Response:",
      input.response,
    ].join("\n");
  }

  return [
    "You are an evaluation judge.",
    "",
    "Your job is to determine whether the response's final answer is semantically equivalent to the known correct answer.",
    "Do not solve the question yourself.",
    "Do not use outside knowledge.",
    "Focus only on whether the response's final answer matches the correct answer.",
    "Allow harmless wording differences, equivalent formatting, and added correct detail.",
    "For numerical answers, allow small formatting differences and obvious equivalent forms.",
    "If the response does not contain a final answer you can extract, set extracted_final_answer to null and correct to false.",
    "",
    "Return exactly one JSON object and nothing else.",
    "Do not wrap the JSON in markdown or code fences.",
    "Use this exact schema:",
    "{",
    '  "extracted_final_answer": string | null,',
    '  "correct_answer": string,',
    '  "reasoning": string,',
    '  "correct": boolean,',
    '  "confidence": number',
    "}",
    "",
    "Requirements:",
    "- confidence must be a number between 0 and 100",
    "- correct must be true or false",
    "- repeat the provided correct answer exactly in correct_answer",
    "- reasoning must explain only whether the extracted final answer matches the correct answer",
    "",
    `Question: ${input.question}`,
    "",
    "Response:",
    input.response,
    "",
    `Correct answer: ${input.correctAnswer ?? ""}`,
  ].join("\n");
}

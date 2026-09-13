export function extractResponseSelfReportedConfidence(response: string): number | null {
  if (!response.trim()) return null;
  const matches = [
    ...response.matchAll(/(?:^|\n)\s*(?:\*\*)?confidence(?:\*\*)?\s*:\s*(\d+(?:\.\d+)?)\s*%?/gim),
  ];
  if (matches.length === 0) return null;
  const raw = Number.parseFloat(matches[matches.length - 1][1] ?? "");
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, raw));
}

export function resolveResponseCalibrationConfidence(
  response: string,
  defaultConfidence = 100,
): number | null {
  if (!response.trim()) return null;
  return extractResponseSelfReportedConfidence(response) ?? defaultConfidence;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calibrationError(
  confidences: number[],
  correctness: boolean[],
  beta = 100,
): number {
  if (confidences.length === 0 || confidences.length !== correctness.length) {
    throw new Error("Confidences and correctness arrays must be non-empty and aligned.");
  }
  const pairs = confidences.map((confidence, index) => ({
    confidence: confidence / 100,
    correct: correctness[index] ? 1 : 0,
  }));
  pairs.sort((a, b) => a.confidence - b.confidence);

  let cerr = 0;
  for (let start = 0; start < pairs.length; start += beta) {
    const slice = pairs.slice(start, start + beta);
    if (slice.length === 0) continue;
    const binConfidence = average(slice.map((item) => item.confidence)) ?? 0;
    const binCorrect = average(slice.map((item) => item.correct)) ?? 0;
    const difference = Math.abs(binConfidence - binCorrect);
    cerr += (slice.length / pairs.length) * difference * difference;
  }

  return Math.sqrt(cerr) * 100;
}

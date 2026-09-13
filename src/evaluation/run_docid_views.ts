type NormalizedResultEntry = {
  type?: string;
  tool_name?: string | null;
  arguments?: unknown;
  output?: string;
  is_error?: boolean;
};

export type RunDocidRecord = {
  surfaced_docids?: unknown;
  previewed_docids?: unknown;
  agent_docids?: unknown;
  opened_docids?: unknown;
  cited_docids?: unknown;
  retrieved_docids?: unknown;
  result?: unknown;
};

function normalizeDocidArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value) {
    const docid = typeof item === "string" || typeof item === "number" ? String(item) : null;
    if (!docid) continue;
    unique.add(docid);
  }
  return Array.from(unique);
}

function normalizeResultEntries(value: unknown): NormalizedResultEntry[] {
  return Array.isArray(value) ? (value as NormalizedResultEntry[]) : [];
}

export function extractCitationsFromText(text: string): string[] {
  if (!text) return [];
  const allDocids = new Set<string>();

  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    allDocids.add(match[1]);
  }
  for (const match of text.matchAll(/\[([^[\]]*?)\]/g)) {
    for (const docid of match[1].match(/\d+/g) ?? []) {
      allDocids.add(docid);
    }
  }
  for (const match of text.matchAll(/【(\d+)】/g)) {
    allDocids.add(match[1]);
  }
  for (const match of text.matchAll(/【([^【】]*?)】/g)) {
    for (const docid of match[1].match(/\d+/g) ?? []) {
      allDocids.add(docid);
    }
  }

  return Array.from(allDocids);
}

export function getFinalAssistantText(run: RunDocidRecord): string {
  const result = normalizeResultEntries(run.result);
  const last = result[result.length - 1];
  if (last?.type === "output_text" && typeof last.output === "string") {
    return last.output;
  }
  return "";
}

function deriveOpenedDocidsFromResult(run: RunDocidRecord): string[] {
  const opened = new Set<string>();
  for (const entry of normalizeResultEntries(run.result)) {
    if (entry.type !== "tool_call" || entry.tool_name !== "read_document") continue;
    // Same rule as the primary accumulator: a failed read opened nothing.
    if (entry.is_error === true) continue;
    const args = entry.arguments;
    if (typeof args !== "object" || args === null) continue;
    const rawDocid = (args as { docid?: unknown }).docid;
    if (typeof rawDocid !== "string" && typeof rawDocid !== "number") continue;
    opened.add(String(rawDocid));
  }
  return Array.from(opened);
}

function deriveCitedDocidsFromResult(run: RunDocidRecord): string[] {
  return extractCitationsFromText(getFinalAssistantText(run));
}

export function getSurfacedDocids(run: RunDocidRecord): string[] {
  return normalizeDocidArray(run.surfaced_docids ?? run.retrieved_docids);
}

export function getPreviewedDocids(run: RunDocidRecord): string[] {
  const explicit = normalizeDocidArray(run.previewed_docids);
  return explicit;
}

export function getOpenedDocids(run: RunDocidRecord): string[] {
  const explicit = normalizeDocidArray(run.opened_docids);
  return explicit.length > 0 ? explicit : deriveOpenedDocidsFromResult(run);
}

export function getCitedDocids(run: RunDocidRecord): string[] {
  const explicit = normalizeDocidArray(run.cited_docids);
  return explicit.length > 0 ? explicit : deriveCitedDocidsFromResult(run);
}

export function getAgentDocids(run: RunDocidRecord): string[] {
  const explicit = normalizeDocidArray(run.agent_docids);
  if (explicit.length > 0) return explicit;
  return Array.from(new Set([...getOpenedDocids(run), ...getCitedDocids(run)]));
}

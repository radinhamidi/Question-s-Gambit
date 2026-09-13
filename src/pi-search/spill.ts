import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ReadDocumentPayload } from "./protocol/schemas";

type SearchPageLike = {
  searchId: string;
  rawQuery?: string;
  queryMode?: string;
  totalCached?: number;
  offset: number;
  limit: number;
  returnedRankStart: number;
  returnedRankEnd: number;
  results: unknown[];
};

export class ManagedTempSpillDir {
  readonly rootDir: string;
  private cleanedUp = false;

  constructor(prefix: string) {
    this.rootDir = mkdtempSync(join(tmpdir(), prefix));
  }

  spillFile(relativePath: string, content: string): string {
    const outputPath = join(this.rootDir, relativePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, content, "utf8");
    return outputPath;
  }

  cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    rmSync(this.rootDir, { recursive: true, force: true });
  }
}

function sanitizeSpillPathPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function buildReadSpillFileName(parsed: ReadDocumentPayload, spillSequence: number): string {
  const docid = sanitizeSpillPathPart(parsed.docid ?? "unknown");
  const returnedLineStart = parsed.returned_line_start ?? parsed.offset ?? 0;
  const returnedLineEnd = parsed.returned_line_end ?? returnedLineStart;
  return `${spillSequence}-${docid}-lines-${returnedLineStart}-${returnedLineEnd}.txt`;
}

export function buildSearchSpillFileName(page: SearchPageLike, spillSequence: number): string {
  const searchId = sanitizeSpillPathPart(page.searchId);
  if (page.results.length === 0) {
    return `${spillSequence}-${searchId}-offset-${page.offset}-limit-${page.limit}-empty.json`;
  }
  return `${spillSequence}-${searchId}-ranks-${page.returnedRankStart}-${page.returnedRankEnd}.json`;
}

function spillFullOutput(
  spillDir: ManagedTempSpillDir,
  kind: "read" | "search",
  fileName: string,
  content: string,
): string {
  return spillDir.spillFile(join(kind, sanitizeSpillPathPart(fileName)), content);
}

export function truncateReadDocumentOutput(
  spillDir: ManagedTempSpillDir,
  spillFileName: string,
  text: string,
  fullText: string,
  parsed: ReadDocumentPayload,
): { text: string; truncation?: TruncationResult; fullOutputPath?: string } {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { text };
  }

  const docid = parsed.docid ?? "unknown";
  const fullOutputPath = spillFullOutput(spillDir, "read", spillFileName, fullText);
  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  const continuationHint =
    parsed.truncated && parsed.next_offset
      ? `Continue with read_document({"docid":"${docid}","offset":${parsed.next_offset},"limit":${parsed.limit ?? 200}}) to keep reading this document.`
      : "Use a smaller limit if you want a narrower chunk from this document.";
  const suffix = [
    "",
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted. Full output saved to: ${fullOutputPath}]`,
    continuationHint,
  ].join("\n");

  return {
    text: `${truncation.content}${suffix}`,
    truncation,
    fullOutputPath,
  };
}

export function truncateSearchOutput(
  spillDir: ManagedTempSpillDir,
  spillFileName: string,
  text: string,
  fullJson: string,
): { text: string; truncation?: TruncationResult; fullOutputPath?: string } {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    return { text };
  }

  const fullOutputPath = spillFullOutput(spillDir, "search", spillFileName, fullJson);
  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  const suffix = [
    "",
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted. Full output saved to: ${fullOutputPath}]`,
    "Use read_document(docid) to inspect a document in paginated chunks.",
  ].join("\n");

  return {
    text: `${truncation.content}${suffix}`,
    truncation,
    fullOutputPath,
  };
}

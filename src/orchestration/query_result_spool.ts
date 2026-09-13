import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { serializeJsonLine } from "../runtime/jsonl";

export type QueryNormalizedResult = {
  type: "tool_call" | "output_text";
  tool_name: string | null;
  arguments: unknown;
  output: string;
  /** Whether the tool call failed. Consumers use it to exclude failed reads. */
  is_error?: boolean;
  details?: unknown;
};

export class QueryResultSpool {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  append(result: QueryNormalizedResult): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, serializeJsonLine(result), "utf8");
  }

  load(): QueryNormalizedResult[] {
    if (!existsSync(this.path)) {
      return [];
    }
    const text = readFileSync(this.path, "utf8");
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as QueryNormalizedResult);
  }

  cleanup(): void {
    rmSync(dirname(this.path), { recursive: true, force: true });
  }
}

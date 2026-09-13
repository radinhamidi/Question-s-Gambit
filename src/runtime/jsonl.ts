import { StringDecoder } from "node:string_decoder";

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

type JsonlLineReaderOptions = {
  onTrailingLine?: (line: string) => void;
};

export function attachJsonlLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  options?: JsonlLineReaderOptions,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const normalizeLine = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
  const emitLine = (line: string) => {
    onLine(normalizeLine(line));
  };

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      const line = normalizeLine(buffer);
      buffer = "";
      if (options?.onTrailingLine) {
        options.onTrailingLine(line);
      } else {
        onLine(line);
      }
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

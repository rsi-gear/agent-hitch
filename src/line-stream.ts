import type { Readable } from "node:stream";

export function consumeLines(stream: Readable, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) onLine(buffer.replace(/\r$/, ""));
  });
}

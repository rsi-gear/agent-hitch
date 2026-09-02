import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { ServerResponse } from "node:http";

export function streamFileRange(file: string, start: number, end: number, response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, { start, end });
    stream.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    stream.pipe(response);
  });
}

export async function completeLineSize(file: string, size: number): Promise<number> {
  if (size === 0) return 0;
  const handle = await open(file, "r");
  try {
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - 64 * 1024);
      const buffer = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

export async function isLineBoundary(file: string, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(buffer, 0, 1, offset - 1);
    return bytesRead === 1 && buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

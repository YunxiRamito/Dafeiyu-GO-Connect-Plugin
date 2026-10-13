import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { FileSnapshot } from "./types.ts";

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function snapshotFile(filePath: string, relativePath: string): Promise<FileSnapshot> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    return { relativePath, sha256: await sha256File(filePath), sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  } finally { await handle.close(); }
}

export function chunkCount(sizeBytes: number, chunkSizeBytes: number): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) throw new RangeError("无效的文件大小或分块大小。");
  return sizeBytes === 0 ? 1 : Math.ceil(sizeBytes / chunkSizeBytes);
}

export function chunkBuffer(bytes: Uint8Array, chunkSizeBytes: number, index: number): Uint8Array {
  const total = chunkCount(bytes.byteLength, chunkSizeBytes);
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new RangeError("分块索引越界。");
  const start = index * chunkSizeBytes;
  return bytes.slice(start, Math.min(bytes.byteLength, start + chunkSizeBytes));
}


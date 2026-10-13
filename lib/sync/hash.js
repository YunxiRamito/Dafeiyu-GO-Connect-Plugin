import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
                                               

export function sha256Bytes(bytes            )         {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filePath        )                  {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function snapshotFile(filePath        , relativePath        )                        {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    return { relativePath, sha256: await sha256File(filePath), sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  } finally { await handle.close(); }
}

export function chunkCount(sizeBytes        , chunkSizeBytes        )         {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) throw new RangeError("无效的文件大小或分块大小。");
  return sizeBytes === 0 ? 1 : Math.ceil(sizeBytes / chunkSizeBytes);
}

export function chunkBuffer(bytes            , chunkSizeBytes        , index        )             {
  const total = chunkCount(bytes.byteLength, chunkSizeBytes);
  if (!Number.isInteger(index) || index < 0 || index >= total) throw new RangeError("分块索引越界。");
  const start = index * chunkSizeBytes;
  return bytes.slice(start, Math.min(bytes.byteLength, start + chunkSizeBytes));
}


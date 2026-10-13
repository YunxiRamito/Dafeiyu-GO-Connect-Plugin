import { createHash } from "node:crypto";
import type { CacheCleanupResult, ConnectionProvider, GroupScopedRequest } from "./types.ts";
import { SyncError } from "./types.ts";
import { assertSameGroup, withRetry } from "./engine.ts";

export const MAX_CACHE_CLEANUP_BATCH = 100;

export function cacheCleanupIdempotencyKey(groupId: string, fileIds: readonly string[]): string {
  if (!groupId) throw new SyncError("group_required", "缓存清理需要 group_id。");
  const ids = [...new Set(fileIds)].sort();
  return createHash("sha256").update(`${groupId}\u0000${ids.join("\u0000")}`, "utf8").digest("hex");
}

export class CacheCleanupManager {
  private readonly provider: ConnectionProvider;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  constructor(provider: ConnectionProvider, maxRetries = 3, retryDelayMs = 250) { this.provider = provider; this.maxRetries = maxRetries; this.retryDelayMs = retryDelayMs; }

  async cleanup(groupId: string, fileIds: readonly string[], signal?: AbortSignal): Promise<CacheCleanupResult> {
    const ids = [...new Set(fileIds)];
    if (ids.length === 0) throw new SyncError("empty_cleanup_batch", "缓存清理批次不能为空。");
    if (ids.length > MAX_CACHE_CLEANUP_BATCH) throw new SyncError("cleanup_batch_too_large", `缓存清理每批最多 ${MAX_CACHE_CLEANUP_BATCH} 个文件。`);
    const state = await this.provider.getConnectionState(signal);
    assertSameGroup(groupId, state.groupId);
    if (!state.serverConnected) throw new SyncError("launcher_not_connected", "启动器未连接 Aries。", { retryable: true });
    if (!state.capabilities.fileCacheCleanup) throw new SyncError("cleanup_unsupported", "当前启动器未提供文件缓存清理能力。");
    const idempotencyKey = cacheCleanupIdempotencyKey(groupId, ids);
    return withRetry(() => this.provider.cleanupGroupFileCache({ groupId, fileIds: ids, idempotencyKey, signal }), { maxRetries: this.maxRetries, delayMs: this.retryDelayMs, signal });
  }

  async cleanupAllAvailable(groupId: string, signal?: AbortSignal): Promise<CacheCleanupResult | null> {
    const stats = await this.provider.getGroupFileCacheStats({ groupId, signal });
    assertSameGroup(groupId, stats.groupId);
    if (stats.available === 0 && stats.cleanupPending === 0) return null;
    throw new SyncError("cleanup_requires_file_ids", "缓存统计只返回计数；清理前必须由启动器返回当前小组的 file_id 列表。", { details: stats });
  }
}




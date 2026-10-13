import { ConnectionPluginError } from './errors.ts'
import type { CleanupResult, ConnectionProvider, FileCacheStats } from './provider.ts'

export interface CleanupBatch { group_id: string; file_ids: string[]; idempotency_key: string }

export function createCleanupBatches(groupId: string, fileIds: readonly string[], idempotencyPrefix = 'dafeiyu-cache-cleanup'): CleanupBatch[] {
  if (!groupId || fileIds.some(fileId => !fileId)) throw new ConnectionPluginError('validation_failed', '缓存清理必须使用当前 group_id 和有效 file_id。')
  const batches: CleanupBatch[] = []
  for (let index = 0; index < fileIds.length; index += 100) {
    const part = [...fileIds.slice(index, index + 100)]
    batches.push({ group_id: groupId, file_ids: part, idempotency_key: `${idempotencyPrefix}:${groupId}:${index / 100}` })
  }
  return batches
}

export class CacheCleanupCoordinator {
  private readonly provider: ConnectionProvider
  constructor(provider: ConnectionProvider) { this.provider = provider }

  async stats(groupId: string, options?: { signal?: AbortSignal }): Promise<FileCacheStats> {
    if (!groupId) throw new ConnectionPluginError('validation_failed', 'group_id 不能为空。')
    return (await this.provider.get_group_file_cache_stats({ group_id: groupId }, options)).data
  }

  async cleanup(groupId: string, fileIds: readonly string[], options?: { signal?: AbortSignal }): Promise<CleanupResult[]> {
    const batches = createCleanupBatches(groupId, fileIds)
    const results: CleanupResult[] = []
    for (const batch of batches) results.push((await this.provider.cleanup_group_file_cache(batch, options)).data)
    return results
  }
}

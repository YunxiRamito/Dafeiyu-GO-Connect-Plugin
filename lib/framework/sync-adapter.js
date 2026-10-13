import { createHash } from 'node:crypto'
import { ConnectionPluginError } from './errors.js'
                                                                                                
                                                                                                                          
import { SyncError } from '../sync/types.js'
import { assertPathAllowed } from '../sync/path-filter.js'
import { isSensitivePath } from './path-policy.js'

export function toSyncState(state                 )            {
  return {
    protocol: state.protocol, serverConnected: state.server_connected, groupId: state.group_id,
    pairingStatus: state.pairing_status === 'revoked' ? 'disconnected' : state.pairing_status,
    localDevice: state.local_device,
    members: (state.members ?? (state.remote_device ? [state.remote_device] : [])).map(member => ({
      deviceId: member.id, publicKey: member.public_key, active: 'active' in member ? member.active !== false : true,
      role: 'role' in member ? member.role : undefined, presence: member.online ?? 'unknown',
    })),
    remotePresence: state.remote_device?.online ?? 'unknown',
    capabilities: { workspaceSync: state.capabilities.workspace_sync, webBroadcast: state.capabilities.web_broadcast,
      encryptedMessages: state.capabilities.encrypted_messages, encryptedFiles: state.capabilities.encrypted_files,
      presence: state.capabilities.presence, fileCacheCleanup: state.capabilities.file_cache_cleanup },
  }
}

export function toIncomingTransfer(item                        , group        )                   {
  const relativePath = assertPathAllowed(item.relative_path ?? '', { ignoreRules: [] })
  const totalChunks = Math.max(1, Math.ceil(item.size / item.chunk_size))
  if (item.group_id !== group || !item.transfer_id || isSensitivePath(relativePath) ||
      !Number.isSafeInteger(item.size) || item.size < 0 || !Number.isSafeInteger(item.chunk_size) ||
      item.chunk_size < 1 || item.chunk_size > 1024 * 1024 || totalChunks > 65536 ||
      (item.chunk_count !== undefined && item.chunk_count !== totalChunks) || !/^[a-f0-9]{64}$/i.test(item.hash))
    throw new SyncError('protocol_error', 'Invalid incoming file metadata.')
  return { groupId: group, fileId: item.transfer_id, relativePath, sha256: item.hash.toLowerCase(),
    sizeBytes: item.size, chunkSizeBytes: item.chunk_size, totalChunks, receivedChunks: item.received_chunks,
    senderId: item.sender_device_id, acknowledged: item.acknowledged }
}

export class FrameworkSyncAdapter                         {
                   provider                    
  constructor(provider                    ) { this.provider = provider }
          async checked   (group        , signal                         , operation                  )             {
    try {
      const state = (await this.provider.get_connection_state({ signal })).data
      if (!state.server_connected) throw new SyncError('launcher_not_connected', 'Connection unavailable.', { retryable: true })
      if (state.pairing_status !== 'paired' || state.group_id !== group)
        throw new SyncError('group_changed', 'Current group changed.')
      if (!state.capabilities.workspace_sync || !state.capabilities.encrypted_files)
        throw new SyncError('unsupported', 'Workspace transfers unavailable.')
      const result = await operation()
      const current = (await this.provider.get_connection_state({ signal })).data
      if (current.group_id !== group || current.pairing_status !== 'paired') throw new SyncError('group_changed', 'Current group changed.')
      return result
    } catch (error) {
      if (error instanceof ConnectionPluginError)
        throw new SyncError(error.code === 'request_cancelled' ? 'cancelled' : error.code, error.message, { retryable: error.retryable })
      throw error
    }
  }
  async getConnectionState(signal              ) {
    try { return toSyncState((await this.provider.get_connection_state({ signal })).data) }
    catch (error) {
      if (error instanceof ConnectionPluginError) throw new SyncError(error.code === 'request_cancelled' ? 'cancelled' : error.code, error.message, { retryable: error.retryable })
      throw error
    }
  }
  subscribeConnectionState(listener                            ) { return this.provider.subscribe_connection_state(state => listener(toSyncState(state))) }
  async createFileTransfer(input                                                   ) {
    const relative = assertPathAllowed(input.relativePath, { ignoreRules: [] })
    if (isSensitivePath(relative)) throw new SyncError('path_rejected', 'Sensitive path rejected.')
    return this.checked(input.groupId, input.signal, async () => {
      const result = (await this.provider.create_file_transfer({ group_id: input.groupId, file_id: relative,
        relative_path: relative, size: input.sizeBytes, chunk_size: input.chunkSizeBytes, hash: input.sha256,
        targets: input.targets, idempotency_key: input.idempotencyKey }, { signal: input.signal })).data
      if (result.group_id !== input.groupId || result.size !== input.sizeBytes || result.hash !== input.sha256 ||
          result.chunk_size !== input.chunkSizeBytes || !result.transfer_id)
        throw new SyncError('protocol_error', 'Transfer metadata mismatch.')
      return { fileId: result.transfer_id, groupId: result.group_id,
        totalChunks: Math.max(1, Math.ceil(result.size / result.chunk_size)), chunkSizeBytes: result.chunk_size,
        receivedChunks: result.received_chunks }
    })
  }
  async uploadFileChunk(input                                                ) {
    return this.checked(input.groupId, input.signal, async () => {
      const result = (await this.provider.upload_file_chunk({ group_id: input.groupId, transfer_id: input.fileId,
        chunk_index: input.chunkIndex, hash: createHash('sha256').update(input.bytes).digest('hex'),
        bytes: input.bytes, idempotency_key: input.idempotencyKey }, { signal: input.signal })).data
      if (result.accepted !== true) throw new SyncError('protocol_error', 'Chunk was not accepted.')
    })
  }
  async completeFileTransfer(input                                                     ) {
    return this.checked(input.groupId, input.signal, async () => {
      const result = (await this.provider.complete_file_transfer({ group_id: input.groupId, transfer_id: input.fileId,
        idempotency_key: input.idempotencyKey }, { signal: input.signal })).data
      if (result.completed !== true) throw new SyncError('protocol_error', 'Transfer completion unconfirmed.')
    })
  }
  async listIncomingFileTransfers(input                                                          ) {
    return this.checked(input.groupId, input.signal, async () => {
      const transfers                     = []
      const cursors = new Set        ()
      let cursor                    
      for (let page = 0; page < 10; page++) {
        const result = (await this.provider.list_incoming_file_transfers({ group_id: input.groupId, cursor, limit: 100 }, { signal: input.signal })).data
        if (!Array.isArray(result.transfers) || result.transfers.length > 100 || transfers.length + result.transfers.length > 256)
          throw new SyncError('protocol_error', 'Incoming transfer page exceeds limits.')
        transfers.push(...result.transfers.map(item => toIncomingTransfer(item, input.groupId)))
        if (result.next_cursor === null) return transfers
        if (typeof result.next_cursor !== 'string' || !result.next_cursor || result.next_cursor.length > 256 || cursors.has(result.next_cursor))
          throw new SyncError('protocol_error', 'Invalid incoming transfer cursor.')
        cursor = result.next_cursor
        cursors.add(cursor)
      }
      throw new SyncError('protocol_error', 'Incoming transfer scan exceeds page limit.')
    })
  }
  async downloadFileChunk(input                                                  ) {
    return this.checked(input.groupId, input.signal, async () => {
      const result = (await this.provider.download_file_chunk({ group_id: input.groupId, transfer_id: input.fileId,
        chunk_index: input.chunkIndex }, { signal: input.signal })).data
      if (!(result.bytes instanceof Uint8Array) || createHash('sha256').update(result.bytes).digest('hex') !== result.hash.toLowerCase())
        throw new SyncError('hash_mismatch', 'Downloaded chunk hash mismatch.')
      return result.bytes
    })
  }
  async acknowledgeFileTransfer(input                                                        ) {
    return this.checked(input.groupId, input.signal, async () => {
      await this.provider.acknowledge_file_transfer({ group_id: input.groupId, transfer_id: input.fileId }, { signal: input.signal })
    })
  }
  async getGroupFileCacheStats(input                                                       ) {
    const result = (await this.provider.get_group_file_cache_stats({ group_id: input.groupId }, { signal: input.signal })).data
    return { groupId: input.groupId, uploading: result.uploading, available: result.available,
      cleanupPending: result.cleanup_pending, logicalDeleted: result.logical_deleted, physicalBytes: result.physical_bytes }
  }
  async cleanupGroupFileCache(input                                                      ) {
    const result = (await this.provider.cleanup_group_file_cache({ group_id: input.groupId, file_ids: [...input.fileIds],
      idempotency_key: input.idempotencyKey }, { signal: input.signal })).data
    return { groupId: result.group_id, requested: input.fileIds.length, logicalDeleted: result.logical_deleted,
      alreadyDeleted: 0, cleanupPending: result.pending_physical, physicalCleanupComplete: result.pending_physical === 0,
      idempotencyKey: input.idempotencyKey }
  }
}

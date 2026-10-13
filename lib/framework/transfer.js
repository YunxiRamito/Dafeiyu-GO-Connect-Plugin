import { createHash, randomUUID } from 'node:crypto'
import { createReadStream as readFileStream } from 'node:fs'
import { ConnectionPluginError } from './errors.js'

export function sha256Bytes(bytes            )         { return createHash('sha256').update(bytes).digest('hex') }
export async function sha256File(filePath        )                  { const hash = createHash('sha256'); for await (const chunk of readFileStream(filePath)) hash.update(chunk); return hash.digest('hex') }
export function ensureDiskSpace(availableBytes        , requiredBytes        )       { if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) throw new ConnectionPluginError('disk_space_low', '可用磁盘空间不足。') }
export async function retry   (operation                                 , options                                                                = {})             {
  const attempts = Math.max(1, options.attempts ?? 3); let lastError         
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw new ConnectionPluginError('request_cancelled', '操作已取消。')
    try { return await operation(attempt) } catch (error) { lastError = error; if (attempt === attempts) break; await new Promise      ((resolve, reject) => { const timer = setTimeout(resolve, Math.max(0, options.delayMs ?? 10) * attempt); options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new ConnectionPluginError('request_cancelled', '操作已取消。')) }, { once: true }) }) }
  }
  throw new ConnectionPluginError('retry_exhausted', '重试次数已用尽。', { details: lastError })
}
export function newTransferId()         { return randomUUID() }
                                                                                                                      
                                                                                                                                                                                   

export class TransferStateMachine {
  #status                 = 'created'; #acknowledged = new Set        (); #error                    
           transferId        ;          groupId        ;          fileId        ;          chunkCount        
  constructor(transferId        , groupId        , fileId        , chunkCount        ) { this.transferId = transferId; this.groupId = groupId; this.fileId = fileId; this.chunkCount = chunkCount; if (!Number.isInteger(chunkCount) || chunkCount <= 0) throw new ConnectionPluginError('validation_failed', 'chunkCount 必须是正整数。') }
  get status()                 { return this.#status }
  get acknowledgedChunks()                    { return [...this.#acknowledged].sort((a, b) => a - b) }
  markUploading()       { this.transition(['created', 'interrupted', 'paused', 'failed'], 'uploading') }
  acknowledgeChunk(index        )       { if (!Number.isInteger(index) || index < 0 || index >= this.chunkCount) throw new ConnectionPluginError('validation_failed', 'chunk index 无效。'); if (this.#status === 'cancelled' || this.#status === 'completed') throw new ConnectionPluginError('validation_failed', '传输已经结束。'); this.#acknowledged.add(index); if (this.#acknowledged.size === this.chunkCount) this.#status = 'uploading' }
  pause()       { this.transition(['uploading'], 'paused') }
  interrupt()       { this.transition(['uploading', 'paused'], 'interrupted') }
  resume()       { this.transition(['interrupted', 'paused', 'failed'], 'uploading') }
  complete()       { if (this.#acknowledged.size !== this.chunkCount) throw new ConnectionPluginError('validation_failed', '所有分块确认前不能完成传输。'); this.transition(['uploading'], 'completed') }
  cancel()       { if (this.#status !== 'completed') this.#status = 'cancelled' }
  fail(message        )       { if (this.#status !== 'completed' && this.#status !== 'cancelled') { this.#error = message; this.#status = 'failed' } }
  snapshot()                   { return { transferId: this.transferId, groupId: this.groupId, fileId: this.fileId, chunkCount: this.chunkCount, acknowledgedChunks: this.acknowledgedChunks, status: this.#status, error: this.#error } }
  static restore(snapshot                  )                       { const machine = new TransferStateMachine(snapshot.transferId, snapshot.groupId, snapshot.fileId, snapshot.chunkCount); for (const chunk of snapshot.acknowledgedChunks) machine.#acknowledged.add(chunk); machine.#status = snapshot.status; machine.#error = snapshot.error; return machine }
          transition(allowed                  , next                )       { if (!allowed.includes(this.#status)) throw new ConnectionPluginError('validation_failed', `不能从 ${this.#status} 转移到 ${next}。`); this.#status = next }
}


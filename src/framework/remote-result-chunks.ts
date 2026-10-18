import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { ConnectionPluginError } from './errors.ts'

export const RESULT_CHUNK_TRANSPORT = 'remote_result_chunks_v1'
export const RESULT_CHUNK_BYTES = 48 * 1024
export const RESULT_MAX_BYTES = 8 * 1024 * 1024
export const RESULT_MAX_COUNT = Math.ceil(RESULT_MAX_BYTES / RESULT_CHUNK_BYTES)
const STORE_MAX_BYTES = 64 * 1024 * 1024
const STORE_MAX_FILES = 1024
const HASH = /^[a-f0-9]{64}$/
export interface ResultBlob { response_id: string; total_bytes: number; chunk_count: number; sha256: string; result_type: 'result' | 'event'; sequence: number }
const fail = (code: 'protocol_error' | 'disk_space_low', message: string): never => { throw new ConnectionPluginError(code, message) }
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
export function validResultBlob(value: any): value is ResultBlob {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'chunk_count,response_id,result_type,sequence,sha256,total_bytes' &&
    typeof value.response_id === 'string' && HASH.test(value.response_id) && typeof value.sha256 === 'string' && HASH.test(value.sha256) &&
    Number.isSafeInteger(value.total_bytes) && value.total_bytes > 128 * 1024 && value.total_bytes <= RESULT_MAX_BYTES &&
    Number.isSafeInteger(value.chunk_count) && value.chunk_count === Math.ceil(value.total_bytes / RESULT_CHUNK_BYTES) && value.chunk_count <= RESULT_MAX_COUNT &&
    ['result', 'event'].includes(value.result_type) && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && value.sequence + value.chunk_count + 1 <= 1025
}
export function resultChunkFrames(blob: ResultBlob, bytes: Buffer): Array<{ sequence: number; type: 'result' | 'event'; payload: unknown }> {
  if (!validResultBlob(blob) || bytes.length !== blob.total_bytes || digest(bytes) !== blob.sha256) fail('protocol_error', 'Invalid durable response content.')
  const metadata = { response_id: blob.response_id, total_bytes: blob.total_bytes, chunk_count: blob.chunk_count, sha256: blob.sha256 }
  const frames: Array<{ sequence: number; type: 'result' | 'event'; payload: unknown }> = [{ sequence: blob.sequence, type: 'event',
    payload: { kind: 'result.begin', ...metadata, chunk_bytes: RESULT_CHUNK_BYTES, result_type: blob.result_type } }]
  for (let index = 0; index < blob.chunk_count; index++) frames.push({ sequence: blob.sequence + 1 + index, type: 'event',
    payload: { kind: 'result.chunk', response_id: blob.response_id, index, bytes: bytes.subarray(index * RESULT_CHUNK_BYTES, (index + 1) * RESULT_CHUNK_BYTES).toString('base64') } })
  frames.push({ sequence: blob.sequence + 1 + blob.chunk_count, type: blob.result_type, payload: { kind: 'result.end', ...metadata } })
  return frames
}

/** Immutable, bounded JSON bytes; request receipts retain only checked descriptors. */
export class RemoteResultBlobStore {
  private readonly directory: string
  private writes: Promise<unknown> = Promise.resolve()
  constructor(directory: string) { this.directory = path.join(directory, 'result-blobs') }
  private async ensure(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const directory of [path.dirname(this.directory), this.directory]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) fail('protocol_error', 'Invalid durable response directory.')
    }
  }
  async retain(knownIds: Set<string>): Promise<void> {
    await this.ensure()
    const names = await readdir(this.directory)
    if (names.length > STORE_MAX_FILES * 2) fail('disk_space_low', 'Too many durable response files.')
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name) && !/^response-[a-f0-9-]+\.tmp$/.test(name)) fail('protocol_error', 'Unexpected durable response file.')
      const info = await lstat(path.join(this.directory, name))
      if (!info.isFile() || info.isSymbolicLink() || info.size > RESULT_MAX_BYTES) fail('protocol_error', 'Invalid durable response file.')
      if (name.endsWith('.tmp') || !knownIds.has(name.slice(0, -5))) await rm(path.join(this.directory, name))
    }
  }
  async write(responseId: string, bytes: Buffer): Promise<void> {
    if (!HASH.test(responseId) || bytes.length > RESULT_MAX_BYTES) fail('protocol_error', 'Invalid response size or identity.')
    const write = this.writes.catch(() => {}).then(async () => {
      await this.ensure()
      const names = await readdir(this.directory)
      let total = 0
      if (names.length >= STORE_MAX_FILES) fail('disk_space_low', 'Durable response count limit reached.')
      for (const name of names) {
        const info = await lstat(path.join(this.directory, name))
        if (!/^[a-f0-9]{64}\.json$/.test(name) || !info.isFile() || info.isSymbolicLink() || info.size > RESULT_MAX_BYTES) fail('protocol_error', 'Invalid durable response store.')
        total += info.size
      }
      if (total + bytes.length > STORE_MAX_BYTES) fail('disk_space_low', 'Durable response storage limit reached.')
      const target = path.join(this.directory, responseId + '.json')
      try { await lstat(target); fail('protocol_error', 'Response identity already exists.') } catch (error) { if ((error as any).code !== 'ENOENT') throw error }
      const temporary = path.join(this.directory, `response-${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        await rename(temporary, target)
      } finally { await rm(temporary, { force: true }) }
    })
    this.writes = write
    await write
  }
  async read(blob: ResultBlob): Promise<Buffer> {
    if (!validResultBlob(blob)) fail('protocol_error', 'Invalid response descriptor.')
    await this.ensure()
    const file = path.join(this.directory, blob.response_id + '.json')
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== blob.total_bytes) fail('protocol_error', 'Durable response file changed.')
    const handle = await open(file, 'r')
    try {
      const checked = await handle.stat()
      if (!checked.isFile() || checked.ino !== info.ino || checked.dev !== info.dev || checked.size !== blob.total_bytes) fail('protocol_error', 'Durable response ownership changed.')
      const bytes = Buffer.alloc(blob.total_bytes + 1)
      let position = 0
      while (position < bytes.length) {
        const result = await handle.read(bytes, position, bytes.length - position, position)
        if (!result.bytesRead) break
        position += result.bytesRead
      }
      if (position !== blob.total_bytes || digest(bytes.subarray(0, position)) !== blob.sha256) fail('protocol_error', 'Durable response checksum changed.')
      return bytes.subarray(0, position)
    } finally { await handle.close() }
  }
}

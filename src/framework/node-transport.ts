import net from 'node:net'
import path from 'node:path'
import { open } from 'node:fs/promises'
import { ConnectionPluginError, ERROR_CODES } from './errors.ts'
import type { IpcEnvelope, IpcResponse, IpcTransport } from './ipc.ts'

export const IPC_PROTOCOL = 'dafeiyu-go.connection.v1'
export const MAX_REQUEST_BYTES = 1024 * 1024
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export async function readBoundedJson(file: string, limit = 64 * 1024): Promise<any> {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw new Error('invalid_json_file')
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size <= limit) {
      const read = await handle.read(buffer, size, buffer.length - size, null)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size > limit) throw new Error('invalid_json_file')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
  } finally { await handle.close() }
}

export function pipePath(name: unknown): string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]{1,180}$/.test(name))
    throw new ConnectionPluginError('protocol_error', 'Invalid local pipe name.')
  return `\\\\.\\pipe\\${name}`
}

function encodeRequest(envelope: IpcEnvelope): Buffer {
  let params = envelope.params
  if (envelope.method === 'upload_file_chunk') {
    const chunk = params as any
    if (!(chunk?.bytes instanceof Uint8Array)) throw new ConnectionPluginError('validation_failed', 'Chunk bytes must be Uint8Array.')
    params = { ...chunk, bytes: Buffer.from(chunk.bytes).toString('base64') }
  }
  const bytes = Buffer.from(JSON.stringify({ ...envelope, params }) + '\n', 'utf8')
  if (bytes.length > MAX_REQUEST_BYTES) throw new ConnectionPluginError('validation_failed', 'IPC request exceeds 1 MiB.')
  return bytes
}

export function decodeResponse<T>(buffer: Buffer, envelope: IpcEnvelope): IpcResponse<T> {
  let response: any
  try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) }
  catch { throw new ConnectionPluginError('protocol_error', 'Invalid IPC JSON or UTF-8.') }
  if (!response || response.request_id !== envelope.request_id ||
      (response.protocol !== undefined && response.protocol !== IPC_PROTOCOL) ||
      typeof response.success !== 'boolean')
    throw new ConnectionPluginError('protocol_error', 'IPC response identity mismatch.')
  if (!response.success) {
    if (typeof response.error_code !== 'string' || !Object.hasOwn(ERROR_CODES, response.error_code) || typeof response.message !== 'string')
      throw new ConnectionPluginError('protocol_error', 'Invalid IPC error envelope.')
    // Never expose untrusted raw service errors to logs or command history.
    return { success: false, request_id: response.request_id, error_code: response.error_code,
      message: `Connection request failed (${response.error_code}).`, retryable: response.retryable === true }
  }
  if (!Object.hasOwn(response, 'data')) throw new ConnectionPluginError('protocol_error', 'Missing IPC data.')
  if (envelope.method === 'download_file_chunk') {
    const value = response.data?.bytes
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      throw new ConnectionPluginError('protocol_error', 'Invalid standard base64 chunk.')
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value) throw new ConnectionPluginError('protocol_error', 'Noncanonical base64 chunk.')
    response.data = { ...response.data, bytes: new Uint8Array(bytes) }
  }
  return response
}

export interface NodeTransportOptions {
  env?: NodeJS.ProcessEnv
  /** Socket factory is injectable only for isolated tests and mobile host adapters. */
  connect?: (pipe: string) => net.Socket
}

export class NodePipeTransport implements IpcTransport {
  protected readonly env: NodeJS.ProcessEnv
  private readonly connect: (pipe: string) => net.Socket
  private active = new Set<AbortController>()
  private disposed = false
  constructor(options: NodeTransportOptions = {}) {
    this.env = options.env ?? process.env
    this.connect = options.connect ?? (pipe => net.createConnection(pipe))
  }

  protected async endpoints(): Promise<string[]> {
    const endpoints: string[] = []
    if (this.env.DAFEIYU_CONNECTION_PIPE) endpoints.push(pipePath(this.env.DAFEIYU_CONNECTION_PIPE))
    if (this.env.DSH_HOME) {
      try {
        const descriptor = await readBoundedJson(path.join(this.env.DSH_HOME, 'dafeiyu-connection.json'))
        if (descriptor.protocol !== IPC_PROTOCOL || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1)
          throw new Error('invalid_descriptor')
        const endpoint = pipePath(descriptor.pipe_name)
        if (!endpoints.includes(endpoint)) endpoints.push(endpoint)
      } catch (error) {
        if (!endpoints.length && (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new ConnectionPluginError('protocol_error', 'Invalid launcher descriptor.')
      }
    }
    if (!endpoints.length) throw new ConnectionPluginError('launcher_unavailable', 'Launcher pipe is not available.', { retryable: true })
    return endpoints
  }

  protected wireEnvelope(envelope: IpcEnvelope): IpcEnvelope { return envelope }

  async request<T>(envelope: IpcEnvelope, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<IpcResponse<T>> {
    if (this.disposed) throw new ConnectionPluginError('request_cancelled', 'Transport disposed.')
    if (envelope.protocol !== IPC_PROTOCOL) throw new ConnectionPluginError('protocol_error', 'Unsupported IPC protocol.')
    const bytes = encodeRequest(this.wireEnvelope(envelope))
    const controller = new AbortController()
    const cancel = () => controller.abort(new ConnectionPluginError('request_cancelled', 'IPC request cancelled.'))
    const timeoutMs = Math.min(60_000, Math.max(1, options.timeoutMs ?? 60_000))
    const timer = setTimeout(() => controller.abort(new ConnectionPluginError('request_timeout', 'IPC deadline exceeded.', { retryable: true })), timeoutMs)
    this.active.add(controller)
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    try {
      const endpoints = await this.endpoints()
      for (let index = 0; index < endpoints.length; index++) {
        try { return await this.exchange<T>(endpoints[index], envelope, bytes, controller.signal) }
        catch (error) {
          // A fallback is allowed only before sending any request bytes.
          if (!(error as any)?.beforeSend || index === endpoints.length - 1) throw error
        }
      }
      throw new ConnectionPluginError('launcher_unavailable', 'Launcher pipe unavailable.')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      this.active.delete(controller)
    }
  }

  private exchange<T>(endpoint: string, envelope: IpcEnvelope, bytes: Buffer, signal: AbortSignal): Promise<IpcResponse<T>> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      let socket: net.Socket
      try { socket = this.connect(endpoint) } catch { reject(new ConnectionPluginError('transport_unavailable', 'Cannot create local socket.')); return }
      let sent = false, settled = false, length = 0
      const chunks: Buffer[] = []
      const finish = (error?: unknown, response?: IpcResponse<T>) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        socket.destroy()
        error ? reject(error) : resolve(response!)
      }
      const abort = () => finish(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      socket.once('connect', () => {
        sent = true
        // end() here would cancel the server operation before its response.
        socket.write(bytes)
      })
      socket.on('data', (chunk: Buffer) => {
        const newline = chunk.indexOf(10)
        length += chunk.length
        if (length > MAX_RESPONSE_BYTES) { finish(new ConnectionPluginError('protocol_error', 'IPC response exceeds 2 MiB.')); return }
        if (newline >= 0 && newline !== chunk.length - 1) { finish(new ConnectionPluginError('protocol_error', 'Trailing IPC bytes.')); return }
        chunks.push(chunk)
        if (newline >= 0) {
          try { finish(undefined, decodeResponse<T>(Buffer.concat(chunks, length).subarray(0, length - 1), envelope)) }
          catch (error) { finish(error) }
        }
      })
      const disconnected = () => {
        const error = new ConnectionPluginError('transport_unavailable', 'Launcher pipe disconnected.', { retryable: true })
        Object.assign(error, { beforeSend: !sent })
        finish(error)
      }
      socket.once('error', disconnected)
      socket.once('end', disconnected)
      socket.once('close', disconnected)
    })
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.active) controller.abort(new ConnectionPluginError('request_cancelled', 'Transport disposed.'))
    this.active.clear()
  }
}

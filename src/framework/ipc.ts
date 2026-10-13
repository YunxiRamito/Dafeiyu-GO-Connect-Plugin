import { ConnectionPluginError, type ErrorCode } from './errors.ts'

export interface IpcEnvelope<T = unknown> {
  protocol: 'dafeiyu-go.connection.v1'
  request_id: string
  method: string
  params: T
}
export interface IpcSuccess<T> { success: true; request_id: string; data: T }
export interface IpcFailure { success: false; request_id: string; error_code: ErrorCode; message: string; retryable?: boolean }
export type IpcResponse<T> = IpcSuccess<T> | IpcFailure
export interface IpcTransport { request<T>(envelope: IpcEnvelope, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<IpcResponse<T>> }

export function makeRequestId(): string { return crypto.randomUUID() }

export class ConnectionIpcClient {
  private readonly transport: IpcTransport
  private readonly defaultTimeoutMs: number
  constructor(transport: IpcTransport, defaultTimeoutMs = 20_000) { this.transport = transport; this.defaultTimeoutMs = defaultTimeoutMs }

  async call<T>(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const request_id = makeRequestId()
    if (options.signal?.aborted) throw new ConnectionPluginError('request_cancelled', 'IPC 请求已取消。', { requestId: request_id })
    const response = await this.transport.request<T>({ protocol: 'dafeiyu-go.connection.v1', request_id, method, params }, { ...options, timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs })
    if (!response.success) throw new ConnectionPluginError(response.error_code, response.message, { requestId: response.request_id || request_id, retryable: response.retryable })
    return response.data
  }
}

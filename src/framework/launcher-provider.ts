import { ConnectionPluginError } from './errors.ts'
import { makeRequestId, type IpcTransport } from './ipc.ts'
import { IPC_PROTOCOL } from './node-transport.ts'
import type { ConnectionProvider, ConnectionState, ProviderResult, RemoteHttpRequest, RemoteHttpResponse, RemoteTaskEvent, RemoteTaskRequest, RemoteTaskResult } from './provider.ts'

export function validateConnectionState(value: ConnectionState): ConnectionState {
  if (!value || value.protocol !== IPC_PROTOCOL || typeof value.server_connected !== 'boolean' ||
      (value.group_id !== null && typeof value.group_id !== 'string') ||
      !['paired', 'unpaired', 'awaiting_approval', 'unknown', 'revoked'].includes(value.pairing_status) ||
      !value.local_device || typeof value.local_device.id !== 'string' || !value.capabilities ||
      ['workspace_sync', 'web_broadcast', 'encrypted_messages', 'encrypted_files', 'presence', 'file_cache_cleanup']
        .some(key => typeof (value.capabilities as any)[key] !== 'boolean') ||
      (value.remote_device && !['online', 'offline', 'unknown'].includes(value.remote_device.online)) ||
      ['remote_task', 'remote_directory', 'remote_settings', 'remote_web_tunnel', 'remote_workspace_lifecycle', 'remote_archive_delete', 'remote_artifacts', 'remote_attachments']
        .some(key => (value.capabilities as any)[key] !== undefined && typeof (value.capabilities as any)[key] !== 'boolean'))
    throw new ConnectionPluginError('protocol_error', 'Invalid connection snapshot.')
  return value
}

export class IpcConnectionProvider implements ConnectionProvider {
  readonly protocol = IPC_PROTOCOL
  readonly transport: ConnectionProvider['transport']
  private readonly ipc: IpcTransport
  constructor(ipc: IpcTransport, transport: ConnectionProvider['transport'] = 'named_pipe') { this.ipc = ipc; this.transport = transport }
  private async call<T>(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderResult<T>> {
    const request_id = makeRequestId()
    const response = await this.ipc.request<T>({ protocol: IPC_PROTOCOL, request_id, method, params }, { ...options, timeoutMs: options.timeoutMs ?? 60_000 })
    if (response.request_id !== request_id) throw new ConnectionPluginError('protocol_error', 'IPC response identity mismatch.')
    if (!response.success) throw new ConnectionPluginError(response.error_code, response.message, { requestId: request_id, retryable: response.retryable })
    return response
  }
  async get_connection_state(options?: { signal?: AbortSignal; timeoutMs?: number }) {
    const response = await this.call<ConnectionState>('get_connection_state', {}, options)
    validateConnectionState(response.data)
    return response
  }
  subscribe_connection_state(listener: (state: ConnectionState) => void): () => void {
    const controller = new AbortController()
    let busy = false
    const poll = async () => {
      if (busy || controller.signal.aborted) return
      busy = true
      try { const response = await this.get_connection_state({ signal: controller.signal }); if (!controller.signal.aborted) listener(response.data) }
      catch { /* IPC failure never manufactures an online snapshot. */ }
      finally { busy = false }
    }
    const timer = setInterval(() => { void poll() }, 2000)
    timer.unref()
    void poll()
    return () => { clearInterval(timer); controller.abort() }
  }
  send_encrypted_message: ConnectionProvider['send_encrypted_message'] = (input, options) => this.call('send_encrypted_message', input, options)
  list_incoming_messages: ConnectionProvider['list_incoming_messages'] = (input, options) => this.call('list_incoming_messages', input, options)
  acknowledge_message: ConnectionProvider['acknowledge_message'] = (input, options) => this.call('acknowledge_message', input, options)
  create_file_transfer: ConnectionProvider['create_file_transfer'] = (input, options) => this.call('create_file_transfer', input, options)
  upload_file_chunk: ConnectionProvider['upload_file_chunk'] = (input, options) => this.call('upload_file_chunk', input, options)
  complete_file_transfer: ConnectionProvider['complete_file_transfer'] = (input, options) => this.call('complete_file_transfer', input, options)
  list_incoming_file_transfers: ConnectionProvider['list_incoming_file_transfers'] = (input, options) => this.call('list_incoming_file_transfers', input, options)
  download_file_chunk: ConnectionProvider['download_file_chunk'] = (input, options) => this.call('download_file_chunk', input, options)
  acknowledge_file_transfer: ConnectionProvider['acknowledge_file_transfer'] = (input, options) => this.call('acknowledge_file_transfer', input, options)
  get_group_file_cache_stats: ConnectionProvider['get_group_file_cache_stats'] = (input, options) => this.call('get_group_file_cache_stats', input, options)
  cleanup_group_file_cache: ConnectionProvider['cleanup_group_file_cache'] = (input, options) => this.call('cleanup_group_file_cache', input, options)
  submit_remote_task: ConnectionProvider['submit_remote_task'] = (input, options) => this.call<RemoteTaskResult>('submit_remote_task', input, options)
  poll_remote_events: ConnectionProvider['poll_remote_events'] = (input, options) => this.call<{ events: RemoteTaskEvent[]; next_sequence: number; closed: boolean }>('poll_remote_events', input, options)
  cancel_remote_task: ConnectionProvider['cancel_remote_task'] = (input, options) => this.call<{ accepted: true }>('cancel_remote_task', input, options)
  remote_http: ConnectionProvider['remote_http'] = (input, options) => this.call<RemoteHttpResponse>('remote_http', input, options)
}

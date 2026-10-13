import { ConnectionPluginError, type ErrorCode } from './errors.ts'

export interface ConnectionState {
  protocol: 'dafeiyu-go.connection.v1'
  server_connected: boolean
  group_id: string | null
  pairing_status: 'paired' | 'unpaired' | 'awaiting_approval' | 'unknown' | 'revoked'
  local_device: { id: string; name: string; public_key: string }
  remote_device: { id: string; name: string; public_key: string; online: 'online' | 'offline' | 'unknown'; last_seen_at: string | null } | null
  members?: Array<{ id: string; public_key?: string; role?: string; active?: boolean; online?: 'online' | 'offline' | 'unknown' }>
  capabilities: {
    workspace_sync: boolean
    web_broadcast: boolean
    encrypted_messages: boolean
    encrypted_files: boolean
    presence: boolean
    file_cache_cleanup: boolean
    /** Optional 0.3.0 capabilities. Unknown keys remain forward compatible. */
    remote_task?: boolean
    remote_directory?: boolean
    remote_workspace_lifecycle?: boolean
    remote_archive_delete?: boolean
    remote_artifacts?: boolean
    remote_attachments?: boolean
    remote_settings?: boolean
    remote_web_tunnel?: boolean
  }
}

export interface ProviderResponse<T> { success: true; request_id: string; data: T }
export type ProviderResult<T> = ProviderResponse<T>

export interface EncryptedMessage { message_id: string; kind: string; body: unknown; sender_device_id: string; created_at: string }
export interface FileTransferDescriptor {
  transfer_id: string; file_id: string; group_id: string; size: number; chunk_size: number; hash: string
  relative_path?: string; chunk_count?: number; received_chunks?: number[]; sender_device_id?: string; acknowledged?: boolean
}
export interface FileCacheStats { uploading: number; available: number; cleanup_pending: number; logical_deleted: number; physical_bytes: number }
export interface CleanupResult { group_id: string; batch_id: string; logical_deleted: number; physical_deleted: number; pending_physical: number }

export interface RemoteTaskRequest {
  group_id: string
  request_id: string
  target_device_id?: string
  operation: 'session.create' | 'session.selectModel' | 'session.prompt' | 'session.cancel' | 'session.control' | 'session.follow' | 'session.list' | 'directory.list' |
    'workspace.list' | 'workspace.resolve' | 'models.catalog' | 'settings.describe' | 'settings.update' | 'permissions.catalog' |
    'web.http' | 'web.socket' | 'web.socket.send' | 'web.socket.close' |
    'workspace.remove.prepare' | 'workspace.remove' | 'workspace.files.delete' | 'workspace.removed.list' | 'workspace.removed.restore' |
    'session.archive' | 'session.restore' | 'session.archived.list' |
    'session.archived.delete.prepare' | 'session.archived.delete' |
    'artifact.list' | 'artifact.prepare' | 'artifact.read' | 'artifact.close' |
    'attachment.prepare' | 'attachment.write' | 'attachment.status' | 'attachment.commit' | 'attachment.cancel'
  payload: Record<string, unknown>
}
export interface RemoteTaskEvent {
  request_id: string
  sequence: number
  type: 'accepted' | 'result' | 'error' | 'event' | 'closed'
  payload: unknown
}
export interface RemoteTaskResult { request_id: string; accepted: true }
export interface RemoteHttpRequest {
  group_id: string
  request_id: string
  target_device_id?: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  headers?: Record<string, string>
  body_base64?: string
  /** HTTP uses framed results; omit for the first page, then keep the durable event cursor. */
  after_sequence?: number
}
export interface RemoteHttpResponse { request_id: string; events: RemoteTaskEvent[]; next_sequence: number; final: boolean }

export interface ConnectionProvider {
  get_connection_state(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ProviderResult<ConnectionState>>
  subscribe_connection_state(listener: (state: ConnectionState) => void): () => void
  send_encrypted_message(input: { group_id: string; kind: string; body: unknown; idempotency_key?: string }, options?: { signal?: AbortSignal }): Promise<ProviderResult<{ message_id: string }>>
  list_incoming_messages(input: { group_id: string; cursor?: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<ProviderResult<{ messages: EncryptedMessage[]; next_cursor: string | null }>>
  acknowledge_message(input: { group_id: string; message_id: string }, options?: { signal?: AbortSignal }): Promise<ProviderResult<null>>
  create_file_transfer(input: { group_id: string; file_id: string; size: number; chunk_size: number; hash: string; relative_path?: string; targets?: readonly string[]; idempotency_key?: string }, options?: { signal?: AbortSignal }): Promise<ProviderResult<FileTransferDescriptor>>
  upload_file_chunk(input: { group_id: string; transfer_id: string; chunk_index: number; chunk_count?: number; hash: string; bytes: Uint8Array; idempotency_key?: string }, options?: { signal?: AbortSignal }): Promise<ProviderResult<{ accepted: boolean }>>
  complete_file_transfer(input: { group_id: string; transfer_id: string; idempotency_key?: string }, options?: { signal?: AbortSignal }): Promise<ProviderResult<{ completed: boolean }>>
  list_incoming_file_transfers(input: { group_id: string; cursor?: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<ProviderResult<{ transfers: FileTransferDescriptor[]; next_cursor: string | null }>>
  download_file_chunk(input: { group_id: string; transfer_id: string; chunk_index: number }, options?: { signal?: AbortSignal }): Promise<ProviderResult<{ bytes: Uint8Array; hash: string; final: boolean }>>
  acknowledge_file_transfer(input: { group_id: string; transfer_id: string }, options?: { signal?: AbortSignal }): Promise<ProviderResult<null>>
  get_group_file_cache_stats(input: { group_id: string }, options?: { signal?: AbortSignal }): Promise<ProviderResult<FileCacheStats>>
  cleanup_group_file_cache(input: { group_id: string; file_ids: string[]; idempotency_key: string }, options?: { signal?: AbortSignal }): Promise<ProviderResult<CleanupResult>>
  submit_remote_task(input: RemoteTaskRequest, options?: { signal?: AbortSignal }): Promise<ProviderResult<RemoteTaskResult>>
  poll_remote_events(input: { group_id: string; request_id: string; after_sequence?: number; limit?: number }, options?: { signal?: AbortSignal }): Promise<ProviderResult<{ events: RemoteTaskEvent[]; next_sequence: number; closed: boolean }>>
  cancel_remote_task(input: { group_id: string; request_id: string }, options?: { signal?: AbortSignal }): Promise<ProviderResult<{ accepted: true }>>
  remote_http(input: RemoteHttpRequest, options?: { signal?: AbortSignal }): Promise<ProviderResult<RemoteHttpResponse>>
}

export interface LauncherConnectionProvider extends ConnectionProvider {
  readonly protocol: 'dafeiyu-go.connection.v1'
  readonly transport: 'named_pipe' | 'launcher_rpc' | 'mock' | 'android_abstract_socket' | 'injected_ipc'
}

export class UnavailableConnectionProvider implements LauncherConnectionProvider {
  readonly protocol = 'dafeiyu-go.connection.v1' as const
  readonly transport = 'launcher_rpc' as const
  #listeners = new Set<(state: ConnectionState) => void>()

  async get_connection_state(): Promise<ProviderResult<ConnectionState>> {
    throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。')
  }

  subscribe_connection_state(listener: (state: ConnectionState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async send_encrypted_message(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async list_incoming_messages(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async acknowledge_message(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async create_file_transfer(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async upload_file_chunk(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async complete_file_transfer(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async list_incoming_file_transfers(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async download_file_chunk(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async acknowledge_file_transfer(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async get_group_file_cache_stats(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async cleanup_group_file_cache(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async submit_remote_task(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async poll_remote_events(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async cancel_remote_task(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
  async remote_http(): Promise<never> { throw new ConnectionPluginError('launcher_unavailable', '启动器连接接口尚未提供。') }
}

export class MockConnectionProvider implements LauncherConnectionProvider {
  readonly protocol = 'dafeiyu-go.connection.v1' as const
  readonly transport = 'mock' as const
  readonly calls: Array<{ method: string; input: unknown }> = []
  #state: ConnectionState
  #listeners = new Set<(state: ConnectionState) => void>()
  #messages: EncryptedMessage[] = []

  constructor(state?: Partial<ConnectionState>) {
    this.#state = {
      protocol: 'dafeiyu-go.connection.v1', server_connected: false, group_id: null, pairing_status: 'unknown',
      local_device: { id: '', name: '', public_key: '' }, remote_device: null,
      capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: false, encrypted_files: false, presence: false, file_cache_cleanup: false },
      ...state,
    }
  }

  setState(state: ConnectionState): void { this.#state = state; for (const listener of this.#listeners) listener(state) }
  enqueueMessage(message: EncryptedMessage): void { this.#messages.push(message) }
  async get_connection_state(): Promise<ProviderResult<ConnectionState>> { this.calls.push({ method: 'get_connection_state', input: null }); return { success: true, request_id: crypto.randomUUID(), data: this.#state } }
  subscribe_connection_state(listener: (state: ConnectionState) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  async send_encrypted_message(input: { group_id: string; kind: string; body: unknown }): Promise<ProviderResult<{ message_id: string }>> { this.calls.push({ method: 'send_encrypted_message', input }); return { success: true, request_id: crypto.randomUUID(), data: { message_id: crypto.randomUUID() } } }
  async list_incoming_messages(input: { group_id: string; cursor?: string; limit?: number }): Promise<ProviderResult<{ messages: EncryptedMessage[]; next_cursor: string | null }>> { this.calls.push({ method: 'list_incoming_messages', input }); return { success: true, request_id: crypto.randomUUID(), data: { messages: this.#messages.splice(0, input.limit ?? 100), next_cursor: null } } }
  async acknowledge_message(input: { group_id: string; message_id: string }): Promise<ProviderResult<null>> { this.calls.push({ method: 'acknowledge_message', input }); return { success: true, request_id: crypto.randomUUID(), data: null } }
  async create_file_transfer(input: { group_id: string; file_id: string; size: number; chunk_size: number; hash: string }): Promise<ProviderResult<FileTransferDescriptor>> { this.calls.push({ method: 'create_file_transfer', input }); return { success: true, request_id: crypto.randomUUID(), data: { transfer_id: 'transfer_mock', ...input } } }
  async upload_file_chunk(input: { group_id: string; transfer_id: string; chunk_index: number; chunk_count: number; hash: string; bytes: Uint8Array }): Promise<ProviderResult<{ accepted: boolean }>> { this.calls.push({ method: 'upload_file_chunk', input: { ...input, bytes: `<${input.bytes.byteLength} bytes>` } }); return { success: true, request_id: crypto.randomUUID(), data: { accepted: true } } }
  async complete_file_transfer(input: { group_id: string; transfer_id: string }): Promise<ProviderResult<{ completed: boolean }>> { this.calls.push({ method: 'complete_file_transfer', input }); return { success: true, request_id: crypto.randomUUID(), data: { completed: true } } }
  async list_incoming_file_transfers(input: { group_id: string; cursor?: string; limit?: number }): Promise<ProviderResult<{ transfers: FileTransferDescriptor[]; next_cursor: string | null }>> { this.calls.push({ method: 'list_incoming_file_transfers', input }); return { success: true, request_id: crypto.randomUUID(), data: { transfers: [], next_cursor: null } } }
  async download_file_chunk(input: { group_id: string; transfer_id: string; chunk_index: number }): Promise<ProviderResult<{ bytes: Uint8Array; hash: string; final: boolean }>> { this.calls.push({ method: 'download_file_chunk', input }); return { success: true, request_id: crypto.randomUUID(), data: { bytes: new Uint8Array(), hash: '', final: true } } }
  async acknowledge_file_transfer(input: { group_id: string; transfer_id: string }): Promise<ProviderResult<null>> { this.calls.push({ method: 'acknowledge_file_transfer', input }); return { success: true, request_id: crypto.randomUUID(), data: null } }
  async get_group_file_cache_stats(input: { group_id: string }): Promise<ProviderResult<FileCacheStats>> { this.calls.push({ method: 'get_group_file_cache_stats', input }); return { success: true, request_id: crypto.randomUUID(), data: { uploading: 0, available: 0, cleanup_pending: 0, logical_deleted: 0, physical_bytes: 0 } } }
  async cleanup_group_file_cache(input: { group_id: string; file_ids: string[]; idempotency_key: string }): Promise<ProviderResult<CleanupResult>> { this.calls.push({ method: 'cleanup_group_file_cache', input }); return { success: true, request_id: crypto.randomUUID(), data: { group_id: input.group_id, batch_id: input.idempotency_key, logical_deleted: input.file_ids.length, physical_deleted: input.file_ids.length, pending_physical: 0 } } }
  async submit_remote_task(input: RemoteTaskRequest): Promise<ProviderResult<RemoteTaskResult>> { this.calls.push({ method: 'submit_remote_task', input }); return { success: true, request_id: crypto.randomUUID(), data: { request_id: input.request_id, accepted: true } } }
  async poll_remote_events(input: { group_id: string; request_id: string; after_sequence?: number; limit?: number }): Promise<ProviderResult<{ events: RemoteTaskEvent[]; next_sequence: number; closed: boolean }>> { this.calls.push({ method: 'poll_remote_events', input }); return { success: true, request_id: crypto.randomUUID(), data: { events: [], next_sequence: input.after_sequence ?? 0, closed: false } } }
  async cancel_remote_task(input: { group_id: string; request_id: string }): Promise<ProviderResult<{ accepted: true }>> { this.calls.push({ method: 'cancel_remote_task', input }); return { success: true, request_id: crypto.randomUUID(), data: { accepted: true } } }
  async remote_http(input: RemoteHttpRequest): Promise<ProviderResult<RemoteHttpResponse>> { this.calls.push({ method: 'remote_http', input }); return { success: true, request_id: crypto.randomUUID(), data: { request_id: input.request_id, events: [], next_sequence: 0, final: true } } }
}

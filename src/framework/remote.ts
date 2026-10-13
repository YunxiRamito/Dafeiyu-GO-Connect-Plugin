import { ConnectionPluginError } from './errors.ts'
import type {
  ConnectionProvider, ProviderResult, RemoteHttpRequest, RemoteHttpResponse,
  RemoteTaskEvent, RemoteTaskRequest, RemoteTaskResult,
} from './provider.ts'
import { PermissionSet } from './permissions.ts'
import { validateRemoteWebHttp } from './remote-web.ts'
import { WORKSPACE_LIFECYCLE_OPERATIONS } from './remote-workspaces.ts'
import { ARCHIVE_DELETE_OPERATIONS } from './remote-archive.ts'
import { ARTIFACT_OPERATIONS } from './remote-artifacts.ts'
import { ATTACHMENT_OPERATIONS } from './remote-attachments.ts'

/**
 * Narrow, capability-gated client for the 0.3.0 remote DSH bridge.
 *
 * The request id belongs to the caller and is reused when a transport call is
 * retried. The PC bridge treats it as an idempotency key; reconnecting therefore
 * polls the existing event stream instead of submitting another DSH prompt.
 */
export class RemoteDshClient {
  private readonly provider: ConnectionProvider
  private readonly permissions: PermissionSet
  constructor(provider: ConnectionProvider, permissions: PermissionSet = new PermissionSet()) {
    this.provider = provider
    this.permissions = permissions
  }

  private async state(group_id: string, required: 'remote_task' | 'remote_directory' | 'remote_settings' | 'remote_web_tunnel' | 'remote_workspace_lifecycle' | 'remote_archive_delete' | 'remote_artifacts' | 'remote_attachments') {
    this.permissions.require('connection.read')
    if (!validGroup(group_id)) throw new ConnectionPluginError('validation_failed', 'Invalid remote group.')
    const state = (await this.provider.get_connection_state()).data
    if (state.group_id !== group_id || !state.server_connected || state.pairing_status !== 'paired')
      throw new ConnectionPluginError('connection_unavailable', 'Remote DSH pairing is unavailable.')
    if (state.remote_device?.online !== 'online') throw new ConnectionPluginError('remote_offline', 'Remote DSH is offline.')
    if (state.capabilities[required] !== true) throw new ConnectionPluginError('unsupported', 'Remote DSH capability is unavailable.')
    return state
  }

  async submit(input: RemoteTaskRequest, options: { signal?: AbortSignal } = {}): Promise<ProviderResult<RemoteTaskResult>> {
    this.permissions.require('connection.remote.task')
    validateRequest(input)
    const directory = ['directory.list', 'workspace.list', 'workspace.resolve'].includes(input.operation)
    const settings = ['session.selectModel', 'settings.describe', 'settings.update', 'permissions.catalog'].includes(input.operation)
    if (directory) this.permissions.require('connection.remote.directory')
    if (settings) this.permissions.require('connection.remote.settings')
    const lifecycle = WORKSPACE_LIFECYCLE_OPERATIONS.includes(input.operation)
    const archiveDelete = ARCHIVE_DELETE_OPERATIONS.includes(input.operation)
    const artifact = ARTIFACT_OPERATIONS.includes(input.operation)
    const attachment = ATTACHMENT_OPERATIONS.includes(input.operation)
    if (lifecycle) this.permissions.require('connection.remote.workspace.lifecycle')
    if (archiveDelete) this.permissions.require('connection.remote.archive.delete')
    if (artifact) this.permissions.require('connection.remote.artifacts')
    if (attachment) this.permissions.require('connection.remote.attachments')
    if (input.operation.startsWith('web.')) this.permissions.require('connection.remote.web')
    const state = await this.state(input.group_id, archiveDelete ? 'remote_archive_delete' : attachment ? 'remote_attachments' : artifact ? 'remote_artifacts' : lifecycle ? 'remote_workspace_lifecycle' : input.operation.startsWith('web.') ? 'remote_web_tunnel' : directory ? 'remote_directory' : settings ? 'remote_settings' : 'remote_task')
    if (input.operation === 'session.prompt' && Array.isArray(input.payload.content) && input.payload.content.some((part: any) => part?.type === 'file')) {
      this.permissions.require('connection.remote.attachments')
      if (state.capabilities.remote_attachments !== true) throw new ConnectionPluginError('unsupported', 'Remote attachments are unavailable.')
    }
    if (input.target_device_id !== undefined && input.target_device_id !== state.remote_device?.id) throw new ConnectionPluginError('conflict', 'The selected execution device changed.')
    return this.provider.submit_remote_task({ ...input, target_device_id: state.remote_device!.id }, options)
  }

  async events(input: { group_id: string; request_id: string; after_sequence?: number; limit?: number }, options: { signal?: AbortSignal } = {}): Promise<ProviderResult<{ events: RemoteTaskEvent[]; next_sequence: number; closed: boolean }>> {
    this.permissions.require('connection.remote.task')
    await this.state(input.group_id, 'remote_task')
    validateRequestId(input.request_id)
    if (input.after_sequence !== undefined && (!Number.isSafeInteger(input.after_sequence) || input.after_sequence < 0)) throw new ConnectionPluginError('validation_failed', 'Invalid event cursor.')
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new ConnectionPluginError('validation_failed', 'Invalid event limit.')
    return this.provider.poll_remote_events(input, options)
  }

  async cancel(input: { group_id: string; request_id: string }, options: { signal?: AbortSignal } = {}): Promise<ProviderResult<{ accepted: true }>> {
    this.permissions.require('connection.remote.task')
    await this.state(input.group_id, 'remote_task')
    validateRequestId(input.request_id)
    return this.provider.cancel_remote_task(input, options)
  }

  async http(input: RemoteHttpRequest, options: { signal?: AbortSignal } = {}): Promise<ProviderResult<RemoteHttpResponse>> {
    this.permissions.require('connection.remote.web')
    const state = await this.state(input.group_id, 'remote_web_tunnel')
    validateRequestId(input.request_id)
    validateRemoteWebHttp({ method: input.method, path: input.path, headers: input.headers, body_base64: input.body_base64 })
    if (input.target_device_id !== undefined && input.target_device_id !== state.remote_device!.id) throw new ConnectionPluginError('conflict', 'The selected web execution device changed.')
    if (input.after_sequence !== undefined && (!Number.isSafeInteger(input.after_sequence) || input.after_sequence < -1 || input.after_sequence > 1025)) throw new ConnectionPluginError('validation_failed', 'Invalid HTTP event cursor.')
    return this.provider.remote_http({ ...input, target_device_id: state.remote_device!.id }, options)
  }
}

function validGroup(value: string): boolean { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) }
function validateRequestId(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new ConnectionPluginError('validation_failed', 'Remote request id is invalid.')
}
function validateRequest(value: RemoteTaskRequest): void {
  validateRequestId(value.request_id)
  if (!validGroup(value.group_id) || !value.payload || Array.isArray(value.payload) || typeof value.payload !== 'object') throw new ConnectionPluginError('validation_failed', 'Remote request is invalid.')
  if (Object.keys(value.payload).length > 64 || Buffer.byteLength(JSON.stringify(value.payload), 'utf8') > 128 * 1024) throw new ConnectionPluginError('validation_failed', 'Remote request payload is too large.')
  if (!['session.create', 'session.selectModel', 'session.prompt', 'session.cancel', 'session.control', 'session.follow', 'session.list', 'directory.list', 'workspace.list', 'workspace.resolve', 'models.catalog', 'settings.describe', 'settings.update', 'permissions.catalog', 'web.http', 'web.socket', 'web.socket.send', 'web.socket.close', ...WORKSPACE_LIFECYCLE_OPERATIONS, ...ARCHIVE_DELETE_OPERATIONS, ...ARTIFACT_OPERATIONS, ...ATTACHMENT_OPERATIONS].includes(value.operation)) throw new ConnectionPluginError('unsupported', 'Remote operation is unavailable.')
}

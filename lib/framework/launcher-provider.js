import { ConnectionPluginError } from './errors.js'
import { makeRequestId,                   } from './ipc.js'
import { IPC_PROTOCOL } from './node-transport.js'
                                                                                                                                                                                                       

function validHardwareSnapshot(value         )                            {
  if (!value || typeof value !== 'object') return false
  const v = value       
  const memory = v.memory
  const network = v.network
  return typeof v.device_name === 'string' && typeof v.system === 'string' && typeof v.cpu === 'string' && typeof v.gpu === 'string' &&
    typeof v.updated_at === 'string' && !!memory && typeof memory.used_bytes === 'number' && Number.isFinite(memory.used_bytes) &&
    typeof memory.total_bytes === 'number' && Number.isFinite(memory.total_bytes) && !!network &&
    typeof network.upload_bytes_per_second === 'number' && Number.isFinite(network.upload_bytes_per_second) &&
    typeof network.download_bytes_per_second === 'number' && Number.isFinite(network.download_bytes_per_second) &&
    Array.isArray(v.storage) && v.storage.every((item     ) => item && typeof item.name === 'string' &&
      typeof item.used_bytes === 'number' && Number.isFinite(item.used_bytes) && typeof item.total_bytes === 'number' && Number.isFinite(item.total_bytes))
}

export function validateConnectionState(value                 )                  {
  if (!value || value.protocol !== IPC_PROTOCOL || typeof value.server_connected !== 'boolean' ||
      (value.group_id !== null && typeof value.group_id !== 'string') ||
      !['paired', 'unpaired', 'awaiting_approval', 'unknown', 'revoked'].includes(value.pairing_status) ||
      !value.local_device || typeof value.local_device.id !== 'string' || !value.capabilities ||
      ['workspace_sync', 'web_broadcast', 'encrypted_messages', 'encrypted_files', 'presence', 'file_cache_cleanup']
        .some(key => typeof (value.capabilities       )[key] !== 'boolean') ||
      (value.remote_device && (!['online', 'offline', 'unknown'].includes(value.remote_device.online) ||
        (value.remote_device.hardware !== undefined && !validHardwareSnapshot(value.remote_device.hardware)))) ||
      ['device_hardware', 'remote_task', 'remote_directory', 'remote_settings', 'remote_web_tunnel', 'remote_workspace_lifecycle', 'remote_archive_delete', 'remote_artifacts', 'remote_attachments']
        .some(key => (value.capabilities       )[key] !== undefined && typeof (value.capabilities       )[key] !== 'boolean'))
    throw new ConnectionPluginError('protocol_error', 'Invalid connection snapshot.')
  return value
}

export class IpcConnectionProvider                               {
           protocol = IPC_PROTOCOL
           transport                                 
                   ipc              
  constructor(ipc              , transport                                  = 'named_pipe') { this.ipc = ipc; this.transport = transport }
          async call   (method        , params         , options                                               = {})                             {
    const request_id = makeRequestId()
    const response = await this.ipc.request   ({ protocol: IPC_PROTOCOL, request_id, method, params }, { ...options, timeoutMs: options.timeoutMs ?? 60_000 })
    if (response.request_id !== request_id) throw new ConnectionPluginError('protocol_error', 'IPC response identity mismatch.')
    if (!response.success) throw new ConnectionPluginError(response.error_code, response.message, { requestId: request_id, retryable: response.retryable })
    return response
  }
  async get_connection_state(options                                               ) {
    const response = await this.call                 ('get_connection_state', {}, options)
    validateConnectionState(response.data)
    return response
  }
  subscribe_connection_state(listener                                  )             {
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
  send_encrypted_message                                               = (input, options) => this.call('send_encrypted_message', input, options)
  list_incoming_messages                                               = (input, options) => this.call('list_incoming_messages', input, options)
  acknowledge_message                                            = (input, options) => this.call('acknowledge_message', input, options)
  create_file_transfer                                             = (input, options) => this.call('create_file_transfer', input, options)
  upload_file_chunk                                          = (input, options) => this.call('upload_file_chunk', input, options)
  complete_file_transfer                                               = (input, options) => this.call('complete_file_transfer', input, options)
  list_incoming_file_transfers                                                     = (input, options) => this.call('list_incoming_file_transfers', input, options)
  download_file_chunk                                            = (input, options) => this.call('download_file_chunk', input, options)
  acknowledge_file_transfer                                                  = (input, options) => this.call('acknowledge_file_transfer', input, options)
  get_group_file_cache_stats                                                   = (input, options) => this.call('get_group_file_cache_stats', input, options)
  cleanup_group_file_cache                                                 = (input, options) => this.call('cleanup_group_file_cache', input, options)
  submit_remote_task                                           = (input, options) => this.call                  ('submit_remote_task', input, options)
  poll_remote_events                                           = (input, options) => this.call                                                                       ('poll_remote_events', input, options)
  cancel_remote_task                                           = (input, options) => this.call                    ('cancel_remote_task', input, options)
  remote_http                                    = (input, options) => this.call                    ('remote_http', input, options)
}

import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { mergeConfig,                   } from './config.js'
import { ConnectionPluginError } from './errors.js'
import { readBoundedJson } from './node-transport.js'
import { decideSyncPath } from './path-policy.js'
import { createBroadcastPayload, sanitizeIncomingBroadcast,                       } from './broadcast.js'
                                                                                          
import { validateConnectionState } from './launcher-provider.js'
import { FrameworkSyncAdapter } from './sync-adapter.js'
import { WorkspaceSynchronizer } from '../sync/engine.js'
import { JsonQueueStore, SyncQueue } from '../sync/queue.js'
import { assertPathAllowed, resolveWorkspacePath } from '../sync/path-filter.js'
import { TransferStateMachine } from '../sync/transfer.js'
                                                                             
import { SyncError } from '../sync/types.js'
import { PermissionSet } from './permissions.js'
                                                     

                                                                                  
export function patchConfig(base              , patch              = {})               {
  return mergeConfig({ workspaceSync: { ...base.workspaceSync, ...patch.workspaceSync,
    kind: patch.workspaceSync?.kind ?? (patch.workspaceSync?.root ? 'files' : base.workspaceSync.kind) },
    broadcast: { ...base.broadcast, ...patch.broadcast }, limits: { ...base.limits, ...patch.limits } })
}
                                                                                                                                   
                        
                   
                      
                 
                                                             
                       
                                   
 
                                 
                              
                            
                      
               
                         
                 
                            
 

export class ConnectionRuntime {
           ready               
           queue           
                   provider                    
                   permissions               
                   adapter                      
                   directory         
                   home         
                   options                
          durable              
          history                                                                             = []
          stop = new AbortController()
          operation                  
          operationDone                   
          timer                                 
          pendingPoll                
          saves                = Promise.resolve()
          unsubscribe             
          disposed = false
          snapshot                  
          nativeFingerprint         
          syncStatus = 'disabled'
          lastError         
                   remoteHost                

  constructor(options                ) {
    this.options = options
    this.provider = options.provider
    this.permissions = options.permissions
    this.remoteHost = options.remoteHost
    this.adapter = new FrameworkSyncAdapter(this.provider)
    this.home = options.home
    this.directory = options.stateDirectory ?? (this.home ? path.join(this.home, 'dafeiyu-connection-plugin') : undefined)
    this.durable = { schema_version: 1, config: patchConfig(mergeConfig(undefined), options.config),
      paused: false, groups: {}, conflicts: [], baselines: {} }
    // Without an explicit host home, use memory rather than write into a guessed directory.
    this.queue = new SyncQueue(this.directory
      ? new JsonQueueStore(path.join(this.directory, 'queue.json'), this.directory)
      : { load: async () => [], save: async () => {} })
    this.ready = this.initialize()
    this.ready.catch(() => { this.lastError = 'state_restore_failed' })
  }

          async initialize()                {
    if (this.directory) {
      try {
        const value = await readBoundedJson(path.join(this.directory, 'state.json'), 2 * 1024 * 1024)
        if (value.schema_version !== 1 || typeof value.paused !== 'boolean' || !value.config ||
            !value.groups || !Array.isArray(value.conflicts) || !value.baselines)
          throw new Error('invalid_state')
        this.durable = { ...value, config: patchConfig(mergeConfig(value.config), this.options.config) }
        if (value.config.workspaceSync?.kind === undefined && !this.options.config?.workspaceSync?.root)
          this.durable.config = patchConfig(this.durable.config, { workspaceSync: { enabled: true, kind: 'dsh', root: null }, broadcast: { enabled: true } })
      } catch (error) { if ((error                         ).code !== 'ENOENT') throw error }
    }
    this.applyConfig({})
    await this.queue.restore()
    // Interrupted processes must resume through the queue state machine.
    for (const item of this.queue.list()) {
      if (['creating', 'uploading'].includes(item.status))
        await this.queue.upsert(new TransferStateMachine(item).pause())
    }
    await this.readNativePreferences()
    if (this.disposed) return
    this.permissions.require('connection.state.subscribe')
    this.unsubscribe = this.provider.subscribe_connection_state(state => {
      try { this.acceptSnapshot(validateConnectionState(state)) } catch { this.snapshot = undefined }
    })
    this.timer = setInterval(() => { void this.pollOnce().catch(error => { this.lastError = this.errorCode(error) }) }, this.options.pollMs ?? 2000)
    this.timer.unref()
    void this.pollOnce().catch(error => { this.lastError = this.errorCode(error) })
  }

  getConfig()               { return structuredClone(this.durable.config) }
  getStatus() { return { status: this.durable.paused ? 'paused' : this.syncStatus, error_code: this.lastError,
    group_id: this.snapshot?.group_id ?? null, persistent: Boolean(this.directory) } }
  async setConfig(patch             )                {
    await this.ready
    this.assertActive()
    this.applyConfig(patch)
    await this.save()
  }
          applyConfig(patch             )       {
    const previous = this.durable.config
    const next = patchConfig(previous, patch)
    if (next.workspaceSync.root !== null) {
      if (typeof next.workspaceSync.root !== 'string' || !next.workspaceSync.root.trim() || !path.isAbsolute(next.workspaceSync.root))
        throw new ConnectionPluginError('validation_failed', 'Workspace root must be an explicitly selected absolute path.')
      next.workspaceSync.root = path.resolve(next.workspaceSync.root)
    }
    if (typeof next.workspaceSync.enabled !== 'boolean' || !['dsh', 'files'].includes(next.workspaceSync.kind) ||
        (next.workspaceSync.dshHome !== null && (typeof next.workspaceSync.dshHome !== 'string' || !path.isAbsolute(next.workspaceSync.dshHome))) ||
        (next.workspaceSync.root !== null && typeof next.workspaceSync.root !== 'string') ||
        !['manual', 'watch'].includes(next.workspaceSync.mode) || !['ask', 'keep_local', 'keep_remote', 'keep_both'].includes(next.workspaceSync.conflictPolicy) ||
        typeof next.broadcast.enabled !== 'boolean' || !Number.isSafeInteger(next.limits.chunkBytes) ||
        next.limits.chunkBytes < 1 || next.limits.chunkBytes > 512 * 1024 ||
        !Number.isSafeInteger(next.limits.maxFileBytes) || next.limits.maxFileBytes < 0 ||
        next.limits.maxFileBytes > 256 * 1024 * 1024 || !Number.isSafeInteger(next.limits.maxQueuedTasks) ||
        next.limits.maxQueuedTasks < 1 || next.limits.maxQueuedTasks > 1000 ||
        !Number.isSafeInteger(next.limits.retryAttempts) || next.limits.retryAttempts < 0 || next.limits.retryAttempts > 5 ||
        !Number.isSafeInteger(next.limits.requestTimeoutMs) || next.limits.requestTimeoutMs < 1 || next.limits.requestTimeoutMs > 60_000)
      throw new ConnectionPluginError('validation_failed', 'Invalid connection configuration.')
    this.durable.config = next
    if (previous.workspaceSync.root !== next.workspaceSync.root || !next.workspaceSync.enabled) this.operation?.abort()
    this.syncStatus = next.workspaceSync.enabled ? 'waiting_for_connection' : 'disabled'
  }
          async readNativePreferences()                {
    if (!this.home) return
    try {
      const value = await readBoundedJson(path.join(this.home, 'dafeiyu-connection-preferences.json'))
      if (![1, 2].includes(value.schema_version) || typeof value.workspace_sync?.enabled !== 'boolean' ||
          typeof value.web_broadcast?.enabled !== 'boolean' ||
          (value.schema_version === 2 && (value.workspace_sync.kind !== 'dsh' ||
            typeof value.workspace_sync.dsh_home !== 'string' || !this.home ||
            path.resolve(value.workspace_sync.dsh_home) !== path.resolve(this.home))))
        throw new Error('invalid_preferences')
      const fingerprint = JSON.stringify(value)
      if (fingerprint !== this.nativeFingerprint) {
        // Connection means DSH workspace/conversation sharing and web access.
        // Old toggles and arbitrary roots are migrated without reading files.
        this.applyConfig({ workspaceSync: { enabled: true, kind: 'dsh', dshHome: this.home, root: null },
          broadcast: { enabled: true } })
        await this.save()
        this.nativeFingerprint = fingerprint
      }
      if (this.lastError === 'invalid_native_preferences') this.lastError = undefined
    } catch (error) {
      if ((error                         ).code !== 'ENOENT') this.lastError = 'invalid_native_preferences'
    }
  }
          save()                {
    if (!this.directory) return Promise.resolve()
    const content = JSON.stringify(this.durable)
    const operation = this.saves.catch(() => {}).then(async () => {
      await mkdir(this.directory , { recursive: true })
      const temporary = path.join(this.directory , `state-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await rename(temporary, path.join(this.directory , 'state.json'))
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
    })
    this.saves = operation
    return operation
  }
          assertActive()       {
    if (this.disposed) throw new ConnectionPluginError('request_cancelled', 'Plugin disposed.')
  }
          errorCode(error         )         {
    return error instanceof ConnectionPluginError || error instanceof SyncError ? error.code : 'runtime_failed'
  }
          acceptSnapshot(state                 )       {
    if (this.snapshot?.group_id !== state.group_id || state.pairing_status !== 'paired') {
      this.operation?.abort()
      this.history = []
    }
    this.snapshot = state
  }
          async current(signal              )                           {
    this.permissions.require('connection.read')
    const state = validateConnectionState((await this.provider.get_connection_state({ signal })).data)
    this.acceptSnapshot(state)
    if (!state.server_connected || state.pairing_status !== 'paired' || !state.group_id)
      throw new ConnectionPluginError('connection_unavailable', 'Current paired group is unavailable.')
    return state
  }
          async verifyGroup(group        , signal             )                {
    const state = await this.current(signal)
    if (state.group_id !== group) throw new ConnectionPluginError('request_cancelled', 'Group changed.')
  }
  async pause()                              {
    await this.ready
    this.permissions.require('workspace.read')
    this.durable.paused = true
    this.operation?.abort()
    await this.operationDone?.catch(() => {})
    await this.save()
    return { status: 'paused' }
  }
  async resume()                              {
    await this.ready
    this.permissions.require('workspace.read')
    this.durable.paused = false
    await this.save()
    const result = await this.syncNow()
    return { status: result.status }
  }
  async setMuted(muted         ) { await this.setConfig({ broadcast: { muted } }); return { muted } }
  async getConflicts() {
    await this.ready
    this.permissions.require('workspace.read')
    const state = await this.current(this.stop.signal)
    return this.durable.conflicts.filter(item => item.group_id === state.group_id).map(item => ({ ...item }))
  }
  async getHistory() {
    await this.ready
    this.permissions.require('broadcast.receive')
    const state = await this.current(this.stop.signal)
    return this.history.filter(item => item.group_id === state.group_id).map(item => structuredClone(item))
  }
  async clearHistory() {
    await this.ready
    this.permissions.require('broadcast.receive')
    this.history = []
    return { cleared: true }
  }

  async pollOnce()                {
    await this.ready
    if (this.disposed) return
    if (this.pendingPoll) return this.pendingPoll
    const poll = this.poll()
    this.pendingPoll = poll
    try { await poll } finally { this.pendingPoll = undefined }
  }
          async poll()                {
    await this.readNativePreferences()
    const state = await this.current(this.stop.signal)
    await this.remoteHost?.advertise(state)
    const group = state.group_id 
    if (((this.durable.config.broadcast.enabled && !this.durable.config.broadcast.receivePaused) || this.remoteHost) && state.capabilities.encrypted_messages) {
      this.permissions.require('connection.message.read')
      if (this.durable.config.broadcast.enabled) this.permissions.require('broadcast.receive')
      const checkpoint = this.durable.groups[group] ??= { seen: [] }
      const response = (await this.provider.list_incoming_messages({ group_id: group, cursor: checkpoint.cursor, limit: 100 }, { signal: this.stop.signal })).data
      if (!Array.isArray(response.messages) || response.messages.length > 100) throw new ConnectionPluginError('protocol_error', 'Invalid message page.')
      await this.verifyGroup(group, this.stop.signal)
      let allHandled = true
      for (const message of response.messages) {
        if (!await this.receiveMessage(group, message, checkpoint)) allHandled = false
      }
      // Unknown message kinds belong to other plugins and must not be skipped.
      if (allHandled && response.next_cursor) checkpoint.cursor = response.next_cursor
      await this.save()
    }
    if (this.durable.config.workspaceSync.enabled && this.durable.config.workspaceSync.kind === 'dsh') {
      // Actual services are shared by RemoteDshHost; no directory/file scan.
      const capabilities = await this.remoteHost?.availableCapabilities() ?? []
      this.syncStatus = ['remote_task', 'remote_directory'].every(value => capabilities.includes(value)) ? 'completed' : 'waiting_for_host'
    }
    if (this.durable.config.workspaceSync.enabled && this.durable.config.workspaceSync.kind === 'files' && !this.durable.paused && !this.operationDone) {
      const operation = new AbortController()
      const cancel = () => operation.abort()
      this.stop.signal.addEventListener('abort', cancel, { once: true })
      this.operation = operation
      const receiving = this.receiveFiles(group, operation.signal)
      this.operationDone = receiving
      try { await receiving }
      finally {
        this.operation = undefined
        this.operationDone = undefined
        this.stop.signal.removeEventListener('abort', cancel)
      }
      if (this.durable.config.workspaceSync.mode === 'watch') await this.syncNow()
    }
  }
          async receiveMessage(group        , message                  , checkpoint                    )                   {
    if (this.remoteHost && ['dsh_remote_request', 'dsh_remote_cancel', 'dsh_remote_ack'].includes(message.kind)) {
      const handled = await this.remoteHost.receive(group, message)
      if (handled) await this.provider.acknowledge_message({ group_id: group, message_id: message.message_id }, { signal: this.stop.signal })
      return handled
    }
    if (!this.durable.config.broadcast.enabled || this.durable.config.broadcast.receivePaused) return false
    if (!message || typeof message.message_id !== 'string' || !message.message_id || message.message_id.length > 256 ||
        message.kind !== 'dsh_web_broadcast') return false
    if (!checkpoint.seen.includes(message.message_id)) {
      const payload = sanitizeIncomingBroadcast(message.body                             )
      payload.sender_device_id = message.sender_device_id
      this.history.push({ group_id: group, message_id: message.message_id, payload })
      this.history = this.history.slice(-100)
      checkpoint.seen.push(message.message_id)
      checkpoint.seen = checkpoint.seen.slice(-1000)
      // Persist only IDs before acknowledgement, never a URL or message body.
      await this.save()
    }
    await this.verifyGroup(group, this.stop.signal)
    await this.provider.acknowledge_message({ group_id: group, message_id: message.message_id }, { signal: this.stop.signal })
    return true
  }
  async sendBroadcast(args                         , signal              ) {
    await this.ready
    this.assertActive()
    this.permissions.require('broadcast.send')
    this.permissions.require('connection.message.send')
    const config = this.durable.config.broadcast
    if (!config.enabled) throw new ConnectionPluginError('permission_denied', 'Web broadcast is disabled.')
    const state = await this.current(signal)
    if (!state.capabilities.web_broadcast || !state.capabilities.encrypted_messages)
      throw new ConnectionPluginError('unsupported', 'Web broadcast is unavailable.')
    if (typeof args.url !== 'string') throw new ConnectionPluginError('validation_failed', 'URL is required.')
    const payload = createBroadcastPayload({ url: args.url, title: typeof args.title === 'string' ? args.title : '',
      selection: typeof args.selection === 'string' ? args.selection : '', message: typeof args.message === 'string' ? args.message : '',
      sender_device_id: state.local_device.id }, config)
    const idempotency_key = `broadcast:${randomUUID()}`
    const result = await this.provider.send_encrypted_message({ group_id: state.group_id , kind: payload.kind,
      body: payload, idempotency_key }, { signal })
    return result.data
  }

          syncConfig()                      {
    const config = this.durable.config
    if (!config.workspaceSync.enabled || !config.workspaceSync.root)
      throw new ConnectionPluginError('validation_failed', 'An enabled, explicitly selected workspace is required.')
    return { ...config.workspaceSync, root: path.resolve(config.workspaceSync.root),
      conflictPolicy: ({ ask: 'ask', keep_local: 'prefer-local', keep_remote: 'prefer-remote', keep_both: 'keep-both' }         )[config.workspaceSync.conflictPolicy],
      chunkSizeBytes: config.limits.chunkBytes, maxRetries: config.limits.retryAttempts, retryDelayMs: 250 }
  }
          async allowedPath(root        , relative        , allowMissing = false)                  {
    const normalized = assertPathAllowed(relative, { ignoreRules: this.durable.config.workspaceSync.ignoreRules })
    const full = resolveWorkspacePath(root, normalized)
    if (!decideSyncPath(root, full, this.durable.config.workspaceSync.ignoreRules).allowed)
      throw new ConnectionPluginError('permission_denied', 'Workspace path rejected.')
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new ConnectionPluginError('permission_denied', 'Workspace root must be a real directory.')
    const resolvedRoot = await realpath(root)
    let current = root
    for (const component of normalized.split('/')) {
      if (component.includes(':')) throw new ConnectionPluginError('permission_denied', 'Alternate data streams rejected.')
      current = path.join(current, component)
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new ConnectionPluginError('permission_denied', 'Workspace symlinks rejected.')
        if (!decideSyncPath(resolvedRoot, await realpath(current)).allowed) throw new ConnectionPluginError('permission_denied', 'Resolved path escapes workspace.')
      } catch (error) { if (allowMissing && (error                         ).code === 'ENOENT') break; throw error }
    }
    return full
  }
  async syncNow(relative         , signal              )                                              {
    await this.ready
    this.assertActive()
    this.permissions.require('workspace.read')
    this.permissions.require('connection.file.transfer')
    if (this.durable.paused) return { status: 'paused' }
    if (!this.durable.config.workspaceSync.enabled) return { status: 'disabled' }
    if (this.durable.config.workspaceSync.kind === 'dsh') {
      if (relative) throw new ConnectionPluginError('permission_denied', 'DSH sharing does not transfer workspace files.')
      const state = await this.current(signal)
      await this.remoteHost?.advertise(state)
      const capabilities = await this.remoteHost?.availableCapabilities() ?? []
      this.syncStatus = ['remote_task', 'remote_directory'].every(value => capabilities.includes(value)) ? 'completed' : 'waiting_for_host'
      return { status: this.syncStatus }
    }
    // A receive operation must not consume a later explicit upload intent.
    while (this.operationDone) {
      await this.operationDone.catch(() => {})
      this.assertActive()
      if (signal?.aborted) throw new ConnectionPluginError('request_cancelled', 'Sync cancelled.')
      if (this.durable.paused) return { status: 'paused' }
      if (!this.durable.config.workspaceSync.enabled) return { status: 'disabled' }
    }
    const operation = new AbortController()
    const cancel = () => operation.abort()
    this.stop.signal.addEventListener('abort', cancel, { once: true })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted || this.stop.signal.aborted) cancel()
    this.operation = operation
    const running = this.uploadWorkspace(relative, operation.signal)
    this.operationDone = running
    try { return await running }
    catch (error) {
      this.lastError = this.errorCode(error)
      this.syncStatus = operation.signal.aborted ? 'paused' : 'failed'
      throw error
    } finally {
      this.operation = undefined
      this.operationDone = undefined
      this.stop.signal.removeEventListener('abort', cancel)
      signal?.removeEventListener('abort', cancel)
    }
  }
          async uploadWorkspace(relative                    , signal             )                                             {
    const config = this.syncConfig()
    const state = await this.current(signal)
    const group = state.group_id 
    const paths           = []
    const visit = async (prefix        ) => {
      for (const entry of await readdir(path.join(config.root, prefix), { withFileTypes: true })) {
        if (signal.aborted) throw new ConnectionPluginError('request_cancelled', 'Sync cancelled.')
        const item = prefix ? `${prefix}/${entry.name}` : entry.name
        if (!decideSyncPath(config.root, path.join(config.root, item), config.ignoreRules).allowed || entry.isSymbolicLink()) continue
        if (entry.isDirectory()) { await this.allowedPath(config.root, item); await visit(item) }
        else if (entry.isFile()) {
          paths.push(item)
          if (paths.length > this.durable.config.limits.maxQueuedTasks) throw new ConnectionPluginError('validation_failed', 'Workspace queue limit exceeded.')
        }
      }
    }
    if (relative) paths.push(relative)
    else {
      const info = await lstat(config.root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ConnectionPluginError('permission_denied', 'Invalid workspace root.')
      await visit('')
    }
    const synchronizer = new WorkspaceSynchronizer(this.adapter, config, this.queue)
    this.syncStatus = 'syncing'
    let files = 0
    for (const item of paths) {
      const full = await this.allowedPath(config.root, item)
      if ((await stat(full)).size > this.durable.config.limits.maxFileBytes) throw new ConnectionPluginError('validation_failed', 'File exceeds configured size limit.')
      await this.verifyGroup(group, signal)
      if (this.queue.list().length >= this.durable.config.limits.maxQueuedTasks) {
        const completed = this.queue.list().find(item => item.status === 'completed')
        if (completed) await this.queue.remove(completed.id)
        else throw new ConnectionPluginError('validation_failed', 'Persistent queue limit exceeded.')
      }
      const queued = await synchronizer.uploadFile(item, signal)
      if (queued.groupId !== group) throw new ConnectionPluginError('request_cancelled', 'Group changed.')
      this.durable.baselines[`${group}\0${config.root}\0${item}`] = queued.sha256
      files++
      await this.save()
    }
    this.syncStatus = 'completed'
    this.lastError = undefined
    return { status: 'completed', files }
  }
          async receiveFiles(group        , signal             )                {
    this.permissions.require('workspace.write')
    this.permissions.require('connection.file.transfer')
    const config = this.syncConfig()
    const transfers = await this.adapter.listIncomingFileTransfers({ groupId: group, signal })
    for (const transfer of transfers) {
      if (transfer.acknowledged) continue
      if (this.durable.paused || !this.durable.config.workspaceSync.enabled || this.durable.config.workspaceSync.root !== config.root) return
      if (transfer.sizeBytes > this.durable.config.limits.maxFileBytes) throw new ConnectionPluginError('validation_failed', 'Incoming file exceeds size limit.')
      const full = await this.allowedPath(config.root, transfer.relativePath, true)
      let localHash                = null
      try { localHash = createHash('sha256').update(await readFile(full)).digest('hex') }
      catch (error) { if ((error                         ).code !== 'ENOENT') throw error }
      const baselineKey = `${group}\0${config.root}\0${transfer.relativePath}`
      // Even an identical local file must authenticate the incoming transfer before acknowledgement.
      const conflict = localHash !== null && localHash !== transfer.sha256 && localHash !== this.durable.baselines[baselineKey]
      if (conflict && config.conflictPolicy === 'ask') {
        if (!this.durable.conflicts.some(item => item.group_id === group && item.transfer_id === transfer.fileId))
          this.durable.conflicts.push({ group_id: group, transfer_id: transfer.fileId,
            relative_path: transfer.relativePath, local_hash: localHash, remote_hash: transfer.sha256 })
        this.durable.conflicts = this.durable.conflicts.slice(-100)
        this.syncStatus = 'conflict'
        await this.save()
        continue
      }
      if (conflict && config.conflictPolicy === 'prefer-local') continue
      const destination = conflict && config.conflictPolicy === 'keep-both'
        ? `${transfer.relativePath}.remote-${transfer.sha256.slice(0, 12)}` : transfer.relativePath
      await this.downloadAndCommit(config.root, destination, transfer, group, signal, destination === transfer.relativePath ? localHash : null)
      this.durable.baselines[`${group}\0${config.root}\0${destination}`] = transfer.sha256
      this.durable.conflicts = this.durable.conflicts.filter(item => item.group_id !== group || item.transfer_id !== transfer.fileId)
      await this.save()
      await this.adapter.acknowledgeFileTransfer({ groupId: group, fileId: transfer.fileId, idempotencyKey: `ack:${transfer.fileId}`, signal })
    }
  }
          async downloadAndCommit(root        , relative        , transfer                  , group        , signal             , expectedLocal               )                {
    const target = await this.allowedPath(root, relative, true)
    await mkdir(path.dirname(target), { recursive: true })
    await this.allowedPath(root, relative, true)
    const temporary = path.join(path.dirname(target), `.dafeiyu-${randomUUID()}.part`)
    const hash = createHash('sha256')
    let size = 0
    try {
      await writeFile(temporary, '', { flag: 'wx', mode: 0o600 })
      for (let index = 0; index < transfer.totalChunks; index++) {
        if (this.durable.paused || !this.durable.config.workspaceSync.enabled || this.durable.config.workspaceSync.root !== root)
          throw new ConnectionPluginError('request_cancelled', 'Workspace configuration changed.')
        const chunk = await this.adapter.downloadFileChunk({ groupId: group, fileId: transfer.fileId, chunkIndex: index, signal })
        const expected = Math.min(transfer.chunkSizeBytes, transfer.sizeBytes - index * transfer.chunkSizeBytes)
        if (chunk.byteLength !== expected) throw new ConnectionPluginError('protocol_error', 'Unexpected incoming chunk size.')
        size += chunk.byteLength
        hash.update(chunk)
        await writeFile(temporary, chunk, { flag: 'a' })
      }
      if (size !== transfer.sizeBytes || hash.digest('hex') !== transfer.sha256) throw new ConnectionPluginError('protocol_error', 'Incoming file hash mismatch.')
      await this.verifyGroup(group, signal)
      await this.allowedPath(root, relative, true)
      let currentHash                = null
      try { currentHash = createHash('sha256').update(await readFile(target)).digest('hex') }
      catch (error) { if ((error                         ).code !== 'ENOENT') throw error }
      if (currentHash !== expectedLocal) throw new ConnectionPluginError('conflict', 'Local file changed during download.')
      if (signal.aborted || this.durable.paused || !this.durable.config.workspaceSync.enabled ||
          this.durable.config.workspaceSync.root !== root || this.snapshot?.group_id !== group)
        throw new ConnectionPluginError('request_cancelled', 'Workspace lifecycle changed.')
      // Same-directory rename preserves the existing file on a failed commit.
      await rename(temporary, target)
    } finally { await rm(temporary, { force: true }).catch(() => {}) }
  }

  async dispose()                {
    if (this.disposed) return
    this.disposed = true
    this.stop.abort()
    this.operation?.abort()
    if (this.timer) clearInterval(this.timer)
    this.unsubscribe?.()
    await this.remoteHost?.dispose()
    await this.ready.catch(() => {})
    await this.operationDone?.catch(() => {})
    await this.pendingPoll?.catch(() => {})
    await this.saves.catch(() => {})
  }
}

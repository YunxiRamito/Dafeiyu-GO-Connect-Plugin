import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { ConnectionPluginError } from './errors.ts'
import { PermissionSet } from './permissions.ts'
import type { ConnectionProvider, ConnectionState, EncryptedMessage } from './provider.ts'
import { publicDshControlFrame, publicDshFollowFrame, publicDshResult } from './remote-public.ts'
import { RemoteWorkspaceLifecycle, WORKSPACE_LIFECYCLE_OPERATIONS } from './remote-workspaces.ts'
import { ARCHIVE_DELETE_OPERATIONS } from './remote-archive.ts'
import { RemoteArtifactReader, ARTIFACT_OPERATIONS } from './remote-artifacts.ts'
import { RemoteAttachmentReceiver, ATTACHMENT_OPERATIONS } from './remote-attachments.ts'

export const REMOTE_DSH_PROTOCOL = 'dafeiyu-go.remote-dsh.v1'
export const REMOTE_DSH_REQUEST_KIND = 'dsh_remote_request'
export const REMOTE_DSH_EVENT_KIND = 'dsh_remote_event'
export const REMOTE_DSH_CANCEL_KIND = 'dsh_remote_cancel'
export const REMOTE_DSH_ACK_KIND = 'dsh_remote_ack'
export const REMOTE_DSH_CAPABILITY_KIND = 'dsh_remote_capabilities'
const MAX_EVENTS = 1024
const MAX_REQUESTS = 256
const MAX_GROUPS = 32
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 128 * 1024
const MAX_ENVELOPE_BYTES = 192 * 1024
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/
const OPERATIONS = new Set(['session.create', 'session.selectModel', 'session.prompt', 'session.cancel', 'session.control', 'session.follow', 'session.list', 'directory.list', 'workspace.list', 'workspace.resolve', 'models.catalog', 'settings.describe', 'settings.update', 'permissions.catalog', 'web.http', 'web.socket', 'web.socket.send', 'web.socket.close', ...WORKSPACE_LIFECYCLE_OPERATIONS, ...ARCHIVE_DELETE_OPERATIONS, ...ARTIFACT_OPERATIONS, ...ATTACHMENT_OPERATIONS])
const STREAM_OPERATIONS = new Set(['session.follow', 'session.control', 'web.http', 'web.socket'])
const READ_OPERATIONS = new Set(['workspace.list', 'session.list', 'models.catalog', 'directory.list', 'settings.describe', 'permissions.catalog', 'session.follow', 'session.control', 'web.socket', 'web.socket.send', 'web.socket.close', 'workspace.removed.list', 'session.archived.list', 'artifact.list', 'artifact.read', 'artifact.close', 'attachment.write', 'attachment.status'])
const BULK_OPERATIONS = new Set(['artifact.list', 'artifact.read', 'artifact.close', 'attachment.write', 'attachment.status'])

interface Request { protocol: string; request_id: string; operation: string; payload: Record<string, any>; target_device_id: string }
interface TerminalEvent { sequence: number; type: 'result' | 'error' | 'closed'; payload: unknown }
interface Receipt { hash: string; sender: string; request_id: string; operation: string; readOnly?: boolean; sessionId?: string; phase: 'intent' | 'submitted' | 'done' | 'uncertain'; result?: unknown; error_code?: string; next_sequence?: number; terminal_event?: TerminalEvent; terminal_sent?: boolean; acknowledged_terminal_sequence?: number }
interface State { version: 1; groups: Record<string, { requests: Record<string, Receipt> }> }
interface Task { controller: AbortController; group: string; peer: string; operation: string; sessionId?: string; acknowledgedSequence: number }

function object(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function validIdentifier(value: unknown): value is string { return typeof value === 'string' && IDENTIFIER.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value) }
function validRequestId(value: unknown): value is string { return typeof value === 'string' && REQUEST_ID.test(value) }
function operationCapability(operation: string): 'remote_task' | 'remote_directory' | 'remote_settings' | 'remote_web_tunnel' | 'remote_workspace_lifecycle' | 'remote_archive_delete' | 'remote_artifacts' | 'remote_attachments' {
  if (ARCHIVE_DELETE_OPERATIONS.includes(operation)) return 'remote_archive_delete'
  if (ARTIFACT_OPERATIONS.includes(operation)) return 'remote_artifacts'
  if (ATTACHMENT_OPERATIONS.includes(operation)) return 'remote_attachments'
  if (WORKSPACE_LIFECYCLE_OPERATIONS.includes(operation)) return 'remote_workspace_lifecycle'
  if (operation.startsWith('web.')) return 'remote_web_tunnel'
  if (['directory.list', 'workspace.list', 'workspace.resolve'].includes(operation)) return 'remote_directory'
  if (['session.selectModel', 'settings.describe', 'settings.update', 'permissions.catalog'].includes(operation)) return 'remote_settings'
  return 'remote_task'
}
function boundedValue(value: unknown): unknown {
  const text = JSON.stringify(value ?? null)
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) throw new ConnectionPluginError('protocol_error', 'Remote result exceeds the bounded envelope; request a smaller page.')
  return JSON.parse(text)
}
function validState(value: unknown): value is State {
  if (!object(value) || value.version !== 1 || !object(value.groups) || Object.keys(value.groups).length > MAX_GROUPS) return false
  for (const [id, group] of Object.entries(value.groups)) {
    if (!validIdentifier(id) || !object(group) || !object(group.requests) || Object.keys(group.requests).length > MAX_REQUESTS) return false
    for (const [key, receipt] of Object.entries(group.requests)) {
      if (!object(receipt) || !validIdentifier(receipt.sender) || !validRequestId(receipt.request_id) || key !== `${receipt.sender}\0${receipt.request_id}` ||
          !/^[a-f0-9]{64}$/.test(receipt.hash) || !OPERATIONS.has(receipt.operation) || !['intent', 'submitted', 'done', 'uncertain'].includes(receipt.phase) ||
          (receipt.readOnly !== undefined && (typeof receipt.readOnly !== 'boolean' || receipt.readOnly && receipt.operation !== 'web.http')) ||
          (receipt.sessionId !== undefined && (typeof receipt.sessionId !== 'string' || !IDENTIFIER.test(receipt.sessionId))) ||
          (receipt.next_sequence !== undefined && (!Number.isSafeInteger(receipt.next_sequence) || receipt.next_sequence < 0 || receipt.next_sequence > MAX_EVENTS + 2))) return false
      if (receipt.terminal_event !== undefined && (!object(receipt.terminal_event) || !Number.isSafeInteger(receipt.terminal_event.sequence) ||
          receipt.terminal_event.sequence < 0 || receipt.terminal_event.sequence > MAX_EVENTS + 1 || !['result', 'error', 'closed'].includes(receipt.terminal_event.type))) return false
      if (receipt.terminal_sent !== undefined && (typeof receipt.terminal_sent !== 'boolean' || !BULK_OPERATIONS.has(receipt.operation) || !receipt.terminal_event)) return false
      if (receipt.acknowledged_terminal_sequence !== undefined && (!BULK_OPERATIONS.has(receipt.operation) || receipt.phase !== 'done' ||
          !Number.isSafeInteger(receipt.acknowledged_terminal_sequence) || receipt.acknowledged_terminal_sequence !== receipt.terminal_event?.sequence)) return false
      try { boundedValue(receipt.result); if (receipt.terminal_event) boundedValue(receipt.terminal_event.payload) } catch { return false }
    }
  }
  return true
}

/** Actual DSH service adapter, injected by the same Cordis plugin on PC. */
export interface RemoteDshHostAdapter {
  capabilities(): string[]
  /** Rechecks late service composition; it cannot grant unverified capabilities. */
  refreshCapabilities?(): Promise<void>
  execute(operation: string, payload: Record<string, any>, requestId: string, signal: AbortSignal, context?: RemoteDshHostContext): Promise<unknown>
  follow?(payload: Record<string, any>, signal: AbortSignal, operation?: string, requestId?: string, context?: RemoteDshHostContext): AsyncIterable<unknown>
  cancel(sessionId: string): Promise<unknown>
  revoke?(group: string, peer?: string): void | Promise<void>
  dispose?(): void | Promise<void>
}
export interface RemoteDshHostContext { readonly group: string; readonly peer: string }

/**
 * Consumes only authenticated/decrypted provider messages. Persisting an intent
 * before DSH admission makes a lost response safe: an uncertain prompt is never
 * replayed, even when the plugin process restarts.
 */
export class RemoteDshHost {
  private readonly provider: ConnectionProvider
  private readonly adapter: RemoteDshHostAdapter
  private readonly permissions: PermissionSet
  private readonly directory?: string
  private state: State = { version: 1, groups: {} }
  readonly ready: Promise<void>
  private tasks = new Map<string, Task>()
  private writes = Promise.resolve()
  private admissions = Promise.resolve()
  private closed = false
  private capabilityRevision = ''
  private capabilityGeneration = randomUUID()
  private outstanding = new Set<Promise<unknown>>()
  private relationships = new Map<string, Set<string>>()
  private unsubscribe?: () => void

  constructor(options: { provider: ConnectionProvider; adapter: RemoteDshHostAdapter; permissions: PermissionSet; stateDirectory?: string }) {
    this.provider = options.provider
    this.adapter = options.adapter
    this.permissions = options.permissions
    this.directory = options.stateDirectory
    this.ready = this.load()
    // Observe revocation between stream frames. Server disconnection alone does
    // not cancel a PC task already admitted before the connection was lost.
    if (this.permissions.has('connection.state.subscribe')) this.unsubscribe = this.provider.subscribe_connection_state(state => {
      for (const task of this.tasks.values()) {
        const terminal = ['unpaired', 'revoked'].includes(state.pairing_status)
        const removed = state.server_connected && (state.group_id !== task.group || (state.pairing_status === 'paired' &&
          !(state.members ?? []).some(member => member.id === task.peer && member.active !== false)))
        if (terminal || removed) task.controller.abort()
      }
      for (const [group, peers] of this.relationships) {
        const terminal = ['unpaired', 'revoked'].includes(state.pairing_status)
        const changedGroup = state.server_connected && state.group_id !== group
        if (terminal || changedGroup) {
          this.relationships.delete(group)
          this.revoke(group)
        } else if (state.server_connected && state.pairing_status === 'paired') {
          for (const peer of peers) if (!(state.members ?? []).some(member => member.id === peer && member.active !== false)) {
            peers.delete(peer)
            this.revoke(group, peer)
          }
        }
      }
    })
    void this.ready.catch(() => { this.closed = true; this.unsubscribe?.() })
  }

  private revoke(group: string, peer?: string): void {
    const pending = Promise.resolve().then(() => this.adapter.revoke?.(group, peer))
    this.outstanding.add(pending)
    void pending.catch(() => { this.closed = true }).finally(() => this.outstanding.delete(pending))
  }

  private async load(): Promise<void> {
    if (!this.directory) return
    try {
      const file = path.join(this.directory, 'remote-requests.json')
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES) throw new Error('invalid_remote_journal')
      const loaded: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!validState(loaded)) throw new Error('invalid_remote_journal')
      this.state = loaded
      for (const group of Object.values(this.state.groups)) for (const request of Object.values(group.requests))
        if (request.phase === 'intent' || request.phase === 'submitted') {
          request.phase = 'uncertain'
          request.result = { code: 'request_uncertain', ...(request.sessionId ? { sessionId: request.sessionId } : {}) }
          request.terminal_event = { sequence: request.next_sequence ?? 0, type: 'error', payload: request.result }
        }
      await this.save()
    } catch (error) { if ((error as any).code !== 'ENOENT') throw error }
  }

  private save(): Promise<void> {
    if (!this.directory) return Promise.resolve()
    const text = JSON.stringify(this.state)
    if (Buffer.byteLength(text, 'utf8') > MAX_JOURNAL_BYTES) return Promise.reject(new ConnectionPluginError('disk_space_low', 'Remote request journal reached its byte limit.'))
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.directory!, { recursive: true })
      const temporary = path.join(this.directory!, `remote-${randomUUID()}.tmp`)
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
        await rename(temporary, path.join(this.directory!, 'remote-requests.json'))
      }
      finally { await rm(temporary, { force: true }).catch(() => {}) }
    })
    return this.writes
  }

  private async persistOutcome(): Promise<void> {
    try { await this.save() } catch (error) { this.closed = true; throw error }
  }

  private async streamEvent(group: string, receipt: Receipt, type: string, payload: unknown, signal: AbortSignal): Promise<void> {
    if (receipt.operation.startsWith('web.')) {
      const task = this.tasks.get(`${group}\0${receipt.sender}\0${receipt.request_id}`)
      if (!task) throw new ConnectionPluginError('request_cancelled', 'Web generation ended.')
      const deadline = Date.now() + 30_000
      // Aries message acknowledgement is local-durable only. This encrypted,
      // exact-request ACK is the remote consumer's actual four-frame window.
      while (receipt.next_sequence! > task.acknowledgedSequence + 4) {
        if (signal.aborted) throw new ConnectionPluginError('request_cancelled', 'Web consumer cancelled.')
        if (Date.now() >= deadline) throw new ConnectionPluginError('request_timeout', 'Web consumer stopped acknowledging frames.')
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); timer.unref() })
      }
    }
    const sequence = receipt.next_sequence!++
    // Reserve the sequence durably before sending. Restart uncertainty can then
    // use a new sequence instead of colliding with an already delivered frame.
    await this.persistOutcome()
    await this.event(group, receipt, sequence, type, payload, signal)
  }

  async advertise(state: ConnectionState): Promise<void> {
    await this.ready
    if (this.closed || !this.directory || !state.server_connected || state.pairing_status !== 'paired' || !state.group_id || !state.capabilities.encrypted_messages) return
    await this.adapter.refreshCapabilities?.()
    if (this.closed) return
    const available = [...new Set(this.adapter.capabilities())].filter(value =>
      value === 'remote_task' ? this.permissions.has('connection.remote.task') :
      value === 'remote_directory' ? this.permissions.has('connection.remote.directory') :
      value === 'remote_settings' ? this.permissions.has('connection.remote.settings') :
      value === 'remote_workspace_lifecycle' ? this.permissions.has('connection.remote.workspace.lifecycle') :
      value === 'remote_archive_delete' ? this.permissions.has('connection.remote.archive.delete') :
      value === 'remote_artifacts' ? this.permissions.has('connection.remote.artifacts') :
      value === 'remote_attachments' ? this.permissions.has('connection.remote.attachments') :
      value === 'remote_web_tunnel' && this.permissions.has('connection.remote.web')).sort()
    const revision = `${state.group_id}:${state.local_device.id}:${available.join(',')}`
    if (revision === this.capabilityRevision) return
    this.permissions.require('connection.message.send')
    const digest = createHash('sha256').update(revision).digest('hex').slice(0, 32)
    await this.provider.send_encrypted_message({ group_id: state.group_id, kind: REMOTE_DSH_CAPABILITY_KIND,
      idempotency_key: `remote-capabilities-${this.capabilityGeneration}-${digest}`, body: {
        protocol: REMOTE_DSH_PROTOCOL, device_id: state.local_device.id, capabilities: available, generation: this.capabilityGeneration,
      } })
    this.capabilityRevision = revision
  }

  async receive(group: string, message: EncryptedMessage): Promise<boolean> {
    if (![REMOTE_DSH_REQUEST_KIND, REMOTE_DSH_CANCEL_KIND, REMOTE_DSH_ACK_KIND].includes(message?.kind)) return false
    const admission = this.admissions.catch(() => {}).then(() => this.admit(group, message))
    this.admissions = admission.then(() => {}, () => {})
    return admission
  }

  private async admit(group: string, message: EncryptedMessage): Promise<boolean> {
    await this.ready
    if (this.closed) throw new ConnectionPluginError('request_cancelled', 'Remote host disposed.')
    this.permissions.require('connection.remote.task')
    this.permissions.require('connection.message.read')
    if (!validIdentifier(group) || !validIdentifier(message.sender_device_id)) throw new ConnectionPluginError('protocol_error', 'Invalid remote group or sender.')
    const current = await this.current(group, message.sender_device_id)
    const body = message.body as Request
    if (!object(body) || body.protocol !== REMOTE_DSH_PROTOCOL || !validRequestId(body.request_id)) throw new ConnectionPluginError('protocol_error', 'Invalid remote request.')
    // An encrypted message is group-visible. Only the explicitly selected
    // execution device may admit it, including in groups with multiple PCs.
    if (body.target_device_id !== current.local_device.id) return false
    if (message.kind === REMOTE_DSH_ACK_KIND) {
      const sequence = (body as any).sequence
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_EVENTS + 1) throw new ConnectionPluginError('protocol_error', 'Invalid web acknowledgement.')
      const receipt = this.state.groups[group]?.requests[`${message.sender_device_id}\0${body.request_id}`]
      // A late ACK for an expired completed read is harmless. It cannot create
      // a task, reopen a socket or advance another sender's generation.
      if (!receipt) return true
      if (BULK_OPERATIONS.has(receipt.operation)) {
        if (Object.keys(body).sort().join(',') !== 'operation,protocol,request_id,sequence,target_device_id' ||
            body.operation !== receipt.operation || receipt.phase !== 'done' || sequence !== receipt.terminal_event?.sequence)
          throw new ConnectionPluginError('permission_denied', 'ACK does not belong to the exact delivered transfer.')
        const capability = operationCapability(receipt.operation)
        this.permissions.require(capability === 'remote_artifacts' ? 'connection.remote.artifacts' : 'connection.remote.attachments')
        if (!this.adapter.capabilities().includes(capability)) throw new ConnectionPluginError('unsupported', 'Transfer acknowledgement capability is unavailable.')
        // An authenticated consumer can observe the event before our native
        // send call returns. Save that ACK now; eviction still waits for the
        // successful durable send receipt below.
        receipt.acknowledged_terminal_sequence = sequence
        await this.persistOutcome()
        return true
      }
      if (!receipt?.operation.startsWith('web.') || sequence >= receipt.next_sequence!) throw new ConnectionPluginError('permission_denied', 'ACK does not belong to a delivered web generation.')
      const task = this.tasks.get(`${group}\0${message.sender_device_id}\0${body.request_id}`)
      if (task) task.acknowledgedSequence = Math.max(task.acknowledgedSequence, sequence)
      return true
    }
    if (!this.directory && message.kind === REMOTE_DSH_REQUEST_KIND)
      throw new ConnectionPluginError('unsupported', 'Remote execution requires a durable host journal.')
    if (message.kind === REMOTE_DSH_CANCEL_KIND) {
      const task = this.tasks.get(`${group}\0${message.sender_device_id}\0${body.request_id}`)
      task?.controller.abort()
      // Transport/observation cancellation never means "stop this PC task".
      // The separately journaled session.cancel operation is the only task stop.
      return true
    }
    if (!OPERATIONS.has(body.operation)) throw new ConnectionPluginError('unsupported', 'Remote DSH operation is unavailable.')
    const capability = operationCapability(body.operation)
    this.permissions.require(capability === 'remote_archive_delete' ? 'connection.remote.archive.delete' : capability === 'remote_artifacts' ? 'connection.remote.artifacts' : capability === 'remote_attachments' ? 'connection.remote.attachments' : capability === 'remote_directory' ? 'connection.remote.directory' : capability === 'remote_settings' ? 'connection.remote.settings' : capability === 'remote_web_tunnel' ? 'connection.remote.web' : capability === 'remote_workspace_lifecycle' ? 'connection.remote.workspace.lifecycle' : 'connection.remote.task')
    await this.adapter.refreshCapabilities?.()
    if (this.closed) throw new ConnectionPluginError('request_cancelled', 'Remote host disposed.')
    if (!this.adapter.capabilities().includes(capability)) throw new ConnectionPluginError('unsupported', 'Required remote DSH service is unavailable.')
    if (!object(body.payload) || Object.keys(body.payload).length > 64 || Buffer.byteLength(JSON.stringify(body.payload), 'utf8') > MAX_PAYLOAD_BYTES) throw new ConnectionPluginError('validation_failed', 'Invalid remote payload.')
    if (body.operation === 'session.prompt' && Array.isArray(body.payload.content) && body.payload.content.some((part: any) => part?.type === 'file')) {
      this.permissions.require('connection.remote.attachments')
      if (!this.adapter.capabilities().includes('remote_attachments')) throw new ConnectionPluginError('unsupported', 'Remote attachment service is unavailable.')
    }
    const key = `${message.sender_device_id}\0${body.request_id}`
    if (!Object.hasOwn(this.state.groups, group) && Object.keys(this.state.groups).length >= MAX_GROUPS) throw new ConnectionPluginError('disk_space_low', 'Remote group journal is full.')
    const groupState = this.state.groups[group] ??= { requests: {} }
    const fingerprint = createHash('sha256').update(JSON.stringify({ operation: body.operation, payload: body.payload })).digest('hex')
    const previous = groupState.requests[key]
    if (previous) {
      if (previous.hash !== fingerprint || previous.sender !== message.sender_device_id) throw new ConnectionPluginError('conflict', 'Remote request id was reused.')
      // DSH durable prompts are never replayed after response loss or restart.
      if (previous.phase === 'uncertain' || previous.phase === 'done') {
        const terminal = previous.terminal_event ?? { sequence: 0, type: previous.error_code || previous.phase === 'uncertain' ? 'error' : 'result',
          payload: previous.error_code ? { code: previous.error_code, ...(previous.sessionId ? { sessionId: previous.sessionId } : {}) } : previous.result }
        await this.event(group, previous, terminal.sequence, terminal.type, terminal.payload)
      }
      return true
    }
    // Byte-bearing results are retired only after the authenticated consumer
    // persisted consumption and the original send returned a durable receipt.
    const completedBulk = Object.entries(this.state.groups).flatMap(([savedGroup, saved]) => Object.entries(saved.requests)
      .filter(([entry, value]) => value.phase === 'done' && BULK_OPERATIONS.has(value.operation) && value.terminal_sent === true &&
        value.acknowledged_terminal_sequence === value.terminal_event?.sequence && !this.tasks.has(`${savedGroup}\0${entry}`))
      .map(([entry]) => ({ saved, entry })))
    for (const { saved, entry } of completedBulk.slice(0, Math.max(0, completedBulk.length - 16))) delete saved.requests[entry]
    if (Object.keys(groupState.requests).length >= MAX_REQUESTS - 32) {
      // Completed observations/catalog reads may safely run again if their old
      // result has expired. Never evict prompt, create or settings-write intent.
      const completedReads = Object.entries(groupState.requests).filter(([, value]) => value.phase === 'done' &&
        !BULK_OPERATIONS.has(value.operation) && (READ_OPERATIONS.has(value.operation) || value.readOnly === true))
      for (const [expired] of completedReads.slice(0, Math.max(0, completedReads.length - 64))) delete groupState.requests[expired]
    }
    if (Object.keys(groupState.requests).length >= MAX_REQUESTS) throw new ConnectionPluginError('disk_space_low', 'Remote request journal is full.')
    const receipt: Receipt = { hash: fingerprint, sender: message.sender_device_id, request_id: body.request_id,
      operation: body.operation, readOnly: body.operation === 'web.http' && body.payload.method === 'GET', phase: 'intent', sessionId: typeof body.payload.sessionId === 'string' ? body.payload.sessionId : undefined, next_sequence: 0 }
    groupState.requests[key] = receipt
    // A failed admission write is never acknowledged or executed. The host
    // closes rather than retaining a non-durable in-memory deduplication claim.
    try { await this.save() } catch (error) { this.closed = true; throw error }
    const controller = new AbortController()
    const taskKey = `${group}\0${key}`
    const task: Task = { group, peer: message.sender_device_id, operation: body.operation, controller, sessionId: receipt.sessionId, acknowledgedSequence: -1 }
    this.tasks.set(taskKey, task)
    const execution = (async () => { try {
      await this.current(group, message.sender_device_id, controller.signal)
      const executionId = 'remote-' + createHash('sha256').update(`${group}\0${message.sender_device_id}\0${body.request_id}`).digest('hex').slice(0, 40)
      const hostContext = { group, peer: message.sender_device_id }
      const result = boundedValue(await this.adapter.execute(body.operation, { ...body.payload }, executionId, controller.signal, hostContext))
      if (result && typeof result === 'object' && typeof (result as any).sessionId === 'string') {
        receipt.sessionId = (result as any).sessionId
        task.sessionId = receipt.sessionId
      }
      receipt.result = result
      if (STREAM_OPERATIONS.has(body.operation) && this.adapter.follow) {
        receipt.phase = 'submitted'
        await this.persistOutcome()
        await this.streamEvent(group, receipt, 'result', result, controller.signal)
        for await (const frame of this.adapter.follow(body.payload, controller.signal, body.operation, executionId, hostContext)) {
          if (controller.signal.aborted) throw new ConnectionPluginError('request_cancelled', 'Remote observation cancelled.')
          if (receipt.next_sequence! > MAX_EVENTS) throw new ConnectionPluginError('validation_failed', 'Remote event buffer limit reached; reconnect with the durable cursor.')
          await this.streamEvent(group, receipt, 'event', boundedValue(frame), controller.signal)
        }
        receipt.phase = 'done'
        receipt.terminal_event = { sequence: receipt.next_sequence!++, type: 'closed', payload: {} }
        await this.persistOutcome()
        await this.event(group, receipt, receipt.terminal_event.sequence, 'closed', {}, controller.signal)
      } else {
        receipt.phase = 'done'
        receipt.terminal_event = { sequence: receipt.next_sequence!++, type: 'result', payload: result }
        await this.persistOutcome()
        // Transport failure after the durable result must not become a new
        // execution error. A duplicate request resends the identical receipt.
        await this.event(group, receipt, receipt.terminal_event.sequence, 'result', result, controller.signal)
      }
    } catch (error) {
      if (receipt.phase !== 'done') {
        receipt.phase = 'done'
        receipt.error_code = error instanceof ConnectionPluginError ? error.code : controller.signal.aborted ? 'request_cancelled' : 'remote_execution_failed'
        const payload = { code: receipt.error_code, ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}) }
        receipt.result = payload
        receipt.terminal_event = { sequence: receipt.next_sequence!++, type: 'error', payload }
        try {
          await this.persistOutcome()
          await this.event(group, receipt, receipt.terminal_event.sequence, 'error', payload)
        } catch { /* The persisted intent prevents a prompt replay after restart. */ }
      }
    } finally { this.tasks.delete(taskKey) } })()
    this.outstanding.add(execution)
    void execution.finally(() => this.outstanding.delete(execution)).catch(() => {})
    return true
  }

  private async current(group: string, peer: string, signal?: AbortSignal): Promise<ConnectionState> {
    this.permissions.require('connection.read')
    if (signal?.aborted) throw new ConnectionPluginError('request_cancelled', 'Remote operation cancelled.')
    const state = (await this.provider.get_connection_state({ signal })).data
    if (!state.server_connected || state.group_id !== group || state.pairing_status !== 'paired' || !state.capabilities.encrypted_messages ||
        peer === state.local_device.id || !(state.members ?? []).some(member => member.id === peer && member.active !== false)) throw new ConnectionPluginError('revoked', 'Remote peer is no longer authorized.')
    if (!this.relationships.has(group)) this.relationships.set(group, new Set())
    this.relationships.get(group)!.add(peer)
    return state
  }
  private async event(group: string, receipt: Receipt, sequence: number, type: string, payload: unknown, signal?: AbortSignal): Promise<void> {
    this.permissions.require('connection.message.send')
    await this.current(group, receipt.sender, signal)
    const body = { protocol: REMOTE_DSH_PROTOCOL, request_id: receipt.request_id, target_device_id: receipt.sender, sequence, type, payload }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_ENVELOPE_BYTES) throw new ConnectionPluginError('protocol_error', 'Remote event exceeds the transport envelope.')
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    await this.provider.send_encrypted_message({ group_id: group, kind: REMOTE_DSH_EVENT_KIND,
      idempotency_key: `remote-event-${receipt.request_id}-${sequence}-${digest.slice(0, 16)}`, body }, { signal })
    if (BULK_OPERATIONS.has(receipt.operation) && receipt.terminal_event?.sequence === sequence) {
      receipt.terminal_sent = true
      await this.persistOutcome()
    }
  }
  async dispose(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    for (const task of this.tasks.values()) task.controller.abort()
    await this.admissions.catch(() => {})
    const pending = Promise.allSettled([...this.outstanding])
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); timer.unref() })])
    if (timer) clearTimeout(timer)
    await this.writes.catch(() => {})
    await this.adapter.dispose?.()
  }
}

/** Reads the current PC DSH composition on each call, including late services. */
export function createCordisRemoteDshAdapter(ctx: any, options: { workspaceRoot?: () => string | null | undefined; lifecycleDirectory?: string; protectedPaths?: string[];
  attachmentDirectory?: string; artifactsEnabled?: boolean; attachmentsEnabled?: boolean; archiveDeletionEnabled?: boolean } = {}): RemoteDshHostAdapter {
  const get = (key: string) => typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key]
  const service = (key: string) => { const value = get(key); if (!value) throw new ConnectionPluginError('unsupported', 'Required DSH service is unavailable.'); return value }
  const lifecycle = options.lifecycleDirectory ? new RemoteWorkspaceLifecycle(ctx, { directory: options.lifecycleDirectory,
    protectedPaths: options.protectedPaths, archiveDeletion: options.archiveDeletionEnabled === true }) : undefined
  const artifacts = new RemoteArtifactReader(ctx)
  const attachments = options.attachmentDirectory ? new RemoteAttachmentReceiver(ctx, { directory: options.attachmentDirectory }) : undefined
  const retentionController = new AbortController()
  let adapterClosed = false
  let archiveRefresh: Promise<void> | undefined
  let retentionAttemptAt = 0
  const refreshArchiveCapabilities = (): Promise<void> => {
    if (adapterClosed || options.archiveDeletionEnabled !== true || !lifecycle) return Promise.resolve()
    if (archiveRefresh) return archiveRefresh
    const pending = (async () => {
      if (!await lifecycle.ensureArchiveDeletion() || adapterClosed) return
      // Only the local host clock drives retention. Network payloads cannot
      // accelerate it, and overlapping ready/poll/timer callbacks share work.
      if (Date.now() - retentionAttemptAt >= 6 * 60 * 60 * 1000) {
        retentionAttemptAt = Date.now()
        await lifecycle.sweepArchives(retentionController.signal)
      }
    })()
    archiveRefresh = pending
    void pending.finally(() => { if (archiveRefresh === pending) archiveRefresh = undefined }).catch(() => {})
    return pending
  }
  let retentionTimer: ReturnType<typeof setInterval> | undefined
  let releaseReady: (() => void) | undefined
  if (options.archiveDeletionEnabled === true && lifecycle) {
    retentionTimer = setInterval(() => { void refreshArchiveCapabilities().catch(() => {}) }, 6 * 60 * 60 * 1000)
    retentionTimer.unref()
    if (typeof ctx?.on === 'function') {
      const release = ctx.on('ready', () => refreshArchiveCapabilities())
      if (typeof release === 'function') releaseReady = release
    }
  }
  // Windows DSH normally composes the native picker, whose list() correctly
  // refuses browsing. The remote client needs the shipped browse backend in
  // its own Cordis service realm, leaving the PC's native chooser intact.
  let browseModule: string | undefined
  try {
    const anchor = get('profileContext')?.installAnchor
    if (typeof anchor === 'string' && typeof ctx?.isolate === 'function') {
      const require = createRequire(anchor)
      if (require('@deepseek-ai/dsh-host-directory-picker-browse/package.json').version === '0.2.1-alpha.1')
        browseModule = require.resolve('@deepseek-ai/dsh-host-directory-picker-browse')
    }
  } catch { /* Missing runtime package is an unavailable browse capability. */ }
  let browse: Promise<any> | undefined
  const pickerAvailable = () => {
    const current = get('directoryPicker')?.capability?.()
    return current ? current.kind === 'browse' || browseModule !== undefined : typeof get('directoryPickerController')?.list === 'function'
  }
  const remotePicker = async () => {
    const current = get('directoryPicker')?.capability?.()
    if (current?.kind === 'browse') return current
    if (!current) return service('directoryPickerController')
    if (!browseModule) throw new ConnectionPluginError('unsupported', 'Remote computer directory browsing is unavailable.')
    browse ??= (async () => {
      const child = ctx.isolate('directoryPicker')
      const { default: BrowseDirectoryPicker } = await import(pathToFileURL(browseModule!).href)
      await child.plugin(BrowseDirectoryPicker, { maxEntries: 1000 })
      return child.get('directoryPicker').capability()
    })()
    return browse
  }
  const entryFor = (name: string) => {
    const entries = service('configEditor').entries().filter((entry: any) => entry.options.name === name)
    if (entries.length !== 1) throw new ConnectionPluginError('unsupported', 'DSH defaults require one active, addressable configuration entry.')
    return entries[0]
  }
  const persistenceAvailable = () => {
    try { entryFor('@deepseek-ai/dsh-agent-default-model'); entryFor('@deepseek-ai/dsh-permission-presets');
      return typeof get('configEditor')?.edit === 'function' && typeof get('permissionPresets')?.catalog === 'function' }
    catch { return false }
  }
  let settingsWrites = Promise.resolve()
  const serializeSettings = <T>(change: () => Promise<T>): Promise<T> => {
    const pending = settingsWrites.catch(() => {}).then(change)
    settingsWrites = pending.then(() => {}, () => {})
    return pending
  }
  const assertActive = (signal: AbortSignal) => { if (signal.aborted) throw new ConnectionPluginError('request_cancelled', 'Remote operation cancelled.') }
  const selection = async (payload: Record<string, any>) => {
    const current = service('agentDefaultModel').currentSelection()
    const provider = payload.provider ?? current.provider
    const modelId = payload.model ?? current.model
    const changed = provider !== current.provider || modelId !== current.model
    const reasoningEffort = Object.hasOwn(payload, 'reasoningEffort') ? payload.reasoningEffort ?? undefined : changed ? undefined : current.reasoningEffort
    if (typeof provider !== 'string' || typeof modelId !== 'string' || (reasoningEffort !== undefined && typeof reasoningEffort !== 'string')) throw new ConnectionPluginError('validation_failed', 'Invalid model selection.')
    const catalog = await service('sessionController').modelCatalog()
    const group = catalog.groups.find((group: any) => group.id === provider)
    const model = group?.models.find((model: any) => model.id === modelId)
    if (!model || (reasoningEffort !== undefined && !model.reasoning?.efforts.some((effort: any) => effort.id === reasoningEffort))) throw new ConnectionPluginError('validation_failed', 'Provider, model or reasoning effort is unavailable.')
    return { provider, model: modelId, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }
  const saveSelection = async (next: Awaited<ReturnType<typeof selection>>, signal: AbortSignal) => {
    assertActive(signal)
    const editor = service('configEditor')
    const entry = entryFor('@deepseek-ai/dsh-agent-default-model')
    // saveSelection is a no-op without an active editor entry. Using edit here
    // guarantees reconciliation and the persistent profile write both settled.
    await editor.edit(entry, (current: any) => {
      const updated = { ...current, ...next }
      if (next.reasoningEffort === undefined) delete updated.reasoningEffort
      return updated
    })
    const saved = service('agentDefaultModel').currentSelection()
    if (saved.provider !== next.provider || saved.model !== next.model || saved.reasoningEffort !== next.reasoningEffort) throw new ConnectionPluginError('conflict', 'DSH default selection did not persist.')
    return { provider: saved.provider, model: saved.model, ...(saved.reasoningEffort === undefined ? {} : { reasoningEffort: saved.reasoningEffort }) }
  }
  const followRequest = (payload: Record<string, any>) => {
    const address = payload.address ?? { kind: 'session', sessionId: payload.sessionId }
    if (!object(address) || (address.kind === 'session' ? !validIdentifier(address.sessionId) : address.kind === 'subagent' ?
      !validIdentifier(address.parentSessionId) || !validIdentifier(address.childSessionId) || !['one-shot', 'continuable', 'unknown'].includes(address.mode) : true)) throw new ConnectionPluginError('validation_failed', 'Invalid session address.')
    if (payload.maxMessages !== undefined && (!Number.isSafeInteger(payload.maxMessages) || payload.maxMessages < 1 || payload.maxMessages > 200)) throw new ConnectionPluginError('validation_failed', 'Invalid session page size.')
    return { address, ...(payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
      ...(payload.turnWindow === undefined ? {} : { turnWindow: payload.turnWindow }), assistantStream: true }
  }
  const workspaceView = (workspace: any) => ({ workspaceId: workspace.id, title: workspace.title, path: workspace.path, sessionIds: [...workspace.sessionIds] })
  const resolveWorkspace = async (payload: Record<string, any>, signal: AbortSignal) => {
    if (Object.keys(payload).some(key => !['name', 'path'].includes(key)) || typeof payload.name !== 'string' ||
        payload.name.trim() !== payload.name || !payload.name || [...payload.name].length > 128 || /[\x00-\x1f\x7f/\\]/.test(payload.name) ||
        ['.', '..'].includes(payload.name)) throw new ConnectionPluginError('validation_failed', 'Invalid workspace name.')
    const registry = service('workspaceRegistry')
    const existing = registry.list().filter((workspace: any) => workspace.title === payload.name)
    if (existing.length === 1) return { status: 'resolved', workspace: workspaceView(existing[0]), created: false }
    if (existing.length > 1) return { status: 'choose_workspace', workspaces: existing.map(workspaceView) }
    assertActive(signal)
    const picker = await remotePicker()
    if (typeof registry.create !== 'function') throw new ConnectionPluginError('unsupported', 'Workspace registration is unavailable.')
    let directory: string
    if (payload.path !== undefined) {
      if (typeof payload.path !== 'string' || !path.isAbsolute(payload.path)) throw new ConnectionPluginError('validation_failed', 'Choose a directory on the computer.')
      directory = (await picker.list(payload.path, signal)).path
    } else {
      const root = options.workspaceRoot?.()
      // The launcher defaults this preference to null. A missing configured
      // root is a required directory choice, never a guessed home directory.
      if (!root || !path.isAbsolute(root)) return { status: 'needs_directory', name: payload.name }
      const info = await lstat(root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ConnectionPluginError('permission_denied', 'Configured workspace root is unavailable.')
      const canonicalRoot = await realpath(root)
      const children = await picker.list(canonicalRoot, signal)
      const sameName = children.entries.filter((entry: any) => entry.name === payload.name)
      if (sameName.length > 1) throw new ConnectionPluginError('conflict', 'Choose the intended computer directory.')
      if (sameName.length === 1) directory = await realpath(sameName[0].path)
      else {
        if (typeof picker.createDirectory !== 'function') throw new ConnectionPluginError('unsupported', 'Directory creation is unavailable.')
        directory = await picker.createDirectory(canonicalRoot, payload.name)
      }
      const relative = path.relative(canonicalRoot, directory)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ConnectionPluginError('permission_denied', 'Workspace directory escapes its configured root.')
    }
    assertActive(signal)
    const workspace = await registry.create(directory, payload.name)
    return { status: 'resolved', workspace: workspaceView(workspace), created: true }
  }
  return {
    capabilities: () => {
      const sessions = get('sessionController')
      if (!sessions || !['create', 'prompt', 'cancel', 'list', 'modelCatalog', 'follow', 'control'].every(key => typeof sessions[key] === 'function') || typeof get('agentDefaultModel')?.currentSelection !== 'function') return []
      return ['remote_task', ...(typeof get('workspaceRegistry')?.list === 'function' && pickerAvailable() ? ['remote_directory'] : []), ...(persistenceAvailable() ? ['remote_settings'] : []), ...(lifecycle?.available() ? ['remote_workspace_lifecycle'] : []),
        ...(options.archiveDeletionEnabled === true && lifecycle?.archiveDeletionAvailable() ? ['remote_archive_delete'] : []),
        ...(options.artifactsEnabled === true && artifacts.available() ? ['remote_artifacts'] : []),
        ...(options.attachmentsEnabled === true && attachments?.available() ? ['remote_attachments'] : [])]
    },
    refreshCapabilities: refreshArchiveCapabilities,
    execute: async (operation, payload, requestId, signal, context) => {
      if (signal.aborted) throw new ConnectionPluginError('request_cancelled', 'Remote operation cancelled.')
      if (ARCHIVE_DELETE_OPERATIONS.includes(operation)) {
        if (options.archiveDeletionEnabled !== true || !lifecycle) throw new ConnectionPluginError('unsupported', 'Archive deletion remains unavailable pending verified host validation.')
        await refreshArchiveCapabilities()
        return publicDshResult(operation, await lifecycle.execute(operation, payload, requestId, signal, context))
      }
      if (ARTIFACT_OPERATIONS.includes(operation)) {
        if (options.artifactsEnabled !== true) throw new ConnectionPluginError('unsupported', 'Remote artifacts remain unavailable pending device validation.')
        return publicDshResult(operation, await artifacts.execute(operation, payload, requestId, signal, context))
      }
      if (ATTACHMENT_OPERATIONS.includes(operation)) {
        if (options.attachmentsEnabled !== true || !attachments) throw new ConnectionPluginError('unsupported', 'Remote attachments remain unavailable pending device validation.')
        return publicDshResult(operation, await attachments.execute(operation, payload, requestId, signal, context))
      }
      if (WORKSPACE_LIFECYCLE_OPERATIONS.includes(operation)) {
        if (!lifecycle) throw new ConnectionPluginError('unsupported', 'Durable workspace lifecycle is unavailable.')
        return lifecycle.execute(operation, payload, requestId, signal, context)
      }
      const sessions = service('sessionController')
      switch (operation) {
        case 'models.catalog': return publicDshResult(operation, await sessions.modelCatalog())
        case 'permissions.catalog': return publicDshResult(operation, service('permissionPresets').catalog())
        case 'session.create': {
          const digest = createHash('sha256').update(requestId).digest('hex')
          const sessionId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
          return publicDshResult(operation, await sessions.create({ ...payload, sessionId: payload.sessionId ?? sessionId }))
        }
        case 'session.prompt': {
          if (Object.keys(payload).some(key => !['sessionId', 'requestId', 'mode', 'content', 'clientTimeZone'].includes(key)) ||
              !Array.isArray(payload.content) || payload.content.length < 1 || payload.content.length > 64)
            throw new ConnectionPluginError('permission_denied', 'Remote prompt fields are restricted.')
          const hasFiles = payload.content.some((part: any) => part?.type === 'file')
          if (hasFiles && (options.attachmentsEnabled !== true || !attachments?.available()))
            throw new ConnectionPluginError('unsupported', 'Remote attachment service is unavailable.')
          for (const part of payload.content) {
            if (!object(part)) throw new ConnectionPluginError('permission_denied', 'Invalid remote prompt part.')
            const valid = part.type === 'text' ? Object.keys(part).every(key => ['type', 'text'].includes(key)) && typeof part.text === 'string' :
              part.type === 'file' && Object.keys(part).every(key => ['type', 'uploadId'].includes(key)) && validIdentifier(part.uploadId)
            if (!valid)
              throw new ConnectionPluginError('permission_denied', 'Remote prompt content must use a selected attachment upload.')
          }
          const prepared = hasFiles ? await attachments!.preparePrompt(payload, signal, context) : payload
          return publicDshResult(operation, await sessions.prompt({ ...prepared, requestId }, signal))
        }
        case 'session.cancel': return publicDshResult(operation, await sessions.cancel(payload))
        case 'session.follow': return { address: followRequest(payload).address, stream: 'follow' }
        case 'session.control': return { stream: 'control' }
        case 'session.list': return publicDshResult(operation, await sessions.list(payload, signal))
        case 'session.selectModel': {
          if (Object.keys(payload).some(key => !['sessionId', 'provider', 'model', 'reasoningEffort'].includes(key))) throw new ConnectionPluginError('permission_denied', 'Provider editing is controlled by the PC.')
          return serializeSettings(async () => {
            const selected = await saveSelection(await selection(payload), signal)
            if (payload.sessionId) await sessions.selectModel({ sessionId: payload.sessionId, ...selected })
            return { selected, persisted: true }
          })
        }
        case 'settings.describe': {
          const current = service('agentDefaultModel').currentSelection()
          return { selection: { provider: current.provider, model: current.model, ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }) }, permissions: publicDshResult('permissions.catalog', service('permissionPresets').catalog()) }
        }
        case 'settings.update': {
          // No provider definitions, credential values, ordering or endpoint
          // settings can cross this bridge, including from the web UI.
          if (Object.keys(payload).some(key => !['provider', 'model', 'reasoningEffort', 'sandbox'].includes(key))) throw new ConnectionPluginError('permission_denied', 'Provider editing is controlled by the PC.')
          if (!Object.keys(payload).length) throw new ConnectionPluginError('validation_failed', 'A setting change is required.')
          return serializeSettings(async () => {
            assertActive(signal)
            const hasSelection = ['provider', 'model', 'reasoningEffort'].some(key => Object.hasOwn(payload, key))
            const next = hasSelection ? await selection(payload) : undefined
            const permissionEntry = payload.sandbox === undefined ? undefined : entryFor('@deepseek-ai/dsh-permission-presets')
            // Validate all fields before writing either configuration entry.
            if (payload.sandbox !== undefined && !service('permissionPresets').catalog().defaultOptions.some((option: any) => option.value === payload.sandbox)) throw new ConnectionPluginError('validation_failed', 'Sandbox preset is unavailable.')
            const selected = next === undefined ? undefined : await saveSelection(next, signal)
            if (permissionEntry) {
              assertActive(signal)
              await service('configEditor').edit(permissionEntry, (current: any) => ({ ...current, defaultPreset: payload.sandbox }))
              if (service('permissionPresets').defaultPreset !== payload.sandbox) throw new ConnectionPluginError('conflict', 'DSH permission default did not persist.')
            }
            return { ...(selected === undefined ? {} : { selected }), ...(payload.sandbox === undefined ? {} : { sandbox: payload.sandbox }), persisted: true }
          })
        }
        case 'workspace.list': return { workspaces: service('workspaceRegistry').list().map(workspaceView) }
        case 'workspace.resolve': return resolveWorkspace(payload, signal)
        case 'directory.list': return publicDshResult(operation, await (await remotePicker()).list(payload.path, signal))
        default: throw new ConnectionPluginError('unsupported', 'Remote DSH operation is unavailable.')
      }
    },
    follow: async function* (payload, signal, operation) {
      const source = operation === 'session.control' ? service('sessionController').control(signal) : service('sessionController').follow(followRequest(payload), signal)
      for await (const frame of source) yield operation === 'session.control' ? publicDshControlFrame(frame) : publicDshFollowFrame(frame)
    },
    cancel: async sessionId => service('sessionController').cancel({ sessionId }),
    revoke: async (group, peer) => { await Promise.all([attachments?.revoke(group, peer), artifacts.revoke(group, peer)]) },
    dispose: async () => {
      adapterClosed = true; retentionController.abort()
      if (retentionTimer) clearInterval(retentionTimer)
      releaseReady?.()
      await archiveRefresh?.catch(() => {})
      await lifecycle?.dispose(); await artifacts.dispose(); await attachments?.dispose()
    },
  }
}

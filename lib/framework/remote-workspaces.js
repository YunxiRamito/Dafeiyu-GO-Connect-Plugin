import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { ConnectionPluginError } from './errors.js'
                                                            
import { FixedDshArchiveDriver } from './remote-archive-dsh.js'
import { ARCHIVE_DELETE_OPERATIONS, RemoteArchiveDeletion,                                       } from './remote-archive.js'

                                
                                                                                              
                   
                                                                                                      
                               
                                                                                                                 
                                                                                              
 
                                                                                                                                           
                                                                        
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/
const LIMIT = 512
const MAX_BYTES = 4 * 1024 * 1024
const EXPIRY = 30 * 24 * 60 * 60 * 1000
export const WORKSPACE_LIFECYCLE_OPERATIONS = Object.freeze(['workspace.remove.prepare', 'workspace.remove', 'workspace.files.delete',
  'workspace.removed.list', 'workspace.removed.restore', 'session.archive', 'session.restore', 'session.archived.list'])
const object = (value         )                 => value !== null && typeof value === 'object' && !Array.isArray(value)
function fail(code                                                                                                                                                        , message        )        {
  throw new ConnectionPluginError(code, message)
}
function identifier(value         )         {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('validation_failed', 'Invalid lifecycle identity.')
  return value
}
function fields(payload       , allowed          )       {
  if (!object(payload) || Object.keys(payload).some(key => !allowed.includes(key))) fail('permission_denied', 'Unknown lifecycle field.')
}
function absolute(value         )         {
  if (typeof value !== 'string' || value.length > 16_384 || value.includes('\0') || !path.isAbsolute(value)) fail('validation_failed', 'Invalid computer path.')
  return path.normalize(value)
}
function samePath(left        , right        )          { return path.relative(left, right) === '' }
function contains(parent        , child        )          {
  const relative = path.relative(parent, child)
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** Owns recoverable registration removal; destructive files require a second exact-path command. */
export class RemoteWorkspaceLifecycle {
          state        = { version: 1, removals: [], archives: [] }
          tail = Promise.resolve()
                   directory         
                   ctx     
          stopGate             
          archiveDriver                        
          archiveDeletion                        
          archiveClosed = false
          archiveFailure         
                   archiveEnabled         
          archiveInitializing                   
           ready               

  constructor(ctx     , options                                                                               = {}) {
    this.ctx = ctx
    this.directory = options.directory
    this.archiveEnabled = options.archiveDeletion === true
    this.protectedPaths = [os.homedir(), path.dirname(process.execPath), ...(options.protectedPaths ?? []),
      ...(process.env.SystemRoot ? [process.env.SystemRoot] : [])].filter(value => path.isAbsolute(value))
    this.ready = this.load().then(async () => { await this.initializeArchiveDeletion() })
    if (this.directory && typeof ctx?.on === 'function') this.stopGate = ctx.on('agent/pre-step', async (payload     , next                        ) => {
      await this.ready
      const header = payload?.agent?.session?.header
      if (!header || typeof header.cwd !== 'string') return next()
      const cwd = absolute(header.cwd)
      let canonical = cwd
      try { canonical = await realpath(cwd) } catch { /* Removed directories still match the durable lexical path. */ }
      const blocked = this.state.removals.some(value => value.phase !== 'prepared' && value.phase !== 'restored' &&
        (contains(value.workspace.path, cwd) || contains(value.workspace.path, canonical)))
      return blocked ? { kind: 'reject' } : next()
    })
  }
  async dispose()                {
    this.archiveClosed = true; this.stopGate?.(); this.stopGate = undefined
    await this.ready.catch(() => {})
    await this.archiveInitializing?.catch(() => {})
    await this.archiveDeletion?.dispose(); this.archiveDeletion = undefined; this.archiveDriver = undefined
    await this.tail.catch(() => {})
  }
          initializeArchiveDeletion()                   {
    if (this.archiveClosed || !this.archiveEnabled || !this.directory || this.archiveFailure) return Promise.resolve(false)
    if (this.archiveDeletion) return Promise.resolve(this.archiveDeletionAvailable())
    if (this.archiveInitializing) return this.archiveInitializing
    const driver = new FixedDshArchiveDriver(this.ctx)
    // Factories may compose their actual services after the plugin. This is the
    // only retryable admission failure; a journal or initialization error latches.
    if (!driver.available()) return Promise.resolve(false)
    const directory = this.directory
    const work = (async () => {
      const deletion = new RemoteArchiveDeletion(driver, this, directory)
      try { await deletion.ready }
      catch (error) {
        this.archiveFailure = (error       )?.details?.reason ?? 'archive_initialization_failed'
        await deletion.dispose(); return false
      }
      if (this.archiveClosed) { await deletion.dispose(); return false }
      this.archiveDriver = driver; this.archiveDeletion = deletion
      return this.archiveDeletionAvailable()
    })()
    this.archiveInitializing = work
    void work.finally(() => { if (this.archiveInitializing === work) this.archiveInitializing = undefined }).catch(() => {})
    return work
  }
  /** Same-instance single flight; never resets a durable failure or reloads state. */
  async ensureArchiveDeletion()                   {
    await this.ready
    return this.initializeArchiveDeletion()
  }
  archiveDeletionAvailable()          { return !this.archiveClosed && this.archiveDeletion?.available() === true }
  archiveDeletionReason()                { return this.archiveDeletionAvailable() ? null : this.archiveFailure ?? 'archive_service_composition_unverified' }
  async sweepArchives(signal             )                                                                    {
    this.active(signal)
    if (!await this.ensureArchiveDeletion()) fail('unsupported', 'Verified archive deletion is unavailable.')
    return this.archiveDeletion .sweep(signal)
  }
  /** Scoped catalogue admission shares the same queue as remove and restore. */
  async withArchive   (scope              , id        , work                                                                                 )             {
    await this.ready
    identifier(scope.group); identifier(scope.peer); identifier(id)
    const run = this.tail.catch(() => {}).then(() => {
      if (this.archiveClosed) fail('request_cancelled', 'Lifecycle has stopped.')
      const archive = this.state.archives.find(value => value.group === scope.group && value.peer === scope.peer && value.sessionId === id)
      return work(archive && structuredClone(archive), async () => {
        // Once physical deletion succeeds, no retained removal or other peer's
        // archive snapshot may reattach that identity during a later restore.
        const without = (workspace           )            => ({ ...workspace, sessionIds: workspace.sessionIds.filter(value => value !== id) })
        const next        = { ...this.state,
          archives: this.state.archives.filter(value => value.sessionId !== id).map(value => ({ ...value, workspace: value.workspace && without(value.workspace) })),
          removals: this.state.removals.map(value => ({ ...value, workspace: without(value.workspace), previouslyArchived: value.previouslyArchived.filter(value => value !== id) })) }
        await this.save(next); this.state = next
      })
    })
    this.tail = run.then(() => {}, () => {}); return run
  }
  async allArchives()                           {
    await this.ready
    const run = this.tail.catch(() => {}).then(() => structuredClone(this.state.archives))
    this.tail = run.then(() => {}, () => {}); return run
  }
                   protectedPaths          
          get(key        )      { return typeof this.ctx?.get === 'function' ? this.ctx.get(key) : this.ctx?.[key] }
  available()          {
    const registry = this.get('workspaceRegistry'), sessions = this.get('sessionController')
    return !!this.directory && ['list', 'get', 'delete', 'create', 'insertBefore', 'archiveSession', 'unarchiveSession'].every(key => typeof registry?.[key] === 'function') &&
      ['projections', 'inspect', 'updateQueue'].every(key => typeof sessions?.[key] === 'function') &&
      ['get', 'list'].every(key => typeof this.get('agents')?.[key] === 'function') &&
      typeof this.get('sessions')?.list === 'function' && typeof this.ctx?.on === 'function' &&
      typeof this.ctx?.waterfall === 'function' && typeof this.ctx?.parallel === 'function'
  }
          workspace(value     )            {
    if (!value || typeof value.title !== 'string' || value.title.length > 512 || !Array.isArray(value.sessionIds) || value.sessionIds.length > 1000) fail('protocol_error', 'Invalid authoritative workspace.')
    return { workspaceId: identifier(value.id ?? value.workspaceId), title: value.title, path: absolute(value.path), sessionIds: value.sessionIds.map(identifier) }
  }
          async load()                {
    if (!this.directory) return
    try {
      const file = path.join(this.directory, 'workspace-lifecycle.json'), info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) fail('protocol_error', 'Invalid lifecycle journal.')
      const state        = JSON.parse(await readFile(file, 'utf8'))
      if (!object(state) || state.version !== 1 || !Array.isArray(state.removals) || !Array.isArray(state.archives) || state.removals.length > LIMIT || state.archives.length > 2000) fail('protocol_error', 'Invalid lifecycle journal.')
      const tickets = new Set(), archiveIds = new Set()
      for (const value of state.removals) {
        identifier(value.ticket); identifier(value.group); identifier(value.peer); this.workspace(value.workspace)
        if (tickets.has(value.ticket) || !Number.isSafeInteger(value.order) || value.order < 0 || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
          !Array.isArray(value.previouslyArchived) || value.previouslyArchived.length > 1000 || value.previouslyArchived.some(id => !value.workspace.sessionIds.includes(id)) ||
          value.beforeId !== undefined && !IDENTIFIER.test(value.beforeId) || value.restoredId !== undefined && !IDENTIFIER.test(value.restoredId) ||
          value.removedAt !== undefined && (!Number.isSafeInteger(value.removedAt) || value.removedAt < 0) ||
          value.device !== undefined && !/^[0-9]{1,32}$/.test(value.device) || value.inode !== undefined && !/^[0-9]{1,32}$/.test(value.inode) ||
          !['prepared', 'archiving', 'removed', 'restored', 'files_moving', 'files_deleting', 'files_deleted'].includes(value.phase)) fail('protocol_error', 'Invalid removal receipt.')
        tickets.add(value.ticket)
      }
      for (const value of state.archives) {
        identifier(value.sessionId); identifier(value.group); identifier(value.peer)
        if (value.workspace !== null) this.workspace(value.workspace)
        const key = `${value.group}\0${value.peer}\0${value.sessionId}`
        if (archiveIds.has(key) || !Number.isSafeInteger(value.order) || value.order < 0 || value.archivedAt !== null && (!Number.isSafeInteger(value.archivedAt) || value.archivedAt < 0)) fail('protocol_error', 'Invalid archive receipt.')
        archiveIds.add(key)
      }
      this.state = state
    } catch (error) { if ((error       ).code !== 'ENOENT') throw error }
  }
          async save(state        = this.state)                {
    if (!this.directory) fail('unsupported', 'Lifecycle persistence is unavailable.')
    const text = JSON.stringify(state)
    if (Buffer.byteLength(text) > MAX_BYTES) fail('disk_space_low', 'Lifecycle journal reached its bound.')
    await mkdir(this.directory, { recursive: true })
    const temporary = path.join(this.directory, `lifecycle-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
      const destination = path.join(this.directory, 'workspace-lifecycle.json')
      if (this.archiveDriver) await this.archiveDriver.durableMove(temporary, destination, true)
      else await rename(temporary, destination)
    } finally { await rm(temporary, { force: true }).catch(() => {}) }
  }
          active(signal             )       { if (this.archiveClosed || signal.aborted) fail('request_cancelled', 'Lifecycle operation cancelled.') }
          receipt(payload       , context                      )          {
    const ticket = identifier(payload.ticket)
    const found = this.state.removals.find(value => value.ticket === ticket && value.group === context.group && value.peer === context.peer)
    if (!found) fail('permission_denied', 'Removal does not belong to this relationship.')
    return found
  }
          async sessionActivity(sessionId        , signal             )                                                                                     {
    this.active(signal)
    const projection = await this.get('sessionController').projections({ sessionId }, signal)
    const inbox = projection?.values?.inbox
    if (!object(inbox) || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step']) || inbox['next-turn'].length + inbox['next-step'].length > 512) fail('conflict', 'Session queue state is unknown; no deletion is allowed.')
    const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    if (!Array.isArray(activity) || activity.length > 64) fail('conflict', 'Session activity is unknown; no deletion is allowed.')
    return { sessionId, running: this.get('agents').get(sessionId)?.status === 'running', queued: inbox['next-turn'].length + inbox['next-step'].length, activity: activity.length }
  }
          async activities(ids          , signal             ) {
    const result = []
    for (const id of ids) result.push(await this.sessionActivity(id, signal))
    return result
  }
          async directoryActivities(workspace           , signal             ) {
    const agents = this.get('agents').list(), sessions = this.get('sessions').list()
    if (!Array.isArray(agents) || !Array.isArray(sessions) || agents.length + sessions.length > 4000) fail('conflict', 'Live directory activity cannot be inspected.')
    const ids = new Set(workspace.sessionIds)
    for (const header of [...agents.map((agent     ) => agent?.session?.header), ...sessions.map((session     ) => session?.header)]) {
      this.active(signal)
      if (!header || typeof header.cwd !== 'string') fail('conflict', 'Live task directory is unknown.')
      const cwd = absolute(header.cwd)
      let canonical = cwd
      try { canonical = await realpath(cwd) } catch { /* Retained/moved session headers still use the original path. */ }
      if (contains(workspace.path, cwd) || contains(workspace.path, canonical)) ids.add(identifier(header.id))
    }
    return this.activities([...ids], signal)
  }
          archiveRecord(sessionId        , workspace                  , order        , context                      , alreadyArchived         )       {
    if (this.state.archives.some(value => value.sessionId === sessionId && value.group === context.group && value.peer === context.peer)) return
    if (this.state.archives.length >= 2000) fail('disk_space_low', 'Archive journal reached its bound.')
    this.state.archives.push({ sessionId, group: context.group, peer: context.peer, workspace, order, archivedAt: alreadyArchived ? null : Date.now() })
  }
          async archiveAndStop(ids          , workspace                  , order        , stop         , signal             , context                      )                {
    const registry = this.get('workspaceRegistry'), sessions = this.get('sessionController')
    const before = await this.activities(ids, signal)
    if (!stop && before.some(value => value.running || value.queued || value.activity)) fail('conflict', 'Running work requires explicit stop confirmation.')
    for (const id of ids) this.archiveRecord(id, workspace, order, context, registry.archivedSessionIds.includes(id))
    await this.save()
    for (const id of ids) {
      this.active(signal)
      await registry.archiveSession(id, stop ? { stopActivity: true } : {})
      if (stop) {
        // An already archived session does not issue stop again. Request it,
        // then remove actual pending occurrences; accepted is never proof of idle.
        await this.ctx.parallel('workspace/session-stop', { sessionId: id })
        const inbox = (await sessions.projections({ sessionId: id }, signal))?.values?.inbox
        if (!object(inbox) || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) fail('conflict', 'Queue state became unknown during stop.')
        for (const item of [...inbox['next-turn'], ...inbox['next-step']]) {
          this.active(signal)
          if (typeof item?.id !== 'string') fail('conflict', 'Unknown queue occurrence.')
          await sessions.updateQueue({ sessionId: id, itemId: item.id, action: { kind: 'remove' } })
        }
      }
    }
    const deadline = Date.now() + 30_000
    while (true) {
      this.active(signal)
      const values = await this.activities(ids, signal)
      if (values.every(value => !value.running && value.queued === 0 && value.activity === 0)) return
      if (!stop || Date.now() >= deadline) fail('request_timeout', 'Work has not stopped; workspace and files are retained.')
      await pause(100)
    }
  }
          view(value         ) {
    return { ticket: value.ticket, workspace: value.workspace, order: value.order, phase: value.phase,
      createdAt: value.createdAt, removedAt: value.removedAt ?? null, restoredId: value.restoredId ?? null,
      executionDevice: 'remote_computer', filesDeleted: value.phase === 'files_deleted', filesDeleteRequiresSeparateConfirmation: true }
  }
          archiveView(value         ) {
    if (this.archiveDeletion) return { sessionId: value.sessionId, workspace: value.workspace, order: value.order,
      ...this.archiveDeletion.retention(value.sessionId) }
    return { sessionId: value.sessionId, workspace: value.workspace, order: value.order, archivedAt: value.archivedAt,
      expiresAt: value.archivedAt === null ? null : value.archivedAt + EXPIRY,
      remainingDays: value.archivedAt === null ? null : Math.max(0, Math.ceil((value.archivedAt + EXPIRY - Date.now()) / 86_400_000)) }
  }
          async seedNativeArchives(context              , signal             )                {
    if (!this.archiveDeletion) return
    const registry = this.get('workspaceRegistry'), list = registry.list(), current = registry.archivedSessionIds
    if (!Array.isArray(current) || current.length > 2000 || typeof registry.readSessionHeader !== 'function') fail('conflict', 'Authoritative archive catalogue is unavailable.')
    const next = this.state.archives.slice()
    for (const rawId of current) {
      this.active(signal)
      const id = identifier(rawId)
      if (this.archiveDeletion.blocked(id) || next.some(value => value.sessionId === id && value.group === context.group && value.peer === context.peer)) continue
      const header = await registry.readSessionHeader(id)
      if (!header || header.id !== id) continue
      if (next.length >= 2000) fail('disk_space_low', 'Archive journal reached its bound.')
      const order = list.findIndex((workspace     ) => workspace.sessionIds.includes(id)), workspace = order < 0 ? null : this.workspace(list[order])
      const retained = this.state.removals.find(value => value.group === context.group && value.peer === context.peer && value.workspace.sessionIds.includes(id))
      next.push({ ...context, sessionId: id, workspace: workspace ?? retained?.workspace ?? null, order: order < 0 ? retained?.order ?? 0 : order,
        // Only the native archive observer owns time. Legacy native entries
        // are scoped for confirmation without inventing a retention epoch.
        archivedAt: null })
    }
    if (next.length !== this.state.archives.length) { const state = { ...this.state, archives: next }; await this.save(state); this.state = state }
  }
          async prepare(payload       , context                      , signal             ) {
    fields(payload, ['workspaceId'])
    const registry = this.get('workspaceRegistry'), id = identifier(payload.workspaceId), list = registry.list()
    const index = list.findIndex((value     ) => value.id === id)
    if (index < 0) fail('conflict', 'Workspace is no longer registered.')
    const workspace = this.workspace(list[index]), activity = await this.directoryActivities(workspace, signal)
    this.state.removals = this.state.removals.filter(value => value.phase !== 'prepared' || Date.now() - value.createdAt <= 24 * 60 * 60 * 1000)
    if (this.state.removals.length >= LIMIT) fail('disk_space_low', 'Removal journal reached its bound.')
    let info
    try { info = await lstat(workspace.path, { bigint: true }) }
    catch (error) { if ((error       ).code !== 'ENOENT') fail('permission_denied', 'Computer directory cannot be inspected.') }
    const value          = { ticket: randomUUID(), group: context.group, peer: context.peer, workspace, order: index,
      previouslyArchived: workspace.sessionIds.filter(id => registry.archivedSessionIds.includes(id)),
      ...(list[index + 1] ? { beforeId: identifier(list[index + 1].id) } : {}), phase: 'prepared', createdAt: Date.now(),
      ...(info && !info.isSymbolicLink() && info.isDirectory() ? { device: String(info.dev), inode: String(info.ino) } : {}) }
    this.state.removals.push(value); await this.save()
    return { ...this.view(value), activity, stopRequired: activity.some(item => item.running || item.queued || item.activity), defaultFilesDecision: 'keep', filesIdentityVerified: !!value.inode }
  }
          async remove(payload       , context                      , signal             ) {
    fields(payload, ['ticket', 'stopTasks'])
    if (payload.stopTasks !== undefined && typeof payload.stopTasks !== 'boolean') fail('validation_failed', 'Invalid stop confirmation.')
    const value = this.receipt(payload, context), registry = this.get('workspaceRegistry')
    if (['removed', 'files_deleted', 'files_moving', 'files_deleting'].includes(value.phase)) return this.view(value)
    if (!['prepared', 'archiving'].includes(value.phase) || value.phase === 'prepared' && Date.now() - value.createdAt > 24 * 60 * 60 * 1000) fail('conflict', 'Prepare a new removal confirmation.')
    const current = registry.get(value.workspace.workspaceId)
    if (!current || JSON.stringify(this.workspace(current)) !== JSON.stringify(value.workspace)) fail('conflict', 'Workspace changed after confirmation; prepare again.')
    const before = await this.directoryActivities(value.workspace, signal)
    if (payload.stopTasks !== true && before.some(item => item.running || item.queued || item.activity)) fail('conflict', 'Running work requires explicit stop confirmation.')
    value.phase = 'archiving'; await this.save()
    // The durable pre-step gate now blocks newly admitted work at this path.
    // Include unaccounted or child sessions already attached to this directory.
    const admitted = await this.directoryActivities(value.workspace, signal)
    await this.archiveAndStop(admitted.map(item => item.sessionId), value.workspace, value.order, payload.stopTasks === true, signal, context)
    this.active(signal)
    if (JSON.stringify(this.workspace(registry.get(value.workspace.workspaceId))) !== JSON.stringify(value.workspace)) fail('conflict', 'Workspace changed during stop; files are retained.')
    await registry.delete(value.workspace.workspaceId)
    if (registry.get(value.workspace.workspaceId)) fail('conflict', 'Workspace removal did not persist.')
    value.phase = 'removed'; value.removedAt = Date.now(); await this.save()
    return this.view(value)
  }
          async restore(payload       , context                      , signal             ) {
    fields(payload, ['ticket'])
    const value = this.receipt(payload, context), registry = this.get('workspaceRegistry')
    if (value.phase === 'restored') {
      const restored = registry.get(value.restoredId)
      if (!restored) fail('conflict', 'Restored workspace registration changed.')
      return { ...this.view(value), workspace: this.workspace(restored), status: 'restored', restoredSessions: value.workspace.sessionIds.filter(id => !value.previouslyArchived.includes(id)) }
    }
    if (!['removed', 'files_deleted', 'archiving'].includes(value.phase)) fail('conflict', 'Removal is not ready to restore.')
    this.active(signal)
    let info
    try { info = await lstat(value.workspace.path) } catch { return { ...this.view(value), status: 'needs_directory' } }
    if (!info.isDirectory() || info.isSymbolicLink()) return { ...this.view(value), status: 'needs_directory' }
    const current = registry.list().find((item     ) => samePath(absolute(item.path), value.workspace.path))
    const restored = current ?? await registry.create(value.workspace.path, value.workspace.title)
    if (typeof restored.attachSession !== 'function' || typeof restored.insertSessionBefore !== 'function') fail('unsupported', 'Workspace history accounting is unavailable.')
    if (restored.title !== value.workspace.title) await restored.setTitle(value.workspace.title)
    // registry.create() persists an empty ownership account; cwd alone never
    // reattaches historical sessions. The native method validates each header.
    for (const id of value.workspace.sessionIds) { this.active(signal); await restored.attachSession(id) }
    for (let index = value.workspace.sessionIds.length - 1; index >= 0; index--) {
      this.active(signal)
      await restored.insertSessionBefore(value.workspace.sessionIds[index], value.workspace.sessionIds[index + 1])
    }
    const authoritative = this.workspace(restored)
    if (value.workspace.sessionIds.some(id => !authoritative.sessionIds.includes(id))) fail('conflict', 'Workspace history accounting did not persist.')
    const retainedOrder = authoritative.sessionIds.filter(id => value.workspace.sessionIds.includes(id))
    if (JSON.stringify(retainedOrder) !== JSON.stringify(value.workspace.sessionIds)) fail('conflict', 'Workspace session order did not persist.')
    await registry.insertBefore(restored.id, value.beforeId && registry.get(value.beforeId) ? value.beforeId : undefined)
    const restoreIds = value.workspace.sessionIds.filter(id => !value.previouslyArchived.includes(id))
    for (const id of restoreIds) { this.active(signal); await registry.unarchiveSession(id) }
    this.state.archives = this.state.archives.filter(record => record.group !== context.group || record.peer !== context.peer || !restoreIds.includes(record.sessionId))
    value.restoredId = identifier(restored.id); value.phase = 'restored'; await this.save()
    return { ...this.view(value), workspace: this.workspace(restored), status: 'restored', restoredSessions: restoreIds }
  }
          quarantine(value         )         { return path.join(path.dirname(value.workspace.path), `.dafeiyu-removed-${value.ticket}`) }
          async deleteFiles(payload       , context                      , signal             ) {
    fields(payload, ['ticket', 'confirmedPath', 'confirmDelete'])
    const value = this.receipt(payload, context), root = value.workspace.path
    if (payload.confirmDelete !== true || typeof payload.confirmedPath !== 'string' || payload.confirmedPath !== root) fail('permission_denied', 'Exact computer path deletion requires explicit confirmation.')
    if (value.phase === 'files_deleted') return this.view(value)
    if (!['removed', 'files_moving', 'files_deleting'].includes(value.phase)) fail('conflict', 'Registration must be removed before deleting files.')
    if (samePath(root, path.parse(root).root) || !value.device || !value.inode || this.protectedPaths.some(protectedPath => contains(root, protectedPath) || contains(protectedPath, root))) fail('permission_denied', 'Protected or unverified directory cannot be deleted.')
    if (this.get('workspaceRegistry').list().some((item     ) => contains(root, absolute(item.path)))) fail('conflict', 'Another workspace is still registered in this directory.')
    this.active(signal)
    const activity = await this.directoryActivities(value.workspace, signal)
    if (activity.some(item => item.running || item.queued || item.activity)) fail('conflict', 'Actual tasks have not stopped.')
    // Rename first: a recreated original path is never followed by the removal.
    // The journal records the deterministic quarantine before every filesystem step.
    const quarantine = this.quarantine(value)
    if (value.phase === 'removed') {
      if (!samePath(await realpath(root), root)) fail('permission_denied', 'Directory mapping changed.')
      const info = await lstat(root, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== value.device || String(info.ino) !== value.inode) fail('conflict', 'Directory identity changed after confirmation.')
      try { await lstat(quarantine); fail('conflict', 'Quarantine path already exists.') }
      catch (error) { if ((error       ).code !== 'ENOENT') throw error }
      value.phase = 'files_moving'; await this.save()
      await rename(root, quarantine)
    } else if (value.phase === 'files_moving') {
      try { await lstat(root); fail('conflict', 'Uncertain move requires reviewing the retained directory.') }
      catch (error) { if ((error       ).code !== 'ENOENT') throw error }
    }
    const quarantined = await lstat(quarantine, { bigint: true })
    if (!quarantined.isDirectory() || quarantined.isSymbolicLink() || String(quarantined.dev) !== value.device || String(quarantined.ino) !== value.inode) fail('conflict', 'Quarantine identity does not match the confirmed directory.')
    this.active(signal)
    value.phase = 'files_deleting'; await this.save()
    await rm(quarantine, { recursive: true, force: false })
    value.phase = 'files_deleted'; await this.save()
    return this.view(value)
  }
          async archive(payload       , context                      , signal             ) {
    fields(payload, ['sessionId', 'stopTasks'])
    const id = identifier(payload.sessionId), registry = this.get('workspaceRegistry'), list = registry.list()
    const index = list.findIndex((item     ) => item.sessionIds.includes(id))
    const workspace = index < 0 ? null : this.workspace(list[index])
    if (payload.stopTasks !== undefined && typeof payload.stopTasks !== 'boolean') fail('validation_failed', 'Invalid stop confirmation.')
    await this.archiveAndStop([id], workspace, Math.max(index, 0), payload.stopTasks === true, signal, context)
    const record = this.state.archives.find(value => value.sessionId === id && value.group === context.group && value.peer === context.peer) 
    return { ...this.archiveView(record), archived: true, tasksStopped: true }
  }
          async restoreSession(payload       , context                      , signal             ) {
    fields(payload, ['sessionId'])
    const id = identifier(payload.sessionId), record = this.state.archives.find(value => value.sessionId === id && value.group === context.group && value.peer === context.peer)
    if (!record) fail('permission_denied', 'Archive does not belong to this relationship.')
    const workspace = record.workspace && this.get('workspaceRegistry').list().find((item     ) => samePath(absolute(item.path), record.workspace .path))
    if (record.workspace && !workspace)
      return { sessionId: id, restored: false, status: 'restore_workspace_first', path: record.workspace.path }
    if (workspace) {
      this.active(signal); await workspace.attachSession(id)
      const source = record.workspace .sessionIds
      const before = source.slice(source.indexOf(id) + 1).find(next => workspace.sessionIds.includes(next))
      await workspace.insertSessionBefore(id, before)
    }
    this.active(signal); await this.get('workspaceRegistry').unarchiveSession(id)
    this.state.archives = this.state.archives.filter(value => value !== record); await this.save()
    return { sessionId: id, restored: true }
  }
  async execute(operation        , payload       , _requestId        , signal             , context                       )                   {
    await this.ready
    if (!this.available() || !context) fail('unsupported', 'Durable workspace lifecycle is unavailable.')
    identifier(context.group); identifier(context.peer)
    if (this.archiveClosed) fail('request_cancelled', 'Lifecycle has stopped.')
    // The deletion manager enters withArchive itself; never hold this queue
    // while waiting for it or prepare/delete would deadlock against restore.
    if (ARCHIVE_DELETE_OPERATIONS.includes(operation)) {
      if (!await this.ensureArchiveDeletion()) fail('unsupported', 'Verified archive deletion is unavailable.')
      return this.archiveDeletion .execute(operation, payload, _requestId, signal, context)
    }
    // Lists and native archive/restore must start epoch observation when late
    // services become ready, even before the first permanent-delete request.
    if (['session.archive', 'session.restore', 'session.archived.list', 'workspace.remove', 'workspace.removed.restore'].includes(operation))
      await this.ensureArchiveDeletion()
    const run = this.tail.catch(() => {}).then(async () => {
      this.active(signal)
      switch (operation) {
        case 'workspace.remove.prepare': return this.prepare(payload, context, signal)
        case 'workspace.remove': return this.remove(payload, context, signal)
        case 'workspace.files.delete': return this.deleteFiles(payload, context, signal)
        case 'workspace.removed.restore': return this.restore(payload, context, signal)
        case 'workspace.removed.list': {
          fields(payload, [])
          return { removals: this.state.removals.filter(value => value.group === context.group && value.peer === context.peer && value.phase !== 'prepared' && value.phase !== 'restored').map(value => this.view(value)) }
        }
        case 'session.archive': return this.archive(payload, context, signal)
        case 'session.restore': return this.restoreSession(payload, context, signal)
        case 'session.archived.list': {
          fields(payload, [])
          await this.seedNativeArchives(context, signal)
          const current = this.get('workspaceRegistry').archivedSessionIds
          return { archives: this.state.archives.filter(value => value.group === context.group && value.peer === context.peer && current.includes(value.sessionId)).map(value => this.archiveView(value)) }
        }
        default: fail('unsupported', 'Unknown lifecycle operation.')
      }
    })
    this.tail = run.then(() => {}, () => {})
    return run
  }
}

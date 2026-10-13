import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { ConnectionPluginError } from './errors.ts'
import { FixedDshArchiveDriver, archiveRefusal, type ArchiveEpoch, type ArchiveStorageSnapshot, type ArchiveRegistryWitness } from './remote-archive-dsh.ts'

type Value = Record<string, any>
export interface ArchiveScope { group: string; peer: string }
export interface ScopedArchive extends ArchiveScope { sessionId: string; workspace: Value | null; order: number; archivedAt: number | null }
export interface ArchiveCatalog {
  /** The caller holds the lifecycle's serialization slot until work settles. */
  withArchive<T>(scope: ArchiveScope, id: string, work: (archive: ScopedArchive | undefined, commit: () => Promise<void>) => Promise<T>): Promise<T>
  allArchives(): Promise<ScopedArchive[]>
}
interface Receipt extends ArchiveScope {
  ticket: string; sessionId: string; preparedAt: number; archiveDigest: string; epoch: string; archivedAt: number | null;
  snapshot: ArchiveStorageSnapshot; phase: 'prepared' | 'tombstoned' | 'indexed' | 'files' | 'deleted';
  deleteRequestId?: string; deletedAt?: number; reason?: 'manual' | 'retention'
}
interface Journal { version: 1; epochs: Record<string, ArchiveEpoch>; receipts: Receipt[]; registryWitness?: ArchiveRegistryWitness }
const ID = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^[0-9a-f]{64}$/
const EXPIRY = 30 * 86_400_000
const MAX_BYTES = 8 * 1024 * 1024
const MAX_RECORDS = 2000
export const ARCHIVE_DELETE_OPERATIONS = Object.freeze(['session.archived.delete.prepare', 'session.archived.delete'])
export const ARCHIVE_DELETE_CAPABILITY = 'remote_archive_delete'
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) archiveRefusal('archive_identity_invalid', 'protocol_error')
  return value
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function fields(value: Value, permitted: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !permitted.includes(key))) archiveRefusal('archive_field_invalid', 'permission_denied')
}
/** Read-only pre-CLI validation: never trusts an unknown journal or executes recovery. */
export function validateArchiveBootstrapJournal(value: unknown): ReadonlySet<string> {
  const journal = RemoteArchiveDeletion.validateJournal(value)
  return new Set(journal.receipts.filter(receipt => receipt.phase !== 'prepared').map(receipt => receipt.sessionId))
}

/** Durable, bounded tombstones. Prepared confirmation never removes any history. */
export class RemoteArchiveDeletion {
  private state: Journal = { version: 1, epochs: Object.create(null), receipts: [] }
  private writes = Promise.resolve()
  private operations = Promise.resolve()
  private lease?: { release(): Promise<void> }
  private closed = false
  private loaded = false
  private failed = false
  private durableTombstones = new Set<string>()
  private readonly driver: FixedDshArchiveDriver
  private readonly catalog: ArchiveCatalog
  private readonly directory: string
  readonly ready: Promise<void>
  constructor(driver: FixedDshArchiveDriver, catalog: ArchiveCatalog, directory: string) {
    this.driver = driver; this.catalog = catalog; this.directory = directory
    this.ready = this.load()
  }
  private active(signal: AbortSignal): void { if (this.closed || signal.aborted) throw new ConnectionPluginError('request_cancelled', 'Archive operation cancelled.') }
  available(): boolean { return this.loaded && !this.failed && !this.closed && this.driver.available() }
  blocked(id: string): boolean { return this.state.receipts.some(value => value.sessionId === id && value.phase !== 'prepared') }
  retention(id: string): { archiveVersion: string | null; archivedAt: number | null; expiresAt: number | null; remainingDays: number | null } {
    const epoch = this.state.epochs[id], archivedAt = epoch?.archived ? epoch.archivedAt : null
    return { archiveVersion: epoch?.archived ? epoch.version : null, archivedAt,
      expiresAt: archivedAt === null ? null : archivedAt + EXPIRY,
      remainingDays: archivedAt === null ? null : Math.max(0, Math.ceil((archivedAt + EXPIRY - Date.now()) / 86_400_000)) }
  }
  private async load(): Promise<void> {
    if (!path.isAbsolute(this.directory)) archiveRefusal('archive_journal_directory_invalid', 'unsupported')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) archiveRefusal('archive_journal_directory_invalid', 'protocol_error')
    this.lease = await this.driver.journalLease(this.directory)
    try {
      const file = path.join(this.directory, 'archive-deletion.json')
      try {
        const stored = await lstat(file)
        if (!stored.isFile() || stored.isSymbolicLink() || stored.size > MAX_BYTES) archiveRefusal('archive_journal_invalid', 'protocol_error')
        this.state = RemoteArchiveDeletion.validateJournal(JSON.parse(await readFile(file, 'utf8')))
      } catch (error) { if ((error as any).code !== 'ENOENT') throw error }
      this.durableTombstones = new Set(this.state.receipts.filter(value => value.phase !== 'prepared').map(value => value.sessionId))
      this.driver.assertJournalTombstones(id => this.blocked(id))
      const witness = await this.driver.registryWitness()
      if (JSON.stringify(this.state.registryWitness) !== JSON.stringify(witness)) {
        for (const [id, epoch] of Object.entries(this.state.epochs)) {
          if (!this.blocked(id)) this.state.epochs[id] = { ...epoch, version: randomUUID(), archivedAt: null }
        }
        this.state.registryWitness = witness
        await this.save()
      }
      this.driver.bind({ blocked: id => this.blocked(id), tombstones: () => new Set(this.state.receipts.filter(value => value.phase !== 'prepared').map(value => value.sessionId)),
        durableTombstones: () => this.durableTombstones,
        transition: (before, after) => this.transition(before, after),
        registryWritten: async () => { this.state.registryWitness = await this.driver.registryWitness(); await this.save() } })
      this.loaded = true
    } catch (error) { await this.lease.release(); this.lease = undefined; throw error }
  }
  static validateJournal(value: any): Journal {
    if (!value || value.version !== 1 || !value.epochs || typeof value.epochs !== 'object' || Array.isArray(value.epochs) || Object.keys(value.epochs).length > MAX_RECORDS || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECORDS)
      archiveRefusal('archive_journal_invalid', 'protocol_error')
    const epochs: Record<string, ArchiveEpoch> = Object.create(null)
    for (const [id, epoch] of Object.entries(value.epochs) as Array<[string, any]>) {
      identifier(id); identifier(epoch.version)
      if (typeof epoch.archived !== 'boolean' || epoch.archivedAt !== null && !timestamp(epoch.archivedAt)) archiveRefusal('archive_epoch_invalid', 'protocol_error')
      epochs[id] = { version: epoch.version, archived: epoch.archived, archivedAt: epoch.archivedAt }
    }
    const tickets = new Set<string>()
    for (const receipt of value.receipts as Receipt[]) {
      for (const key of ['ticket', 'group', 'peer', 'sessionId', 'epoch'] as const) identifier(receipt[key])
      if (tickets.has(receipt.ticket) || !HASH.test(receipt.archiveDigest) || !timestamp(receipt.preparedAt) || receipt.archivedAt !== null && !timestamp(receipt.archivedAt) ||
        !['prepared', 'tombstoned', 'indexed', 'files', 'deleted'].includes(receipt.phase) || receipt.deleteRequestId !== undefined && !ID.test(receipt.deleteRequestId) ||
        receipt.reason !== undefined && !['manual', 'retention'].includes(receipt.reason) || receipt.deletedAt !== undefined && !timestamp(receipt.deletedAt)) archiveRefusal('archive_receipt_invalid', 'protocol_error')
      tickets.add(receipt.ticket)
      const snapshot = receipt.snapshot
      if (!snapshot || snapshot.sessionId !== receipt.sessionId || typeof snapshot.revision !== 'string' || snapshot.revision.length > 8192 || !path.isAbsolute(snapshot.directory) ||
        !/^[0-9]{1,32}$/.test(snapshot.device) || !/^[0-9]{1,32}$/.test(snapshot.inode) || snapshot.header?.id !== receipt.sessionId || snapshot.header.version !== 4 ||
        !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > 32) archiveRefusal('archive_storage_receipt_invalid', 'protocol_error')
      const names = new Set<string>()
      for (const file of snapshot.files) {
        if (!/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(file.name) || names.has(file.name) || !HASH.test(file.sha256) ||
          [file.device, file.inode, file.size, file.modified, file.changed].some(item => typeof item !== 'string' || !/^[0-9]{1,32}$/.test(item))) archiveRefusal('archive_file_receipt_invalid', 'protocol_error')
        names.add(file.name)
      }
    }
    if (value.registryWitness !== undefined) {
      const witness = value.registryWitness, file = witness?.file
      if (!witness || typeof witness.path !== 'string' || witness.path.length > 16384 || witness.path.includes('\0') || !path.isAbsolute(witness.path) ||
        !file || file.name !== 'workspace.json' || !HASH.test(file.sha256) ||
        [file.device, file.inode, file.size, file.modified, file.changed].some(item => typeof item !== 'string' || !/^[0-9]{1,32}$/.test(item)))
        archiveRefusal('archive_registry_witness_invalid', 'protocol_error')
    }
    return { version: 1, epochs, receipts: value.receipts, ...(value.registryWitness === undefined ? {} : { registryWitness: value.registryWitness }) }
  }
  private save(): Promise<void> {
    const work = this.writes.catch(() => {}).then(async () => {
      const saved = RemoteArchiveDeletion.validateJournal(this.state), text = JSON.stringify(saved)
      const tombstones = saved.receipts.filter(value => value.phase !== 'prepared').map(value => value.sessionId)
      if (Buffer.byteLength(text) > MAX_BYTES) archiveRefusal('archive_journal_full')
      const temporary = path.join(this.directory, `archive-${randomUUID()}.tmp`)
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
        await this.driver.durableMove(temporary, path.join(this.directory, 'archive-deletion.json'), true)
        for (const id of tombstones) this.durableTombstones.add(id)
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    })
    const guarded = work.catch(error => { this.failed = true; throw error })
    this.writes = guarded
    return guarded
  }
  private async transition(before: string[], after: string[]): Promise<void> {
    const removed = before.filter(id => !after.includes(id)), added = after.filter(id => !before.includes(id))
    if (!removed.length && !added.length) return
    for (const id of [...removed, ...added]) {
      identifier(id)
      if (!Object.hasOwn(this.state.epochs, id) && Object.keys(this.state.epochs).length >= MAX_RECORDS) archiveRefusal('archive_epoch_journal_full')
      this.state.epochs[id] = { version: randomUUID(), archivedAt: added.includes(id) ? Date.now() : null, archived: added.includes(id) }
    }
    // A failed registry write may invalidate an epoch, which safely requires a
    // new confirmation. It can never preserve an older automatic deletion date.
    await this.save()
  }
  private async epoch(id: string): Promise<ArchiveEpoch> {
    let epoch = this.state.epochs[id]
    if (!epoch || !epoch.archived) {
      if (!epoch && Object.keys(this.state.epochs).length >= MAX_RECORDS) archiveRefusal('archive_epoch_journal_full')
      epoch = { version: randomUUID(), archivedAt: null, archived: true }
      this.state.epochs[id] = epoch; await this.save()
    }
    return epoch
  }
  private view(value: Receipt): Value {
    return { ticket: value.ticket, sessionId: value.sessionId, archiveVersion: value.epoch, archivedAt: value.archivedAt,
      executionDevice: 'remote_computer', deleted: value.phase === 'deleted', status: value.phase === 'deleted' ? 'deleted' : value.phase === 'prepared' ? 'prepared' : 'deleting',
      ...(value.deletedAt === undefined ? {} : { deletedAt: value.deletedAt }) }
  }
  private scoped(payload: Value, context: ArchiveScope): Receipt {
    const ticket = identifier(payload.ticket), receipt = this.state.receipts.find(value => value.ticket === ticket && value.group === context.group && value.peer === context.peer)
    if (!receipt) archiveRefusal('archive_confirmation_scope_changed', 'permission_denied')
    return receipt
  }
  private async prepare(id: string, context: ArchiveScope, signal: AbortSignal): Promise<Value> {
    return this.catalog.withArchive(context, id, archive => this.driver.registryTransaction(async () => {
      if (!archive) archiveRefusal('archive_relationship_snapshot_missing', 'permission_denied')
      if (this.blocked(id)) archiveRefusal('archive_deletion_pending')
      const epoch = await this.epoch(id), snapshot = await this.driver.inspect(id, signal)
      this.active(signal)
      if (this.state.epochs[id].version !== epoch.version) archiveRefusal('archive_changed_during_confirmation')
      // Expired, never-used confirmations may be compacted; tombstones are retained.
      this.state.receipts = this.state.receipts.filter(value => value.phase !== 'prepared' || Date.now() - value.preparedAt <= 86_400_000)
      if (this.state.receipts.length >= MAX_RECORDS) archiveRefusal('archive_confirmation_journal_full')
      const receipt: Receipt = { ticket: randomUUID(), ...context, sessionId: id, preparedAt: Date.now(), archiveDigest: digest(archive),
        epoch: epoch.version, archivedAt: epoch.archivedAt, snapshot, phase: 'prepared' }
      this.state.receipts.push(receipt); await this.save()
      return { ...this.view(receipt), expiresAt: epoch.archivedAt === null ? null : epoch.archivedAt + EXPIRY }
    }))
  }
  private async remove(receipt: Receipt, requestId: string, signal: AbortSignal, reason: 'manual' | 'retention'): Promise<Value> {
    if (receipt.phase === 'deleted') return this.view(receipt)
    return this.catalog.withArchive(receipt, receipt.sessionId, (archive, commit) => this.driver.registryTransaction(async () => {
      const fresh = receipt.phase === 'prepared'
      if (fresh && (!archive || digest(archive) !== receipt.archiveDigest || this.state.epochs[receipt.sessionId]?.version !== receipt.epoch ||
        Date.now() - receipt.preparedAt > 86_400_000)) archiveRefusal('archive_changed_after_confirmation')
      if (reason === 'retention' && (receipt.archivedAt === null || Date.now() < receipt.archivedAt + EXPIRY)) archiveRefusal('archive_retention_not_due')
      if (!fresh && archive && digest(archive) !== receipt.archiveDigest) archiveRefusal('archive_changed_during_recovery')
      return this.driver.withOwnership(receipt.snapshot, signal, !fresh, async () => {
        if (fresh) {
          this.active(signal)
          receipt.phase = 'tombstoned'; receipt.deleteRequestId = requestId; receipt.reason = reason
          await this.save()
        }
        if (receipt.phase === 'tombstoned') {
          await this.driver.detachIndex(receipt.sessionId)
          receipt.phase = 'indexed'; await this.save()
        }
        if (receipt.phase === 'indexed') { receipt.phase = 'files'; await this.save() }
        if (receipt.phase === 'files') {
          this.active(signal)
          await this.driver.deleteFiles(receipt.snapshot, receipt.ticket, signal)
          await this.driver.purgeCaches(receipt.sessionId, signal)
          await commit()
          receipt.phase = 'deleted'; receipt.deletedAt = Date.now(); await this.save()
        }
        return this.view(receipt)
      })
    }))
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operations.catch(() => {}).then(work)
    this.operations = result.then(() => {}, () => {})
    return result
  }
  async execute(operation: string, payload: Value, requestId: string, signal: AbortSignal, context: ArchiveScope): Promise<unknown> {
    await this.ready
    identifier(context.group); identifier(context.peer); identifier(requestId)
    if (!this.available()) archiveRefusal('archive_delete_unavailable', 'unsupported')
    return this.serial(async () => {
      this.active(signal)
      if (!this.available()) archiveRefusal('archive_journal_write_failed', 'unsupported')
      if (operation === 'session.archived.delete.prepare') {
        fields(payload, ['sessionId']); return this.prepare(identifier(payload.sessionId), context, signal)
      }
      if (operation === 'session.archived.delete') {
        fields(payload, ['ticket', 'confirmDelete'])
        if (payload.confirmDelete !== true) archiveRefusal('archive_explicit_confirmation_required', 'permission_denied')
        return this.remove(this.scoped(payload, context), requestId, signal, 'manual')
      }
      archiveRefusal('archive_operation_unknown', 'unsupported')
    })
  }
  /** Trusted local retention; no peer can supply an archive time or accelerate the deadline. */
  async sweep(signal: AbortSignal): Promise<{ deleted: number; retained: number; reasons: string[] }> {
    await this.ready
    return this.serial(async () => {
      this.active(signal)
      if (!this.available()) archiveRefusal('archive_journal_write_failed', 'unsupported')
      let deleted = 0, retained = 0
      const reasons = new Set<string>()
      const pending = this.state.receipts.filter(value => value.phase !== 'prepared' && value.phase !== 'deleted')
      for (const receipt of pending) {
        this.active(signal)
        try { await this.remove(receipt, receipt.deleteRequestId!, signal, receipt.reason!); deleted++ }
        catch (error) { this.active(signal); retained++; reasons.add((error as ConnectionPluginError)?.details && (error as any).details.reason || 'archive_cleanup_failed') }
      }
      for (const archive of await this.catalog.allArchives()) {
        this.active(signal)
        const epoch = this.state.epochs[archive.sessionId]
        if (!epoch?.archived || epoch.archivedAt === null || Date.now() < epoch.archivedAt + EXPIRY || this.blocked(archive.sessionId)) continue
        try {
          const prepared = await this.prepare(archive.sessionId, archive, signal), receipt = this.scoped(prepared, archive)
          await this.remove(receipt, `retention-${receipt.ticket}`, signal, 'retention'); deleted++
        } catch (error) { this.active(signal); retained++; reasons.add((error as any)?.details?.reason || 'archive_cleanup_failed') }
      }
      return { deleted, retained, reasons: [...reasons] }
    })
  }
  async dispose(): Promise<void> {
    this.closed = true
    await this.operations.catch(() => {}); await this.writes.catch(() => {})
    this.driver.dispose(); await this.lease?.release(); this.lease = undefined
  }
}

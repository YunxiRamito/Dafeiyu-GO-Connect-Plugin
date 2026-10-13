import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { lstat, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { ConnectionPluginError } from './errors.ts'

type Value = Record<string, any>
export interface ArchiveEpoch { version: string; archivedAt: number | null; archived: boolean }
export interface ArchiveGuards {
  blocked(id: string): boolean
  tombstones(): ReadonlySet<string>
  durableTombstones(): ReadonlySet<string>
  transition(before: string[], after: string[]): Promise<void>
  registryWritten(): Promise<void>
}
export interface ArchiveFile {
  name: string; device: string; inode: string; size: string; modified: string; changed: string; sha256: string
}
export interface ArchiveStorageSnapshot {
  sessionId: string; revision: string; directory: string; device: string; inode: string; header: Value; files: ArchiveFile[]
}
export interface ArchiveRegistryWitness { path: string; file: ArchiveFile }
export function archiveRefusal(reason: string, code: 'conflict' | 'unsupported' | 'permission_denied' | 'protocol_error' = 'conflict'): never {
  throw new ConnectionPluginError(code, `Archived history is retained: ${reason}.`, { details: { reason } })
}
const VERSION = '0.2.1-alpha.1'
// Fixed published first-party modules. No private seam is used on another build.
const PINS: Record<string, string> = {
  'cordis': '6a9394c0877ff45218818c6e815edd038f8057e1a1deb390a8d43ec81c57691e',
  'dsh-agent-loop': '00c4814d63f3d1e2754eb09144832d19b30499d6ea444730473f740b587948c2',
  'dsh-session-persistence-jsonl': '0845707017acc2b4a8a75eab2244fa3fd88587b8094ab32014321dce7ca1e31b',
  'dsh-workspace': 'a33af459cfc7af29dd17412443a63655fd5037dd348b0dec20a413ce60c6c8bc',
  'dsh-session-query': 'dd8056fad008063c7e85169d4306720abe8efa6b32eac98f1b3053c6f89894aa',
  'dsh-session-query-sqlite': 'dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0',
  'dsh-session-projection-cache': 'faf307dce5db2fb7ff58b4c7d9e544fc7cad5de2f270a89326a8d7bb2bda9c80',
  'dsh-session-format': '6c7417ec2cd555e2781197d91c4566c88ffcf2728f362d7a2937859be57226ec',
  'dsh-session': 'b847e7ec736ce4049ec40ea0b20753bad5d7c2388785b4369d2bf00baa32472b',
  'dsh-storage-domain': 'a54f7664d2f64fe04a08c7058ca5bff4fc69ed6a0d30c2bc11561b620698ef16',
  'dsh-storage-json': '0a6b75d5569db3379edd93e863570170e1f4121b6c9fabd856f5b476cffe8df4',
}
const GLOBAL = Symbol.for('dafeiyu-go.fixed-dsh-archive.v1')
// Cordis supplies context-specific service proxies. Canonical identity must be
// the verified native service, otherwise a new proxy bypasses its admission.
const ORIGINAL = Symbol.for('cordis.original')
function canonical<T>(service: T): T { return (service as any)?.[ORIGINAL] ?? service }
interface Extension {
  modules: Record<string, any>; owners: WeakMap<object, () => Promise<void>>; bindings: WeakMap<object, FixedDshArchiveDriver>;
  entries: Readonly<Record<string, string>>;
  witnessedPrototypes: WeakSet<object>;
  bootstrap?: { directory: string; blocked: ReadonlySet<string> };
  rawStat: (this: any, id: string, options?: any) => Promise<any>
  durableMove(source: string, destination: string, replace: boolean): Promise<void>
}
function driverFor(extension: Extension, service: any): FixedDshArchiveDriver | undefined {
  return extension.bindings.get(canonical(service))
}
function admission(driver: FixedDshArchiveDriver | undefined, id: string): void {
  if (isBlocked(driver, id)) archiveRefusal('archive_tombstoned', 'permission_denied')
}
function isBlocked(driver: FixedDshArchiveDriver | undefined, id: string): boolean {
  return driver?.blocked(id) === true || (globalThis as any)[GLOBAL]?.bootstrap?.blocked.has(id) === true
}
async function readBootstrap(directory: string): Promise<{ directory: string; blocked: ReadonlySet<string> }> {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) archiveRefusal('archive_preload_directory_invalid', 'unsupported')
  let stored: any
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) archiveRefusal('archive_preload_directory_invalid', 'unsupported')
    const file = path.join(directory, 'archive-deletion.json'), snapshot = await lstat(file)
    if (!snapshot.isFile() || snapshot.isSymbolicLink() || snapshot.nlink !== 1 || snapshot.size > 8 * 1024 * 1024) archiveRefusal('archive_journal_invalid', 'protocol_error')
    stored = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as any)?.code === 'ENOENT') return { directory, blocked: new Set() }
    throw error
  }
  const { validateArchiveBootstrapJournal } = await import('./remote-archive.ts')
  return { directory, blocked: validateArchiveBootstrapJournal(stored) }
}

/** Install before runCli/Loader: retain the actual owner's disposer rather than inventing Agent.dispose(). */
export async function installFixedDshArchiveExtension(installAnchor: string, options: { archiveDirectory?: string } = {}): Promise<void> {
  if (!path.isAbsolute(installAnchor)) archiveRefusal('archive_install_anchor_invalid', 'unsupported')
  const require = createRequire(installAnchor), modules: Record<string, any> = {}, entries: Record<string, string> = {}
  for (const [name, digest] of Object.entries(PINS)) {
    const key = `@deepseek-ai/${name}`, metadata = require(`${key}/package.json`), entry = require.resolve(key)
    if (metadata.version !== (name === 'cordis' ? '4.0.5-alpha.1' : VERSION) || metadata.license !== 'MIT' ||
      createHash('sha256').update(await readFile(entry)).digest('hex') !== digest) archiveRefusal('archive_runtime_version_unverified', 'unsupported')
    modules[name] = await import(pathToFileURL(entry).href)
    entries[name] = await realpath(entry)
  }
  const global = globalThis as any
  const previous: Extension | undefined = global[GLOBAL]
  if (previous) {
    if (!previous.entries || Object.entries(entries).some(([name, entry]) => previous.entries[name] !== entry || previous.modules[name] !== modules[name]))
      archiveRefusal('archive_multiple_service_realms', 'unsupported')
    if (options.archiveDirectory !== undefined) {
      const bootstrap = await readBootstrap(options.archiveDirectory)
      if (previous.bootstrap && previous.bootstrap.directory !== bootstrap.directory) archiveRefusal('archive_preload_directory_changed', 'unsupported')
      previous.bootstrap = { directory: bootstrap.directory, blocked: new Set([...(previous.bootstrap?.blocked ?? []), ...bootstrap.blocked]) }
    }
    return
  }
  let move: ((from: string, to: string, flags: number) => number) | undefined
  let lastError: (() => number) | undefined
  if (process.platform === 'win32') {
    const koffi = require('koffi')
    if (koffi.version !== '3.1.1') archiveRefusal('archive_native_version_unverified', 'unsupported')
    const native = koffi.load('kernel32.dll')
    move = native.func('int __stdcall MoveFileExW(str16, str16, uint32)')
    lastError = native.func('uint32 __stdcall GetLastError()')
  }
  const extension: Extension = { modules, entries: Object.freeze(entries), owners: new WeakMap(), bindings: new WeakMap(), witnessedPrototypes: new WeakSet(), rawStat: modules['dsh-session-persistence-jsonl'].default.prototype.stat,
    async durableMove(source, destination, replace) {
      if (move) {
        // Node accepts long absolute paths; Win32 needs the extended namespace
        // for the same path (quarantine names deliberately add a stable ticket).
        const namespace = (value: string) => value.startsWith('\\\\?\\') ? value : value.startsWith('\\\\') ? `\\\\?\\UNC\\${value.slice(2)}` : `\\\\?\\${path.resolve(value)}`
        if (!move(namespace(source), namespace(destination), 8 | (replace ? 1 : 0))) archiveRefusal(`archive_durable_move_failed_win32_${lastError!()}`)
      } else {
        if (!replace) {
          try { await lstat(destination); archiveRefusal('archive_quarantine_exists') }
          catch (error) { if ((error as any).code !== 'ENOENT') throw error }
        }
        await rename(source, destination)
        const directory = await open(path.dirname(destination), 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    },
  }
  if (options.archiveDirectory !== undefined) extension.bootstrap = await readBootstrap(options.archiveDirectory)
  const loop = modules['dsh-agent-loop'].AgentLoop.prototype, prepare = loop.prepare
  loop.prepare = function (...args: any[]) {
    if (typeof args[1] === 'string') admission(undefined, args[1])
    const prepared = Reflect.apply(prepare, this, args)
    if (!prepared?.agent || typeof prepared.dispose !== 'function') archiveRefusal('archive_owner_contract_changed', 'unsupported')
    extension.owners.set(canonical(prepared.agent), prepared.dispose)
    return prepared
  }
  const sessions = modules['dsh-session'].SessionStore.prototype
  for (const method of ['prepare', 'enter']) {
    const original = sessions[method]
    sessions[method] = function (...args: any[]) {
      const id = method === 'enter' ? args[0]?.id : args[0]
      if (typeof id === 'string') admission(driverFor(extension, this), id)
      return Reflect.apply(original, this, args)
    }
  }
  const persistence = modules['dsh-session-persistence-jsonl'].default.prototype
  for (const method of ['create', 'open']) {
    const original = persistence[method]
    persistence[method] = async function (...args: any[]) {
      const id = method === 'create' ? args[0].id : args[0], driver = driverFor(extension, this)
      admission(driver, id)
      return driver ? driver.track(id, async () => {
        const handle = await Reflect.apply(original, this, args)
        if (driver.blocked(id)) { await handle.close(); admission(driver, id) }
        return handle
      }) : Reflect.apply(original, this, args)
    }
  }
  const stat = persistence.stat, list = persistence.list
  persistence.stat = async function (id: string, ...args: any[]) {
    const driver = driverFor(extension, this)
    if (isBlocked(driver, id)) return undefined
    const result = await Reflect.apply(stat, this, [id, ...args])
    return isBlocked(driver, id) ? undefined : result
  }
  persistence.list = async function (...args: any[]) {
    const driver = driverFor(extension, this), result = await Reflect.apply(list, this, args)
    return result.filter((snapshot: any) => !isBlocked(driver, snapshot.header.id))
  }
  const query = modules['dsh-session-query'].default.prototype, observe = query.observeSession
  query.observeSession = async function (id: string, ...args: any[]) {
    const driver = driverFor(extension, this)
    admission(driver, id)
    if (!driver) return Reflect.apply(observe, this, [id, ...args])
    return driver.track(id, async () => {
      const observation = await Reflect.apply(observe, this, [id, ...args])
      if (driver.blocked(id)) { observation[Symbol.dispose](); admission(driver, id) }
      return driver.observation(id, observation)
    })
  }
  const cache = modules['dsh-session-projection-cache'].SessionProjectionCache.prototype, put = cache.put
  cache.put = async function (id: string, ...args: any[]) {
    const driver = driverFor(extension, this)
    admission(driver, id)
    return driver ? driver.track(id, () => Reflect.apply(put, this, [id, ...args])) : Reflect.apply(put, this, [id, ...args])
  }
  const workspace = modules['dsh-workspace'].WorkspaceRegistry.prototype, setState = workspace.setState
  workspace.setState = async function (next: Value) {
    const driver = driverFor(extension, this)
    if (driver && !driver.internalRegistryWrite) {
      const before: string[] = this.requireState().archivedSessionIds
      for (const id of before) if (!next.archivedSessionIds.includes(id)) admission(driver, id)
      await driver.transition(before, next.archivedSessionIds)
    }
    return Reflect.apply(setState, this, [next])
  }
  for (const method of ['readSessionHeader', 'sessionKnown']) {
    const original = workspace[method]
    workspace[method] = function (id: string, ...args: any[]) {
      admission(driverFor(extension, this), id)
      return Reflect.apply(original, this, [id, ...args])
    }
  }
  for (const method of ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) {
    const original = workspace[method]
    workspace[method] = async function (id: string, ...args: any[]) {
      admission(driverFor(extension, this), id)
      return Reflect.apply(original, this, [id, ...args])
    }
  }
  global[GLOBAL] = extension
}

/** Launcher assertion only: no imports, prototype mutations, journal writes or recovery. */
export async function assertFixedDshArchivePreload(installAnchor: string, archiveDirectory: string): Promise<void> {
  if (!path.isAbsolute(installAnchor)) archiveRefusal('archive_install_anchor_invalid', 'unsupported')
  const extension: Extension | undefined = (globalThis as any)[GLOBAL]
  if (!extension?.entries || !extension.bootstrap) archiveRefusal('archive_preload_not_ready', 'unsupported')
  if (!path.isAbsolute(archiveDirectory) || path.resolve(archiveDirectory) !== archiveDirectory || extension.bootstrap.directory !== archiveDirectory)
    archiveRefusal('archive_preload_directory_changed', 'unsupported')
  const require = createRequire(installAnchor)
  for (const name of Object.keys(PINS)) {
    let entry: string
    try { entry = await realpath(require.resolve(`@deepseek-ai/${name}`)) }
    catch { archiveRefusal('archive_multiple_service_realms', 'unsupported') }
    if (extension.entries[name] !== entry) archiveRefusal('archive_multiple_service_realms', 'unsupported')
  }
}

function sameSnapshot(first: ArchiveStorageSnapshot, second: ArchiveStorageSnapshot): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}
async function fileSnapshot(file: string, name: string): Promise<ArchiveFile> {
  const before = await lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 8n * 1024n ** 3n) archiveRefusal('archive_artifact_identity_unverified')
  const hash = createHash('sha256')
  const reader = await open(file, 'r')
  try {
    const identity = await reader.stat({ bigint: true })
    if (identity.dev !== before.dev || identity.ino !== before.ino || identity.nlink !== 1n || !identity.isFile()) archiveRefusal('archive_artifact_changed')
    const chunk = Buffer.alloc(256 * 1024)
    while (true) {
      const read = await reader.read(chunk, 0, chunk.length, null)
      if (!read.bytesRead) break
      hash.update(chunk.subarray(0, read.bytesRead))
    }
  } finally { await reader.close() }
  const after = await lstat(file, { bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
    archiveRefusal('archive_artifact_changed')
  return { name, device: String(before.dev), inode: String(before.ino), size: String(before.size),
    modified: String(before.mtimeNs), changed: String(before.ctimeNs), sha256: hash.digest('hex') }
}

/** Fixed first-party adapter; accesses private fields only after exact artifact/version/instance verification. */
export class FixedDshArchiveDriver {
  private readonly extension?: Extension
  private guards?: ArchiveGuards
  private pending = new Map<string, number>()
  private references = new Map<string, number>()
  private intents = new Set<string>()
  private released = false
  private journalDirectory?: string
  private readonly ctx: any
  internalRegistryWrite = false
  constructor(ctx: any) { this.ctx = ctx; this.extension = (globalThis as any)[GLOBAL] }
  private get(key: string): any { return canonical(typeof this.ctx?.get === 'function' ? this.ctx.get(key) : this.ctx?.[key]) }
  available(): boolean {
    const e = this.extension, persistence = this.get('sessionPersistence'), registry = this.get('workspaceRegistry'), query = this.get('sessionQuery'), cache = this.get('sessionProjectionCache')
    return !this.released && !!e && persistence instanceof e.modules['dsh-session-persistence-jsonl'].default &&
      registry instanceof e.modules['dsh-workspace'].WorkspaceRegistry && query instanceof e.modules['dsh-session-query-sqlite'].SqliteSessionQueryEngine &&
      (!cache || cache instanceof e.modules['dsh-session-projection-cache'].SessionProjectionCache) &&
      typeof this.get('sessionController')?.projections === 'function' && typeof this.get('agents')?.get === 'function' &&
      typeof this.get('sessions')?.get === 'function' && typeof this.ctx?.waterfall === 'function' && registry.state !== undefined
  }
  private owningServices(): Set<any> {
    const services = new Set<any>()
    for (const key of ['sessionPersistence', 'workspaceRegistry', 'sessionQuery', 'sessionProjectionCache', 'sessions']) {
      const service = this.get(key)
      if (service) services.add(service)
    }
    const registry = this.get('workspaceRegistry')
    services.add(registry.host); services.add(registry.requireTable().host.unit)
    return services
  }
  /** Validate before any save, including a missing journal on plugin reload. */
  assertJournalTombstones(blocked: (id: string) => boolean): void {
    if (!this.available()) archiveRefusal('archive_service_composition_unverified', 'unsupported')
    for (const id of this.extension!.bootstrap?.blocked ?? []) if (!blocked(id)) archiveRefusal('archive_journal_tombstone_missing', 'unsupported')
    for (const service of this.owningServices()) {
      const existing = this.extension!.bindings.get(service)
      if (!existing || existing === this) continue
      if (!existing.released) archiveRefusal('archive_duplicate_host', 'unsupported')
      if (!this.journalDirectory || existing.journalDirectory !== this.journalDirectory) archiveRefusal('archive_journal_directory_changed', 'unsupported')
      for (const id of existing.guards?.durableTombstones() ?? []) if (!blocked(id)) archiveRefusal('archive_journal_tombstone_missing', 'unsupported')
    }
  }
  bind(guards: ArchiveGuards): void {
    this.assertJournalTombstones(id => guards.blocked(id))
    const services = this.owningServices()
    // Account mutations run inside the actual table write chain. Never let a
    // delayed attach restore a tombstoned id after the deletion transaction.
    const registry = this.get('workspaceRegistry'), host = registry.host
    services.add(host)
    // The pinned native JSON unit atomically replaces its durable document on
    // every actual registry write. Preserve its physical revision, including
    // unrelated table writes, so unobserved restore/rearchive across a disabled
    // plugin or crash cannot inherit an old automatic deletion deadline.
    const unit = registry.requireTable().host.unit, prototype = Object.getPrototypeOf(unit), extension = this.extension!
    services.add(unit)
    // A released plugin's owning native services still retain every tombstone.
    // The whole replacement was validated before changing any service binding.
    this.guards = guards
    for (const service of services) extension.bindings.set(service, this)
    if (!extension.witnessedPrototypes.has(prototype)) {
      for (const method of ['setGlobal', 'putRecord', 'deleteRecord']) {
        const original = prototype[method]
        if (typeof original !== 'function') archiveRefusal('archive_registry_medium_unverified', 'unsupported')
        prototype[method] = async function (...args: any[]) {
          const value = await Reflect.apply(original, this, args)
          await driverFor(extension, this)?.registryWritten()
          return value
        }
      }
      extension.witnessedPrototypes.add(prototype)
    }
    const wrapEntities = () => {
      for (const entity of registry.list()) {
        const prototype = Object.getPrototypeOf(entity)
        if (Object.hasOwn(prototype, '__dafeiyuArchiveMutation')) continue
        const mutate = prototype.mutate, extension = this.extension!
        prototype.mutate = function (fn: (record: Value) => Value) {
          return Reflect.apply(mutate, this, [(record: Value) => {
            const next = fn(record), driver = extension.bindings.get(this.host)
            for (const id of next.sessionIds) admission(driver, id)
            return next
          }])
        }
        Object.defineProperty(prototype, '__dafeiyuArchiveMutation', { value: true })
      }
    }
    wrapEntities()
    const rebuild = registry.rebuildEntities.bind(registry)
    registry.rebuildEntities = () => { rebuild(); wrapEntities() }
    const create = registry.create.bind(registry)
    registry.create = async (...args: any[]) => { const result = await create(...args); wrapEntities(); return result }
  }
  blocked(id: string): boolean { return this.intents.has(id) || this.guards?.blocked(id) === true }
  transition(before: string[], after: string[]): Promise<void> { return this.guards?.transition(before, after) ?? Promise.resolve() }
  registryWritten(): Promise<void> { return this.guards?.registryWritten() ?? Promise.resolve() }
  async registryWitness(): Promise<ArchiveRegistryWitness> {
    const registry = this.get('workspaceRegistry'), domain = this.get('storageDomain')?.get('workspace'), unit = registry?.requireTable().host.unit
    const routing = this.get('storageDomain')?.config, name = routing?.routes?.workspace ?? routing?.backend
    const backend = typeof name === 'string' ? this.get('storage')?.backend.get(name) : undefined
    if (!unit || domain?.unit !== unit || backend?.open?.get('workspace') !== unit || typeof backend.root !== 'string' || !path.isAbsolute(backend.root) ||
      unit.descriptor?.name !== 'workspace' || (unit.descriptor.layout ?? 'single') !== 'single' || unit.path !== path.join(backend.root, 'workspace.json'))
      archiveRefusal('archive_registry_medium_unverified', 'unsupported')
    const canonicalRoot = await realpath(backend.root)
    if (await realpath(unit.path) !== path.join(canonicalRoot, 'workspace.json')) archiveRefusal('archive_registry_medium_unverified', 'unsupported')
    return { path: path.join(canonicalRoot, 'workspace.json'), file: await fileSnapshot(unit.path, 'workspace.json') }
  }
  async track<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1)
    try { return await work() }
    finally { const remaining = this.pending.get(id)! - 1; if (remaining) this.pending.set(id, remaining); else this.pending.delete(id) }
  }
  observation(id: string, observation: any): any {
    this.references.set(id, (this.references.get(id) ?? 0) + 1)
    let disposed = false
    return new Proxy(observation, { get: (target, key, receiver) => {
      if (key === Symbol.dispose) return () => {
        if (disposed) return
        disposed = true; target[Symbol.dispose]()
        const remaining = this.references.get(id)! - 1
        if (remaining) this.references.set(id, remaining); else this.references.delete(id)
      }
      if (key === 'retain') return () => { if (disposed) archiveRefusal('archive_observation_disposed'); admission(this, id); return this.observation(id, target.retain()) }
      return Reflect.get(target, key, receiver)
    } })
  }
  async durableMove(from: string, to: string, replace = false): Promise<void> { await this.extension!.durableMove(from, to, replace) }
  async journalLease(directory: string): Promise<{ release(): Promise<void> }> {
    if (!this.available()) archiveRefusal('archive_service_composition_unverified', 'unsupported')
    if (this.extension!.bootstrap && this.extension!.bootstrap.directory !== directory) archiveRefusal('archive_preload_directory_changed', 'unsupported')
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || await realpath(directory) !== directory)
      archiveRefusal('archive_journal_directory_invalid', 'unsupported')
    const lease = await this.get('sessionPersistence').acquireLease('dafeiyu-remote-archive-journal', undefined, directory)
    this.journalDirectory = directory
    return lease
  }
  assertActive(signal: AbortSignal): void { if (signal.aborted) throw new ConnectionPluginError('request_cancelled', 'Archive operation cancelled.') }
  private async idle(id: string, signal: AbortSignal): Promise<void> {
    this.assertActive(signal)
    if (!this.get('workspaceRegistry').archivedSessionIds.includes(id)) archiveRefusal('archive_not_current')
    const projection = await this.get('sessionController').projections({ sessionId: id }, signal), inbox = projection?.values?.inbox
    if (!inbox || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) archiveRefusal('archive_queue_state_unknown')
    if (inbox['next-turn'].length || inbox['next-step'].length || this.get('agents').get(id)?.status === 'running') archiveRefusal('archive_task_not_idle')
    const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
    if (!Array.isArray(activity) || activity.length) archiveRefusal('archive_activity_not_idle')
    const agents = this.get('agents').list()
    if (!Array.isArray(agents) || agents.length > 4000) archiveRefusal('archive_descendant_lineage_unknown')
    const registry = this.get('workspaceRegistry'), ancestors = new Map<string, Value>(registry.headers)
    for (const agent of agents) ancestors.set(agent.session.header.id, agent.session.header)
    for (const agent of agents) {
      const header = agent.session.header
      if (header.id === id || header.origin !== 'subagent') continue
      const seen = new Set<string>([header.id])
      let parent = header.parentSession
      for (let depth = 0; parent !== undefined; depth++) {
        if (parent === id) archiveRefusal('archive_descendant_owner_present')
        if (depth >= 64 || typeof parent !== 'string' || !parent || seen.has(parent)) archiveRefusal('archive_descendant_lineage_unknown')
        seen.add(parent)
        let ancestor = ancestors.get(parent)
        if (!ancestor) {
          ancestor = (await Reflect.apply(this.extension!.rawStat, this.get('sessionPersistence'), [parent, { signal }]))?.header
          if (ancestor) ancestors.set(parent, ancestor)
        }
        if (!ancestor) archiveRefusal('archive_descendant_lineage_unknown')
        parent = ancestor.parentSession
      }
    }
  }
  private async snapshot(id: string, signal: AbortSignal): Promise<ArchiveStorageSnapshot> {
    const persistence = this.get('sessionPersistence'), stored = await Reflect.apply(this.extension!.rawStat, persistence, [id, { signal }])
    if (!stored || stored.header.id !== id || stored.header.version !== 4) archiveRefusal('archive_generation_unsupported')
    const current = await persistence.resolveCurrentLog(id, signal)
    if (typeof current !== 'string' || !path.isAbsolute(current)) archiveRefusal('archive_current_generation_missing')
    const directory = path.dirname(current), root = await realpath(persistence.config.root), relative = path.relative(root, directory)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || await realpath(directory) !== directory) archiveRefusal('archive_storage_path_unverified')
    const info = await lstat(directory, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) archiveRefusal('archive_storage_path_unverified')
    const files: ArchiveFile[] = [], entries = await readdir(directory)
    if (entries.length > 32) archiveRefusal('archive_artifact_set_unverified')
    for (const name of entries.sort()) {
      if (name === 'session.lock') continue
      const plain = name.endsWith('.zstd') ? name.slice(0, -5) : name
      const generation = this.extension!.modules['dsh-session-format'].parseSessionFormatLogFilename(plain)
      if (generation === undefined || generation > 4 || name.endsWith('.zstd') !== (persistence.config.compression !== 'none')) archiveRefusal('archive_artifact_set_unverified')
      files.push(await fileSnapshot(path.join(directory, name), name))
    }
    if (!files.length) archiveRefusal('archive_artifact_set_unverified')
    return { sessionId: id, revision: stored.revision, directory, device: String(info.dev), inode: String(info.ino), header: stored.header, files }
  }
  async inspect(id: string, signal: AbortSignal): Promise<ArchiveStorageSnapshot> {
    if (!this.available()) archiveRefusal('archive_service_composition_unverified', 'unsupported')
    await this.idle(id, signal)
    await this.get('sessionPersistence').flush()
    return this.snapshot(id, signal)
  }
  async registryTransaction<T>(work: () => Promise<T>): Promise<T> {
    if (!this.available()) archiveRefusal('archive_service_composition_unverified', 'unsupported')
    return this.get('workspaceRegistry').enqueueOperation(work)
  }
  private quiet(id: string): void {
    if (this.pending.has(id) || this.references.has(id) || this.get('sessionPersistence').migrationPreparations.has(id)) archiveRefusal('archive_reader_or_migration_active')
    const entry = this.get('sessionQuery')._observations.cache.get(id)
    if (entry?.refs > 0) archiveRefusal('archive_observation_active')
  }
  async withOwnership<T>(snapshot: ArchiveStorageSnapshot, signal: AbortSignal, recovery: boolean, work: () => Promise<T>): Promise<T> {
    const id = snapshot.sessionId, persistence = this.get('sessionPersistence')
    if (this.intents.has(id)) archiveRefusal('archive_operation_in_progress')
    if (!recovery) await this.idle(id, signal)
    this.intents.add(id)
    let claimed = false, lease: any
    try {
      this.quiet(id)
      const agent = this.get('agents').get(id), live = this.get('sessions').get(id)
      if (agent) {
        const dispose = this.extension!.owners.get(canonical(agent))
        if (!dispose || agent.status === 'running') archiveRefusal('archive_owner_unavailable')
        await dispose()
      } else if (live) archiveRefusal('archive_session_owner_unavailable')
      if (this.get('agents').get(id) || this.get('sessions').get(id)) archiveRefusal('archive_owner_not_released')
      this.quiet(id)
      if (persistence.tracker.hasPending(id) || [...persistence.tracker.openHandles].some((handle: any) => handle.id === id)) archiveRefusal('archive_backend_handle_active')
      persistence.tracker.claimWrite(id); claimed = true
      if (snapshot.header.id !== id || snapshot.header.version !== 4 || path.relative(path.dirname(persistence.locate(snapshot.header).path), snapshot.directory) !== '')
        archiveRefusal('archive_receipt_path_invalid', 'protocol_error')
      const directory = await lstat(snapshot.directory, { bigint: true })
      if (!directory.isDirectory() || directory.isSymbolicLink() || String(directory.dev) !== snapshot.device || String(directory.ino) !== snapshot.inode || await realpath(snapshot.directory) !== snapshot.directory)
        archiveRefusal('archive_directory_changed')
      lease = await persistence.acquireLease(id, undefined, snapshot.directory)
      if (!recovery && !sameSnapshot(snapshot, await this.snapshot(id, signal))) archiveRefusal('archive_storage_changed_after_confirmation')
      this.assertActive(signal)
      return await work()
    } catch (error) {
      if ((error as any)?.name === 'SessionAlreadyOwnedError') archiveRefusal('archive_writer_held')
      throw error
    } finally {
      try { await lease?.release() } finally { if (claimed) persistence.tracker.releaseClaim(id); this.intents.delete(id) }
    }
  }
  async detachIndex(id: string): Promise<void> {
    const registry = this.get('workspaceRegistry'), table = registry.requireTable()
    for (const [workspaceId, record] of table.entries()) if (record.sessionIds.includes(id)) {
      await table.update(workspaceId, (current: Value) => ({ ...current, sessionIds: current.sessionIds.filter((value: string) => value !== id), updatedAt: new Date().toISOString() }))
    }
    this.internalRegistryWrite = true
    try {
      const state = registry.requireState()
      await registry.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter((value: string) => value !== id), pinnedSessionIds: state.pinnedSessionIds.filter((value: string) => value !== id) })
    } finally { this.internalRegistryWrite = false }
    registry.headers.delete(id); registry.sessionPaths.delete(id); registry.invalidSessionPaths.delete(id); registry.rebuildEntities()
    if (registry.archivedSessionIds.includes(id) || registry.pinnedSessionIds.includes(id) || registry.list().some((workspace: any) => workspace.sessionIds.includes(id))) archiveRefusal('archive_index_commit_unconfirmed')
  }
  async deleteFiles(snapshot: ArchiveStorageSnapshot, deletionId: string, signal: AbortSignal): Promise<void> {
    const allowed = new Set(snapshot.files.flatMap(file => [file.name, `.dafeiyu-delete-${deletionId}-${file.name}`]).concat('session.lock'))
    if ((await readdir(snapshot.directory)).some(name => !allowed.has(name))) archiveRefusal('archive_artifact_set_changed')
    for (const file of snapshot.files) {
      this.assertActive(signal)
      const source = path.join(snapshot.directory, file.name), quarantined = path.join(snapshot.directory, `.dafeiyu-delete-${deletionId}-${file.name}`)
      let original: ArchiveFile | undefined
      try { original = await fileSnapshot(source, file.name) } catch (error) { if ((error as any).code !== 'ENOENT') throw error }
      if (original) {
        if (JSON.stringify(original) !== JSON.stringify(file)) archiveRefusal('archive_artifact_changed')
        await this.durableMove(source, quarantined)
      }
      let retained: ArchiveFile | undefined
      try { retained = await fileSnapshot(quarantined, file.name) } catch (error) { if ((error as any).code !== 'ENOENT') throw error }
      if (retained) {
        // Rename changes ctime; all stable identity/content fields still match.
        if (retained.device !== file.device || retained.inode !== file.inode || retained.size !== file.size || retained.modified !== file.modified || retained.sha256 !== file.sha256) archiveRefusal('archive_quarantine_changed')
        await unlink(quarantined)
      }
    }
    if (process.platform !== 'win32') { const directory = await open(snapshot.directory, 'r'); try { await directory.sync() } finally { await directory.close() } }
    // Keep the directory AND stable POSIX session.lock inode. Removing either
    // would allow a new writer to acquire an unrelated lock while ours is held.
  }
  async purgeCaches(id: string, signal: AbortSignal): Promise<void> {
    this.quiet(id)
    const persistence = this.get('sessionPersistence'), query = this.get('sessionQuery'), cache = this.get('sessionProjectionCache')
    persistence.coldLogMemo.delete(id); query._observations.cache.delete(id)
    if (cache) {
      for (const [session, state] of cache.dirty) if (session.id === id) { if (state.timer) clearTimeout(state.timer); cache.dirty.delete(session) }
      await cache.requireTable().delete(id)
    }
    if (query._db) await query._serialized(signal, () => query._reconcile(signal))
    if (await Reflect.apply(this.extension!.rawStat, persistence, [id, { signal }]) !== undefined) archiveRefusal('archive_storage_delete_unconfirmed')
    if (typeof this.ctx?.emit === 'function') this.ctx.emit('api-session/removed', id)
  }
  dispose(): void {
    if (!this.extension) return
    this.released = true
    // Keep immutable tombstone admission on the actual owning services when
    // only the Connect plugin is unloaded. A new verified manager can replace
    // this released binding after it reloads the same durable journal. Epoch
    // observation pauses; the native document witness makes it unknown later.
    const retained = this.guards?.tombstones()
    const tombstones = retained && new Set(retained)
    const durable = new Set(this.guards?.durableTombstones() ?? [])
    this.guards = tombstones ? { blocked: id => tombstones.has(id), tombstones: () => tombstones, durableTombstones: () => durable,
      transition: async () => {}, registryWritten: async () => {} } : undefined
    const unit = this.get('workspaceRegistry')?.table?.host?.unit
    if (unit && this.extension.bindings.get(unit) === this) this.extension.bindings.delete(unit)
  }
}

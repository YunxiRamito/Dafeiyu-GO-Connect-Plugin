import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, readdir, rm, writeFile, stat, utimes, link, copyFile } from 'node:fs/promises'
import { FixedDshArchiveDriver, installFixedDshArchiveExtension } from '../../src/framework/remote-archive-dsh.ts'
import { RemoteArchiveDeletion, type ArchiveScope, type ScopedArchive } from '../../src/framework/remote-archive.ts'
import { RemoteWorkspaceLifecycle } from '../../src/framework/remote-workspaces.ts'

const root = 'G:/DeepSeek DSH/DSH Works/Project/Dafeiyu-Go/Temp_Android/qa/remote-archive-tests'
const anchor = process.env.DAFEIYU_ARCHIVE_TEST_ANCHOR ?? 'G:/DeepSeek DSH/package.json'
const require = createRequire(anchor)
const load = (name: string) => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
await installFixedDshArchiveExtension(anchor)
const [{ Context, Service }, { default: Storage }, JsonStorage, Domains, { SessionStore }, { default: Persistence }, { WorkspaceRegistry },
  { SqliteSessionQueryEngine }, { SessionProjectionRegistry }, { AgentRegistry }, { AgentLoop }, { default: Tools }, { default: SystemPrompt }, { default: Llm }, { SessionController }, { TypertRegistry }, { SessionProjectionCache }] =
  await Promise.all(['cordis', 'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-session', 'dsh-session-persistence-jsonl', 'dsh-workspace',
    'dsh-session-query-sqlite', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-tools', 'dsh-system-prompt', 'dsh-llm', 'dsh-api-session-controller', 'dsh-typert-registry', 'dsh-session-projection-cache'].map(load))
const scope: ArchiveScope = { group: 'isolated-group', peer: 'isolated-phone' }
const signal = () => new AbortController().signal
type Value = Record<string, any>
async function fixture(t: any) {
  const directory = path.join(root, randomUUID()), workspace = path.join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  const ctx = new Context()
  let manager: RemoteArchiveDeletion | undefined
  t.after(async () => {
    await manager?.dispose(); await ctx.fiber.dispose()
    assert.equal(path.dirname(directory), path.normalize(root)); await rm(directory, { recursive: true, force: true })
  })
  new Storage(ctx); JsonStorage.apply(ctx, { root: path.join(directory, 'domains') }); await Domains.apply(ctx, { backend: 'json' })
  new SessionStore(ctx); const persistence = new Persistence(ctx, { root: path.join(directory, 'sessions'), compression: 'none' })
  const registry = new WorkspaceRegistry(ctx); await registry[Service.init]()
  new SessionProjectionRegistry(ctx); new AgentRegistry(ctx); new SystemPrompt(ctx, {}); new Tools(ctx); new Llm(ctx)
  const cache = new SessionProjectionCache(ctx, { writeEveryEvents: 100, writeIntervalMs: 60_000 }); await cache[Service.init]()
  const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 10 })
  const query = new SqliteSessionQueryEngine(ctx, { path: path.join(directory, 'derived.sqlite'), openAt: 'startup' }); await query[Service.init]()
  new TypertRegistry(ctx)
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} })
  const controller = new SessionController(ctx, {})
  const work = await registry.create(workspace, 'Original workspace')
  const archives: ScopedArchive[] = []
  let catalogTail = Promise.resolve(), commits = 0, failCommit = false
  const catalog = {
    withArchive<T>(context: ArchiveScope, id: string, body: (archive: ScopedArchive | undefined, commit: () => Promise<void>) => Promise<T>): Promise<T> {
      const run = catalogTail.catch(() => {}).then(() => body(archives.find(value => value.sessionId === id && value.group === context.group && value.peer === context.peer), async () => {
        if (failCommit) throw new Error('synthetic-catalog-write-failure')
        const index = archives.findIndex(value => value.sessionId === id && value.group === context.group && value.peer === context.peer)
        if (index >= 0) archives.splice(index, 1)
        commits++
      }))
      catalogTail = run.then(() => {}, () => {}); return run
    },
    async allArchives() { return structuredClone(archives) },
  }
  let driver = new FixedDshArchiveDriver(ctx)
  manager = new RemoteArchiveDeletion(driver, catalog, path.join(directory, 'journal'))
  await manager.ready
  async function session(id = 'session-a', live = false, archived = true) {
    let agent: any
    if (live) agent = (await loop.createAgent(ctx, { sessionId: id, meta: { cwd: workspace } })).agent
    else {
      const prepared = ctx.sessions.prepare(id, { meta: { cwd: workspace } }), handle = await persistence.create(prepared.header)
      await handle.flush(); await handle.close()
    }
    await work.attachSession(id)
    if (archived) await registry.archiveSession(id)
    const entry = { ...scope, sessionId: id, order: 0, archivedAt: Date.now(), workspace: { workspaceId: work.id, title: work.title, path: work.path, sessionIds: [...work.sessionIds] } }
    archives.push(entry)
    return { agent, entry, log: await persistence.resolveCurrentLog(id) }
  }
  const execute = (operation: string, payload: Value, context = scope, aborted = signal()) => manager!.execute(operation, payload, randomUUID(), aborted, context) as Promise<any>
  async function restartManager(unobserved?: () => Promise<void>) {
    await manager!.dispose(); await unobserved?.()
    driver = new FixedDshArchiveDriver(ctx); manager = new RemoteArchiveDeletion(driver, catalog, path.join(directory, 'journal')); await manager.ready
  }
  return { ctx, persistence, registry, query, cache, controller, loop, work, archives, catalog, get manager() { return manager! }, get driver() { return driver }, directory, session, execute, restartManager,
    commits: () => commits, setFailCommit(value: boolean) { failCommit = value } }
}

test('fixed native persistence and registry remove real generations and derived index only after explicit scoped confirmation', async t => {
  const f = await fixture(t), stored = await f.session()
  await f.query.searchSessions({ query: 'synthetic' })
  assert.equal(f.query._db.prepare('SELECT COUNT(*) AS count FROM persisted_sessions WHERE id = ?').get('session-a').count, 1)
  const confirmed = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  assert.equal(confirmed.executionDevice, 'remote_computer'); assert.equal(confirmed.status, 'prepared')
  assert.ok((await stat(stored.log)).isFile()); assert.ok(f.registry.archivedSessionIds.includes('session-a'))
  await assert.rejects(f.execute('session.archived.delete', { ticket: confirmed.ticket, confirmDelete: true }, { ...scope, peer: 'foreign-phone' }), { code: 'permission_denied' })
  await assert.rejects(f.execute('session.archived.delete', { ticket: confirmed.ticket }), { code: 'permission_denied' })
  const removed = await f.execute('session.archived.delete', { ticket: confirmed.ticket, confirmDelete: true })
  assert.equal(removed.deleted, true); assert.equal(f.commits(), 1); assert.equal(await f.persistence.stat('session-a'), undefined)
  assert.ok(!f.registry.archivedSessionIds.includes('session-a')); assert.ok(!f.registry.get(f.work.id).sessionIds.includes('session-a'))
  assert.equal(f.query._db.prepare('SELECT COUNT(*) AS count FROM persisted_sessions WHERE id = ?').get('session-a').count, 0)
  assert.equal(f.query._observations.cache.has('session-a'), false)
  assert.equal(f.persistence.coldLogMemo.has('session-a'), false)
  assert.deepEqual((await readdir(path.dirname(stored.log))).filter(value => value !== 'session.lock'), [])
  assert.equal((await f.execute('session.archived.delete', { ticket: confirmed.ticket, confirmDelete: true })).deleted, true)
  await assert.rejects(f.registry.unarchiveSession('session-a'), /archive_tombstoned/)
})

test('a retained actual observation lease or kernel writer keeps real history intact', async t => {
  const f = await fixture(t), stored = await f.session()
  const prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  const observation = await f.query.observeSession('session-a')
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /archive_reader_or_migration_active/)
  assert.ok((await stat(stored.log)).isFile()); observation[Symbol.dispose]()
  const lease = await f.persistence.acquireLease('session-a', undefined, path.dirname(stored.log))
  try { await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /archive_writer_held/) }
  finally { await lease.release() }
  assert.ok((await stat(stored.log)).isFile()); assert.equal(f.commits(), 0)
  assert.equal((await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
})

test('local restore and rearchive invalidate the previous confirmation and restart the actual retention epoch', async t => {
  const f = await fixture(t), stored = await f.session()
  const prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' }), old = f.manager.retention('session-a')
  await f.registry.unarchiveSession('session-a'); await f.registry.archiveSession('session-a')
  assert.notEqual(f.manager.retention('session-a').archiveVersion, old.archiveVersion)
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /archive_changed_after_confirmation/)
  assert.ok((await stat(stored.log)).isFile()); assert.equal(f.commits(), 0)
})

test('a real captured AgentHandle drains the owner, scope, SessionStore and JSONL lease without running a model', async t => {
  const f = await fixture(t), stored = await f.session('session-live', true)
  await f.cache.write(stored.agent.session)
  assert.ok(f.cache.requireTable().get('session-live'))
  assert.equal(f.ctx.agents.get('session-live'), stored.agent); assert.equal(f.ctx.sessions.get('session-live'), stored.agent.session)
  const prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-live' })
  const result = await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })
  assert.equal(result.deleted, true); assert.equal(f.ctx.agents.get('session-live'), undefined); assert.equal(f.ctx.sessions.get('session-live'), undefined)
  assert.equal(f.persistence.tracker.writers.has('session-live'), false)
  assert.equal(f.cache.requireTable().get('session-live'), undefined)
})

test('partial durable deletion retries its exact tombstone rather than restoring or repeating work', async t => {
  const f = await fixture(t), stored = await f.session()
  const prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  f.setFailCommit(true)
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /synthetic-catalog-write-failure/)
  const journal = JSON.parse(await readFile(path.join(f.directory, 'journal', 'archive-deletion.json'), 'utf8'))
  assert.equal(journal.receipts[0].phase, 'files'); assert.equal(await f.persistence.stat('session-a'), undefined)
  await assert.rejects(f.registry.unarchiveSession('session-a'), /archive_tombstoned/)
  await assert.rejects(stat(stored.log), { code: 'ENOENT' })
  f.setFailCommit(false)
  assert.equal((await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
  assert.equal(f.commits(), 1)
})

test('modified real artifact or unexpected session-local file refuses confirmation and retains both files', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  await writeFile(path.join(path.dirname(stored.log), 'user-file.txt'), 'retain')
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /archive_artifact_set_unverified/)
  assert.ok((await stat(stored.log)).isFile()); assert.equal(await readFile(path.join(path.dirname(stored.log), 'user-file.txt'), 'utf8'), 'retain')
  assert.equal(f.commits(), 0)
})

test('an actual writer in another native Node process refuses deletion and releases its kernel lease on close', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  const child = fork(fileURLToPath(new URL('./fixtures/archive-lock-holder.mjs', import.meta.url)), [anchor, path.join(f.directory, 'sessions'), 'session-a'],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let childError = ''
  child.stderr?.on('data', chunk => { childError += String(chunk).slice(0, 4096) })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const wait = (wanted: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`foreign-writer-${wanted}-timeout:${childError}`)), 10_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('message', value => { clearTimeout(timer); value === wanted ? resolve() : reject(new Error(`foreign-writer-${String(value)}`)) })
  })
  await wait('owned')
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /archive_writer_held/)
  assert.ok((await stat(stored.log)).isFile()); assert.equal(f.commits(), 0)
  const released = wait('released'); child.send('release'); await released
  assert.equal((await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
})

test('durable tombstone and exact file snapshot recover after a fresh manager reads the journal', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  f.setFailCommit(true)
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /synthetic-catalog-write-failure/)
  await f.restartManager(); f.setFailCommit(false)
  assert.equal(f.manager.blocked('session-a'), true)
  await assert.rejects(f.registry.unarchiveSession('session-a'), /archive_tombstoned/)
  assert.equal((await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
  await assert.rejects(stat(stored.log), { code: 'ENOENT' }); assert.equal(f.commits(), 1)
})

test('known retention survives an unchanged native registry while disabled restore/rearchive downgrades to unknown', async t => {
  const f = await fixture(t), stored = await f.session()
  const known = f.manager.retention('session-a')
  assert.ok(known.archivedAt !== null); await f.restartManager()
  assert.deepEqual(f.manager.retention('session-a'), known)
  const prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  await f.restartManager(async () => { await f.registry.unarchiveSession('session-a'); await f.registry.archiveSession('session-a') })
  const unknown = f.manager.retention('session-a')
  assert.equal(unknown.archivedAt, null); assert.equal(unknown.remainingDays, null); assert.notEqual(unknown.archiveVersion, known.archiveVersion)
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /archive_changed_after_confirmation/)
  assert.equal((await f.manager.sweep(signal())).deleted, 0); assert.ok((await stat(stored.log)).isFile())
})

test('trusted native archive epoch triggers thirty-day retention while a legacy catalogue timestamp cannot', async t => {
  const f = await fixture(t), currentTime = Date.now
  try {
    const syntheticNow = currentTime()
    Date.now = () => syntheticNow - 31 * 86_400_000
    const due = await f.session('session-due')
    Date.now = currentTime
    const legacy = await f.session('session-legacy')
    // A legacy entry has an old caller-visible timestamp; delete the observer
    // epoch exactly as a journal from before the archive extension would.
    await f.manager.dispose()
    const file = path.join(f.directory, 'journal', 'archive-deletion.json'), journal = JSON.parse(await readFile(file, 'utf8'))
    delete journal.epochs['session-legacy']; journal.receipts = []
    await writeFile(file, JSON.stringify(journal))
    f.archives.find(value => value.sessionId === 'session-legacy')!.archivedAt = syntheticNow - 100 * 86_400_000
    await f.restartManager()
    assert.equal(f.manager.retention('session-legacy').archivedAt, null)
    const result = await f.manager.sweep(signal())
    assert.equal(result.deleted, 1); await assert.rejects(stat(due.log), { code: 'ENOENT' })
    assert.ok((await stat(legacy.log)).isFile()); assert.equal(f.commits(), 1)
  } finally { Date.now = currentTime }
})

test('same-size real content rewrite or hard-linked generation refuses the old confirmation without unlinking', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  const content = await readFile(stored.log), changed = Buffer.from(content)
  const offset = changed.indexOf(Buffer.from('session-a')); assert.ok(offset >= 0); changed[offset] = changed[offset] === 115 ? 116 : 115
  const old = await stat(stored.log)
  await writeFile(stored.log, changed); await utimes(stored.log, old.atime, old.mtime)
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }))
  assert.deepEqual(await readFile(stored.log), changed); assert.equal(f.commits(), 0)
  await writeFile(stored.log, content)
  const sibling = path.join(f.directory, 'linked-log'); await link(stored.log, sibling)
  await assert.rejects(f.execute('session.archived.delete.prepare', { sessionId: 'session-a' }), /archive_artifact_identity_unverified/)
  assert.deepEqual(await readFile(sibling), content); assert.ok((await stat(stored.log)).isFile())
})

test('a journal fsync/publish failure latches deletion off and preserves the physical generation', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  const move = f.driver.durableMove.bind(f.driver)
  f.driver.durableMove = async (source, destination, replace) => {
    if (path.basename(destination) === 'archive-deletion.json') throw new Error('synthetic-journal-publish-failure')
    return move(source, destination, replace)
  }
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /synthetic-journal-publish-failure/)
  assert.equal(f.manager.available(), false); assert.ok((await stat(stored.log)).isFile())
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /archive_delete_unavailable/)
  f.driver.durableMove = move
  await f.restartManager()
  assert.equal(f.manager.blocked('session-a'), false); assert.ok((await stat(stored.log)).isFile())
})

test('actual native lifecycle commits delete into every removal snapshot so workspace restore cannot resurrect a deleted history', async t => {
  const f = await fixture(t); await f.manager.dispose()
  const directory = path.join(f.directory, 'journal')
  let lifecycle = new RemoteWorkspaceLifecycle(f.ctx, { directory, archiveDeletion: true }); await lifecycle.ready
  t.after(() => lifecycle.dispose())
  const execute = (operation: string, payload: Value) => lifecycle.execute(operation, payload, randomUUID(), signal(), scope) as Promise<any>
  assert.equal(lifecycle.archiveDeletionAvailable(), true)
  const first = await f.session('session-first', false, false), second = await f.session('session-second', false, false)
  const removed = await execute('workspace.remove.prepare', { workspaceId: f.work.id })
  assert.equal((await execute('workspace.remove', { ticket: removed.ticket })).phase, 'removed')
  const prepared = await execute('session.archived.delete.prepare', { sessionId: 'session-first' })
  assert.equal((await execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
  const journal = JSON.parse(await readFile(path.join(directory, 'workspace-lifecycle.json'), 'utf8'))
  assert.deepEqual(journal.removals[0].workspace.sessionIds, ['session-second'])
  assert.ok(journal.archives.every((value: any) => value.sessionId !== 'session-first' && !value.workspace?.sessionIds.includes('session-first')))
  await lifecycle.dispose(); lifecycle = new RemoteWorkspaceLifecycle(f.ctx, { directory, archiveDeletion: true }); await lifecycle.ready
  await assert.rejects(f.persistence.open('session-first'), /archive_tombstoned/)
  const restored = await execute('workspace.removed.restore', { ticket: removed.ticket })
  assert.equal(restored.status, 'restored'); assert.deepEqual(restored.workspace.sessionIds, ['session-second'])
  assert.ok((await stat(second.log)).isFile()); await assert.rejects(stat(first.log), { code: 'ENOENT' })
  assert.deepEqual((await execute('session.archived.list', {})).archives, [])
})

test('native restore and permanent deletion share catalogue admission and cannot both commit for one archive epoch', async t => {
  const f = await fixture(t); await f.manager.dispose()
  const lifecycle = new RemoteWorkspaceLifecycle(f.ctx, { directory: path.join(f.directory, 'journal'), archiveDeletion: true }); await lifecycle.ready
  t.after(() => lifecycle.dispose())
  const stored = await f.session('session-race', false, false)
  const execute = (operation: string, payload: Value) => lifecycle.execute(operation, payload, randomUUID(), signal(), scope) as Promise<any>
  await execute('session.archive', { sessionId: 'session-race' })
  const prepared = await execute('session.archived.delete.prepare', { sessionId: 'session-race' })
  const [deletion, restore] = await Promise.allSettled([
    execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), execute('session.restore', { sessionId: 'session-race' }),
  ])
  assert.equal([deletion, restore].filter(value => value.status === 'fulfilled').length, 1)
  if (deletion.status === 'fulfilled') { assert.equal(deletion.value.deleted, true); await assert.rejects(stat(stored.log), { code: 'ENOENT' }) }
  else { assert.equal(restore.status, 'fulfilled'); assert.ok((await stat(stored.log)).isFile()); assert.ok(!f.registry.archivedSessionIds.includes('session-race')) }
})

test('real native index completion before an injected journal boundary failure retains files and resumes the original tombstone', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  const detach = f.driver.detachIndex.bind(f.driver)
  f.driver.detachIndex = async id => { await detach(id); throw new Error('synthetic-index-boundary-crash') }
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /synthetic-index-boundary-crash/)
  assert.ok((await stat(stored.log)).isFile()); assert.ok(!f.registry.archivedSessionIds.includes('session-a'))
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'journal', 'archive-deletion.json'), 'utf8')).receipts[0].phase, 'tombstoned')
  await f.restartManager()
  assert.equal((await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
  await assert.rejects(stat(stored.log), { code: 'ENOENT' })
})

test('derived-cache boundary failure leaves a durable recovery and cannot report completion with a stale actual SQLite row', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  await f.query.searchSessions({ query: 'synthetic' })
  f.driver.purgeCaches = async () => { throw new Error('synthetic-cache-boundary-crash') }
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /synthetic-cache-boundary-crash/)
  await assert.rejects(stat(stored.log), { code: 'ENOENT' }); assert.equal(f.commits(), 0)
  assert.equal(f.query._db.prepare('SELECT COUNT(*) AS count FROM persisted_sessions WHERE id = ?').get('session-a').count, 1)
  await f.restartManager()
  assert.equal((await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
  assert.equal(f.query._db.prepare('SELECT COUNT(*) AS count FROM persisted_sessions WHERE id = ?').get('session-a').count, 0)
  assert.equal(f.persistence.coldLogMemo.has('session-a'), false)
})

test('unloading only the manager preserves native tombstone admission while its actual services remain alive', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  f.driver.detachIndex = async () => { throw new Error('synthetic-index-write-failure') }
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /synthetic-index-write-failure/)
  await f.manager.dispose()
  await assert.rejects(f.registry.unarchiveSession('session-a'), /archive_tombstoned/)
  await assert.rejects(f.persistence.open('session-a'), /archive_tombstoned/)
  await assert.rejects(f.query.observeSession('session-a'), /archive_tombstoned/)
  assert.ok((await stat(stored.log)).isFile())
  await f.restartManager()
  assert.equal((await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
})

test('a live grandchild through an already-cold first-party parent blocks root archival deletion without running models', async t => {
  const f = await fixture(t), stored = await f.session()
  const parent = f.ctx.sessions.prepare('session-cold-child', { meta: { cwd: f.work.path, origin: 'subagent', parentSession: 'session-a' } })
  const parentWriter = await f.persistence.create(parent.header); await parentWriter.flush(); await parentWriter.close()
  const grandchild = await f.loop.createAgent(f.ctx, { sessionId: 'session-grandchild', meta: { cwd: f.work.path, origin: 'subagent', parentSession: 'session-cold-child' } })
  await assert.rejects(f.execute('session.archived.delete.prepare', { sessionId: 'session-a' }), /archive_descendant_owner_present/)
  assert.ok((await stat(stored.log)).isFile()); assert.equal(f.commits(), 0)
  await grandchild.dispose()
  const prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  assert.equal((await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
})

test('an actual SessionStore owner without an AgentHandle refuses deletion instead of calling an invented disposer', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  const header = (await f.persistence.stat('session-a')).header, bare = f.ctx.sessions.prepare('session-a', { meta: header })
  const detach = f.ctx.sessions.enter(bare)
  try { await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /archive_session_owner_unavailable/) }
  finally { detach() }
  assert.ok((await stat(stored.log)).isFile()); assert.equal(f.commits(), 0)
})

test('native local archives are scoped into the shared catalogue and legacy time stays unknown until a real new archive epoch', async t => {
  const f = await fixture(t); await f.manager.dispose()
  const legacy = await f.session('session-native-legacy')
  const directory = path.join(f.directory, 'journal')
  const lifecycle = new RemoteWorkspaceLifecycle(f.ctx, { directory, archiveDeletion: true }); await lifecycle.ready
  t.after(() => lifecycle.dispose())
  const execute = (operation: string, payload: Value, context = scope) => lifecycle.execute(operation, payload, randomUUID(), signal(), context) as Promise<any>
  const first = await execute('session.archived.list', {})
  assert.equal(first.archives.length, 1); assert.equal(first.archives[0].sessionId, 'session-native-legacy')
  assert.equal(first.archives[0].archivedAt, null); assert.equal(first.archives[0].remainingDays, null)
  const prepared = await execute('session.archived.delete.prepare', { sessionId: 'session-native-legacy' })
  await assert.rejects(execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }, { ...scope, group: 'fresh-relationship' }), /archive_confirmation_scope_changed/)
  assert.ok((await stat(legacy.log)).isFile())
  await f.registry.unarchiveSession('session-native-legacy'); await f.registry.archiveSession('session-native-legacy')
  const second = await execute('session.archived.list', {})
  assert.ok(second.archives[0].archivedAt !== null); assert.equal(second.archives[0].remainingDays, 30)
  await assert.rejects(execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /archive_changed_after_confirmation/)
})

async function preloadFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const stage = path.join(f.directory, 'preload-package'), directory = path.join(f.directory, 'dafeiyu-connection-plugin', 'workspace-lifecycle')
  await mkdir(path.join(stage, 'lib', 'framework'), { recursive: true }); await mkdir(path.join(stage, 'scripts')); await mkdir(directory, { recursive: true })
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const name of ['remote-archive-dsh', 'remote-archive', 'errors']) {
    const source = await readFile(new URL(`../../src/framework/${name}.ts`, import.meta.url), 'utf8')
    const compiled = stripTypeScriptTypes(source, { mode: 'strip', sourceMap: false })
      .replaceAll("'./errors.ts'", "'./errors.js'").replaceAll("'./remote-archive.ts'", "'./remote-archive.js'").replaceAll("'./remote-archive-dsh.ts'", "'./remote-archive-dsh.js'")
    await writeFile(path.join(stage, 'lib', 'framework', `${name}.js`), compiled)
  }
  const preloader = path.join(stage, 'scripts', 'archive-preload.mjs')
  await copyFile(new URL('../../scripts/archive-preload.mjs', import.meta.url), preloader)
  await copyFile(path.join(f.directory, 'journal', 'archive-deletion.json'), path.join(directory, 'archive-deletion.json'))
  const otherRealm = path.join(stage, 'other-realm'), otherPackage = path.join(otherRealm, 'node_modules', '@deepseek-ai', 'dsh-agent-loop')
  await mkdir(path.join(otherPackage, 'lib'), { recursive: true })
  await writeFile(path.join(otherRealm, 'package.json'), JSON.stringify({ type: 'module' }))
  await copyFile(require.resolve('@deepseek-ai/dsh-agent-loop/package.json'), path.join(otherPackage, 'package.json'))
  await copyFile(require.resolve('@deepseek-ai/dsh-agent-loop'), path.join(otherPackage, 'lib', 'index.js'))
  async function run(archiveDirectory = directory, preloaded = true): Promise<{ code: number | null; result?: any; diagnostics: string }> {
    return new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL('./fixtures/archive-preload-probe.mjs', import.meta.url)),
        [anchor, path.join(f.directory, 'sessions'), 'session-a', path.join(stage, 'lib', 'framework', 'remote-archive-dsh.js'), directory, path.join(otherRealm, 'package.json')],
        { execArgv: preloaded ? ['--import', pathToFileURL(preloader).href] : [], env: { ...process.env, DAFEIYU_DSH_INSTALL_ANCHOR: anchor, DSH_HOME: f.directory, DAFEIYU_DSH_ARCHIVE_DIRECTORY: archiveDirectory },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      let result: any, diagnostics = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('preloader-probe-timeout')) }, 10_000)
      child.on('message', value => { result = value })
      child.stderr?.on('data', chunk => { diagnostics += String(chunk).slice(0, 8192) })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); resolve({ code, result, diagnostics }) })
    })
  }
  return { run, directory }
}

test('the real pre-CLI --import script guards native SessionStore and JSONL before any plugin manager or Agent is constructed', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  f.driver.detachIndex = async () => { throw new Error('synthetic-crash-after-durable-tombstone') }
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /synthetic-crash-after-durable-tombstone/)
  const probe = await preloadFixture(f), journal = path.join(probe.directory, 'archive-deletion.json')
  const bytes = await readFile(journal), before = await stat(journal, { bigint: true }), result = await probe.run()
  assert.equal(result.code, 0, result.diagnostics); assert.deepEqual(result.result, { beforeManager: true, preloadReady: true, wrongDirectoryDenied: true, otherRealmDenied: true,
    persistenceDenied: true, storeDenied: true, statHidden: true, modelCalls: 0 })
  assert.ok((await stat(stored.log)).isFile()); assert.equal(f.commits(), 0)
  assert.deepEqual(await readFile(journal), bytes)
  const after = await stat(journal, { bigint: true })
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs)
})

test('pre-CLI unknown or damaged journal and a mismatched archive directory stop before the real native entry point', async t => {
  const f = await fixture(t); await f.session()
  const probe = await preloadFixture(f), journal = path.join(probe.directory, 'archive-deletion.json')
  await writeFile(journal, JSON.stringify({ version: 99, epochs: {}, receipts: [] }))
  const unknown = await probe.run()
  assert.notEqual(unknown.code, 0); assert.equal(unknown.result, undefined); assert.match(unknown.diagnostics, /archive_journal_invalid/)
  await writeFile(journal, '{invalid')
  const damaged = await probe.run()
  assert.notEqual(damaged.code, 0); assert.equal(damaged.result, undefined)
  const wrong = await probe.run(path.join(f.directory, 'another-directory'))
  assert.notEqual(wrong.code, 0); assert.equal(wrong.result, undefined); assert.match(wrong.diagnostics, /archive_preload_directory_invalid/)
})

test('launcher readiness rejects absent preload before native services and reads the exact gate without writing it', async t => {
  const f = await fixture(t); await f.session()
  const probe = await preloadFixture(f), journal = path.join(probe.directory, 'archive-deletion.json')
  const bytes = await readFile(journal), before = await stat(journal, { bigint: true })
  const missing = await probe.run(probe.directory, false)
  assert.notEqual(missing.code, 0); assert.equal(missing.result, undefined); assert.match(missing.diagnostics, /archive_preload_not_ready/)
  assert.deepEqual(await readFile(journal), bytes)
  const after = await stat(journal, { bigint: true })
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs)
})

test('released native services refuse a missing or alternate journal before any replacement save and retain the old tombstone', async t => {
  const f = await fixture(t), stored = await f.session(), prepared = await f.execute('session.archived.delete.prepare', { sessionId: 'session-a' })
  f.driver.detachIndex = async () => { throw new Error('synthetic-crash-after-durable-tombstone') }
  await assert.rejects(f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true }), /synthetic-crash-after-durable-tombstone/)
  const original = path.join(f.directory, 'journal', 'archive-deletion.json'), retained = await readFile(original)
  await f.manager.dispose()
  const another = path.join(f.directory, 'another-journal'), alternate = new RemoteArchiveDeletion(new FixedDshArchiveDriver(f.ctx), f.catalog, another)
  await assert.rejects(alternate.ready, /archive_journal_directory_changed/); await alternate.dispose()
  await assert.rejects(stat(path.join(another, 'archive-deletion.json')), { code: 'ENOENT' })
  await assert.rejects(f.persistence.open('session-a'), /archive_tombstoned/)
  await rm(original)
  const missing = new RemoteArchiveDeletion(new FixedDshArchiveDriver(f.ctx), f.catalog, path.dirname(original))
  await assert.rejects(missing.ready, /archive_journal_tombstone_missing/); await missing.dispose()
  await assert.rejects(stat(original), { code: 'ENOENT' })
  await assert.rejects(f.registry.unarchiveSession('session-a'), /archive_tombstoned/)
  assert.ok((await stat(stored.log)).isFile())
  await writeFile(original, retained); await f.restartManager()
  assert.equal(f.manager.blocked('session-a'), true)
  assert.equal((await f.execute('session.archived.delete', { ticket: prepared.ticket, confirmDelete: true })).deleted, true)
})

test('late real services initialize once across concurrent calls and observe the subsequent native archive epoch', async t => {
  const f = await fixture(t); await f.manager.dispose()
  let composed = false, acquisitions = 0
  const lease = f.persistence.acquireLease.bind(f.persistence)
  f.persistence.acquireLease = async (...args: any[]) => { if (args[0] === 'dafeiyu-remote-archive-journal') acquisitions++; return lease(...args) }
  const late = { get: (key: string) => composed ? f.ctx.get(key) : undefined,
    on: f.ctx.on.bind(f.ctx), waterfall: f.ctx.waterfall.bind(f.ctx), parallel: f.ctx.parallel.bind(f.ctx) }
  const lifecycle = new RemoteWorkspaceLifecycle(late, { directory: path.join(f.directory, 'journal'), archiveDeletion: true })
  t.after(() => lifecycle.dispose())
  await lifecycle.ready; assert.equal(lifecycle.archiveDeletionAvailable(), false)
  assert.equal(await lifecycle.ensureArchiveDeletion(), false); assert.equal(acquisitions, 0)
  composed = true
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => lifecycle.ensureArchiveDeletion())), Array(8).fill(true))
  assert.equal(acquisitions, 1); assert.equal(lifecycle.archiveDeletionReason(), null)
  const stored = await f.session('session-late-services', false, false)
  await lifecycle.execute('session.archive', { sessionId: 'session-late-services' }, randomUUID(), signal(), scope)
  const listed: any = await lifecycle.execute('session.archived.list', {}, randomUUID(), signal(), scope)
  assert.equal(listed.archives[0].remainingDays, 30); assert.ok(listed.archives[0].archivedAt !== null)
  assert.ok((await stat(stored.log)).isFile()); assert.equal(acquisitions, 1)
})

test('a damaged durable archive journal latches the lifecycle unavailable until an explicit plugin reload', async t => {
  const f = await fixture(t); await f.manager.dispose()
  const directory = path.join(f.directory, 'journal'), journal = path.join(directory, 'archive-deletion.json'), original = await readFile(journal)
  let acquisitions = 0
  const lease = f.persistence.acquireLease.bind(f.persistence)
  f.persistence.acquireLease = async (...args: any[]) => { if (args[0] === 'dafeiyu-remote-archive-journal') acquisitions++; return lease(...args) }
  await writeFile(journal, JSON.stringify({ version: 99, epochs: {}, receipts: [] }))
  const lifecycle = new RemoteWorkspaceLifecycle(f.ctx, { directory, archiveDeletion: true }); await lifecycle.ready
  assert.equal(lifecycle.archiveDeletionAvailable(), false); assert.equal(lifecycle.archiveDeletionReason(), 'archive_journal_invalid'); assert.equal(acquisitions, 1)
  await writeFile(journal, original)
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => lifecycle.ensureArchiveDeletion())), Array(8).fill(false))
  assert.equal(acquisitions, 1); assert.deepEqual(await readFile(journal), original)
  await lifecycle.dispose()
  const reloaded = new RemoteWorkspaceLifecycle(f.ctx, { directory, archiveDeletion: true }); t.after(() => reloaded.dispose())
  await reloaded.ready; assert.equal(reloaded.archiveDeletionAvailable(), true); assert.equal(acquisitions, 2)
})

test('lifecycle unload drains a real initialization lease before any replacement manager may own the native services', async t => {
  const f = await fixture(t); await f.manager.dispose()
  let release!: () => void, reached!: () => void
  const wait = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { reached = resolve })
  const lease = f.persistence.acquireLease.bind(f.persistence)
  f.persistence.acquireLease = async (...args: any[]) => { if (args[0] === 'dafeiyu-remote-archive-journal') { reached(); await wait }; return lease(...args) }
  const directory = path.join(f.directory, 'journal'), lifecycle = new RemoteWorkspaceLifecycle(f.ctx, { directory, archiveDeletion: true })
  await started
  const stopped = lifecycle.dispose(); release(); await stopped
  assert.equal(lifecycle.archiveDeletionAvailable(), false); assert.equal(await lifecycle.ensureArchiveDeletion(), false)
  f.persistence.acquireLease = lease
  const reloaded = new RemoteWorkspaceLifecycle(f.ctx, { directory, archiveDeletion: true }); t.after(() => reloaded.dispose())
  await reloaded.ready; assert.equal(reloaded.archiveDeletionAvailable(), true)
})

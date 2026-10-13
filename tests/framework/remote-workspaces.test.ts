import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { RemoteWorkspaceLifecycle } from '../../src/framework/remote-workspaces.ts'

const qaRoot = 'G:/DeepSeek DSH/DSH Works/Project/Dafeiyu-Go/Temp_Android/qa/remote-workspace-tests'
const context = { group: 'isolated-group', peer: 'isolated-phone' }
const signal = () => new AbortController().signal
type Value = Record<string, any>
async function fixture(t: any) {
  const directory = path.join(qaRoot, randomUUID()), work = path.join(directory, 'workspace')
  await mkdir(work, { recursive: true }); await writeFile(path.join(work, 'retained.txt'), 'real files must survive registration removal')
  t.after(async () => { assert.equal(path.dirname(directory), path.normalize(qaRoot)); await rm(directory, { recursive: true, force: true }) })
  const queues: Record<string, any> = { 'session-a': { 'next-turn': [], 'next-step': [] }, 'session-b': { 'next-turn': [], 'next-step': [] } }
  const headers = new Map(['session-a', 'session-b'].map(id => [id, { id, cwd: work }]))
  const running = new Set<string>(), archived = new Set<string>(['session-b'])
  const initial: any = { id: 'workspace-original', title: 'Original workspace', path: work, sessionIds: ['session-a', 'session-b'] }
  let order = [initial, { id: 'workspace-next', title: 'Next', path: path.join(directory, 'next'), sessionIds: [] }]
  let stopSettles = true, stopped = 0, updates = 0
  const registry = {
    list: () => order.slice(), get: (id: string) => order.find(item => item.id === id),
    get archivedSessionIds() { return [...archived] },
    async delete(id: string) { order = order.filter(item => item.id !== id); return true },
    async create(cwd: string, title: string) {
      const workspace: any = { id: 'workspace-restored', title, path: cwd, sessionIds: [],
        async setTitle(next: string) { workspace.title = next },
        async attachSession(id: string) { if (!workspace.sessionIds.includes(id)) workspace.sessionIds.unshift(id) },
        async insertSessionBefore(id: string, before?: string) {
          assert.ok(workspace.sessionIds.includes(id)); if (before !== undefined) assert.ok(workspace.sessionIds.includes(before))
          workspace.sessionIds = workspace.sessionIds.filter((value: string) => value !== id)
          workspace.sessionIds.splice(before === undefined ? workspace.sessionIds.length : workspace.sessionIds.indexOf(before), 0, id)
        } }
      order.push(workspace); return workspace
    },
    async insertBefore(id: string, before?: string) {
      const value = order.find(item => item.id === id); order = order.filter(item => item.id !== id)
      const index = before === undefined ? order.length : order.findIndex(item => item.id === before)
      order.splice(index, 0, value!)
    },
    async archiveSession(id: string, options: Value) { archived.add(id); if (options?.stopActivity && stopSettles) running.delete(id) },
    async unarchiveSession(id: string) { archived.delete(id) },
  }
  const gates = new Set<(payload: Value, next: () => Promise<unknown>) => Promise<unknown>>()
  const ctx = {
    workspaceRegistry: registry,
    agents: { get: (id: string) => ({ status: running.has(id) ? 'running' : 'idle' }),
      list: () => [...headers.values()].map(header => ({ session: { header }, status: running.has(header.id) ? 'running' : 'idle' })) },
    sessions: { list: () => [...headers.values()].map(header => ({ header })) },
    on(event: string, listener: (payload: Value, next: () => Promise<unknown>) => Promise<unknown>) {
      assert.equal(event, 'agent/pre-step'); gates.add(listener); return () => { gates.delete(listener) }
    },
    sessionController: {
      async projections({ sessionId }: Value) { return { asOfSeq: 10, values: { inbox: queues[sessionId] } } },
      async inspect() { return {} },
      async updateQueue({ sessionId, itemId, action }: Value) {
        assert.equal(action.kind, 'remove'); updates++
        for (const lane of ['next-turn', 'next-step']) queues[sessionId][lane] = queues[sessionId][lane].filter((item: any) => item.id !== itemId)
        return { accepted: true }
      },
    },
    async waterfall(_event: string, { sessionId }: Value) { return running.has(sessionId) ? [{ kind: 'turn' }] : [] },
    async parallel() { stopped++; if (stopSettles) running.clear() },
  }
  const journal = path.join(directory, 'journal')
  const lifecycle = new RemoteWorkspaceLifecycle(ctx, { directory: journal })
  t.after(() => lifecycle.dispose())
  const execute = (operation: string, payload: Value, aborted = signal(), peer = context) => lifecycle.execute(operation, payload, 'stable-native-intent', aborted, peer) as Promise<any>
  return { directory, work, queues, archived, running, registry, ctx, journal, execute, lifecycle, headers, gates,
    setStopSettles: (value: boolean) => { stopSettles = value }, stopped: () => stopped, updates: () => updates }
}

test('registration removal preserves real files, exact relationship scope and original archive state', async t => {
  const f = await fixture(t)
  const prepared = await f.execute('workspace.remove.prepare', { workspaceId: 'workspace-original' })
  assert.equal(prepared.defaultFilesDecision, 'keep'); assert.equal(prepared.executionDevice, 'remote_computer')
  await assert.rejects(f.execute('workspace.remove', { ticket: prepared.ticket }, signal(), { ...context, peer: 'other-phone' }), { code: 'permission_denied' })
  const removed = await f.execute('workspace.remove', { ticket: prepared.ticket })
  assert.equal(removed.phase, 'removed'); assert.equal(removed.filesDeleted, false)
  assert.equal(f.registry.get('workspace-original'), undefined)
  assert.equal(await readFile(path.join(f.work, 'retained.txt'), 'utf8'), 'real files must survive registration removal')
  assert.deepEqual([...f.archived].sort(), ['session-a', 'session-b'])
  const before = await f.execute('session.archived.list', {})
  assert.equal(before.archives.find((item: any) => item.sessionId === 'session-b').archivedAt, null)
  assert.equal(before.archives.find((item: any) => item.sessionId === 'session-a').remainingDays, 30)
  f.lifecycle.dispose()
  const reopened = new RemoteWorkspaceLifecycle(f.ctx, { directory: f.journal }); t.after(() => reopened.dispose())
  const restored: any = await reopened.execute('workspace.removed.restore', { ticket: prepared.ticket }, 'restore-intent', signal(), context)
  assert.equal(restored.status, 'restored'); assert.equal(f.registry.list()[0].id, 'workspace-restored')
  assert.deepEqual([...f.archived], ['session-b']); assert.equal(restored.workspace.title, 'Original workspace')
  assert.deepEqual(restored.workspace.sessionIds, ['session-a', 'session-b'])
  assert.deepEqual(f.registry.get('workspace-restored').sessionIds, ['session-a', 'session-b'])
  assert.equal((await reopened.execute('workspace.removed.restore', { ticket: prepared.ticket }, 'retry-restore', signal(), context) as any).status, 'restored')
})

test('accepted stop cannot delete or remove while real activity remains', async t => {
  const f = await fixture(t)
  f.running.add('session-a'); f.setStopSettles(false)
  const prepared = await f.execute('workspace.remove.prepare', { workspaceId: 'workspace-original' })
  assert.equal(prepared.stopRequired, true)
  await assert.rejects(f.execute('workspace.remove', { ticket: prepared.ticket }), { code: 'conflict' })
  assert.ok(f.registry.get('workspace-original')); assert.ok((await stat(f.work)).isDirectory())
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 200)
  try { await assert.rejects(f.execute('workspace.remove', { ticket: prepared.ticket, stopTasks: true }, abort.signal), { code: 'request_cancelled' }) }
  finally { clearTimeout(timer) }
  assert.ok(f.stopped() > 0); assert.ok(f.registry.get('workspace-original')); assert.ok(f.running.has('session-a'))
})

test('confirmed stop clears actual pending queue occurrences before a durable remove', async t => {
  const f = await fixture(t)
  f.running.add('session-a'); f.queues['session-a']['next-turn'].push({ id: 'queued-native-prompt' })
  const prepared = await f.execute('workspace.remove.prepare', { workspaceId: 'workspace-original' })
  const removed = await f.execute('workspace.remove', { ticket: prepared.ticket, stopTasks: true })
  assert.equal(removed.phase, 'removed'); assert.equal(f.updates(), 1); assert.equal(f.queues['session-a']['next-turn'].length, 0)
  assert.equal(f.running.size, 0); assert.ok((await stat(f.work)).isDirectory())
})

test('disk deletion needs a separate exact path confirmation and the prepared directory inode', async t => {
  const f = await fixture(t)
  const prepared = await f.execute('workspace.remove.prepare', { workspaceId: 'workspace-original' })
  await f.execute('workspace.remove', { ticket: prepared.ticket })
  await assert.rejects(f.execute('workspace.files.delete', { ticket: prepared.ticket, confirmedPath: path.dirname(f.work), confirmDelete: true }), { code: 'permission_denied' })
  assert.ok((await stat(f.work)).isDirectory())
  const deleted = await f.execute('workspace.files.delete', { ticket: prepared.ticket, confirmedPath: f.work, confirmDelete: true })
  assert.equal(deleted.phase, 'files_deleted'); assert.equal(deleted.filesDeleted, true)
  await assert.rejects(stat(f.work), { code: 'ENOENT' })
  const restored = await f.execute('workspace.removed.restore', { ticket: prepared.ticket })
  assert.equal(restored.status, 'needs_directory'); assert.equal(f.registry.list().length, 1)
})

test('replacement of the confirmed directory is retained, not recursively removed', async t => {
  const f = await fixture(t)
  const prepared = await f.execute('workspace.remove.prepare', { workspaceId: 'workspace-original' })
  await f.execute('workspace.remove', { ticket: prepared.ticket })
  await rename(f.work, path.join(f.directory, 'retained-old'))
  await mkdir(f.work); await writeFile(path.join(f.work, 'replacement.txt'), 'new directory must survive')
  await assert.rejects(f.execute('workspace.files.delete', { ticket: prepared.ticket, confirmedPath: f.work, confirmDelete: true }), { code: 'conflict' })
  assert.equal(await readFile(path.join(f.work, 'replacement.txt'), 'utf8'), 'new directory must survive')
})

test('unknown queue projection refuses confirmation before changing registry or files', async t => {
  const f = await fixture(t)
  delete f.queues['session-a']
  await assert.rejects(f.execute('workspace.remove.prepare', { workspaceId: 'workspace-original' }), { code: 'conflict' })
  assert.ok(f.registry.get('workspace-original')); assert.deepEqual([...f.archived], ['session-b'])
})

test('new unregistered directory work is stopped and persisted tombstone gates future steps', async t => {
  const f = await fixture(t)
  const prepared = await f.execute('workspace.remove.prepare', { workspaceId: 'workspace-original' })
  f.headers.set('session-new', { id: 'session-new', cwd: f.work }); f.queues['session-new'] = { 'next-turn': [], 'next-step': [] }
  f.running.add('session-new')
  await assert.rejects(f.execute('workspace.remove', { ticket: prepared.ticket }), { code: 'conflict' })
  assert.ok(f.registry.get('workspace-original'))
  await f.execute('workspace.remove', { ticket: prepared.ticket, stopTasks: true })
  assert.ok(f.archived.has('session-new')); assert.equal(f.running.size, 0)
  const gate = [...f.gates][0]
  assert.deepEqual(await gate({ agent: { session: { header: { id: 'future-task', cwd: f.work } } } }, async () => ({ kind: 'continue' })), { kind: 'reject' })
  assert.deepEqual(await gate({ agent: { session: { header: { id: 'unrelated-task', cwd: f.directory } } } }, async () => ({ kind: 'continue' })), { kind: 'continue' })
  f.lifecycle.dispose()
  const loaded = new RemoteWorkspaceLifecycle(f.ctx, { directory: f.journal }); t.after(() => loaded.dispose()); await loaded.ready
  assert.deepEqual(await [...f.gates][0]({ agent: { session: { header: { id: 'future-task', cwd: f.work } } } }, async () => ({ kind: 'continue' })), { kind: 'reject' })
})

test('new unregistered directory activity after registration removal retains files', async t => {
  const f = await fixture(t)
  const prepared = await f.execute('workspace.remove.prepare', { workspaceId: 'workspace-original' })
  await f.execute('workspace.remove', { ticket: prepared.ticket })
  f.headers.set('session-new', { id: 'session-new', cwd: f.work }); f.queues['session-new'] = { 'next-turn': [{ id: 'pending-new' }], 'next-step': [] }
  await assert.rejects(f.execute('workspace.files.delete', { ticket: prepared.ticket, confirmedPath: f.work, confirmDelete: true }), { code: 'conflict' })
  assert.ok((await stat(f.work)).isDirectory())
})

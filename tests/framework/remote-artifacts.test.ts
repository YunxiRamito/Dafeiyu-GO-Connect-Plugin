import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { ARTIFACT_CHUNK_BYTES, RemoteArtifactReader } from '../../src/framework/remote-artifacts.ts'

const qaRoot = 'G:/DeepSeek DSH/DSH Works/Project/Dafeiyu-Go/Temp_Android/qa/remote-artifact-tests'
const context = { group: 'isolated-group', peer: 'isolated-phone' }
type Value = Record<string, any>
const signal = () => new AbortController().signal
async function fixture(t: any, options: Value = {}) {
  const directory = path.join(qaRoot, randomUUID()), work = path.join(directory, 'work')
  await mkdir(work, { recursive: true })
  let current: any = { id: 'workspace-a', path: work }
  const reader = new RemoteArtifactReader({ workspaceRegistry: { get: (id: string) => id === current?.id ? current : undefined } }, options)
  const execute = (operation: string, payload: Value, binding = context, aborted = signal()) => reader.execute(operation, payload, 'stable-artifact-intent', aborted, binding) as Promise<any>
  t.after(async () => { await reader.dispose(); assert.equal(path.dirname(directory), path.normalize(qaRoot)); await rm(directory, { recursive: true, force: true }) })
  const select = async (name: string) => (await execute('artifact.list', { workspaceId: 'workspace-a' })).entries.find((item: any) => item.name === name)
  const prepare = async (name: string) => { const entry = await select(name); assert.ok(entry); return execute('artifact.prepare', { workspaceId: 'workspace-a', relativePath: entry.relativePath, version: entry.version }) }
  return { directory, work, execute, reader, select, prepare, changeWorkspace: (value: any) => { current = value } }
}

test('explicit prepare provides a content digest; four/eight readers return exact real ranges', async t => {
  const f = await fixture(t), content = Buffer.alloc(2 * 1024 * 1024 + 37)
  for (let i = 0; i < content.length; i++) content[i] = i * 17 % 251
  await writeFile(path.join(f.work, 'output.bin'), content)
  const metadata = await f.prepare('output.bin')
  assert.equal(metadata.size, content.length); assert.equal(metadata.chunkBytes, ARTIFACT_CHUNK_BYTES)
  assert.equal(metadata.sha256, createHash('sha256').update(content).digest('hex'))
  for (const concurrency of [4, 8]) {
    const offsets = Array.from({ length: concurrency }, (_, index) => index * ARTIFACT_CHUNK_BYTES)
    const pages = await Promise.all(offsets.map(offset => f.execute('artifact.read', { ticket: metadata.ticket, offset, length: ARTIFACT_CHUNK_BYTES })))
    for (let index = 0; index < pages.length; index++) {
      assert.equal(pages[index].offset, offsets[index]); assert.equal(pages[index].sha256, metadata.sha256)
      assert.deepEqual(Buffer.from(pages[index].bytesBase64, 'base64'), content.subarray(offsets[index], offsets[index] + ARTIFACT_CHUNK_BYTES))
    }
  }
  const end = await f.execute('artifact.read', { ticket: metadata.ticket, offset: content.length - 17, length: ARTIFACT_CHUNK_BYTES })
  assert.deepEqual(Buffer.from(end.bytesBase64, 'base64'), content.subarray(-17))
  assert.deepEqual(await f.execute('artifact.close', { ticket: metadata.ticket }), { ticket: metadata.ticket, closed: true })
  await assert.rejects(f.execute('artifact.read', { ticket: metadata.ticket, offset: 0, length: 1 }), { code: 'permission_denied' })
  assert.deepEqual(await readFile(path.join(f.work, 'output.bin')), content)
})

test('directory pages carry metadata only and retain the exact selected file version', async t => {
  const f = await fixture(t)
  for (const name of ['alpha.txt', 'bravo.txt', 'charlie.txt']) await writeFile(path.join(f.work, name), name)
  await mkdir(path.join(f.work, 'folder')); await writeFile(path.join(f.work, 'folder', 'nested.txt'), 'nested')
  await writeFile(path.join(f.work, '.env'), 'never share credentials')
  await mkdir(path.join(f.work, 'node_modules')); await writeFile(path.join(f.work, 'node_modules', 'dependency'), 'ignored')
  const first = await f.execute('artifact.list', { workspaceId: 'workspace-a', limit: 2 })
  assert.deepEqual(first.entries.map((item: any) => item.name), ['alpha.txt', 'bravo.txt']); assert.equal(first.nextCursor, 'bravo.txt')
  assert.ok(first.entries.every((item: any) => !('bytesBase64' in item) && !('sha256' in item)))
  const second = await f.execute('artifact.list', { workspaceId: 'workspace-a', cursor: first.nextCursor, limit: 2 })
  assert.deepEqual(second.entries.map((item: any) => item.name), ['charlie.txt', 'folder']); assert.equal(second.nextCursor, null)
  const child = await f.execute('artifact.list', { workspaceId: 'workspace-a', directory: 'folder' })
  assert.equal(child.entries[0].relativePath, 'folder/nested.txt')
  await writeFile(path.join(f.work, 'alpha.txt'), 'changed after selection')
  await assert.rejects(f.execute('artifact.prepare', { workspaceId: 'workspace-a', relativePath: 'alpha.txt', version: first.entries[0].version }), { code: 'conflict' })
})

test('a ticket cannot cross a group or peer and does not allow unknown fields', async t => {
  const f = await fixture(t); await writeFile(path.join(f.work, 'output.txt'), 'visible only to the selected relationship')
  const prepared = await f.prepare('output.txt'), payload = { ticket: prepared.ticket, offset: 0, length: 1 }
  for (const foreign of [{ ...context, group: 'other-group' }, { ...context, peer: 'other-phone' }]) {
    await assert.rejects(f.execute('artifact.read', payload, foreign), { code: 'permission_denied' })
    await assert.rejects(f.execute('artifact.close', { ticket: prepared.ticket }, foreign), { code: 'permission_denied' })
  }
  await assert.rejects(f.execute('artifact.read', { ...payload, path: 'arbitrary-computer-file' }), { code: 'permission_denied' })
  await assert.rejects(f.execute('artifact.read', { ...payload, length: ARTIFACT_CHUNK_BYTES + 1 }), { code: 'validation_failed' })
  await assert.rejects(f.execute('artifact.read', { ...payload, offset: -1 }), { code: 'validation_failed' })
})

test('path traversal, credential paths and linked parents are refused', async t => {
  const f = await fixture(t); await writeFile(path.join(f.directory, 'outside.txt'), 'outside workspace')
  const version = 'a'.repeat(64)
  for (const relativePath of ['../outside.txt', '/absolute', 'C:/system', 'a\\b', 'a/../b', '.env', 'secrets/item.txt'])
    await assert.rejects(f.execute('artifact.prepare', { workspaceId: 'workspace-a', relativePath, version }))
  await symlink(f.directory, path.join(f.work, 'linked'), 'junction')
  await assert.rejects(f.execute('artifact.list', { workspaceId: 'workspace-a', directory: 'linked' }), { code: 'permission_denied' })
  assert.ok(!(await f.execute('artifact.list', { workspaceId: 'workspace-a' })).entries.some((item: any) => item.name === 'linked'))
})

test('in-place writes, path replacement and workspace remapping invalidate a prepared read', async t => {
  const f = await fixture(t); await writeFile(path.join(f.work, 'output.txt'), 'old bytes')
  const prepared = await f.prepare('output.txt')
  await writeFile(path.join(f.work, 'output.txt'), 'new bytes with another identity')
  await assert.rejects(f.execute('artifact.read', { ticket: prepared.ticket, offset: 0, length: 1 }), { code: 'conflict' })
  const second = await f.prepare('output.txt')
  await rename(path.join(f.work, 'output.txt'), path.join(f.work, 'saved.txt')); await writeFile(path.join(f.work, 'output.txt'), 'replacement')
  await assert.rejects(f.execute('artifact.read', { ticket: second.ticket, offset: 0, length: 1 }), { code: 'conflict' })
  const third = await f.prepare('output.txt')
  await mkdir(path.join(f.directory, 'another')); f.changeWorkspace({ id: 'workspace-a', path: path.join(f.directory, 'another') })
  await assert.rejects(f.execute('artifact.read', { ticket: third.ticket, offset: 0, length: 1 }), { code: 'conflict' })
})

test('empty files, cancellation, ticket expiry and the open handle budget have real effects', async t => {
  const f = await fixture(t, { maxTickets: 1, ttlMillis: 40 }); await writeFile(path.join(f.work, 'empty.txt'), '')
  const entry = await f.select('empty.txt'), cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(f.execute('artifact.prepare', { workspaceId: 'workspace-a', relativePath: entry.relativePath, version: entry.version }, context, cancelled.signal), { code: 'request_cancelled' })
  const prepared = await f.prepare('empty.txt')
  assert.equal(prepared.sha256, createHash('sha256').update('').digest('hex')); assert.equal(prepared.size, 0)
  const result = await f.execute('artifact.read', { ticket: prepared.ticket, offset: 0, length: 1 })
  assert.equal(result.bytesBase64, '')
  await assert.rejects(f.prepare('empty.txt'), { code: 'disk_space_low' })
  await new Promise(resolve => setTimeout(resolve, 55))
  await assert.rejects(f.execute('artifact.read', { ticket: prepared.ticket, offset: 0, length: 1 }), { code: 'permission_denied' })
  const reopened = await f.prepare('empty.txt'); assert.notEqual(reopened.ticket, prepared.ticket)
  await f.reader.dispose()
  await assert.rejects(f.execute('artifact.read', { ticket: reopened.ticket, offset: 0, length: 1 }), { code: 'request_cancelled' })
})

test('peer revocation cancels an admitted read and preserves other peers and future groups', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.work, 'output.txt'), 'real file bytes')
  const entry = await f.select('output.txt')
  const preparePayload = { workspaceId: 'workspace-a', relativePath: entry.relativePath, version: entry.version }
  const unaffected = { ...context, peer: 'other-phone' }, future = { ...context, group: 'new-group' }
  const own = await f.execute('artifact.prepare', preparePayload)
  const other = await f.execute('artifact.prepare', preparePayload, unaffected)
  const pending = f.execute('artifact.read', { ticket: own.ticket, offset: 0, length: 4 })
  const refused = assert.rejects(pending, { code: 'request_cancelled' })
  await f.reader.revoke(context.group, context.peer)
  await refused
  for (const operation of ['artifact.list', 'artifact.prepare'])
    await assert.rejects(f.execute(operation, operation === 'artifact.list' ? { workspaceId: 'workspace-a' } : preparePayload), { code: 'permission_denied' })
  assert.equal(Buffer.from((await f.execute('artifact.read', { ticket: other.ticket, offset: 0, length: 4 }, unaffected)).bytesBase64, 'base64').toString(), 'real')
  const next = await f.execute('artifact.prepare', preparePayload, future)
  assert.equal((await f.execute('artifact.read', { ticket: next.ticket, offset: 0, length: 4 }, future)).ticket, next.ticket)
  assert.equal(f.reader.available(), true)
})

test('group revocation aborts preparation, drains unpublished handles and cannot issue new tickets', async t => {
  const f = await fixture(t, { maxTickets: 1 })
  await writeFile(path.join(f.work, 'output.bin'), Buffer.alloc(2 * 1024 * 1024, 17))
  const entry = await f.select('output.bin')
  const payload = { workspaceId: 'workspace-a', relativePath: entry.relativePath, version: entry.version }
  const pending = f.execute('artifact.prepare', payload)
  const refused = assert.rejects(pending, { code: 'request_cancelled' })
  await f.reader.revoke(context.group)
  await refused
  await assert.rejects(f.execute('artifact.prepare', payload, { ...context, peer: 'other-phone' }), { code: 'permission_denied' })
  const next = await f.execute('artifact.prepare', payload, { ...context, group: 'new-group' })
  assert.equal(next.size, 2 * 1024 * 1024)
  await f.reader.revoke(context.group)
  assert.equal(f.reader.available(), true)
})

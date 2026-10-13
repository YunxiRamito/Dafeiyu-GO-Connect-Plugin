import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { ATTACHMENT_CHUNK_BYTES, RemoteAttachmentReceiver } from '../../src/framework/remote-attachments.ts'

type Value = Record<string, any>
const qaRoot = process.platform === 'win32' ? 'G:/DeepSeek DSH/DSH Works/Project/Dafeiyu-Go/Temp_Android/qa/remote-attachment-tests' :
  '/mnt/g/DeepSeek DSH/DSH Works/Project/Dafeiyu-Go/Temp_Android/qa/remote-attachment-tests'
const binding = { group: 'isolated-group', peer: 'isolated-phone' }
const signal = () => new AbortController().signal
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fixture(t: any, options: Value = {}) {
  const directory = path.join(qaRoot, randomUUID())
  await mkdir(directory, { recursive: true })
  const admitted: Value[] = [], agents = new Map<string, any>([['session-a', { id: 'session-a' }], ['session-b', { id: 'session-b' }]])
  let intercept: ((request: Value) => Promise<void>) | undefined
  let storedChunks: number[] = []
  const receipts = new Map<string, Value>()
  const uploads = {
    async uploadStream(request: Value) {
      if (intercept) await intercept(request)
      const chunks = []
      for await (const bytes of request.data) { request.signal?.throwIfAborted(); storedChunks.push(bytes.length); chunks.push(bytes) }
      const bytes = Buffer.concat(chunks)
      const result = { receiptId: randomUUID(), file: { attachmentId: `sha256:${sha(bytes)}`, name: request.name, bytes: bytes.length } }
      receipts.set(result.receiptId, { sessionId: request.sessionId, ...result })
      admitted.push({ sessionId: request.sessionId, bytes, result })
      return result
    },
    resolve(agent: Value, receiptId: string) { const receipt = receipts.get(receiptId); return receipt?.sessionId === agent.id ? receipt.file : undefined },
  }
  const ctx = { fileUploads: uploads, agents }, receiver = new RemoteAttachmentReceiver(ctx, { directory, ...options })
  t.after(async () => { await receiver.dispose(); assert.equal(path.dirname(directory), path.normalize(qaRoot)); await rm(directory, { recursive: true, force: true }) })
  const execute = (operation: string, payload: Value, context = binding, lifetime = signal()) =>
    receiver.execute(operation, payload, 'stable-attachment-request', lifetime, context) as Promise<Value>
  const prepare = (bytes: Buffer, uploadId = 'upload-a', extra: Value = {}) => execute('attachment.prepare',
    { uploadId, sessionId: 'session-a', name: 'selected.bin', size: bytes.length, sha256: sha(bytes), ...extra })
  const write = (bytes: Buffer, offset = 0, uploadId = 'upload-a', extra: Value = {}) => execute('attachment.write',
    { uploadId, offset, bytesBase64: bytes.toString('base64'), chunkSha256: sha(bytes), ...extra })
  const upload = async (bytes: Buffer, uploadId = 'upload-a', extra: Value = {}) => {
    await prepare(bytes, uploadId, extra)
    for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES)
      await write(bytes.subarray(offset, Math.min(bytes.length, offset + ATTACHMENT_CHUNK_BYTES)), offset, uploadId)
    return execute('attachment.commit', { uploadId })
  }
  return { directory, receiver, ctx, execute, prepare, write, upload, admitted, receipts,
    storedChunks: () => storedChunks, intercept: (value?: (request: Value) => Promise<void>) => { intercept = value } }
}

test('real staged chunks are ordered, bounded, digest-verified and become Session receipt content', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(2 * ATTACHMENT_CHUNK_BYTES + 37)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index * 17 % 251
  const result = await f.upload(bytes)
  assert.equal(result.status, 'ready'); assert.equal(result.received, bytes.length)
  assert.deepEqual(result.content, { type: 'file', uploadId: 'upload-a' })
  assert.deepEqual(result.file, { attachmentId: `sha256:${sha(bytes)}`, name: 'selected.bin', bytes: bytes.length })
  assert.deepEqual(f.admitted[0].bytes, bytes)
  assert.ok(f.storedChunks().every(count => count <= ATTACHMENT_CHUNK_BYTES))
  const prompt = await f.receiver.preparePrompt({ sessionId: 'session-a', content: [{ type: 'text', text: 'inspect selected file' }, result.content] }, signal(), binding)
  assert.equal(prompt.content[0].text, 'inspect selected file')
  assert.deepEqual(prompt.content[1], { type: 'file', receiptId: f.admitted[0].result.receiptId })
  assert.equal(f.admitted.length, 1, 'ready receipt is reused while first-party scope still owns it')
  assert.ok(!JSON.stringify(result).includes('bytesBase64') && !JSON.stringify(result).includes(f.directory))
})

test('retry is idempotent per offset; different bytes, skipped offsets and mismatched intents fail', async t => {
  const f = await fixture(t), bytes = Buffer.from('synthetic complete file')
  const initial = await f.prepare(bytes)
  assert.deepEqual(await f.prepare(bytes), initial)
  await f.write(bytes.subarray(0, 8))
  assert.equal((await f.write(bytes.subarray(0, 8))).received, 8)
  await assert.rejects(f.write(Buffer.from('xxxxxxxx')), { code: 'conflict' })
  await assert.rejects(f.write(bytes.subarray(8), 9), { code: 'validation_failed' })
  await assert.rejects(f.write(bytes.subarray(0, 10)), { code: 'conflict' })
  await assert.rejects(f.execute('attachment.commit', { uploadId: 'upload-a' }), { code: 'conflict' })
  await assert.rejects(f.prepare(bytes, 'upload-a', { name: 'different.bin' }), { code: 'conflict' })
  await f.write(bytes.subarray(8), 8)
  const committed = await f.execute('attachment.commit', { uploadId: 'upload-a' })
  assert.deepEqual(await f.execute('attachment.commit', { uploadId: 'upload-a' }), committed)
  assert.equal(f.admitted.length, 1)
})

test('relationship and Session boundaries reject forged references and foreign upload authority', async t => {
  const f = await fixture(t), selected = await f.upload(Buffer.from('selected'))
  for (const foreign of [{ ...binding, group: 'foreign-group' }, { ...binding, peer: 'foreign-phone' }]) {
    for (const operation of ['attachment.status', 'attachment.commit', 'attachment.cancel'])
      await assert.rejects(f.execute(operation, { uploadId: selected.uploadId }, foreign), { code: 'permission_denied' })
    await assert.rejects(f.receiver.preparePrompt({ sessionId: 'session-a', content: [selected.content] }, signal(), foreign), { code: 'permission_denied' })
  }
  await assert.rejects(f.receiver.preparePrompt({ sessionId: 'session-b', content: [selected.content] }, signal(), binding), { code: 'permission_denied' })
  for (const part of [{ type: 'file', receiptId: f.admitted[0].result.receiptId }, { type: 'file', attachment: selected.file },
    { ...selected.content, attachmentId: selected.file.attachmentId }, { type: 'script', text: 'unused' }])
    await assert.rejects(f.receiver.preparePrompt({ sessionId: 'session-a', content: [part] }, signal(), binding), { code: 'permission_denied' })
  await assert.rejects(f.execute('attachment.status', { uploadId: selected.uploadId, path: '/host/private' }), { code: 'permission_denied' })
})

test('persisted stage resumes at saved offset after restart; unsaved suffix never changes committed bytes', async t => {
  const f = await fixture(t), bytes = Buffer.from('resume exact original bytes')
  await f.prepare(bytes); await f.write(bytes.subarray(0, 7))
  const [folder] = await readdir(f.directory), file = path.join(f.directory, folder, 'bytes.bin')
  await writeFile(file, Buffer.concat([bytes.subarray(0, 7), Buffer.from('unsaved')]))
  await f.receiver.dispose()
  const receiver = new RemoteAttachmentReceiver(f.ctx, { directory: f.directory })
  t.after(() => receiver.dispose())
  const execute = (op: string, payload: Value) => receiver.execute(op, payload, 'same-stable-action', signal(), binding) as Promise<Value>
  assert.equal((await execute('attachment.status', { uploadId: 'upload-a' })).received, 7)
  await execute('attachment.write', { uploadId: 'upload-a', offset: 7, bytesBase64: bytes.subarray(7).toString('base64'), chunkSha256: sha(bytes.subarray(7)) })
  assert.deepEqual(await readFile(file), bytes)
  const committed = await execute('attachment.commit', { uploadId: 'upload-a' })
  f.receipts.clear()
  const prompt = await receiver.preparePrompt({ sessionId: 'session-a', content: [committed.content] }, signal(), binding)
  assert.equal(prompt.content[0].receiptId, f.admitted.at(-1)!.result.receiptId)
  assert.deepEqual(f.admitted.at(-1)!.bytes, bytes)
  assert.equal(f.admitted.length, 2, 'expired first-party in-memory authority is reminted from exact persisted bytes')
})

test('complete digest mismatch prevents any store receipt, and canonical base64 is mandatory', async t => {
  const f = await fixture(t), bytes = Buffer.from('real bytes')
  await f.prepare(bytes, 'upload-a', { sha256: sha(Buffer.from('different')) })
  await assert.rejects(f.write(bytes, 0, 'upload-a', { bytesBase64: bytes.toString('base64') + '\n' }), { code: 'validation_failed' })
  await assert.rejects(f.write(bytes, 0, 'upload-a', { chunkSha256: 'f'.repeat(64) }), { code: 'validation_failed' })
  await f.write(bytes)
  await assert.rejects(f.execute('attachment.commit', { uploadId: 'upload-a' }), { code: 'conflict' })
  assert.equal(f.admitted.length, 0)
})

test('zero byte files, names and resource budgets do not admit arbitrary host paths', async t => {
  const f = await fixture(t, { maxBytes: 8, maxTotalBytes: 12, maxUploads: 2 })
  const empty = await f.upload(Buffer.alloc(0))
  assert.equal(empty.file.bytes, 0); assert.equal(empty.file.attachmentId, `sha256:${sha(Buffer.alloc(0))}`)
  for (const name of ['../private', 'a\\b', '.', 'x\n', ' trailing '])
    await assert.rejects(f.prepare(Buffer.from('a'), randomUUID(), { name }), { code: 'validation_failed' })
  await f.prepare(Buffer.alloc(8), 'upload-b')
  await assert.rejects(f.prepare(Buffer.from('a'), 'upload-c'), { code: 'disk_space_low' })
  await assert.rejects(f.prepare(Buffer.alloc(9), 'oversized'), { code: 'validation_failed' })
  await assert.rejects(f.execute('attachment.write', { uploadId: 'upload-b', offset: 0,
    bytesBase64: Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1).toString('base64'), chunkSha256: 'a'.repeat(64) }), { code: 'validation_failed' })
})

test('explicit cancel is repeatable and keeps a tombstone; durable revoke aborts admission and deletes staged bytes', async t => {
  const f = await fixture(t), bytes = Buffer.from('only selected file')
  await f.prepare(bytes); await f.write(bytes)
  assert.deepEqual(await f.execute('attachment.cancel', { uploadId: 'upload-a' }), { uploadId: 'upload-a', cancelled: true })
  assert.deepEqual(await f.execute('attachment.cancel', { uploadId: 'upload-a' }), { uploadId: 'upload-a', cancelled: true })
  await assert.rejects(f.prepare(bytes), { code: 'permission_denied' })
  await f.prepare(bytes, 'upload-b'); await f.write(bytes, 0, 'upload-b')
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.intercept(async request => {
    entered()
    await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
  })
  const pending = f.execute('attachment.commit', { uploadId: 'upload-b' })
  const rejected = assert.rejects(pending)
  await started; await f.receiver.revoke(binding.group, binding.peer); await rejected
  assert.equal(f.admitted.length, 0)
  for (const folder of await readdir(f.directory)) assert.ok(!(await readdir(path.join(f.directory, folder))).includes('bytes.bin'))
  await assert.rejects(f.execute('attachment.status', { uploadId: 'upload-b' }))
  f.intercept()
  const restarted = new RemoteAttachmentReceiver(f.ctx, { directory: f.directory })
  t.after(() => restarted.dispose())
  await assert.rejects(restarted.execute('attachment.prepare', { uploadId: 'upload-b', sessionId: 'session-a', name: 'selected.bin', size: bytes.length, sha256: sha(bytes) }, 'new-id-after-restart', signal(), binding), { code: 'permission_denied' })
})

test('cancelled caller never advances an offset and linked staging does not access outside data', async t => {
  const f = await fixture(t), bytes = Buffer.from('safe')
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(f.execute('attachment.prepare', { uploadId: 'abort', sessionId: 'session-a', name: 'safe', size: 4, sha256: sha(bytes) }, binding, cancelled.signal), { code: 'request_cancelled' })
  await f.prepare(bytes)
  const [folder] = await readdir(f.directory), filename = path.join(f.directory, folder, 'bytes.bin')
  const outside = f.directory + '-outside-synthetic.txt'
  t.after(() => rm(outside, { force: true }))
  await writeFile(outside, bytes); await rm(filename); await symlink(outside, filename)
  await assert.rejects(f.write(bytes), { code: 'permission_denied' })
  assert.deepEqual(await readFile(outside), bytes)
  await rm(outside)
})

test('corrupt ready metadata cannot mint a receipt', async t => {
  const f = await fixture(t), bytes = Buffer.from('verified')
  await f.upload(bytes)
  const [folder] = await readdir(f.directory), file = path.join(f.directory, folder, 'metadata.json')
  const document = JSON.parse(await readFile(file, 'utf8'))
  document.file.hostPath = '/private/never-publish'
  await writeFile(file, JSON.stringify(document))
  await assert.rejects(f.execute('attachment.status', { uploadId: 'upload-a' }), { code: 'permission_denied' })
  assert.equal(f.admitted.length, 1)
})

test('interrupted unpublished prepare is cleaned and an expired stage releases its reserved bytes', async t => {
  const f = await fixture(t, { maxUploads: 1 })
  const orphan = path.join(f.directory, 'f'.repeat(64))
  await mkdir(orphan); await writeFile(path.join(orphan, 'bytes.bin'), '')
  const bytes = Buffer.from('valid new selection')
  await f.prepare(bytes)
  assert.ok(!(await readdir(f.directory)).includes('f'.repeat(64)))
  const [folder] = await readdir(f.directory), metadata = path.join(f.directory, folder, 'metadata.json')
  const old = JSON.parse(await readFile(metadata, 'utf8'))
  old.createdAt = Date.now() - 100; old.expiresAt = Date.now() - 1
  await writeFile(metadata, JSON.stringify(old))
  const prepared = await f.prepare(bytes, 'new-after-expiry')
  assert.equal(prepared.uploadId, 'new-after-expiry')
  assert.equal((await readdir(f.directory)).length, 1)
  await assert.rejects(f.execute('attachment.status', { uploadId: 'upload-a' }), { code: 'permission_denied' })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { MockConnectionProvider } from '../../src/framework/provider.ts'
import { PermissionSet, PERMISSIONS } from '../../src/framework/permissions.ts'
import { RemoteDshHost, REMOTE_DSH_PROTOCOL } from '../../src/framework/remote-host.ts'
import { RemoteResultBlobStore, resultChunkFrames, validResultBlob } from '../../src/framework/remote-result-chunks.ts'
const transport = 'remote_result_chunks_v1'
const state = { server_connected: true, group_id: 'grp_chunk', pairing_status: 'paired' as const, local_device: { id: 'pc', name: 'PC', public_key: 'p' },
  remote_device: { id: 'phone', name: 'Phone', public_key: 'q', online: 'online' as const, last_seen_at: null }, members: [{ id: 'pc', active: true }, { id: 'phone', active: true }],
  capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true } }
function request(id: string, negotiated = true) { return { kind: 'dsh_remote_request', message_id: id, sender_device_id: 'phone', created_at: '',
  body: { protocol: REMOTE_DSH_PROTOCOL, request_id: id, operation: 'session.create', target_device_id: 'pc', payload: {}, ...(negotiated ? { response_transport: transport } : {}) } } }
test('negotiated 8MiB response has bounded frames, durable byte replay and single mutation execution', async () => {
  const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/eight-mib')
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true })
  const value = { text: 'x'.repeat(8 * 1024 * 1024 - 11) }
  assert.equal(Buffer.byteLength(JSON.stringify(value)), 8 * 1024 * 1024)
  const provider = new MockConnectionProvider(state)
  let executions = 0
  let host: RemoteDshHost
  const sent: any[] = []
  provider.send_encrypted_message = async (input: any) => {
    sent.push(input.body)
    if (input.kind === 'dsh_remote_event') queueMicrotask(() => void host.receive('grp_chunk', { kind: 'dsh_remote_ack', message_id: 'ack', sender_device_id: 'phone', created_at: '', body: {
      protocol: REMOTE_DSH_PROTOCOL, request_id: input.body.request_id, target_device_id: 'pc', operation: 'session.create', response_transport: transport, sequence: input.body.sequence } }))
    return { success: true, request_id: 'fixture', data: { message_id: 'sent' } }
  }
  const adapter = { capabilities: () => ['remote_task'], execute: async () => { executions++; return value }, cancel: async () => ({}) }
  host = new RemoteDshHost({ provider, adapter, permissions: new PermissionSet(PERMISSIONS), stateDirectory: directory })
  await host.ready; await host.receive('grp_chunk', request('large_request_1'))
  const deadline = Date.now() + 15000
  while (!sent.some(frame => frame.payload?.kind === 'result.end')) { assert.ok(Date.now() < deadline, 'missing chunk terminal'); await yieldLoop() }
  await host.dispose()
  assert.equal(sent.length, 173)
  const original = JSON.stringify(sent)
  await writeFile(path.join(directory, 'host-eight-mib-envelopes.json'), original)
  const bytes = Buffer.concat(sent.filter(frame => frame.payload?.kind === 'result.chunk').map(frame => Buffer.from(frame.payload.bytes, 'base64')))
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), value)
  for (const frame of sent) assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 128 * 1024)
  const journal = await readFile(path.join(directory, 'remote-requests.json'), 'utf8')
  assert.ok(Buffer.byteLength(journal) < 4096)
  assert.equal(journal.includes('xxxxxxxxxxxxxxxx'), false)
  sent.length = 0
  host = new RemoteDshHost({ provider, adapter, permissions: new PermissionSet(PERMISSIONS), stateDirectory: directory })
  await host.ready; await host.receive('grp_chunk', request('large_request_1'))
  const replayDeadline = Date.now() + 15000
  while (!sent.some(frame => frame.payload?.kind === 'result.end')) { assert.ok(Date.now() < replayDeadline); await yieldLoop() }
  await host.dispose()
  assert.equal(JSON.stringify(sent), original)
  assert.equal(executions, 1)
  host = new RemoteDshHost({ provider, adapter, permissions: new PermissionSet(PERMISSIONS), stateDirectory: directory })
  await host.ready
  await assert.rejects(() => host.receive('grp_chunk', request('large_request_1', false)), (error: any) => error.code === 'conflict')
  await host.dispose()
})

test('legacy large response is explicit unsupported; negotiated over8MiB remains protocol_error', async () => {
  for (const [name, negotiated, size, code] of [['legacy', false, 140000, 'unsupported'], ['oversized', true, 8 * 1024 * 1024, 'protocol_error']] as const) {
    const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/' + name)
    await rm(directory, { recursive: true, force: true })
    const provider = new MockConnectionProvider(state)
    const host = new RemoteDshHost({ provider, stateDirectory: directory, permissions: new PermissionSet(PERMISSIONS),
      adapter: { capabilities: () => ['remote_task'], execute: async () => ({ text: 'x'.repeat(size) }), cancel: async () => ({}) } })
    await host.ready; await host.receive('grp_chunk', request('negative_request_1', negotiated))
    const deadline = Date.now() + 3000
    while (!provider.calls.some(call => call.method === 'send_encrypted_message')) { assert.ok(Date.now() < deadline); await yieldLoop() }
    await host.dispose()
    const frame: any = provider.calls.find(call => call.method === 'send_encrypted_message')?.input
    assert.equal(frame.body.type, 'error'); assert.equal(frame.body.payload.code, code)
    assert.deepEqual(await readdir(path.join(directory, 'result-blobs')), [])
  }
})

test('chunk descriptors reject invalid counts, size, hash, sequence and content changes', async () => {
  const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/blob-validation')
  await rm(directory, { recursive: true, force: true })
  const bytes = Buffer.from(JSON.stringify({ text: 'x'.repeat(150000) }))
  const hash = createHash('sha256').update(bytes).digest('hex')
  const descriptor = { response_id: 'a'.repeat(64), total_bytes: bytes.length, chunk_count: Math.ceil(bytes.length / 49152), sha256: hash, result_type: 'result' as const, sequence: 0 }
  assert.equal(validResultBlob(descriptor), true)
  for (const bad of [{ ...descriptor, chunk_count: 0 }, { ...descriptor, total_bytes: 8 * 1024 * 1024 + 1 }, { ...descriptor, sha256: 'x' }, { ...descriptor, sequence: 1025 }, { ...descriptor, extra: true }]) assert.equal(validResultBlob(bad), false)
  assert.throws(() => resultChunkFrames(descriptor, Buffer.from('changed')), (error: any) => error.code === 'protocol_error')
  const store = new RemoteResultBlobStore(directory)
  await store.write(descriptor.response_id, bytes)
  assert.deepEqual(await store.read(descriptor), bytes)
  await writeFile(path.join(directory, 'result-blobs', descriptor.response_id + '.json'), Buffer.alloc(bytes.length, 120))
  await assert.rejects(() => store.read(descriptor), (error: any) => error.code === 'protocol_error')
})

test('new ACK cannot acknowledge a future reserved chunk or another operation', async () => {
  const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/ack-window')
  await rm(directory, { recursive: true, force: true })
  const provider = new MockConnectionProvider(state)
  const host = new RemoteDshHost({ provider, stateDirectory: directory, permissions: new PermissionSet(PERMISSIONS),
    adapter: { capabilities: () => ['remote_task'], execute: async () => ({ text: 'x'.repeat(350000) }), cancel: async () => ({}) } })
  await host.ready; await host.receive('grp_chunk', request('window_request_1'))
  const deadline = Date.now() + 3000
  while (provider.calls.filter(call => call.method === 'send_encrypted_message').length < 4) { assert.ok(Date.now() < deadline); await yieldLoop() }
  const ack = (sequence: number, operation = 'session.create') => ({ kind: 'dsh_remote_ack', message_id: 'ack', sender_device_id: 'phone', created_at: '', body: { protocol: REMOTE_DSH_PROTOCOL, request_id: 'window_request_1', target_device_id: 'pc', operation, response_transport: transport, sequence } })
  await assert.rejects(() => host.receive('grp_chunk', ack(6)), (error: any) => error.code === 'permission_denied')
  await assert.rejects(() => host.receive('grp_chunk', ack(3, 'session.prompt')), (error: any) => error.code === 'permission_denied')
  assert.equal(provider.calls.filter(call => call.method === 'send_encrypted_message').length, 4)
  await host.dispose()
})

test('follow preserves small events around independent large frames and closes without sequence gaps', async () => {
  const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/stream')
  await rm(directory, { recursive: true, force: true })
  const provider = new MockConnectionProvider(state)
  const sent: any[] = [], ackErrors: unknown[] = []
  let host: RemoteDshHost
  provider.send_encrypted_message = async (input: any) => {
    sent.push(input.body)
    queueMicrotask(() => void host.receive('grp_chunk', { kind: 'dsh_remote_ack', message_id: 'ack', sender_device_id: 'phone', created_at: '', body: {
      protocol: REMOTE_DSH_PROTOCOL, request_id: input.body.request_id, target_device_id: 'pc', operation: 'session.follow', response_transport: transport, sequence: input.body.sequence } }).catch(error => ackErrors.push(error)))
    return { success: true, request_id: 'fixture', data: { message_id: 'sent' } }
  }
  const frames = [{ type: 'small', text: 'before' }, { type: 'snapshot', text: 'x'.repeat(200000) }, { type: 'small', text: 'between' }, { type: 'snapshot', text: 'y'.repeat(200000) }]
  const adapter = { capabilities: () => ['remote_task'], execute: async () => ({ stream: 'follow' }),
    async *follow() { for (const frame of frames) yield frame }, cancel: async () => ({}) }
  host = new RemoteDshHost({ provider, adapter, stateDirectory: directory, permissions: new PermissionSet(PERMISSIONS) })
  await host.ready
  const message = request('stream_request_1'); message.body.operation = 'session.follow'
  await host.receive('grp_chunk', message)
  const deadline = Date.now() + 5000
  while (!sent.some(frame => frame.type === 'closed')) { assert.ok(Date.now() < deadline); await yieldLoop() }
  await host.dispose()
  assert.deepEqual(ackErrors, [])
  assert.deepEqual(sent.map(frame => frame.sequence), Array.from({ length: sent.length }, (_, index) => index))
  const starts = sent.filter(frame => frame.payload?.kind === 'result.begin')
  assert.equal(starts.length, 2); assert.notEqual(starts[0].payload.response_id, starts[1].payload.response_id)
  for (let index = 0; index < 2; index++) {
    const chunks = sent.filter(frame => frame.payload?.kind === 'result.chunk' && frame.payload.response_id === starts[index].payload.response_id)
    const bytes = Buffer.concat(chunks.map(frame => Buffer.from(frame.payload.bytes, 'base64')))
    assert.deepEqual(JSON.parse(bytes.toString()), frames[index * 2 + 1])
  }
  assert.equal(sent.filter(frame => frame.payload?.type === 'small').length, 2)
})

test('capability is advertised only by durable hosts with actual task service', async () => {
  const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/capability')
  await rm(directory, { recursive: true, force: true })
  for (const [persistent, actual] of [[false, true], [true, false], [true, true]]) {
    const provider = new MockConnectionProvider(state)
    const host = new RemoteDshHost({ provider, stateDirectory: persistent ? directory : undefined, permissions: new PermissionSet(PERMISSIONS),
      adapter: { capabilities: () => actual ? ['remote_task'] : [], execute: async () => ({}), cancel: async () => ({}) } })
    await host.ready
    assert.equal((await host.availableCapabilities()).includes(transport), persistent && actual)
    await host.dispose()
  }
})

test('durable store has a fixed64MiB quota and never overwrites response identities', async () => {
  const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/quota')
  await rm(directory, { recursive: true, force: true })
  const store = new RemoteResultBlobStore(directory)
  const bytes = Buffer.alloc(8 * 1024 * 1024, 120)
  for (let index = 0; index < 8; index++) await store.write(index.toString(16).padStart(64, '0'), bytes)
  await assert.rejects(() => store.write('f'.repeat(64), Buffer.from('x')), (error: any) => error.code === 'disk_space_low')
  await store.retain(new Set(['0'.repeat(64)]))
  await assert.rejects(() => store.write('0'.repeat(64), bytes), (error: any) => error.code === 'protocol_error')
  assert.equal((await readdir(path.join(directory, 'result-blobs'))).length, 1)
})

test('tampered persisted descriptor is refused on load rather than redirected to another scope', async () => {
  const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/descriptor-scope')
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true })
  const descriptor = { response_id: 'a'.repeat(64), total_bytes: 150000, chunk_count: 4, sha256: 'b'.repeat(64), result_type: 'result', sequence: 0 }
  const terminal = { sequence: 5, type: 'result', payload: { kind: 'result.end' } }
  await writeFile(path.join(directory, 'remote-requests.json'), JSON.stringify({ version: 1, groups: { grp_chunk: { requests: { ['phone\0scope_request_1']: {
    hash: 'c'.repeat(64), sender: 'phone', request_id: 'scope_request_1', operation: 'session.create', phase: 'done', next_sequence: 6,
    response_transport: transport, result_blobs: [descriptor], terminal_event: terminal } } } } }))
  const host = new RemoteDshHost({ provider: new MockConnectionProvider(state), stateDirectory: directory, permissions: new PermissionSet(PERMISSIONS),
    adapter: { capabilities: () => ['remote_task'], execute: async () => ({}), cancel: async () => ({}) } })
  await assert.rejects(host.ready, /invalid_remote_journal/)
  await host.dispose()
})

test('lost transport retries replay original bytes; corrupted blob fails explicitly without executing again', async () => {
  const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/lost-send')
  await rm(directory, { recursive: true, force: true })
  const provider = new MockConnectionProvider(state)
  let host: RemoteDshHost, executions = 0, throwSend = true
  const sent: any[] = []
  provider.send_encrypted_message = async (input: any) => {
    if (throwSend) { throwSend = false; throw new Error('synthetic lost transport receipt') }
    sent.push(input.body)
    queueMicrotask(() => void host.receive('grp_chunk', { kind: 'dsh_remote_ack', message_id: 'ack', sender_device_id: 'phone', created_at: '', body: {
      protocol: REMOTE_DSH_PROTOCOL, request_id: input.body.request_id, target_device_id: 'pc', operation: 'session.create', response_transport: transport, sequence: input.body.sequence } }).catch(() => {}))
    return { success: true, request_id: 'fixture', data: { message_id: 'sent' } }
  }
  const adapter = { capabilities: () => ['remote_task'], execute: async () => { executions++; return { text: 'x'.repeat(150000) } }, cancel: async () => ({}) }
  host = new RemoteDshHost({ provider, adapter, stateDirectory: directory, permissions: new PermissionSet(PERMISSIONS) })
  await host.ready; const message = request('lost_send_request_1'); await host.receive('grp_chunk', message)
  const sentDeadline = Date.now() + 3000
  while (throwSend) { assert.ok(Date.now() < sentDeadline); await yieldLoop() }
  await host.dispose()
  host = new RemoteDshHost({ provider, adapter, stateDirectory: directory, permissions: new PermissionSet(PERMISSIONS) })
  await host.ready; await host.receive('grp_chunk', message)
  const deadline = Date.now() + 5000
  while (!sent.some(frame => frame.payload?.kind === 'result.end')) { assert.ok(Date.now() < deadline); await yieldLoop() }
  await host.dispose(); assert.equal(executions, 1)
  const journal = JSON.parse(await readFile(path.join(directory, 'remote-requests.json'), 'utf8'))
  const descriptor = journal.groups.grp_chunk.requests['phone\0lost_send_request_1'].result_blobs[0]
  await writeFile(path.join(directory, 'result-blobs', descriptor.response_id + '.json'), Buffer.alloc(descriptor.total_bytes, 120))
  sent.length = 0
  host = new RemoteDshHost({ provider, adapter, stateDirectory: directory, permissions: new PermissionSet(PERMISSIONS) })
  await host.ready; await host.receive('grp_chunk', message)
  const errorDeadline = Date.now() + 5000
  while (!sent.some(frame => frame.type === 'error')) { assert.ok(Date.now() < errorDeadline); await yieldLoop() }
  assert.equal(sent[0].payload.code, 'protocol_error'); assert.equal(executions, 1)
  await host.dispose()
})

test('restarted observations retain explicit uncertainty and never replay partial stream continuity', async () => {
  const directory = path.resolve('../Temp_Android/codex-review-20261018/closeout-r22/connect-chunks/restarted-stream')
  await rm(directory, { recursive: true, force: true })
  const provider = new MockConnectionProvider(state)
  const sent: any[] = []
  let host: RemoteDshHost, executions = 0
  provider.send_encrypted_message = async (input: any) => {
    sent.push(input.body)
    queueMicrotask(() => void host.receive('grp_chunk', { kind: 'dsh_remote_ack', message_id: 'ack', sender_device_id: 'phone', created_at: '', body: {
      protocol: REMOTE_DSH_PROTOCOL, request_id: input.body.request_id, target_device_id: 'pc', operation: 'session.follow', response_transport: transport, sequence: input.body.sequence } }).catch(() => {}))
    return { success: true, request_id: 'fixture', data: { message_id: 'sent' } }
  }
  const adapter = { capabilities: () => ['remote_task'], execute: async () => { executions++; return { stream: 'follow' } }, async *follow() { yield { text: 'x'.repeat(150000) } }, cancel: async () => ({}) }
  host = new RemoteDshHost({ provider, adapter, stateDirectory: directory, permissions: new PermissionSet(PERMISSIONS) })
  await host.ready; const message = request('restart_stream_1'); message.body.operation = 'session.follow'; await host.receive('grp_chunk', message)
  const deadline = Date.now() + 5000
  while (!sent.some(frame => frame.type === 'closed')) { assert.ok(Date.now() < deadline); await yieldLoop() }
  await host.dispose()
  const journalPath = path.join(directory, 'remote-requests.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  const receipt = journal.groups.grp_chunk.requests['phone\0restart_stream_1']
  receipt.phase = 'submitted'; delete receipt.terminal_event
  await writeFile(journalPath, JSON.stringify(journal))
  sent.length = 0
  host = new RemoteDshHost({ provider, adapter, stateDirectory: directory, permissions: new PermissionSet(PERMISSIONS) })
  await host.ready; await host.receive('grp_chunk', message)
  const restoredDeadline = Date.now() + 5000
  while (!sent.length) { assert.ok(Date.now() < restoredDeadline); await yieldLoop() }
  assert.equal(sent.length, 1); assert.equal(sent[0].type, 'error'); assert.equal(sent[0].payload.code, 'request_uncertain'); assert.equal(executions, 1)
  await host.dispose()
})

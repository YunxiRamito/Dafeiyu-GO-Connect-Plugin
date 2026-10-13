import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { MockConnectionProvider } from '../../src/framework/provider.ts'
import { PERMISSIONS, PermissionSet } from '../../src/framework/permissions.ts'
import { RemoteDshClient } from '../../src/framework/remote.ts'
import { RemoteDshHost, createCordisRemoteDshAdapter, REMOTE_DSH_PROTOCOL } from '../../src/framework/remote-host.ts'
import { publicDshResult } from '../../src/framework/remote-public.ts'

const root = path.resolve('..', 'Temp_Android', 'qa', 'remote-transfer-wiring')
const relationship = { group: 'group-transfer-fixture', peer: 'phone-transfer-fixture' }
const state = {
  protocol: 'dafeiyu-go.connection.v1' as const, server_connected: true, group_id: relationship.group, pairing_status: 'paired' as const,
  local_device: { id: 'pc-transfer-fixture', name: 'PC', public_key: 'pc-fixture-key' },
  remote_device: { id: relationship.peer, name: 'Phone', public_key: 'phone-fixture-key', online: 'online' as const, last_seen_at: null },
  members: [{ id: 'pc-transfer-fixture', active: true }, { id: relationship.peer, active: true }],
  capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true,
    file_cache_cleanup: true, remote_task: true, remote_artifacts: true, remote_attachments: true },
}
const abort = () => new AbortController().signal
function envelope(id: string, operation: string, payload: any = {}) {
  return { message_id: `fixture-${id}`, sender_device_id: relationship.peer, kind: 'dsh_remote_request', created_at: '',
    body: { protocol: REMOTE_DSH_PROTOCOL, request_id: id, operation, payload, target_device_id: state.local_device.id } }
}
function acknowledgement(id: string, operation: string, sequence = 0) {
  return { message_id: `ack-${id}`, sender_device_id: relationship.peer, kind: 'dsh_remote_ack', created_at: '',
    body: { protocol: REMOTE_DSH_PROTOCOL, request_id: id, operation, sequence, target_device_id: state.local_device.id } }
}
async function directory(name: string): Promise<string> { await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, `${name}-`)) }
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) { assert.ok(Date.now() < deadline, 'Expected completed transfer receipt'); await yieldEventLoop() }
}

test('real adapter keeps file capabilities disabled by default and explicitly delegates workspace metadata when enabled', async t => {
  const folder = await directory('adapter')
  await writeFile(path.join(folder, 'generated.txt'), 'fixture generated output')
  let prompts = 0
  const values: any = {
    workspaceRegistry: { get: (id: string) => id === 'workspace-fixture' ? { id, path: folder } : undefined },
    sessionController: { create() {}, async prompt() { prompts++; return { accepted: true } }, cancel() {}, list() {}, modelCatalog() {}, follow() {}, control() {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'provider-fixture', model: 'model-fixture' }) },
    fileUploads: { uploadStream() { throw new Error('Not admitted in a metadata or forged-receipt check') } },
  }
  const ctx = { get: (name: string) => values[name] }
  const gated = createCordisRemoteDshAdapter(ctx, { attachmentDirectory: path.join(folder, 'gated-staging') })
  t.after(() => gated.dispose?.())
  assert.equal(gated.capabilities().includes('remote_artifacts'), false)
  assert.equal(gated.capabilities().includes('remote_attachments'), false)
  await assert.rejects(() => gated.execute('artifact.list', { workspaceId: 'workspace-fixture' }, 'metadata-gated-123', abort(), relationship), (error: any) => error.code === 'unsupported')
  const enabled = createCordisRemoteDshAdapter(ctx, { attachmentDirectory: path.join(folder, 'enabled-staging'), artifactsEnabled: true, attachmentsEnabled: true })
  t.after(() => enabled.dispose?.())
  assert.equal(enabled.capabilities().includes('remote_artifacts'), true)
  assert.equal(enabled.capabilities().includes('remote_attachments'), true)
  const listing: any = await enabled.execute('artifact.list', { workspaceId: 'workspace-fixture' }, 'metadata-enabled-123', abort(), relationship)
  assert.equal(listing.entries.some((entry: any) => entry.name === 'generated.txt' && entry.kind === 'file'), true)
  for (const part of [{ type: 'file', receiptId: 'forged-receipt' }, { type: 'file', attachmentId: 'sha256:forged' }, { type: 'file', uploadId: 'missing-upload' }]) {
    await assert.rejects(() => enabled.execute('session.prompt', { sessionId: 'session-fixture', content: [part] }, 'prompt-forged-123', abort(), relationship),
      (error: any) => error.code === 'permission_denied')
  }
  assert.equal(prompts, 0)
})

test('file operations require their own permission and capability on both client and host', async t => {
  for (const [operation, permission, capability] of [['artifact.list', 'connection.remote.artifacts', 'remote_artifacts'],
    ['attachment.prepare', 'connection.remote.attachments', 'remote_attachments']] as const) {
    const provider = new MockConnectionProvider(state)
    const without = new PermissionSet(PERMISSIONS.filter(value => value !== permission))
    const client = new RemoteDshClient(provider, without)
    await assert.rejects(() => client.submit({ group_id: relationship.group, request_id: 'denied-file-123', operation, payload: {} }),
      (error: any) => error.code === 'permission_denied')
    let executions = 0
    const host = new RemoteDshHost({ provider, permissions: without, stateDirectory: await directory('permissions'),
      adapter: { capabilities: () => ['remote_task', capability], execute: async () => { executions++; return {} }, cancel: async () => ({}) } })
    t.after(() => host.dispose())
    await assert.rejects(() => host.receive(relationship.group, envelope('denied-file-123', operation)), (error: any) => error.code === 'permission_denied')
    assert.equal(executions, 0)
    provider.setState({ ...state, capabilities: { ...state.capabilities, [capability]: false } })
    const allowed = new RemoteDshClient(provider, new PermissionSet(PERMISSIONS))
    await assert.rejects(() => allowed.submit({ group_id: relationship.group, request_id: 'missing-file-cap-123', operation, payload: {} }),
      (error: any) => error.code === 'unsupported')
    assert.equal(provider.calls.some(call => call.method === 'submit_remote_task'), false)
  }
})

test('idle file staging is revoked on terminal relation while an offline confirmed pairing remains intact', async t => {
  const provider = new MockConnectionProvider(state)
  const revoked: Array<{ group: string; peer?: string }> = []
  const host = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: await directory('revocation'),
    adapter: { capabilities: () => ['remote_task', 'remote_attachments'], execute: async () => ({ uploadId: 'upload-idle-fixture' }),
      revoke: async (group, peer) => { revoked.push({ group, peer }) }, cancel: async () => ({}) } })
  t.after(() => host.dispose())
  await host.receive(relationship.group, envelope('idle-upload-123', 'attachment.prepare'))
  await until(() => provider.calls.some(call => call.method === 'send_encrypted_message'))
  await yieldEventLoop()
  provider.setState({ ...state, server_connected: false, remote_device: { ...state.remote_device, online: 'unknown' } })
  await yieldEventLoop(); assert.equal(revoked.length, 0)
  provider.setState({ ...state, group_id: null, pairing_status: 'revoked', members: [] })
  await until(() => revoked.length === 1)
  assert.deepEqual(revoked, [{ group: relationship.group, peer: undefined }])
})

test('host retains irreversible intent while consumed and ACKed byte-bearing reads exceed 256 requests without filling the journal', async t => {
  const folder = await directory('bulk')
  const provider = new MockConnectionProvider(state)
  const bytesBase64 = Buffer.alloc(48 * 1024, 17).toString('base64')
  const host = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: folder,
    adapter: { capabilities: () => ['remote_task', 'remote_artifacts'], execute: async operation => operation === 'artifact.read' ? { bytesBase64 } : { accepted: true },
      cancel: async () => ({}) } })
  t.after(() => host.dispose())
  await host.receive(relationship.group, envelope('durable-prompt-123', 'session.prompt'))
  await until(() => provider.calls.some(call => call.method === 'send_encrypted_message' && (call.input as any).body.request_id === 'durable-prompt-123'))
  for (let index = 0; index < 280; index++) {
    const id = `bulk-read-${index}-123`
    await host.receive(relationship.group, envelope(id, 'artifact.read', { ticket: 'ticket-fixture', offset: index * 48 * 1024, length: 48 * 1024 }))
    await until(() => provider.calls.some(call => call.method === 'send_encrypted_message' && (call.input as any).body.request_id === id))
    await host.receive(relationship.group, acknowledgement(id, 'artifact.read'))
    await yieldEventLoop()
  }
  await host.dispose()
  const saved = await readFile(path.join(folder, 'remote-requests.json'), 'utf8')
  const journal = JSON.parse(saved).groups[relationship.group].requests
  assert.ok(Buffer.byteLength(saved) < 3 * 1024 * 1024)
  assert.ok(journal[`${relationship.peer}\0durable-prompt-123`])
  assert.ok(Object.values(journal).filter((receipt: any) => receipt.operation === 'artifact.read').length <= 17)
})

test('unconsumed transfer results cannot be evicted by ordinary metadata journal pruning', async t => {
  const folder = await directory('unconsumed')
  const provider = new MockConnectionProvider(state)
  const host = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: folder,
    adapter: { capabilities: () => ['remote_task', 'remote_artifacts', 'remote_directory'], execute: async () => ({ count: 1 }), cancel: async () => ({}) } })
  t.after(() => host.dispose())
  for (let index = 0; index < 230; index++) {
    const id = `no-ack-bulk-${index}-123`
    await host.receive(relationship.group, envelope(id, index < 20 ? 'artifact.read' : 'workspace.list'))
    await until(() => provider.calls.some(call => call.method === 'send_encrypted_message' && (call.input as any).body.request_id === id))
  }
  await host.dispose()
  const journal = JSON.parse(await readFile(path.join(folder, 'remote-requests.json'), 'utf8')).groups[relationship.group].requests
  assert.equal(Object.values(journal).filter((value: any) => value.operation === 'artifact.read').length, 20)
  assert.equal(Object.values(journal).every((value: any) => value.acknowledged_terminal_sequence === undefined), true)
})

test('early exact transfer ACK remains durable while native terminal send is still awaiting its receipt', async t => {
  const folder = await directory('early-ack')
  const provider = new MockConnectionProvider(state)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const send = provider.send_encrypted_message.bind(provider)
  provider.send_encrypted_message = async input => { const reply = await send(input); await held; return reply }
  const host = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: folder,
    adapter: { capabilities: () => ['remote_task', 'remote_artifacts'], execute: async () => ({ size: 3 }), cancel: async () => ({}) } })
  t.after(() => host.dispose())
  const id = 'early-ack-bulk-123'
  await host.receive(relationship.group, envelope(id, 'artifact.read'))
  await until(() => provider.calls.some(call => call.method === 'send_encrypted_message'))
  await host.receive(relationship.group, acknowledgement(id, 'artifact.read'))
  let receipt = JSON.parse(await readFile(path.join(folder, 'remote-requests.json'), 'utf8')).groups[relationship.group].requests[`${relationship.peer}\0${id}`]
  assert.equal(receipt.acknowledged_terminal_sequence, 0)
  assert.equal(receipt.terminal_sent, undefined)
  release()
  await host.dispose()
  receipt = JSON.parse(await readFile(path.join(folder, 'remote-requests.json'), 'utf8')).groups[relationship.group].requests[`${relationship.peer}\0${id}`]
  assert.equal(receipt.terminal_sent, true)
  assert.equal(receipt.acknowledged_terminal_sequence, 0)
})

test('bulk acknowledgements reject another operation, sequence, sender, and mutation receipt', async t => {
  const folder = await directory('bad-ack')
  const provider = new MockConnectionProvider({ ...state, members: [...state.members, { id: 'other-phone', active: true }] })
  const host = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: folder,
    adapter: { capabilities: () => ['remote_task', 'remote_artifacts', 'remote_attachments'], execute: async () => ({ count: 1 }), cancel: async () => ({}) } })
  t.after(() => host.dispose())
  await host.receive(relationship.group, envelope('bad-ack-bulk-123', 'artifact.read'))
  await until(() => provider.calls.some(call => call.method === 'send_encrypted_message'))
  for (const invalid of [acknowledgement('bad-ack-bulk-123', 'attachment.write'), acknowledgement('bad-ack-bulk-123', 'artifact.read', 1),
    { ...acknowledgement('bad-ack-bulk-123', 'artifact.read'), body: { ...acknowledgement('bad-ack-bulk-123', 'artifact.read').body, extra: true } }]) {
    await assert.rejects(() => host.receive(relationship.group, invalid), (error: any) => error.code === 'permission_denied')
  }
  await host.receive(relationship.group, { ...acknowledgement('bad-ack-bulk-123', 'artifact.read'), sender_device_id: 'other-phone' })
  await host.receive(relationship.group, envelope('bad-ack-commit-123', 'attachment.commit'))
  await until(() => provider.calls.some(call => call.method === 'send_encrypted_message' && (call.input as any).body.request_id === 'bad-ack-commit-123'))
  await assert.rejects(() => host.receive(relationship.group, acknowledgement('bad-ack-commit-123', 'attachment.commit')), (error: any) => error.code === 'permission_denied')
  await host.dispose()
  const journal = JSON.parse(await readFile(path.join(folder, 'remote-requests.json'), 'utf8')).groups[relationship.group].requests
  assert.equal(journal[`${relationship.peer}\0bad-ack-bulk-123`].acknowledged_terminal_sequence, undefined)
  assert.equal(journal[`${relationship.peer}\0bad-ack-commit-123`].phase, 'done')
})

test('file projections expose selected display data without host paths, receipts or credentials', () => {
  const secret = 'private-host-path-and-credential'
  for (const operation of ['artifact.prepare', 'artifact.read', 'artifact.close', 'attachment.prepare', 'attachment.write', 'attachment.status', 'attachment.commit', 'attachment.cancel']) {
    const result = publicDshResult(operation, { ticket: 'ticket-fixture', workspaceId: 'workspace-fixture', relativePath: 'generated.txt', fileName: 'generated.txt',
      version: '1'.repeat(64), size: 3, sha256: '2'.repeat(64), offset: 0, bytesBase64: 'YWJj', closed: true,
      uploadId: 'upload-fixture', sessionId: 'session-fixture', status: 'ready', received: 3, chunkBytes: 48 * 1024, expiresAt: 100,
      path: secret, receiptId: secret, apiKey: secret, content: { type: 'file', uploadId: 'upload-fixture', receiptId: secret },
      file: { attachmentId: 'sha256:' + '2'.repeat(64), name: 'generated.txt', bytes: 3, private: secret } })
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
  assert.deepEqual(publicDshResult('attachment.cancel', { uploadId: 'upload-fixture', cancelled: true, path: secret }),
    { uploadId: 'upload-fixture', cancelled: true })
})

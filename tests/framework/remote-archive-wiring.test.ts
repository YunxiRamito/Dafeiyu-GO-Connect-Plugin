import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { MockConnectionProvider } from '../../src/framework/provider.ts'
import { PermissionSet, PERMISSIONS } from '../../src/framework/permissions.ts'
import { RemoteDshClient } from '../../src/framework/remote.ts'
import { RemoteDshHost, REMOTE_DSH_PROTOCOL, createCordisRemoteDshAdapter } from '../../src/framework/remote-host.ts'
import { publicDshResult } from '../../src/framework/remote-public.ts'
import { validateConnectionState } from '../../src/framework/launcher-provider.ts'

const state = {
  protocol: 'dafeiyu-go.connection.v1' as const, server_connected: true, group_id: 'archive-wire-group', pairing_status: 'paired' as const,
  local_device: { id: 'archive-wire-pc', name: 'PC', public_key: 'pc-fixture' },
  remote_device: { id: 'archive-wire-phone', name: 'Phone', public_key: 'phone-fixture', online: 'online' as const, last_seen_at: null },
  members: [{ id: 'archive-wire-pc', active: true }, { id: 'archive-wire-phone', active: true }],
  capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true,
    presence: true, file_cache_cleanup: true, remote_task: true, remote_workspace_lifecycle: true, remote_archive_delete: true },
}
const all = () => new PermissionSet(PERMISSIONS)
async function directory() {
  const root = path.resolve('..', 'Temp_Android', 'qa', 'remote-archive-wire')
  await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, 'run-'))
}
const messages = (provider: MockConnectionProvider, kind: string) => provider.calls.filter(call =>
  call.method === 'send_encrypted_message' && (call.input as any).kind === kind).map(call => (call.input as any).body)
const envelope = (id: string, operation: string, payload: any) => ({ message_id: `fixture-${id}`,
  sender_device_id: state.remote_device.id, kind: 'dsh_remote_request', created_at: '', body: {
    protocol: REMOTE_DSH_PROTOCOL, request_id: id, operation, payload, target_device_id: state.local_device.id,
  } })
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < deadline); await yieldTurn() }
}

test('archive delete has independent permission and capability; ordinary lifecycle cannot grant it', async () => {
  const provider = new MockConnectionProvider(state)
  const input = { group_id: state.group_id, request_id: 'archive_client_prepare_123',
    operation: 'session.archived.delete.prepare' as const, payload: { sessionId: 'archive-session' } }
  const restricted = new RemoteDshClient(provider, new PermissionSet(PERMISSIONS.filter(value => value !== 'connection.remote.archive.delete')))
  await assert.rejects(() => restricted.submit(input), (error: any) => error.code === 'permission_denied')
  const unsupported = new RemoteDshClient(new MockConnectionProvider({ ...state,
    capabilities: { ...state.capabilities, remote_archive_delete: false } }), all())
  await assert.rejects(() => unsupported.submit(input), (error: any) => error.code === 'unsupported')
  assert.equal(provider.calls.filter(call => call.method === 'submit_remote_task').length, 0)
  await new RemoteDshClient(provider, all()).submit(input)
  const submitted = provider.calls.find(call => call.method === 'submit_remote_task')!.input as any
  assert.equal(submitted.target_device_id, state.remote_device.id)
  assert.deepEqual(submitted.payload, { sessionId: 'archive-session' })
})

test('late verified service refresh changes advertisement once and ungranted archive permission remains absent', async t => {
  const provider = new MockConnectionProvider(state)
  let enabled = false, refreshes = 0
  const adapter = { capabilities: () => ['remote_task', ...(enabled ? ['remote_archive_delete'] : [])],
    refreshCapabilities: async () => { refreshes++; enabled = true }, execute: async () => ({}), cancel: async () => ({}) }
  const host = new RemoteDshHost({ provider, adapter, permissions: all(), stateDirectory: await directory() })
  t.after(() => host.dispose())
  await host.advertise(state); await host.advertise(state)
  assert.equal(refreshes, 2)
  assert.deepEqual(messages(provider, 'dsh_remote_capabilities').map(value => value.capabilities), [['remote_archive_delete', 'remote_task']])
  const denied = new RemoteDshHost({ provider, adapter,
    permissions: new PermissionSet(PERMISSIONS.filter(value => value !== 'connection.remote.archive.delete')), stateDirectory: await directory() })
  t.after(() => denied.dispose())
  await denied.advertise(state)
  assert.deepEqual(messages(provider, 'dsh_remote_capabilities').at(-1).capabilities, ['remote_task'])
  await assert.rejects(() => denied.receive(state.group_id, envelope('archive_denied_123', 'session.archived.delete',
    { ticket: 'ticket-123', confirmDelete: true })), (error: any) => error.code === 'permission_denied')
})

test('prepare and commit use ordinary durable host receipts and duplicate confirmation cannot execute again', async t => {
  const provider = new MockConnectionProvider(state), location = await directory()
  const count = new Map<string, number>()
  const prepared = { ticket: 'ticket-123', sessionId: 'session-123', archiveVersion: 'epoch-123', archivedAt: null,
    expiresAt: null, executionDevice: 'remote_computer', deleted: false, status: 'prepared' }
  const host = new RemoteDshHost({ provider, permissions: all(), stateDirectory: location, adapter: {
    capabilities: () => ['remote_task', 'remote_archive_delete'], cancel: async () => ({}), execute: async operation => {
      count.set(operation, (count.get(operation) ?? 0) + 1)
      return operation.endsWith('.prepare') ? prepared : { ...prepared, status: 'deleted', deleted: true, deletedAt: 1000 }
    },
  } })
  t.after(() => host.dispose())
  const prepare = envelope('archive_prepare_once_123', 'session.archived.delete.prepare', { sessionId: 'session-123' })
  await host.receive(state.group_id, prepare)
  await until(() => messages(provider, 'dsh_remote_event').some(value => value.request_id === prepare.body.request_id))
  const commit = envelope('archive_commit_once_123', 'session.archived.delete', { ticket: 'ticket-123', confirmDelete: true })
  await host.receive(state.group_id, commit)
  await until(() => messages(provider, 'dsh_remote_event').some(value => value.request_id === commit.body.request_id))
  await host.receive(state.group_id, commit)
  assert.equal(count.get('session.archived.delete.prepare'), 1); assert.equal(count.get('session.archived.delete'), 1)
  const journal = JSON.parse(await readFile(path.join(location, 'remote-requests.json'), 'utf8'))
  const receipt: any = Object.values(journal.groups[state.group_id].requests).find((value: any) => value.operation === 'session.archived.delete')
  assert.equal(receipt.phase, 'done'); assert.equal(receipt.result.deleted, true)
  assert.equal(receipt.terminal_sent, undefined); assert.equal(receipt.acknowledged_terminal_sequence, undefined)
})

test('archive public projection excludes file paths and IPC snapshot rejects nonboolean declaration', () => {
  const result = publicDshResult('session.archived.delete.prepare', { ticket: 't', sessionId: 's', archiveVersion: 'v',
    archivedAt: null, expiresAt: null, executionDevice: 'remote_computer', deleted: false, status: 'prepared',
    filePath: '/private', credential: 'private' }) as any
  assert.equal(result.filePath, undefined); assert.equal(result.credential, undefined)
  assert.equal(validateConnectionState(state).capabilities.remote_archive_delete, true)
  assert.throws(() => validateConnectionState({ ...state, capabilities: { ...state.capabilities, remote_archive_delete: 'yes' } } as any),
    (error: any) => error.code === 'protocol_error')
  const adapter = createCordisRemoteDshAdapter({})
  assert.equal(adapter.capabilities().includes('remote_archive_delete'), false)
})

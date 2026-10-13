import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { MockConnectionProvider } from '../../src/framework/provider.ts'
import { PermissionSet, PERMISSIONS } from '../../src/framework/permissions.ts'
import { RemoteDshHost, createCordisRemoteDshAdapter, REMOTE_DSH_PROTOCOL } from '../../src/framework/remote-host.ts'

const directory = path.resolve('..', 'Temp_Android', 'qa', 'connect-remote-basic-0.3.0')
const state = {
  server_connected: true, group_id: 'grp_remote', pairing_status: 'paired' as const,
  local_device: { id: 'dev_pc', name: 'PC', public_key: 'pc-pk' },
  remote_device: { id: 'dev_android', name: 'Android', public_key: 'android-pk', online: 'online' as const, last_seen_at: null },
  members: [{ id: 'dev_pc', active: true }, { id: 'dev_android', active: true }],
  capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true },
}
function request(requestId: string, operation: string, payload: any) {
  return { message_id: 'message-' + requestId, sender_device_id: 'dev_android', created_at: '', kind: 'dsh_remote_request',
    body: { protocol: REMOTE_DSH_PROTOCOL, request_id: requestId, operation, payload, target_device_id: 'dev_pc' } }
}

test('remote host executes once, persists result before response, and rejects a reused id', async () => {
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true })
  const provider = new MockConnectionProvider(state)
  let calls = 0
  const host = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: directory,
    adapter: { capabilities: () => ['remote_task'], execute: async () => { calls++; return { sessionId: 'session-1' } }, cancel: async () => ({ accepted: true }) } })
  await host.ready
  const message = request('stable_request_1', 'session.create', {})
  assert.equal(await host.receive('grp_remote', message), true)
  const deadline = Date.now() + 3000
  while (!provider.calls.some(call => call.method === 'send_encrypted_message')) {
    assert.ok(Date.now() < deadline, 'durable response was not produced')
    await yieldEventLoop()
  }
  await host.dispose()
  const journal = JSON.parse(await readFile(path.join(directory, 'remote-requests.json'), 'utf8'))
  assert.equal(journal.groups.grp_remote.requests['dev_android\0stable_request_1'].phase, 'done')
  const restored = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: directory,
    adapter: { capabilities: () => ['remote_task'], execute: async () => { calls++; return {} }, cancel: async () => ({}) } })
  await restored.ready
  assert.equal(await restored.receive('grp_remote', message), true)
  assert.equal(calls, 1)
  await assert.rejects(() => restored.receive('grp_remote', request('stable_request_1', 'session.prompt', { content: 'different' })), (error: any) => error?.code === 'conflict')
  await restored.dispose()
})

test('Cordis adapter waits for persistent defaults and forbids provider or credential edits', async () => {
  const values: Record<string, any> = {
    sessionController: { modelCatalog: async () => ({ groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', reasoning: { efforts: [{ id: 'high' }] } }] }] }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }) },
    permissionPresets: { catalog: () => ({ defaultOptions: [{ value: 'workspace-write' }] }), defaultPreset: 'workspace-write' },
  }
  let persisted = false
  const entries = [{ options: { name: '@deepseek-ai/dsh-agent-default-model' } }, { options: { name: '@deepseek-ai/dsh-permission-presets' } }]
  values.configEditor = { entries: () => entries, edit: async (_entry: any, change: any) => { change({}); await Promise.resolve(); persisted = true } }
  const adapter = createCordisRemoteDshAdapter({ get: (key: string) => values[key] })!
  const result: any = await adapter.execute('settings.update', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, 'stable_request_2', new AbortController().signal)
  assert.equal(persisted, true)
  assert.equal(result.persisted, true)
  await assert.rejects(() => adapter.execute('settings.update', { provider: 'deepseek-official', apiKey: 'forbidden' }, 'stable_request_3', new AbortController().signal), (error: any) => error?.code === 'permission_denied')
  await assert.rejects(() => adapter.execute('settings.update', { provider: 'deepseek-official', model: 'missing' }, 'stable_request_4', new AbortController().signal), (error: any) => error?.code === 'validation_failed')
})

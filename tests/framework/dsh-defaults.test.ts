import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createPlugin } from '../../src/framework/index.ts'
import { createCordisRemoteWebAdapter } from '../../src/framework/remote-web.ts'
import { createCordisRemoteDshAdapter, RemoteDshHost } from '../../src/framework/remote-host.ts'
import { MockConnectionProvider } from '../../src/framework/provider.ts'
import { PermissionSet, PERMISSIONS } from '../../src/framework/permissions.ts'

const root = path.resolve('..', 'Temp_SetupandLauncher', 'Feedback-20261016', 'plugin', 'tests')
const state: any = { server_connected: true, group_id: 'group-defaults', pairing_status: 'paired',
  local_device: { id: 'pc-defaults', name: 'PC', public_key: 'public-pc' },
  remote_device: { id: 'phone-defaults', name: 'Phone', public_key: 'public-phone', online: 'online', last_seen_at: null },
  members: [{ id: 'pc-defaults', active: true }, { id: 'phone-defaults', active: true }],
  capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true } }
async function directory(t: any) { await mkdir(root, { recursive: true }); const value = await mkdtemp(path.join(root, 'dsh-')); t.after(() => rm(value, { recursive: true, force: true })); return value }
const base = () => ({ capabilities: () => ['remote_task', 'remote_directory'], execute: async () => ({}), cancel: async () => ({}) })

test('schema2 enables DSH sharing without listing, uploading or receiving workspace files', async t => {
  const home = await directory(t)
  await writeFile(path.join(home, 'dafeiyu-connection-preferences.json'), JSON.stringify({ schema_version: 2,
    workspace_sync: { enabled: true, kind: 'dsh', dsh_home: home }, web_broadcast: { enabled: true } }))
  const provider = new MockConnectionProvider(state)
  const plugin = createPlugin({ provider, home, pollMs: 60_000, remoteHostAdapter: base() })
  t.after(() => plugin.dispose()); await plugin.ready; await plugin.runtime.pollOnce()
  assert.equal(plugin.getConfig().workspaceSync.kind, 'dsh'); assert.equal(plugin.getConfig().workspaceSync.root, null)
  assert.equal(plugin.getConfig().broadcast.enabled, true); assert.equal((await plugin.runtime.syncNow()).status, 'completed')
  assert.equal(plugin.runtime.getStatus().error_code, undefined)
  assert.ok(provider.calls.some(call => call.method === 'send_encrypted_message' && (call.input as any).kind === 'dsh_remote_capabilities'))
  assert.equal(provider.calls.some(call => /file|chunk|transfer/.test(call.method)), false)
  await assert.rejects(() => plugin.runtime.syncNow('secret.txt'), (error: any) => error.code === 'permission_denied')
})

test('old native file root and disabled toggles migrate into DSH defaults without touching the path', async t => {
  const home = await directory(t)
  await writeFile(path.join(home, 'dafeiyu-connection-preferences.json'), JSON.stringify({ schema_version: 1,
    workspace_sync: { enabled: false, root: path.join(home, 'missing-user-workspace') }, web_broadcast: { enabled: false } }))
  const provider = new MockConnectionProvider(state)
  const plugin = createPlugin({ provider, home, pollMs: 60_000 })
  t.after(() => plugin.dispose()); await plugin.ready; await plugin.runtime.pollOnce()
  assert.equal(plugin.getConfig().workspaceSync.kind, 'dsh'); assert.equal(plugin.getConfig().workspaceSync.root, null)
  assert.equal(plugin.getConfig().workspaceSync.enabled, true); assert.equal(plugin.getConfig().broadcast.enabled, true)
  assert.equal((await plugin.runtime.syncNow()).status, 'waiting_for_host')
  assert.equal(provider.calls.some(call => /file|chunk|transfer/.test(call.method)), false)
})

test('DSH metadata remains available when the optional local directory picker cannot browse', async () => {
  const sessions = Object.fromEntries(['create', 'prompt', 'cancel', 'list', 'modelCatalog', 'follow', 'control'].map(name => [name, async () => ({})]))
  const adapter = createCordisRemoteDshAdapter({ sessionController: sessions, agentDefaultModel: { currentSelection: () => ({}) },
    workspaceRegistry: { list: () => [{ id: 'work-actual', path: 'G:/workspace', title: 'Actual DSH', sessionIds: ['session-actual'] }] } })
  assert.ok(adapter.capabilities().includes('remote_directory'))
  assert.deepEqual(await adapter.execute('workspace.list', {}, 'metadata-request', new AbortController().signal),
    { workspaces: [{ workspaceId: 'work-actual', path: 'G:/workspace', title: 'Actual DSH', sessionIds: ['session-actual'] }] })
  await adapter.dispose?.()
})

test('web capability waits for real authenticated HTML and required gateway services, then retracts on service loss', async t => {
  let htmlAvailable = false
  const server = http.createServer((request, response) => {
    if (request.url === '/?token=fixture-private') { response.writeHead(303, { 'set-cookie': 'dsh_session=fixture-cookie; HttpOnly; Path=/', location: './' }); response.end(); return }
    assert.equal(request.headers.cookie, 'dsh_session=fixture-cookie')
    response.writeHead(htmlAvailable ? 200 : 503, { 'content-type': 'text/html' }); response.end('<html>fixture DSH</html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const ctx: any = { webServer: { port: (server.address() as any).port }, connection: { authenticatedUrl: (url: string) => url + '?token=fixture-private' },
    typertGateway: { invoke: async () => ({}), wireStream: { open: async function* () {} } }, on: () => () => {} }
  const adapter = createCordisRemoteWebAdapter(ctx, base())
  t.after(() => adapter.dispose?.())
  assert.equal(adapter.capabilities().includes('remote_web_tunnel'), false)
  await adapter.refreshCapabilities?.(); assert.equal(adapter.capabilities().includes('remote_web_tunnel'), false)
  htmlAvailable = true
  await adapter.refreshCapabilities?.(); assert.equal(adapter.capabilities().includes('remote_web_tunnel'), true)
  delete ctx.typertGateway
  await adapter.refreshCapabilities?.(); assert.equal(adapter.capabilities().includes('remote_web_tunnel'), false)
})

test('unchanged capabilities are rebroadcast on the heartbeat interval', async t => {
  const provider = new MockConnectionProvider(state)
  const host = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: await directory(t), adapter: base() })
  t.after(() => host.dispose())
  const clock = t.mock.method(Date, 'now', () => 1_000_000)
  await host.advertise(state); await host.advertise(state)
  assert.equal(provider.calls.filter(call => call.method === 'send_encrypted_message').length, 1)
  clock.mock.mockImplementation(() => 1_016_000)
  await host.advertise(state)
  const sent = provider.calls.filter(call => call.method === 'send_encrypted_message').map(call => call.input as any)
  assert.equal(sent.length, 2); assert.notEqual(sent[0].idempotency_key, sent[1].idempotency_key)
})

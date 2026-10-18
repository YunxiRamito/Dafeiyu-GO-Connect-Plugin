import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultConfig, mergeConfig } from '../../src/framework/config.ts'
import { createBroadcastPayload, sanitizeIncomingBroadcast, MessageDeduplicator, sanitizeBroadcastUrl } from '../../src/framework/broadcast.ts'
import { createCleanupBatches, CacheCleanupCoordinator } from '../../src/framework/cache-cleanup.ts'
import { ConnectionPluginError, classifyConnectionState, toErrorEnvelope } from '../../src/framework/errors.ts'
import { ConnectionIpcClient } from '../../src/framework/ipc.ts'
import { decideSyncPath, isSensitivePath, remoteFileIdentifier } from '../../src/framework/path-policy.ts'
import { MockConnectionProvider, UnavailableConnectionProvider } from '../../src/framework/provider.ts'
import { PERMISSIONS, PermissionSet } from '../../src/framework/permissions.ts'
import { ensureDiskSpace, retry, sha256Bytes, TransferStateMachine } from '../../src/framework/transfer.ts'
import { registerConnectionCommands } from '../../src/framework/commands.ts'
import { RemoteDshClient } from '../../src/framework/remote.ts'
import { validateConnectionState } from '../../src/framework/launcher-provider.ts'

test('连接默认共享 DSH 和广播且 merge 保留显式文件同步兼容', () => {
  const defaults = createDefaultConfig()
  assert.equal(defaults.workspaceSync.enabled, true)
  assert.equal(defaults.workspaceSync.kind, 'dsh')
  assert.equal(defaults.workspaceSync.root, null)
  assert.equal(defaults.broadcast.enabled, true)
  assert.ok(defaults.workspaceSync.ignoreRules.includes('node_modules'))
  assert.ok(defaults.workspaceSync.ignoreRules.includes('*.pem'))
  const merged = mergeConfig({ workspaceSync: { enabled: true, root: 'G:\\workspace' } })
  assert.equal(merged.workspaceSync.enabled, true)
  assert.equal(merged.workspaceSync.root, 'G:\\workspace')
  assert.equal(merged.workspaceSync.kind, 'files')
  assert.equal(merged.broadcast.enabled, true)
})

test('路径只允许 root 内非敏感文件', () => {
  const root = 'G:\\workspace'
  assert.equal(decideSyncPath(root, 'G:\\workspace\\src\\main.ts', []).allowed, true)
  assert.equal(decideSyncPath(root, 'G:\\workspace\\.env', []).reason, 'sensitive')
  assert.equal(decideSyncPath(root, 'G:\\workspace\\certs\\device.pem', []).reason, 'sensitive')
  assert.equal(decideSyncPath(root, 'G:\\other\\x.ts', []).reason, 'outside_root')
  assert.equal(decideSyncPath(root, 'G:\\workspace\\node_modules\\x.js', ['node_modules']).reason, 'ignored')
  for (const value of ['token.json', 'cookies/session', 'private.key', 'cert.p12', 'cert.pfx', '.env.local', 'credentials/db.json']) assert.equal(isSensitivePath(value), true)
  assert.throws(() => remoteFileIdentifier('../escape.txt'))
})

test('hash 稳定且分块状态支持中断恢复、取消和失败重试', async () => {
  assert.equal(sha256Bytes(new TextEncoder().encode('hello')), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  const machine = new TransferStateMachine('tr_1', 'grp_1', 'file_1', 3)
  machine.markUploading(); machine.acknowledgeChunk(0); machine.acknowledgeChunk(1); machine.interrupt()
  const restored = TransferStateMachine.restore(machine.snapshot())
  restored.resume(); restored.acknowledgeChunk(2); restored.complete()
  assert.equal(restored.status, 'completed')
  assert.deepEqual(restored.acknowledgedChunks, [0, 1, 2])
  const cancelled = new TransferStateMachine('tr_2', 'grp_1', 'file_2', 1); cancelled.cancel(); assert.equal(cancelled.status, 'cancelled')
  let attempts = 0
  const result = await retry(async attempt => { attempts = attempt; if (attempt < 3) throw new Error('temporary'); return 'ok' }, { attempts: 3, delayMs: 0 })
  assert.equal(result, 'ok'); assert.equal(attempts, 3)
  await assert.rejects(() => retry(async () => { throw new Error('nope') }, { attempts: 2, delayMs: 0 }), (error: unknown) => error instanceof ConnectionPluginError && error.code === 'retry_exhausted')
})

test('磁盘空间不足和取消都有明确错误码', async () => {
  assert.throws(() => ensureDiskSpace(10, 11), (error: unknown) => error instanceof ConnectionPluginError && error.code === 'disk_space_low')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => retry(async () => 'never', { signal: controller.signal }), (error: unknown) => error instanceof ConnectionPluginError && error.code === 'request_cancelled')
})

test('网页 URL 脱敏，广播 payload 不携带凭据字段，接收端按纯文本处理', () => {
  const url = sanitizeBroadcastUrl('https://user:pass@example.com/a?ok=1&token=secret&session_id=x#fragment')
  assert.equal(url, 'https://example.com/a?ok=1')
  assert.throws(() => sanitizeBroadcastUrl('http://example.com'))
  assert.equal(sanitizeBroadcastUrl('http://localhost:3000/x', { allowLocalHttp: true }), 'http://localhost:3000/x')
  const payload = createBroadcastPayload({ url: 'https://example.com/?api_key=bad', title: '<b>Hello</b>', selection: '<script>alert(1)</script>', message: 'ok', sender_device_id: 'dev_1' }, { includeSelection: true })
  assert.equal(payload.url, 'https://example.com/')
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'cookie'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'Authorization'), false)
  assert.throws(() => createBroadcastPayload({ url: 'https://example.com', message: 'token=secret', sender_device_id: 'dev_1' }), (error: unknown) => error instanceof ConnectionPluginError && error.code === 'validation_failed')
  const safe = sanitizeIncomingBroadcast(payload)
  assert.equal(safe.title, 'Hello')
  assert.equal(safe.selection, 'alert(1)')
})

test('重复消息去重', () => {
  const dedupe = new MessageDeduplicator()
  assert.equal(dedupe.accept('m1'), true)
  assert.equal(dedupe.accept('m1'), false)
  dedupe.clear(); assert.equal(dedupe.accept('m1'), true)
})

test('IPC envelope 传递 request id，启动器不存在时不伪造连接', async () => {
  const unavailable = new UnavailableConnectionProvider()
  await assert.rejects(() => unavailable.get_connection_state(), (error: unknown) => error instanceof ConnectionPluginError && error.code === 'launcher_unavailable')
  const sent: any[] = []
  const client = new ConnectionIpcClient({ request: async envelope => { sent.push(envelope); return { success: true, request_id: envelope.request_id, data: { ok: true } } } })
  assert.deepEqual(await client.call('get_connection_state', {}), { ok: true })
  assert.equal(sent[0].protocol, 'dafeiyu-go.connection.v1')
  assert.ok(sent[0].request_id)
  assert.equal(toErrorEnvelope(new ConnectionPluginError('request_timeout', 'timeout'), 'req_1').error_code, 'request_timeout')
})

test('server_connected 与 remote online 分离，presence 状态可判定', () => {
  assert.equal(classifyConnectionState({ server_connected: true, pairing_status: 'paired', remote_device: { online: 'unknown' } }), 'presence_unknown')
  assert.equal(classifyConnectionState({ server_connected: true, pairing_status: 'paired', remote_device: { online: 'offline' } }), 'remote_offline')
  assert.equal(classifyConnectionState({ server_connected: true, pairing_status: 'paired', remote_device: { online: 'online' } }), null)
  assert.equal(classifyConnectionState({ server_connected: true, pairing_status: 'paired', remote_device: null }), 'presence_unknown')
})

test('可选硬件快照支持多磁盘，旧状态仍通过验证', () => {
  const base: any = {
    protocol: 'dafeiyu-go.connection.v1', server_connected: true, group_id: 'g', pairing_status: 'paired',
    local_device: { id: 'local', name: 'Local', public_key: 'pk' },
    remote_device: { id: 'remote', name: 'PC', public_key: 'rpk', online: 'online', last_seen_at: null },
    capabilities: { workspace_sync: true, web_broadcast: true, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true },
  }
  assert.equal(validateConnectionState(base), base)
  base.remote_device.hardware = {
    device_name: 'PC', system: 'Windows 11', cpu: 'CPU', gpu: 'GPU',
    memory: { used_bytes: 1, total_bytes: 2 },
    network: { upload_bytes_per_second: 3, download_bytes_per_second: 4 },
    storage: [{ name: 'C:', used_bytes: 5, total_bytes: 6 }, { name: 'D:', used_bytes: 7, total_bytes: 8 }],
    updated_at: '2026-10-17T00:00:00Z',
  }
  base.capabilities.device_hardware = true
  assert.equal(validateConnectionState(base), base)
  assert.throws(() => validateConnectionState({ ...base, remote_device: { ...base.remote_device, hardware: { ...base.remote_device.hardware, storage: [{ name: 'C:', used_bytes: 'bad', total_bytes: 1 }] } } }), ConnectionPluginError)
})

test('缓存清理最多每批 100 项，使用稳定 idempotency key 并保持组隔离', async () => {
  const ids = Array.from({ length: 201 }, (_, index) => `ft_${index}`)
  const batches = createCleanupBatches('grp_a', ids)
  assert.deepEqual(batches.map(batch => batch.file_ids.length), [100, 100, 1])
  assert.equal(batches[0].idempotency_key, 'dafeiyu-cache-cleanup:grp_a:0')
  assert.ok(batches.every(batch => batch.group_id === 'grp_a'))
  const provider = new MockConnectionProvider()
  const results = await new CacheCleanupCoordinator(provider).cleanup('grp_a', ids.slice(0, 2))
  assert.equal(results[0].group_id, 'grp_a')
  assert.equal((provider.calls.at(-1)?.input as any).group_id, 'grp_a')
})

test('权限清单包含高层能力且不包含凭据/身份写入能力', () => {
  assert.ok(PERMISSIONS.includes('connection.file.transfer'))
  assert.ok(PERMISSIONS.includes('broadcast.send'))
  assert.equal(PERMISSIONS.includes('aries_token.read' as any), false)
  const permissions = new PermissionSet(['connection.read'])
  permissions.require('connection.read')
  assert.throws(() => permissions.require('workspace.write'))
})

test('命令注册入口使用现有 host，不创建第二套 CLI', async () => {
  const commands: any[] = []
  let config: any = createDefaultConfig()
  const provider = new MockConnectionProvider({ server_connected: false, pairing_status: 'unknown' })
  registerConnectionCommands({ register: command => commands.push(command) }, { provider, permissions: new PermissionSet(PERMISSIONS), getConfig: () => config, setConfig: patch => { config = mergeConfig({ ...config, ...(patch as any) }) } })
  assert.ok(commands.some(command => command.name === 'dsh connection status'))
  const status = await commands.find(command => command.name === 'dsh connection status').handler({})
  assert.equal(status.status, 'waiting_for_connection')
  await commands.find(command => command.name === 'dsh connection sync enable').handler({})
  assert.equal(config.workspaceSync.enabled, true)
})

test('0.3.0 remote DSH uses capabilities, stable request ids and polls instead of resubmitting', async () => {
  const provider = new MockConnectionProvider({
    server_connected: true,
    group_id: 'grp_remote',
    pairing_status: 'paired',
    remote_device: { id: 'dev_pc', name: 'PC', public_key: 'pk', online: 'online', last_seen_at: null },
    capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true, remote_task: true, remote_directory: true, remote_settings: true, remote_web_tunnel: true },
  })
  const remote = new RemoteDshClient(provider, new PermissionSet(PERMISSIONS))
  const requestId = 'remote_req_123456'
  const accepted = await remote.submit({ group_id: 'grp_remote', request_id: requestId, operation: 'models.catalog', payload: {} })
  assert.equal(accepted.data.request_id, requestId)
  await remote.events({ group_id: 'grp_remote', request_id: requestId, after_sequence: 0 })
  assert.equal(provider.calls.filter(call => call.method === 'submit_remote_task').length, 1)
  assert.equal(provider.calls.filter(call => call.method === 'poll_remote_events').length, 1)
  await assert.rejects(() => remote.http({ group_id: 'grp_remote', request_id: requestId, method: 'GET', path: '/api/remote.mux', headers: { Cookie: 'secret' } }), (error: any) => error?.code === 'permission_denied')
})




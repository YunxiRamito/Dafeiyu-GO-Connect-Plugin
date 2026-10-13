import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { setImmediate as turn } from 'node:timers/promises'
import { createCordisRemoteWebAdapter, remoteWebHttpFrames, remoteWebPath, RemoteWebStaticClient, RemoteWebRpcRouter, validateRemoteWebHttp } from '../../src/framework/remote-web.ts'
import { MockConnectionProvider } from '../../src/framework/provider.ts'
import { RemoteDshHost, REMOTE_DSH_PROTOCOL } from '../../src/framework/remote-host.ts'
import { PermissionSet, PERMISSIONS } from '../../src/framework/permissions.ts'

const signal = () => new AbortController().signal
const context = { group: 'group-fixture', peer: 'phone-fixture' }
const base = (execute = async () => ({})) => ({ capabilities: () => ['remote_task'], execute, cancel: async () => ({}) })
const rpcBody = (method: string, args: any) => Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'rpc-fixture-123', method, payload: { args } })).toString('base64')

test('path policy rejects normalization escapes, authentication queries, authorities and fragments', () => {
  for (const value of ['/../secret', '/assets/%2e%2e/secret', '/assets/%252e%252e/secret', '//evil/file', '/assets/%5cfile', '/assets/x#token', '/?token=secret', '/assets/x?q=hidden', '/api/session/modelCatalog?token=secret'])
    assert.throws(() => remoteWebPath(value))
  assert.equal(remoteWebPath('/assets/index.js?v=42'), '/assets/index.js?v=42')
  assert.equal(remoteWebPath('/plugins/??@deepseek-ai/dsh-client-connection/client.js,custom/client.js&rev=123456abcdef'), '/plugins/??@deepseek-ai/dsh-client-connection/client.js,custom/client.js&rev=123456abcdef')
  assert.equal(validateRemoteWebHttp({ method: 'GET', path: '/plugins/@deepseek-ai/dsh-client-ui-chat/client.abc123.js?rev=123456abcdef' }).method, 'GET')
  for (const value of ['/plugins/??../client.js&rev=123456abcdef', '/plugins/??@scope/name/client.js&rev=123456abcdef&token=secret', '/plugins/??@scope/name/../../secret&rev=123456abcdef']) assert.throws(() => remoteWebPath(value))
})

test('HTTP input rejects PC auth headers, oversized bodies, methods and non-static GET routes', () => {
  const valid = { method: 'GET', path: '/assets/index.js', headers: { accept: '*/*' } }
  assert.equal(validateRemoteWebHttp(valid).body.length, 0)
  for (const headers of [{ Cookie: 'private' }, { Authorization: 'Bearer private' }, { Origin: 'http://evil' }, { host: 'evil' }, { accept: 'a\r\nCookie: bad' }]) assert.throws(() => validateRemoteWebHttp({ ...valid, headers }))
  for (const input of [{ ...valid, method: 'DELETE' }, { ...valid, path: '/api/session/attachment' }, { ...valid, path: '/files/private' }, { ...valid, body_base64: 'YQ==' }, { ...valid, method: 'POST', path: '/api', headers: {}, body_base64: 'YQ==' }, { ...valid, method: 'POST', path: '/api', headers: { 'content-type': 'application/json' }, body_base64: Buffer.alloc(65537).toString('base64') }]) assert.throws(() => validateRemoteWebHttp(input))
})

test('HTTP response uses exact 48 KiB chunks and a total digest', async () => {
  const body = Buffer.alloc(130_000, 77)
  const frames = []
  for await (const frame of remoteWebHttpFrames(200, { 'content-type': 'text/javascript' }, body)) frames.push(frame)
  assert.equal(frames[0].kind, 'http.head')
  const chunks = frames.filter(frame => frame.kind === 'http.chunk') as Array<any>
  assert.deepEqual(chunks.map(frame => frame.index), [0, 1, 2])
  assert.ok(chunks.every(frame => Buffer.from(frame.bytes, 'base64').length <= 49152))
  assert.deepEqual(Buffer.concat(chunks.map(frame => Buffer.from(frame.bytes, 'base64'))), body)
  assert.deepEqual(frames.at(-1), { kind: 'http.end', size: body.length, sha256: createHash('sha256').update(body).digest('hex') })
})

test('PC private auth exchanges token on root only and strips every upstream credential', async t => {
  const seen: Array<any> = []
  const server = http.createServer((request, response) => {
    seen.push({ path: request.url, cookie: request.headers.cookie, origin: request.headers.origin, host: request.headers.host })
    if (request.url === '/?token=private-launch-secret') { response.writeHead(303, { 'set-cookie': 'dsh_session=private-cookie-secret; HttpOnly; Path=/', location: './' }); response.end(); return }
    if (request.headers.cookie !== 'dsh_session=private-cookie-secret') { response.writeHead(401); response.end(); return }
    if (request.url === '/assets/leak.js') { response.end('private-launch-secret'); return }
    if (request.url === '/assets/redirect.js') { response.writeHead(302, { location: 'http://evil/?token=private-launch-secret' }); response.end(); return }
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'another=secret', 'x-upstream-secret': 'hidden' }); response.end('<html>real static fixture</html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as any).port
  const client = new RemoteWebStaticClient(() => `http://127.0.0.1:${port}/`, root => root + '?token=private-launch-secret')
  const first = await client.get(validateRemoteWebHttp({ method: 'GET', path: '/', headers: {} }), signal())
  const second = await client.get(validateRemoteWebHttp({ method: 'GET', path: '/assets/index.js?v=1', headers: {} }), signal())
  assert.equal(first.status, 200); assert.equal(second.status, 200)
  assert.deepEqual(first.headers, { 'content-type': 'text/html' })
  assert.equal(seen.filter(row => row.path.includes('token')).length, 1)
  assert.equal(seen[1].cookie, 'dsh_session=private-cookie-secret')
  assert.equal(seen[1].origin, `http://127.0.0.1:${port}`)
  assert.ok(!JSON.stringify(first).includes('private-'))
  await assert.rejects(() => client.get(validateRemoteWebHttp({ method: 'GET', path: '/assets/leak.js' }), signal()), (error: any) => error.code === 'permission_denied')
  await assert.rejects(() => client.get(validateRemoteWebHttp({ method: 'GET', path: '/assets/redirect.js' }), signal()), (error: any) => error.code === 'permission_denied')
})

test('HTTP RPC uses persistent selection adapter; provider editing cannot fall through to gateway', async () => {
  let saved = false
  let gatewayCalls = 0
  const adapter = base(async (operation: string, payload: any) => {
    assert.equal(operation, 'session.selectModel'); assert.equal(payload.provider, 'configured-provider')
    await turn(); saved = true; return { selected: payload, persisted: true }
  })
  const router = new RemoteWebRpcRouter(adapter, () => ({ invoke: () => { gatewayCalls++ } }))
  const result: any = await router.invoke('session/selectModel', { request: { sessionId: 'session-123', provider: 'configured-provider', model: 'model-123' } }, 'request-fixture-123', signal(), context)
  assert.equal(saved, true); assert.equal(result.persisted, true)
  for (const method of ['configEditor/edit', 'credentials/read', 'modelProviders/delete', 'modelProviders/reorder', '$events/result']) await assert.rejects(() => router.invoke(method, {}, 'request-fixture-123', signal(), context), (error: any) => error.code === 'permission_denied')
  await assert.rejects(() => router.invoke('session/modelCatalog', { apiKey: 'hidden' }, 'request-fixture-123', signal(), context), (error: any) => error.code === 'permission_denied')
  assert.equal(gatewayCalls, 0)
})

test('gzip static resources keep compression while private tokens and malformed gzip fail closed', async t => {
  const server = http.createServer((request, response) => {
    if (request.url === '/?token=private-gzip-launch') { response.writeHead(303, { 'set-cookie': 'dsh_session=private-gzip-cookie; HttpOnly; Path=/', location: './' }); response.end(); return }
    assert.equal(request.headers['accept-encoding'], 'gzip')
    if (request.url === '/assets/leak.js') { response.writeHead(200, { 'content-encoding': 'gzip' }); response.end(gzipSync(Buffer.from('private-gzip-cookie'))); return }
    if (request.url === '/assets/invalid.js') { response.writeHead(200, { 'content-encoding': 'gzip' }); response.end('invalid'); return }
    response.writeHead(200, { 'content-type': 'text/javascript', 'content-encoding': 'gzip', 'set-cookie': 'private-upstream-header' })
    response.end(gzipSync(Buffer.alloc(9 * 1024 * 1024, 65)))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close() })
  const root = `http://127.0.0.1:${(server.address() as any).port}/`
  const client = new RemoteWebStaticClient(() => root, base => base + '?token=private-gzip-launch')
  const response = await client.get(validateRemoteWebHttp({ method: 'GET', path: '/assets/app.js' }), signal())
  assert.equal(response.headers['content-encoding'], 'gzip'); assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(gunzipSync(response.body).length, 9 * 1024 * 1024)
  await assert.rejects(() => client.get(validateRemoteWebHttp({ method: 'GET', path: '/assets/leak.js' }), signal()), (error: any) => error.code === 'permission_denied')
  await assert.rejects(() => client.get(validateRemoteWebHttp({ method: 'GET', path: '/assets/invalid.js' }), signal()), (error: any) => error.code === 'protocol_error')
})

test('browser prompt receipt identity reaches actual session prompt while outer HTTP intent stays separate', async () => {
  let received = ''
  const router = new RemoteWebRpcRouter(base(async (operation, payload, requestId) => {
    assert.equal(operation, 'session.prompt'); received = requestId; assert.equal(payload.requestId, requestId); return { accepted: true }
  }), () => ({}))
  await router.invoke('session/prompt', { request: { sessionId: 'session-123', requestId: 'browser-receipt-123',
    content: [{ type: 'text', text: 'synthetic input' }] } }, 'outer-http-intent-123', signal(), context)
  assert.equal(received, 'browser-receipt-123')
  await assert.rejects(() => router.invoke('session/prompt', { request: { sessionId: 'session-123', content: [] } },
    'outer-http-intent-123', signal(), context), (error: any) => error.code === 'validation_failed')
})

test('web workspace follow and read-only session history use actual Gateway with positive output projection', async () => {
  const gateway = { invoke: async (request: any) => { assert.equal(request.namespace, 'session'); assert.equal(request.method, 'projections'); return { asOfSeq: 10, values: { title: 'Actual title', credentials: 'private-value' } } },
    wireStream: { open: async (endpoint: string, payload: any) => { assert.equal(endpoint, 'workspace/follow'); assert.deepEqual(payload, { args: {} }); return (async function* () { yield { type: 'baseline', value: { items: [{ workspaceId: 'work-1', path: '/actual/pc/work', title: 'Workspace', sessionIds: ['session-1'], createdAt: 'time', updatedAt: 'time', secret: 'private-value' }], archivedSessionIds: [], pinnedSessionIds: [] } } })() } } }
  const router = new RemoteWebRpcRouter(base(), () => gateway)
  const projection: any = await router.invoke('session/projections', { request: { sessionId: 'session-1' } }, 'read-projection-123', signal(), context)
  assert.equal(projection.values.title, 'Actual title'); assert.ok(!JSON.stringify(projection).includes('private-value'))
  for await (const frame of await router.open('workspace/follow', { args: {} }, signal())) { assert.equal((frame as any).value.items[0].path, '/actual/pc/work'); assert.ok(!JSON.stringify(frame).includes('private-value')) }
  await assert.rejects(() => router.invoke('session/page', { request: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 0, secret: 1 } }, 'bad-read-123', signal(), context))
})

test('web wrapper stays unadvertised and frames exact HTTP RPC envelopes', async () => {
  let calls = 0
  const adapter = createCordisRemoteWebAdapter({}, base(async () => { calls++; return { groups: [] } }))
  assert.equal(adapter.capabilities().includes('remote_web_tunnel'), false)
  const payload = { method: 'POST', path: '/api/session/modelCatalog', headers: { 'content-type': 'application/json' }, body_base64: rpcBody('session/modelCatalog', {}) }
  assert.deepEqual(await adapter.execute('web.http', payload, 'execute-http-123', signal(), context), { stream: 'http' })
  const frames = []
  for await (const frame of adapter.follow!(payload, signal(), 'web.http', 'execute-http-123', context)) frames.push(frame)
  const body = Buffer.concat(frames.filter((frame: any) => frame.kind === 'http.chunk').map((frame: any) => Buffer.from(frame.bytes, 'base64')))
  assert.deepEqual(JSON.parse(body.toString()), { type: 'server-response', rpcId: 'rpc-fixture-123', result: { ok: true, value: { groups: [] } } })
  assert.equal(calls, 1)
  await assert.rejects(() => adapter.execute('web.http', payload, 'without-context', signal()))
})

test('mux generations bind sender, exact sequence, public projection and cancellation', async () => {
  let gatewayOpens = 0
  let held!: () => void
  const wait = new Promise<void>(resolve => { held = resolve })
  const gateway = { wireStream: { open: async (endpoint: string, payload: any, _uplink: any, _peer: any, abort: AbortSignal) => {
    gatewayOpens++; assert.equal(endpoint, 'session/follow'); assert.equal(payload.args.request.address.sessionId, 'session-fixture')
    return (async function* () { yield { type: 'event', event: { type: 'assistant/message', seq: 1, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'public output' }] }, authentication: 'private' } } }; await Promise.race([wait, new Promise<void>(resolve => abort.addEventListener('abort', () => resolve(), { once: true }))]) })()
  } } }
  const adapter = createCordisRemoteWebAdapter({ typertGateway: gateway }, base())
  const result: any = await adapter.execute('web.socket', { path: '/api/remote.mux' }, 'socket-request-123', signal(), context)
  const open = { type: 'open', streamId: 'stream-fixture-123', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'session-fixture' }, maxMessages: 20 } } } }
  await assert.rejects(() => adapter.execute('web.socket.send', { socket_id: result.socket_id, sequence: 0, frame: open }, 'send-request-123', signal(), { ...context, peer: 'other-phone' }), (error: any) => error.code === 'permission_denied')
  const next: any = await adapter.execute('web.socket.send', { socket_id: result.socket_id, sequence: 0, frame: open }, 'send-request-123', signal(), context)
  assert.equal(next.next_sequence, 1)
  await adapter.execute('web.socket.send', { socket_id: result.socket_id, sequence: 0, frame: open }, 'same-send-123', signal(), context)
  await assert.rejects(() => adapter.execute('web.socket.send', { socket_id: result.socket_id, sequence: 0, frame: { type: 'cancel', streamId: 'stream-fixture-123' } }, 'changed-send-123', signal(), context), (error: any) => error.code === 'conflict')
  const source = adapter.follow!({}, signal(), 'web.socket', 'socket-request-123', context)[Symbol.asyncIterator]()
  const first: any = await source.next()
  assert.equal(first.value.kind, 'ws.frame'); assert.equal(first.value.frame.type, 'item')
  assert.ok(!JSON.stringify(first).includes('private'))
  assert.equal(gatewayOpens, 1)
  held(); await source.return!()
  await assert.rejects(() => adapter.execute('web.socket.send', { socket_id: result.socket_id, sequence: 1, frame: open }, 'after-close-123', signal(), context), (error: any) => error.code === 'permission_denied')
})

test('durable HTTP intent prevents a repeated POST execution across host restart', async t => {
  const root = path.resolve('..', 'Temp_Android', 'qa', 'remote-web-host'); await mkdir(root, { recursive: true })
  const directory = await mkdtemp(path.join(root, 'host-'))
  const state: any = { server_connected: true, group_id: context.group, pairing_status: 'paired', local_device: { id: 'pc-fixture', name: 'PC', public_key: 'pc-key' },
    remote_device: { id: context.peer, name: 'phone', public_key: 'phone-key', online: 'online', last_seen_at: null }, members: [{ id: 'pc-fixture', active: true }, { id: context.peer, active: true }],
    capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true } }
  let calls = 0
  const web = createCordisRemoteWebAdapter({}, base(async () => { calls++; return { accepted: true } }))
  const adapter = { ...web, capabilities: () => ['remote_task', 'remote_web_tunnel'] }
  const provider = new MockConnectionProvider(state)
  let host = new RemoteDshHost({ provider, adapter, permissions: new PermissionSet(PERMISSIONS), stateDirectory: directory })
  const request: any = { message_id: 'http-fixture-message', kind: 'dsh_remote_request', sender_device_id: context.peer, created_at: '', body: { protocol: REMOTE_DSH_PROTOCOL,
    target_device_id: 'pc-fixture', request_id: 'http-post-fixture-123', operation: 'web.http', payload: { method: 'POST', path: '/api/session/prompt', headers: { 'content-type': 'application/json' }, body_base64: rpcBody('session/prompt', { request: { sessionId: 'session-fixture', requestId: 'browser-prompt-fixture-123', mode: 'queue', content: [{ type: 'text', text: 'offline fixture' }] } }) } } }
  await host.receive(context.group, request)
  const deadline = Date.now() + 5000
  let consumed = -1
  while (!provider.calls.some(call => call.method === 'send_encrypted_message' && (call.input as any).body?.type === 'closed')) {
    assert.ok(Date.now() < deadline)
    const delivered = provider.calls.filter(call => call.method === 'send_encrypted_message' && (call.input as any).body?.request_id === request.body.request_id).map(call => (call.input as any).body.sequence)
    const sequence = Math.max(consumed, ...delivered)
    if (sequence > consumed) {
      await host.receive(context.group, { ...request, kind: 'dsh_remote_ack', body: { protocol: REMOTE_DSH_PROTOCOL, request_id: request.body.request_id, target_device_id: 'pc-fixture', sequence } })
      consumed = sequence
    }
    await turn()
  }
  await host.dispose()
  host = new RemoteDshHost({ provider, adapter, permissions: new PermissionSet(PERMISSIONS), stateDirectory: directory }); t.after(() => host.dispose())
  await host.receive(context.group, request)
  assert.equal(calls, 1)
})

test('host compacts only completed reads while preserving old prompt and settings intent', async t => {
  const root = path.resolve('..', 'Temp_Android', 'qa', 'remote-web-host'); await mkdir(root, { recursive: true })
  const directory = await mkdtemp(path.join(root, 'compact-'))
  const state: any = { server_connected: true, group_id: context.group, pairing_status: 'paired', local_device: { id: 'pc-fixture', name: 'PC', public_key: 'pc-key' },
    remote_device: { id: context.peer, name: 'phone', public_key: 'phone-key', online: 'online', last_seen_at: null }, members: [{ id: 'pc-fixture', active: true }, { id: context.peer, active: true }],
    capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true } }
  const receipts: Record<string, any> = {}
  for (let index = 0; index < 220; index++) {
    const id = `catalog-previous-${index}`
    receipts[`${context.peer}\0${id}`] = { hash: '0'.repeat(64), sender: context.peer, request_id: id, operation: 'models.catalog', phase: 'done', next_sequence: 1, result: {} }
  }
  for (const [index, operation] of ['session.prompt', 'session.create', 'settings.update', 'workspace.resolve'].entries()) {
    const id = `write-previous-${index}`
    receipts[`${context.peer}\0${id}`] = { hash: '1'.repeat(64), sender: context.peer, request_id: id, operation, phase: 'done', next_sequence: 1, result: {} }
  }
  await writeFile(path.join(directory, 'remote-requests.json'), JSON.stringify({ version: 1, groups: { [context.group]: { requests: receipts } } }))
  const provider = new MockConnectionProvider(state)
  const host = new RemoteDshHost({ provider, adapter: base(), permissions: new PermissionSet(PERMISSIONS), stateDirectory: directory }); t.after(() => host.dispose())
  await host.receive(context.group, { message_id: 'compact-message-123', kind: 'dsh_remote_request', sender_device_id: context.peer, created_at: '', body: {
    protocol: REMOTE_DSH_PROTOCOL, target_device_id: 'pc-fixture', request_id: 'fresh-read-123', operation: 'models.catalog', payload: {} } })
  await host.dispose()
  const saved = JSON.parse(await readFile(path.join(directory, 'remote-requests.json'), 'utf8')).groups[context.group].requests
  assert.equal(Object.values(saved).filter((row: any) => row.operation === 'models.catalog').length, 65)
  for (const index of [0, 1, 2, 3]) assert.ok(saved[`${context.peer}\0write-previous-${index}`])
})

test('web host stops at four frames until the exact sender ACK advances its window', async t => {
  const root = path.resolve('..', 'Temp_Android', 'qa', 'remote-web-host'); await mkdir(root, { recursive: true })
  const state: any = { server_connected: true, group_id: context.group, pairing_status: 'paired', local_device: { id: 'pc-fixture', name: 'PC', public_key: 'pc-key' },
    remote_device: { id: context.peer, name: 'phone', public_key: 'phone-key', online: 'online', last_seen_at: null }, members: [{ id: 'pc-fixture', active: true }, { id: context.peer, active: true }, { id: 'other-phone', active: true }],
    capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true } }
  const provider = new MockConnectionProvider(state)
  const host = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: await mkdtemp(path.join(root, 'window-')),
    adapter: { capabilities: () => ['remote_task', 'remote_web_tunnel'], execute: async () => ({ stream: 'http' }), cancel: async () => ({}),
      follow: async function* () { for (let index = 0; index < 10; index++) yield { kind: 'fixture', index } } } }); t.after(() => host.dispose())
  const body = { protocol: REMOTE_DSH_PROTOCOL, request_id: 'web-window-123', target_device_id: 'pc-fixture', operation: 'web.http', payload: { method: 'GET' } }
  await host.receive(context.group, { message_id: 'window-message', kind: 'dsh_remote_request', sender_device_id: context.peer, created_at: '', body })
  const sent = () => provider.calls.filter(call => call.method === 'send_encrypted_message' && (call.input as any).body?.request_id === body.request_id)
  const deadline = Date.now() + 3000
  while (sent().length < 4) { assert.ok(Date.now() < deadline); await turn() }
  for (let index = 0; index < 40; index++) await turn()
  assert.equal(sent().length, 4)
  await host.receive(context.group, { message_id: 'wrong-ack', kind: 'dsh_remote_ack', sender_device_id: 'other-phone', created_at: '',
    body: { protocol: REMOTE_DSH_PROTOCOL, request_id: body.request_id, target_device_id: 'pc-fixture', sequence: 3 } })
  for (let index = 0; index < 40; index++) await turn()
  assert.equal(sent().length, 4)
  await host.receive(context.group, { message_id: 'real-ack', kind: 'dsh_remote_ack', sender_device_id: context.peer, created_at: '',
    body: { protocol: REMOTE_DSH_PROTOCOL, request_id: body.request_id, target_device_id: 'pc-fixture', sequence: 3 } })
  while (sent().length < 8) { assert.ok(Date.now() < deadline); await turn() }
  assert.equal(sent().length, 8)
  await host.receive(context.group, { message_id: 'cancel-window', kind: 'dsh_remote_cancel', sender_device_id: context.peer, created_at: '',
    body: { protocol: REMOTE_DSH_PROTOCOL, request_id: body.request_id, target_device_id: 'pc-fixture' } })
})

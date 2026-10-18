import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { MockConnectionProvider } from '../../src/framework/provider.ts'
import { PermissionSet, PERMISSIONS } from '../../src/framework/permissions.ts'
import { ConnectionPluginError } from '../../src/framework/errors.ts'
import { RemoteDshClient } from '../../src/framework/remote.ts'
import { RemoteDshHost, createCordisRemoteDshAdapter, REMOTE_DSH_PROTOCOL } from '../../src/framework/remote-host.ts'

const root = path.resolve('..', 'Temp_Android', 'qa', 'connect-remote-host-0.3.0')
const state = {
  server_connected: true, group_id: 'grp_remote', pairing_status: 'paired' as const,
  local_device: { id: 'dev_pc', name: 'PC', public_key: 'pc-pk' },
  remote_device: { id: 'dev_android', name: 'Android', public_key: 'android-pk', online: 'online' as const, last_seen_at: null },
  members: [{ id: 'dev_pc', active: true }, { id: 'dev_android', active: true }, { id: 'dev_other_pc', active: true }],
  capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true },
}
const allowed = () => new PermissionSet(PERMISSIONS)
const request = (id: string, operation = 'session.create', payload: any = {}) => ({
  message_id: `message-${id}`, sender_device_id: 'dev_android', created_at: '', kind: 'dsh_remote_request',
  body: { protocol: REMOTE_DSH_PROTOCOL, request_id: id, target_device_id: 'dev_pc', operation, payload },
})
async function directory() { await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, 'host-')) }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000
  while (!condition()) { assert.ok(Date.now() < deadline, 'fixture did not reach its expected boundary'); await yieldEventLoop() }
}
function messages(provider: MockConnectionProvider, kind = 'dsh_remote_event') {
  return provider.calls.filter(call => call.method === 'send_encrypted_message' && (call.input as any).kind === kind).map(call => call.input as any)
}
async function journal(location: string) { return JSON.parse(await readFile(path.join(location, 'remote-requests.json'), 'utf8')) }
const receipt = (value: any, id: string) => value.groups.grp_remote.requests[`dev_android\0${id}`]
function adapterFixture() {
  let selected: any = { provider: 'provider-one', model: 'model-a', reasoningEffort: 'high' }
  let sandbox = 'workspace-write'
  const writes: any[] = []
  const values: any = {
    sessionController: {
      modelCatalog: async () => ({ groups: [{ id: 'provider-one', models: [
        { id: 'model-a', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }, { id: 'model-b' },
      ] }] }),
      create: async (payload: any) => ({ sessionId: payload.sessionId }), prompt: async () => ({ accepted: true }), cancel: () => ({ accepted: true }),
      list: async () => [], follow: async function* () {}, control: async function* () {}, selectModel: async () => ({}),
    },
    agentDefaultModel: { currentSelection: () => ({ ...selected }) },
    permissionPresets: { catalog: () => ({ defaultOptions: [{ value: 'read-only' }, { value: 'workspace-write' }], defaultPreset: sandbox }), get defaultPreset() { return sandbox } },
    workspaceRegistry: { list: () => [] }, directoryPickerController: { list: async () => ({ entries: [] }) },
  }
  const entries = [{ options: { name: '@deepseek-ai/dsh-agent-default-model' } }, { options: { name: '@deepseek-ai/dsh-permission-presets' } }]
  values.configEditor = { entries: () => entries, edit: async (entry: any, change: any) => {
    const next = change(entry === entries[0] ? selected : { defaultPreset: sandbox })
    writes.push({ name: entry.options.name, next })
    if (entry === entries[0]) selected = next
    else sandbox = next.defaultPreset
  } }
  return { values, entries, writes, adapter: createCordisRemoteDshAdapter({ get: (key: string) => values[key] }) }
}

test('group-visible requests require the explicitly selected PC and an active sender', async t => {
  let calls = 0
  const host = new RemoteDshHost({ provider: new MockConnectionProvider(state), permissions: allowed(), stateDirectory: await directory(),
    adapter: { capabilities: () => ['remote_task'], execute: async () => { calls++; return {} }, cancel: async () => ({}) } })
  t.after(() => host.dispose())
  const other = request('wrong_target_123'); other.body.target_device_id = 'dev_other_pc'
  assert.equal(await host.receive('grp_remote', other), false)
  const missing = request('missing_target_123'); delete (missing.body as any).target_device_id
  assert.equal(await host.receive('grp_remote', missing), false)
  const inactive = { ...request('inactive_sender_123'), sender_device_id: 'dev_removed' }
  await assert.rejects(() => host.receive('grp_remote', inactive), (error: any) => error.code === 'revoked')
  const noRequestId = request('missing_identity_123'); delete (noRequestId.body as any).request_id
  await assert.rejects(() => host.receive('grp_remote', noRequestId), (error: any) => error.code === 'protocol_error')
  await assert.rejects(() => host.receive('__proto__', request('invalid_group_123')), (error: any) => error.code === 'protocol_error')
  assert.equal(calls, 0)
})

test('capability changes use distinct message keys and omit ungranted settings/directory', async t => {
  const provider = new MockConnectionProvider(state)
  let capabilities = ['remote_task']
  const host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: await directory(),
    adapter: { capabilities: () => capabilities, execute: async () => ({}), cancel: async () => ({}) } })
  t.after(() => host.dispose())
  await host.advertise(state); await host.advertise(state)
  capabilities = ['remote_task', 'remote_settings']; await host.advertise(state)
  capabilities = []; await host.advertise(state)
  const sent = messages(provider, 'dsh_remote_capabilities')
  assert.equal(sent.length, 3)
  assert.equal(new Set(sent.map(item => item.idempotency_key)).size, 3)
  assert.deepEqual(sent[2].body.capabilities, [])
  const restricted = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS.filter(item => !['connection.remote.directory', 'connection.remote.settings'].includes(item))), stateDirectory: await directory(),
    adapter: { capabilities: () => ['remote_task', 'remote_directory', 'remote_settings'], execute: async () => ({}), cancel: async () => ({}) } })
  t.after(() => restricted.dispose())
  await restricted.advertise(state)
  assert.deepEqual(messages(provider, 'dsh_remote_capabilities').at(-1).body.capabilities, ['remote_task', 'remote_result_chunks_v1'])
  await assert.rejects(() => restricted.receive('grp_remote', request('directory_gate_123', 'directory.list')), (error: any) => error.code === 'permission_denied')
})

test('no durable home means no advertised execution and no admitted task', async t => {
  const provider = new MockConnectionProvider(state)
  const host = new RemoteDshHost({ provider, permissions: allowed(), adapter: { capabilities: () => ['remote_task'], execute: async () => ({}), cancel: async () => ({}) } })
  t.after(() => host.dispose())
  await host.advertise(state)
  assert.equal(messages(provider, 'dsh_remote_capabilities').length, 0)
  await assert.rejects(() => host.receive('grp_remote', request('durable_home_123')), (error: any) => error.code === 'unsupported')
})

test('concurrent duplicate requests admit the PC command only once', async t => {
  const provider = new MockConnectionProvider(state), admitted = deferred(), finish = deferred()
  let calls = 0
  const host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: await directory(), adapter: {
    capabilities: () => ['remote_task'], execute: async () => { calls++; admitted.resolve(); await finish.promise; return { accepted: true } }, cancel: async () => ({}),
  } })
  t.after(() => host.dispose())
  const message = request('concurrent_request_123', 'session.prompt', { sessionId: 'session-1' })
  const results = await Promise.all([host.receive('grp_remote', message), host.receive('grp_remote', message)])
  await admitted.promise
  assert.deepEqual(results, [true, true]); assert.equal(calls, 1)
  finish.resolve(); await until(() => messages(provider).length === 1)
  assert.equal(messages(provider)[0].body.type, 'result')
})

test('response transport loss retains the persisted successful receipt across restart', async t => {
  const location = await directory(), provider = new MockConnectionProvider(state)
  let calls = 0, dropped = false
  const send = provider.send_encrypted_message.bind(provider)
  provider.send_encrypted_message = async input => {
    const result = await send(input)
    if ((input as any).kind === 'dsh_remote_event' && !dropped) { dropped = true; throw new ConnectionPluginError('connection_unavailable', 'fixture response loss') }
    return result
  }
  const adapter = { capabilities: () => ['remote_task'], execute: async () => { calls++; return { sessionId: 'session-1', accepted: true } }, cancel: async () => ({}) }
  const host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: location, adapter })
  const message = request('response_loss_123')
  await host.receive('grp_remote', message); await until(() => dropped)
  await host.dispose()
  const saved = receipt(await journal(location), 'response_loss_123')
  assert.equal(saved.phase, 'done'); assert.equal(saved.error_code, undefined)
  const restored = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: location, adapter })
  t.after(() => restored.dispose())
  await restored.receive('grp_remote', message)
  assert.equal(calls, 1)
  const events = messages(provider)
  assert.deepEqual(events[1], events[0])
})

test('failed PC command replays its exact error receipt with session identity', async t => {
  const location = await directory(), provider = new MockConnectionProvider(state)
  let calls = 0
  const adapter = { capabilities: () => ['remote_task'], execute: async () => { calls++; throw new Error('raw internal error must stay on PC') }, cancel: async () => ({}) }
  const host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: location, adapter })
  const message = request('failed_receipt_123', 'session.prompt', { sessionId: 'session-1' })
  await host.receive('grp_remote', message); await until(() => messages(provider).length === 1); await host.dispose()
  const restored = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: location, adapter })
  t.after(() => restored.dispose())
  await restored.receive('grp_remote', message)
  const events = messages(provider)
  assert.deepEqual(events[1], events[0]); assert.equal(calls, 1)
  assert.deepEqual(events[0].body.payload, { code: 'remote_execution_failed', sessionId: 'session-1' })
})

test('a crash after persisted intent becomes uncertain and never resubmits a prompt', async t => {
  const location = await directory(), message = request('crash_intent_123', 'session.prompt', { sessionId: 'session-1' })
  const hash = createHash('sha256').update(JSON.stringify({ operation: message.body.operation, payload: message.body.payload })).digest('hex')
  await writeFile(path.join(location, 'remote-requests.json'), JSON.stringify({ version: 1, groups: { grp_remote: { requests: {
    'dev_android\0crash_intent_123': { hash, sender: 'dev_android', request_id: 'crash_intent_123', operation: 'session.prompt', phase: 'intent', sessionId: 'session-1', next_sequence: 2 },
  } } } }))
  let calls = 0
  const provider = new MockConnectionProvider(state), host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: location,
    adapter: { capabilities: () => ['remote_task'], execute: async () => { calls++; return {} }, cancel: async () => ({}) } })
  t.after(() => host.dispose())
  await host.receive('grp_remote', message)
  assert.equal(calls, 0)
  assert.equal(messages(provider)[0].body.sequence, 2)
  assert.equal(messages(provider)[0].body.payload.code, 'request_uncertain')
})

test('malformed persisted journals fail closed rather than resetting replay protection', async t => {
  const malformed = [
    { version: 1, groups: [] },
    { version: 1, groups: { grp_remote: { requests: { ignored: {} } } } },
    JSON.parse('{"version":1,"groups":{"__proto__":{"requests":{}}}}'),
  ]
  for (const value of malformed) {
    const location = await directory()
    await writeFile(path.join(location, 'remote-requests.json'), JSON.stringify(value))
    const host = new RemoteDshHost({ provider: new MockConnectionProvider(state), permissions: allowed(), stateDirectory: location,
      adapter: { capabilities: () => ['remote_task'], execute: async () => ({}), cancel: async () => ({}) } })
    t.after(() => host.dispose())
    await assert.rejects(host.ready, /invalid_remote_journal/)
    await assert.rejects(() => host.receive('grp_remote', request('malformed_state_123')), /invalid_remote_journal/)
  }
})

test('a failed intent write neither executes nor acknowledges a non-durable request', async t => {
  const location = await directory()
  let calls = 0
  const host = new RemoteDshHost({ provider: new MockConnectionProvider(state), permissions: allowed(), stateDirectory: location,
    adapter: { capabilities: () => ['remote_task'], execute: async () => { calls++; return {} }, cancel: async () => ({}) } })
  t.after(() => host.dispose())
  await host.ready; await mkdir(path.join(location, 'remote-requests.json'))
  await assert.rejects(() => host.receive('grp_remote', request('write_failed_123')))
  await assert.rejects(() => host.receive('grp_remote', request('write_failed_123')), (error: any) => error.code === 'request_cancelled')
  assert.equal(calls, 0)
})

test('follow errors keep increasing sequence and replay the same terminal frame', async t => {
  const location = await directory(), provider = new MockConnectionProvider(state)
  const adapter = { capabilities: () => ['remote_task'], execute: async () => ({ sessionId: 'session-1' }), cancel: async () => ({}),
    follow: async function* () { yield { type: 'event', seq: 44 }; throw new ConnectionPluginError('request_timeout', 'fixture stream timeout') },
  }
  const host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: location, adapter })
  const message = request('follow_timeout_123', 'session.follow', { sessionId: 'session-1' })
  await host.receive('grp_remote', message); await until(() => messages(provider).length === 3); await host.dispose()
  assert.deepEqual(messages(provider).map(item => item.body.sequence), [0, 1, 2])
  assert.deepEqual(messages(provider).map(item => item.body.type), ['result', 'event', 'error'])
  const restored = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: location, adapter })
  t.after(() => restored.dispose())
  await restored.receive('grp_remote', message)
  assert.deepEqual(messages(provider).at(-1), messages(provider)[2])
})

test('pairing revocation interrupts an idle observation without waiting for another frame', async t => {
  const provider = new MockConnectionProvider(state), started = deferred(), ended = deferred()
  let cancelled = false
  const host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: await directory(), adapter: {
    capabilities: () => ['remote_task'], execute: async () => ({ sessionId: 'session-1' }), cancel: async () => { cancelled = true; return {} },
    follow: async function* (_payload, signal) {
      started.resolve()
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      ended.resolve()
    },
  } })
  t.after(() => host.dispose())
  await host.receive('grp_remote', request('revoked_follow_123', 'session.follow', { sessionId: 'session-1' })); await started.promise
  provider.setState({ ...state, pairing_status: 'unpaired', group_id: null })
  await ended.promise
  assert.equal(cancelled, false, 'revoking observation does not replay a PC task cancellation')
  await host.dispose(); assert.equal(messages(provider).length, 1)
})

test('server disconnection keeps an admitted PC observation alive until explicit cancellation', async t => {
  const provider = new MockConnectionProvider(state), started = deferred(), ended = deferred()
  let signal!: AbortSignal
  const host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: await directory(), adapter: {
    capabilities: () => ['remote_task'], execute: async () => ({ sessionId: 'session-1' }), cancel: async () => ({}),
    follow: async function* (_payload, active) {
      signal = active; started.resolve()
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      ended.resolve()
    },
  } })
  t.after(() => host.dispose())
  await host.receive('grp_remote', request('offline_follow_123', 'session.follow', { sessionId: 'session-1' })); await started.promise
  provider.setState({ ...state, server_connected: false })
  assert.equal(signal.aborted, false)
  await host.dispose(); await ended.promise
})

test('explicit observation cancellation stops follow without cancelling the computer task', async t => {
  const provider = new MockConnectionProvider(state), started = deferred(), ended = deferred()
  let taskCancellations = 0
  const host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: await directory(), adapter: {
    capabilities: () => ['remote_task'], execute: async () => ({ sessionId: 'session-1' }), cancel: async () => { taskCancellations++; return { accepted: true } },
    follow: async function* (_payload, signal) {
      started.resolve()
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      ended.resolve()
    },
  } })
  t.after(() => host.dispose())
  const original = request('observation_cancel_123', 'session.follow', { sessionId: 'session-1' })
  await host.receive('grp_remote', original); await started.promise
  await host.receive('grp_remote', { ...original, kind: 'dsh_remote_cancel', body: { ...original.body, operation: 'cancel' } })
  await ended.promise
  assert.equal(taskCancellations, 0)
})

test('oversized UTF-8 results fail with a bounded error instead of transport overflow', async t => {
  const provider = new MockConnectionProvider(state)
  const host = new RemoteDshHost({ provider, permissions: allowed(), stateDirectory: await directory(), adapter: {
    capabilities: () => ['remote_task'], execute: async () => ({ content: '字'.repeat(50_000) }), cancel: async () => ({}),
  } })
  t.after(() => host.dispose())
  await host.receive('grp_remote', request('oversized_result_123')); await until(() => messages(provider).length === 1)
  assert.deepEqual(messages(provider)[0].body.payload, { code: 'unsupported' })
})

test('Cordis services loaded after Connect activate only real available capabilities', () => {
  const values: any = {}, adapter = createCordisRemoteDshAdapter({ get: (key: string) => values[key] })
  assert.deepEqual(adapter.capabilities(), [])
  Object.assign(values, adapterFixture().values)
  assert.deepEqual(adapter.capabilities(), ['remote_task', 'remote_directory', 'remote_settings'])
  delete values.configEditor
  assert.deepEqual(adapter.capabilities(), ['remote_task', 'remote_directory'])
  delete values.sessionController.follow
  assert.deepEqual(adapter.capabilities(), [])
})

test('settings wait for the physical persistence boundary before reporting success', async () => {
  const fixture = adapterFixture(), admitted = deferred(), saved = deferred()
  const edit = fixture.values.configEditor.edit
  fixture.values.configEditor.edit = async (...args: any[]) => { admitted.resolve(); await saved.promise; return edit(...args) }
  let returned = false
  const pending = fixture.adapter.execute('settings.update', { reasoningEffort: 'low' }, 'persistent_defaults_123', new AbortController().signal).then(value => { returned = true; return value as any })
  await admitted.promise; assert.equal(returned, false)
  saved.resolve(); const value = await pending
  assert.equal(value.persisted, true); assert.equal(value.selected.reasoningEffort, 'low')
})

test('reasoning-only updates, provider defaults and model switches persist real selections', async () => {
  const fixture = adapterFixture(), signal = new AbortController().signal
  const low: any = await fixture.adapter.execute('settings.update', { reasoningEffort: 'low' }, 'reasoning_only_123', signal)
  assert.deepEqual(low.selected, { provider: 'provider-one', model: 'model-a', reasoningEffort: 'low' })
  const defaults: any = await fixture.adapter.execute('settings.update', { reasoningEffort: null }, 'reasoning_default_123', signal)
  assert.equal(Object.hasOwn(defaults.selected, 'reasoningEffort'), false)
  await fixture.adapter.execute('settings.update', { reasoningEffort: 'high' }, 'reasoning_high_123', signal)
  const changed: any = await fixture.adapter.execute('settings.update', { model: 'model-b' }, 'model_switch_123', signal)
  assert.deepEqual(changed.selected, { provider: 'provider-one', model: 'model-b' })
  const sandbox: any = await fixture.adapter.execute('settings.update', { sandbox: 'read-only' }, 'sandbox_only_123', signal)
  assert.equal(sandbox.persisted, true); assert.equal(fixture.values.permissionPresets.defaultPreset, 'read-only')
})

test('invalid sandbox prevents writing a valid model change and unsupported effort is rejected', async () => {
  const fixture = adapterFixture(), signal = new AbortController().signal
  await assert.rejects(() => fixture.adapter.execute('settings.update', { model: 'model-b', sandbox: 'unavailable' }, 'invalid_sandbox_123', signal), (error: any) => error.code === 'validation_failed')
  assert.equal(fixture.writes.length, 0)
  await assert.rejects(() => fixture.adapter.execute('settings.update', { reasoningEffort: 'ultra' }, 'invalid_effort_123', signal), (error: any) => error.code === 'validation_failed')
  await assert.rejects(() => fixture.adapter.execute('settings.update', {}, 'empty_change_123', signal), (error: any) => error.code === 'validation_failed')
})

test('credential edits and duplicate or non-persistent entries cannot report saved defaults', async () => {
  const fixture = adapterFixture(), signal = new AbortController().signal
  for (const operation of ['settings.update', 'session.selectModel']) await assert.rejects(() => fixture.adapter.execute(operation, { provider: 'provider-one', model: 'model-a', apiKey: 'fixture' }, 'forbidden_edit_123', signal), (error: any) => error.code === 'permission_denied')
  fixture.values.configEditor.edit = async () => {}
  await assert.rejects(() => fixture.adapter.execute('settings.update', { reasoningEffort: 'low' }, 'save_mismatch_123', signal), (error: any) => error.code === 'conflict')
  fixture.entries.push(fixture.entries[0])
  assert.equal(fixture.adapter.capabilities().includes('remote_settings'), false)
  await assert.rejects(() => fixture.adapter.execute('settings.update', { reasoningEffort: 'low' }, 'duplicate_entry_123', signal), (error: any) => error.code === 'unsupported')
})

test('DSH follow gets an actual durable session address and session creation uses a stable identity', async () => {
  const fixture = adapterFixture(), signal = new AbortController().signal
  const first: any = await fixture.adapter.execute('session.create', {}, 'create_identity_123', signal)
  const second: any = await fixture.adapter.execute('session.create', {}, 'create_identity_123', signal)
  assert.equal(first.sessionId, second.sessionId)
  assert.match(first.sessionId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
  const opening: any = await fixture.adapter.execute('session.follow', { sessionId: 'session-1' }, 'follow_address_123', signal)
  assert.deepEqual(opening.address, { kind: 'session', sessionId: 'session-1' })
  let actual: any
  fixture.values.sessionController.follow = async function* (payload: any) { actual = payload }
  for await (const _frame of fixture.adapter.follow!({ sessionId: 'session-1' }, signal)) {}
  assert.deepEqual(actual.address, opening.address); assert.equal(actual.assistantStream, true)
})

test('client separately gates settings/directory, pins the PC target and bounds UTF-8 payloads', async () => {
  const provider = new MockConnectionProvider({ ...state, capabilities: { ...state.capabilities, remote_task: true, remote_directory: false, remote_settings: false } })
  const client = new RemoteDshClient(provider, allowed())
  await assert.rejects(() => client.submit({ group_id: 'grp_remote', request_id: 'client_directory_123', operation: 'directory.list', payload: {} }), (error: any) => error.code === 'unsupported')
  await assert.rejects(() => client.submit({ group_id: 'grp_remote', request_id: 'client_settings_123', operation: 'settings.update', payload: { model: 'model-a' } }), (error: any) => error.code === 'unsupported')
  await assert.rejects(() => client.submit({ group_id: 'grp_remote', request_id: 'client_large_123', operation: 'session.prompt', payload: { content: '字'.repeat(50_000) } }), (error: any) => error.code === 'validation_failed')
  await assert.rejects(() => client.submit({ group_id: 'grp_remote', request_id: 'client_target_123', target_device_id: 'dev_other_pc', operation: 'models.catalog', payload: {} }), (error: any) => error.code === 'conflict')
  await client.submit({ group_id: 'grp_remote', request_id: 'client_target_456', operation: 'models.catalog', payload: {} })
  assert.equal((provider.calls.find(call => call.method === 'submit_remote_task')?.input as any).target_device_id, 'dev_android')
})

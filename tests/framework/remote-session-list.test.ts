import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { publicDshResult, publicDshFollowFrame } from '../../src/framework/remote-public.ts'
import { createCordisRemoteDshAdapter, RemoteDshHost, REMOTE_DSH_PROTOCOL } from '../../src/framework/remote-host.ts'
import { MockConnectionProvider } from '../../src/framework/provider.ts'
import { PermissionSet, PERMISSIONS } from '../../src/framework/permissions.ts'

const details = 'synthetic detail text '.repeat(90)
function sessionRows(count = 134) {
  return Array.from({ length: count }, (_, index) => ({ sessionId: `session-${index}`, updatedAt: 100 + index, running: index === 0,
    agentAvailable: index === 0, blank: false, cwd: '/synthetic/workspace', origin: index % 2 ? 'subagent' : 'user',
    parentSessionId: index % 2 ? 'session-0' : undefined,
    projections: { kind: 'cached', asOfSeq: index + 2, values: { title: `Synthetic ${index}`, sessionListMetadata: { blank: false, lastPromptAt: index },
      subagentCatalog: [{ id: `child-${index}`, mode: 'one-shot', createdAt: index, label: 'Child' }],
      subagent: { mode: 'one-shot', label: 'Child', seq: index }, subagentTiming: { settledMs: index, active: { since: index, through: index } },
      modelSelection: { next: { provider: 'p', model: 'm' }, lastUsed: null },
      turnOutline: [{ turn: 1, seq: 0, prompt: details, response: details }],
      inbox: { 'next-turn': [{ id: `queued-${index}`, role: 'user', content: [{ type: 'text', text: details }] }], 'next-step': [] },
      sessionStats: { turns: 1, steps: 2 }, tokenUsage: { outputTokens: 3 }, credentials: 'private-fixture' } },
  }))
}

test('session list retains every metadata row and navigation hint within the fixed transport budget', () => {
  const source = { items: sessionRows() }
  assert.ok(Buffer.byteLength(JSON.stringify(source)) > 128 * 1024)
  const projected: any = publicDshResult('session.list', source)
  assert.equal(projected.items.length, source.items.length)
  for (let index = 0; index < source.items.length; index++) {
    const actual = projected.items[index]
    const original = source.items[index]
    for (const key of ['sessionId', 'updatedAt', 'running', 'agentAvailable', 'blank', 'cwd', 'origin', 'parentSessionId']) assert.equal(actual[key], (original as any)[key])
    assert.equal(actual.projections.kind, 'cached')
    assert.equal(actual.projections.asOfSeq, original.projections.asOfSeq)
    for (const key of ['title', 'sessionListMetadata', 'subagentCatalog', 'subagent', 'subagentTiming', 'modelSelection']) assert.deepEqual(actual.projections.values[key], (original.projections.values as any)[key])
    for (const key of ['turnOutline', 'inbox', 'sessionStats', 'tokenUsage', 'credentials']) assert.equal(actual.projections.values[key], undefined)
  }
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 128 * 1024)
  assert.equal(JSON.stringify(projected).includes(details), false)
  assert.equal(JSON.stringify(projected).includes('private-fixture'), false)
})

test('full follow still supplies outline and queued messages omitted only from list hints', () => {
  const row = sessionRows(1)[0]
  const projected: any = publicDshFollowFrame({ type: 'snapshot', header: { id: row.sessionId }, cursor: 2, hasMore: false, records: [], projections: row.projections })
  assert.equal(projected.projections.values.turnOutline[0].response, details)
  assert.equal(projected.projections.values.inbox['next-turn'][0].content[0].text, details)
})

test('oversized list and malformed retained hints remain rejected without silently truncating rows', () => {
  assert.throws(() => publicDshResult('session.list', { items: sessionRows(1001) }), (error: any) => error.code === 'protocol_error')
  const row: any = sessionRows(1)[0]
  row.projections.values.subagentCatalog = null
  assert.throws(() => publicDshResult('session.list', { items: [row] }), (error: any) => error.code === 'protocol_error')
})

test('production remote host persists and sends a result for the complete large-list adapter response', async () => {
  const directory = path.resolve('..', 'Temp_Android', 'codex-review-20261018', 'local-engine-r21', 'connect-list-host')
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true })
  const state = { server_connected: true, group_id: 'group_list', pairing_status: 'paired' as const,
    local_device: { id: 'pc', name: 'PC', public_key: 'pc-pk' }, remote_device: { id: 'phone', name: 'Phone', public_key: 'phone-pk', online: 'online' as const, last_seen_at: null },
    members: [{ id: 'pc', active: true }, { id: 'phone', active: true }],
    capabilities: { workspace_sync: false, web_broadcast: false, encrypted_messages: true, encrypted_files: true, presence: true, file_cache_cleanup: true } }
  const provider = new MockConnectionProvider(state)
  const sessions = { list: async () => ({ items: sessionRows() }), create() {}, prompt() {}, cancel() {}, modelCatalog() {}, follow() {}, control() {} }
  const adapter = createCordisRemoteDshAdapter({ get: (key: string) => key === 'sessionController' ? sessions : key === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined })
  const host = new RemoteDshHost({ provider, permissions: new PermissionSet(PERMISSIONS), stateDirectory: directory, adapter })
  try {
    await host.ready
    await host.receive('group_list', { message_id: 'fixture-list', sender_device_id: 'phone', created_at: '', kind: 'dsh_remote_request',
      body: { protocol: REMOTE_DSH_PROTOCOL, request_id: 'list_result_134', operation: 'session.list', payload: {}, target_device_id: 'pc' } })
    const deadline = Date.now() + 3000
    while (!provider.calls.some(call => call.method === 'send_encrypted_message')) { assert.ok(Date.now() < deadline); await yieldEventLoop() }
    const journal = JSON.parse(await readFile(path.join(directory, 'remote-requests.json'), 'utf8'))
    const receipt = journal.groups.group_list.requests['phone\0list_result_134']
    assert.equal(receipt.terminal_event.type, 'result')
    assert.equal(receipt.result.items.length, 134)
    assert.ok(Buffer.byteLength(JSON.stringify(receipt.result)) <= 128 * 1024)
    const sent: any = provider.calls.find(call => call.method === 'send_encrypted_message')
    assert.equal(sent.input.body.type, 'result')
  } finally { await host.dispose() }
})

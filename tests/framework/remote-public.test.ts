import test from 'node:test'
import assert from 'node:assert/strict'
import { publicDshControlFrame, publicDshFollowFrame, publicDshResult, publicDshWorkspaceFrame } from '../../src/framework/remote-public.ts'
import { createCordisRemoteDshAdapter } from '../../src/framework/remote-host.ts'

test('DSH public follow keeps user-visible thinking but removes replay/auth/context payloads before encryption', () => {
  const secret = 'private_replay_and_auth_fixture'
  const projected = publicDshFollowFrame({ type: 'snapshot', header: { id: 'session-1', cwd: '/work', auth: secret }, cursor: 2, hasMore: false,
    records: [{ type: 'event', event: { type: 'request/header', seq: 0, time: 10, data: { apiKey: secret, prompt: secret } } },
      { type: 'event', event: { type: 'assistant/message', seq: 1, time: 11, data: { turn: 0, step: 0,
        message: { id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'provider', model: 'model', replayState: secret },
          content: [{ type: 'text', text: '正文' }, { type: 'reasoning', text: '公开思考' },
            { type: 'image', attachment: { attachmentId: 'image-1', bytes: 11, mediaType: 'image/png', width: 1, height: 1, authorization: secret, data: secret } }] },
        stream: [{ type: 'chunk', chunk: { type: 'finish', replayState: secret } }], usage: { inputTokens: 1, outputTokens: 2, authorization: secret },
      } } }], projections: { asOfSeq: 2, values: { credentials: secret, subagentCatalog: [{ id: 'child-1', mode: 'one-shot', createdAt: 12, label: 'Worker', private: secret }] } },
    assistantStream: { revision: 1, activeAttempt: { attemptId: 'attempt-1', startedAfterSeq: 2, turn: 0, step: 1, nextIndex: 1,
      stream: [{ type: 'chunk', time: 12, chunk: { type: 'finish', reason: { kind: 'stop', private: secret }, replayState: secret } }], auth: secret } } })
  assert.equal(JSON.stringify(projected).includes(secret), false)
  assert.deepEqual(projected.records[0].event.data, {})
  assert.equal(projected.records[1].event.data.message.content[1].text, '公开思考')
  assert.equal(projected.records[1].event.data.message.content[2].attachment.attachmentId, 'image-1')
  assert.equal(projected.assistantStream.activeAttempt.stream[0].chunk.reason.kind, 'stop')
})

test('control frames expose only known child/model projections and metadata', () => {
  const secret = 'private_control_fixture'
  const projected = publicDshControlFrame({ type: 'baseline', value: { projections: { 'session-1': { asOfSeq: 1, values: {
    subagentTiming: { settledMs: 300, active: { since: 10, through: 20, secret }, private: secret },
    modelSelection: { lastUsed: { provider: 'p', model: 'm', apiKey: secret }, next: null }, credentials: secret,
  } } } } })
  assert.equal(JSON.stringify(projected).includes(secret), false)
  assert.equal(projected.value.projections['session-1'].values.subagentTiming.active.through, 20)
  assert.equal(publicDshControlFrame({ type: 'projection', sessionId: 'session-1', key: 'auth', seq: 2, value: secret }).value, null)
})

test('finite model/session/directory results never forward credentials or opaque upstream objects', () => {
  const secret = 'private_catalog_fixture'
  const catalog: any = publicDshResult('models.catalog', { default: { provider: 'p', model: 'm', apiKey: secret }, routableProviders: ['p'], groups: [
    { id: 'p', name: 'Provider', auth: secret, models: [{ id: 'm', name: 'Model', replayState: secret, reasoning: { efforts: [{ id: 'high', name: 'High', signature: secret }], defaultEffort: 'high' } }] },
  ], failures: [] })
  assert.equal(JSON.stringify(catalog).includes(secret), false)
  assert.equal(catalog.groups[0].models[0].reasoning.defaultEffort, 'high')
  const sessions: any = publicDshResult('session.list', { items: [{ sessionId: 'session-1', running: true, updatedAt: 10, blank: false, agentAvailable: true, token: secret }] })
  assert.equal(JSON.stringify(sessions).includes(secret), false)
  assert.equal(sessions.items[0].running, true)
  assert.throws(() => publicDshFollowFrame({ type: 'opaque', auth: secret }), (error: any) => error.code === 'protocol_error')
})

test('real Cordis adapter applies public projection to both follow and control iterators', async () => {
  const secret = 'host_worker_auth_fixture'
  const sessions = { follow: async function* () { yield { type: 'event', event: { type: 'request/header', seq: 1, time: 2, data: { auth: secret } } } },
    control: async function* () { yield { type: 'projection', sessionId: 'session-1', key: 'auth', seq: 1, value: secret } } }
  const adapter = createCordisRemoteDshAdapter({ get: (key: string) => key === 'sessionController' ? sessions : undefined })
  for await (const frame of adapter.follow!({ sessionId: 'session-1' }, new AbortController().signal, 'session.follow')) assert.equal(JSON.stringify(frame).includes(secret), false)
  for await (const frame of adapter.follow!({}, new AbortController().signal, 'session.control')) assert.equal(JSON.stringify(frame).includes(secret), false)
})

test('browser display projection retains real session header, summary stats, queue and replacement source references', () => {
  const secret = 'private-display-fixture'
  const projected = publicDshFollowFrame({ type: 'snapshot', cursor: 3, hasMore: false,
    header: { version: 6, id: 'parent-id', createdAt: 10, cwd: '/actual/work', isSeeded: false, origin: 'subagent', parentSession: 'actual-parent', delegationDepth: 1, agentPreset: 'standard', secret },
    records: [{ type: 'event', event: { type: 'request/header', seq: 0, time: 1, data: { header: { apiKey: secret } } } },
      { type: 'event', event: { type: 'user/message', seq: 3, time: 4, sourceEventSeqs: [1, 2], surfaceOp: 'append', data: { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'user input' }] } } }],
    projections: { asOfSeq: 3, values: { title: 'actual title', sessionStats: { turns: 1, steps: 2, llmMs: 100, toolMs: 20, secret },
      turnOutline: [{ turn: 1, seq: 0, prompt: 'question', response: 'answer', secret }], turnBoundary: { openTurnStartSeq: 1, lastStepStartSeq: 2, lastStepBoundary: { kind: 'end', seq: 3, secret }, lastTurn: 1, secret },
      tokenUsage: { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0, secret }, contextPressure: { contextWindow: 100, pressureTokens: 17, secret },
      inbox: { 'next-turn': [{ id: 'queued-1', role: 'user', content: [{ type: 'text', text: 'next input' }], source: { kind: 'user', rpcId: 'receipt-123', auth: secret } }], 'next-step': [], secret },
      credentials: secret } }, assistantStream: { revision: 0 } })
  assert.equal(JSON.stringify(projected).includes(secret), false)
  assert.equal(projected.header.cwd, '/actual/work'); assert.equal(projected.header.version, 6); assert.equal(projected.header.parentSession, 'actual-parent')
  assert.equal(projected.records[0].event.type, 'dafeiyu/hidden'); assert.equal(projected.records[0].event.ignorable, true)
  assert.deepEqual(projected.records[1].event.sourceEventSeqs, [1, 2])
  assert.equal(projected.projections.values.title, 'actual title'); assert.equal(projected.projections.values.sessionStats.turns, 1)
  assert.equal(projected.projections.values.turnOutline[0].response, 'answer'); assert.equal(projected.projections.values.inbox['next-turn'][0].source.rpcId, 'receipt-123')
})

test('workspace stream projects real complete baseline and every increment without private extensions', () => {
  const secret = 'private-workspace-fixture'
  const row = { workspaceId: 'work-1', path: '/computer/directory', title: 'Actual Workspace', sessionIds: ['session-1'], createdAt: 'time-1', updatedAt: 'time-2', secret }
  const frames = [ { type: 'baseline', value: { items: [row], archivedSessionIds: ['archive-1'], pinnedSessionIds: ['session-1'], secret } },
    { type: 'upsert', workspace: row }, { type: 'remove', workspaceId: 'work-1' }, { type: 'order', workspaceIds: ['work-1'] },
    { type: 'archived', archivedSessionIds: ['archive-1'] }, { type: 'pinned', pinnedSessionIds: ['session-1'] } ]
  for (const frame of frames) { const result = publicDshWorkspaceFrame({ ...frame, secret }); assert.equal(result.type, frame.type); assert.equal(JSON.stringify(result).includes(secret), false) }
  assert.equal(publicDshWorkspaceFrame(frames[0]).value.items[0].path, '/computer/directory')
  assert.throws(() => publicDshWorkspaceFrame({ type: 'credentials', value: secret }))
})

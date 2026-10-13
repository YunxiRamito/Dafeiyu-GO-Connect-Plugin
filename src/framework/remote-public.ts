import { ConnectionPluginError } from './errors.ts'

type Value = Record<string, any>
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value)
function fields(value: unknown, keys: string[]): Value {
  if (!object(value)) return {}
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
}
function list(value: unknown, limit: number, project: (item: any) => unknown): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new ConnectionPluginError('protocol_error', 'Invalid remote display list.')
  return value.map(project)
}
const selection = (value: unknown) => object(value) ? fields(value, ['provider', 'model', 'reasoningEffort']) : null
const usage = (value: unknown) => object(value) ? fields(value, ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) : undefined
const attachment = (value: unknown) => fields(value, ['attachmentId', 'name', 'bytes', 'mediaType', 'width', 'height'])
function block(value: any): Value {
  switch (value?.type) {
    case 'text': case 'reasoning': return fields(value, ['type', 'text'])
    case 'tool-call': return fields(value, ['type', 'id', 'name', 'arguments'])
    case 'file': case 'image': return { type: value.type, attachment: attachment(value.attachment) }
    default: return { type: 'unsupported' }
  }
}
function message(value: any): Value {
  return { ...fields(value, ['id', 'role', 'toolCallId', 'isError']),
    source: fields(value?.source, ['kind', 'provider', 'model', 'rpcId', 'callId']),
    content: list(value?.content, 1024, block) }
}
function chunk(value: any): Value {
  const result = fields(value, ['type', 'index', 'blockType', 'text', 'id', 'name', 'argumentsDelta'])
  if (object(value?.block)) result.block = block(value.block)
  if (object(value?.usage)) result.usage = usage(value.usage)
  if (object(value?.reason)) result.reason = fields(value.reason, ['kind'])
  return result
}
function stream(value: unknown): unknown[] {
  return list(value, 4096, record => {
    switch (record?.type) {
      case 'text-chunks': case 'reasoning-chunks': return fields(record, ['type', 'index', 'time0', 'dt', 'texts'])
      case 'tool-call-chunks': return fields(record, ['type', 'index', 'time0', 'dt', 'id', 'name', 'args'])
      case 'chunk': return { ...fields(record, ['type', 'time']), chunk: chunk(record.chunk) }
      default: throw new ConnectionPluginError('protocol_error', 'Invalid remote assistant record.')
    }
  })
}
function event(value: any): Value {
  const data = value?.data
  let projected: Value
  let hidden = false
  switch (value?.type) {
    case 'user/message': projected = message(data); break
    case 'assistant/message': projected = { ...fields(data, ['turn', 'step', 'interrupted']), message: message(data.message),
      stream: stream(data.stream ?? []), usage: usage(data.usage) }; break
    case 'assistant/attempt': projected = { ...fields(data, ['turn', 'step']), stream: stream(data.stream) }; break
    case 'tool/call': projected = fields(data, ['turn', 'step', 'callId', 'name', 'arguments']); break
    case 'tool/result': projected = { ...fields(data, ['turn', 'step']), message: message(data.message), error: object(data.error) ? fields(data.error, ['name', 'code', 'reason']) : undefined }; break
    case 'subagent/catalog': projected = fields(data, ['version', 'childId', 'childCreatedAt', 'mode', 'label']); break
    case 'turn/start': case 'step/start': case 'step/end': projected = fields(data, ['turn', 'step']); break
    case 'turn/end': projected = { ...fields(data, ['turn']), reason: fields(data?.reason, ['kind']) }; break
    case 'model/selection': projected = selection(data) ?? {}; break
    // Request headers, injected context and adapter-private events are not
    // a user-visible thought stream and are not needed to render Android UI.
    default: projected = {}; hidden = true
  }
  // An empty request/header would violate the real browser journal's owner
  // validator. Keep its sequence as an unknown ignorable event instead.
  if (hidden) return { ...fields(value, ['seq', 'time']), type: 'dafeiyu/hidden', ignorable: true, data: {} }
  return { ...fields(value, ['type', 'seq', 'time', 'ignorable']), data: projected,
    ...(Array.isArray(value?.sourceEventSeqs) ? { sourceEventSeqs: list(value.sourceEventSeqs, 4096, item => {
      if (!Number.isSafeInteger(item) || item < 0) throw new ConnectionPluginError('protocol_error', 'Invalid remote event source.')
      return item
    }) } : {}),
    ...(value?.surfaceOp === 'append' ? { surfaceOp: 'append' } : object(value?.surfaceOp) ? { surfaceOp: fields(value.surfaceOp, ['op', 'startSeq', 'endSeq']) } : {}) }
}

export function publicDshProjection(key: string, value: unknown): unknown {
  switch (key) {
    case 'title': return typeof value === 'string' || value === null ? value : undefined
    case 'sessionListMetadata': return fields(value, ['blank', 'lastPromptAt'])
    case 'sessionStats': return fields(value, ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'])
    case 'turnOutline': return list(value, 4096, row => fields(row, ['turn', 'seq', 'prompt', 'response']))
    case 'turnBoundary': return object(value) ? { ...fields(value, ['openTurnStartSeq', 'lastStepStartSeq', 'lastTurn']),
      lastStepBoundary: object(value.lastStepBoundary) ? fields(value.lastStepBoundary, ['kind', 'seq']) : null } : null
    case 'tokenUsage': return fields(value, ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
    case 'contextPressure': return fields(value, ['pressureTokens', 'projectedTokens', 'contextWindow'])
    case 'contextBreakdown': return fields(value, ['systemTokens', 'toolsTokens', 'messageTokens'])
    case 'inbox': return object(value) ? {
      'next-turn': list(value['next-turn'] ?? [], 256, message), 'next-step': list(value['next-step'] ?? [], 256, message),
    } : null
    case 'subagentCatalog': return list(value, 256, row => fields(row, ['id', 'createdAt', 'mode', 'label']))
    case 'subagent': return value === null ? null : fields(value, ['mode', 'label', 'seq'])
    case 'subagentTiming': return object(value) ? { ...fields(value, ['settledMs', 'lastTurnCompleted']), active: object(value.active) ? fields(value.active, ['since', 'through']) : undefined } : null
    case 'modelSelection': return object(value) ? { lastUsed: selection(value.lastUsed), next: selection(value.next) } : null
    default: return undefined
  }
}
export function publicDshProjections(value: any): Value {
  const values: Value = {}
  if (object(value?.values)) for (const [key, item] of Object.entries(value.values)) {
    const projected = publicDshProjection(key, item)
    if (projected !== undefined) values[key] = projected
  }
  return { ...fields(value, ['asOfSeq']), values }
}
const projections = publicDshProjections

export function publicDshPage(value: any): Value {
  return { records: list(value?.records, 2000, record => ({ type: 'event', event: event(record.event) })), hasMore: value?.hasMore }
}

function workspace(value: any): Value {
  return { ...fields(value, ['workspaceId', 'path', 'title', 'createdAt', 'updatedAt']),
    sessionIds: list(value?.sessionIds, 1000, id => String(id)) }
}
/** Complete browser Workspace vocabulary, with no host/private extensions. */
export function publicDshWorkspaceFrame(value: any): Value {
  switch (value?.type) {
    case 'baseline': return { type: 'baseline', value: { items: list(value?.value?.items, 1000, workspace),
      archivedSessionIds: list(value?.value?.archivedSessionIds ?? [], 1000, id => String(id)),
      pinnedSessionIds: list(value?.value?.pinnedSessionIds ?? [], 1000, id => String(id)) } }
    case 'upsert': return { type: 'upsert', workspace: workspace(value.workspace) }
    case 'remove': return { type: 'remove', workspaceId: value.workspaceId }
    case 'order': return { type: 'order', workspaceIds: list(value.workspaceIds, 1000, id => String(id)) }
    case 'archived': return { type: 'archived', archivedSessionIds: list(value.archivedSessionIds, 1000, id => String(id)) }
    case 'pinned': return { type: 'pinned', pinnedSessionIds: list(value.pinnedSessionIds, 1000, id => String(id)) }
    default: throw new ConnectionPluginError('protocol_error', 'Unknown DSH workspace frame.')
  }
}

/** Only public UI fields leave the host; upstream authentication/replay data stays on PC. */
export function publicDshFollowFrame(value: any): Value {
  switch (value?.type) {
    case 'snapshot': {
      const baseline = value.assistantStream
      const attempt = baseline?.activeAttempt
      return { type: 'snapshot', header: fields(value.header, ['version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset']), cursor: value.cursor, hasMore: value.hasMore,
        records: list(value.records, 2000, record => ({ type: 'event', event: event(record.event) })),
        projections: projections(value.projections), assistantStream: object(baseline) ? {
          revision: baseline.revision, activeAttempt: object(attempt) ? {
            ...fields(attempt, ['attemptId', 'startedAfterSeq', 'turn', 'step', 'nextIndex']), stream: stream(attempt.stream),
          } : undefined,
        } : undefined }
    }
    case 'event': return { type: 'event', event: event(value.event) }
    case 'assistant-stream': return { type: value.type, frame: {
      ...fields(value.frame, ['type', 'attemptId', 'revision', 'startedAfterSeq', 'turn', 'step', 'index', 'time']),
      chunk: object(value.frame?.chunk) ? chunk(value.frame.chunk) : undefined,
      outcome: object(value.frame?.outcome) ? fields(value.frame.outcome, ['kind', 'eventType', 'seq']) : undefined,
    } }
    default: throw new ConnectionPluginError('protocol_error', 'Unknown DSH display frame.')
  }
}

export function publicDshControlFrame(value: any): Value {
  if (value?.type === 'projection') return { ...fields(value, ['type', 'sessionId', 'key', 'seq']), value: publicDshProjection(value.key, value.value) ?? null }
  if (value?.type === 'baseline' && object(value?.value?.projections)) {
    if (Object.keys(value.value.projections).length > 1000) throw new ConnectionPluginError('protocol_error', 'Too many remote sessions.')
    return { type: 'baseline', value: { projections: Object.fromEntries(Object.entries(value.value.projections).map(([key, item]) => [key, projections(item)])) } }
  }
  throw new ConnectionPluginError('protocol_error', 'Unknown DSH control frame.')
}

function permissions(value: any): Value {
  return { ...fields(value, ['defaultPreset']), options: list(value?.options ?? [], 64, option => fields(option, ['value', 'name', 'description'])),
    defaultOptions: list(value?.defaultOptions ?? [], 64, option => fields(option, ['value', 'name', 'description'])) }
}
export function publicDshResult(operation: string, value: any): unknown {
  switch (operation) {
    case 'models.catalog': return { default: selection(value?.default), routableProviders: list(value?.routableProviders ?? [], 256, item => String(item)),
      groups: list(value?.groups, 256, group => ({ ...fields(group, ['id', 'name']), models: list(group.models, 2000, model => ({
        ...fields(model, ['id', 'name', 'description']), reasoning: object(model.reasoning) ? {
          efforts: list(model.reasoning.efforts, 32, effort => fields(effort, ['id', 'name', 'description'])), defaultEffort: model.reasoning.defaultEffort,
        } : undefined,
      })) })), failures: list(value?.failures ?? [], 256, failure => fields(failure, ['id', 'name', 'message'])) }
    case 'session.list': {
      const rows = Array.isArray(value) ? value : value?.items
      return { items: list(rows, 1000, row => ({ ...fields(row, ['sessionId', 'agentAvailable', 'updatedAt', 'running', 'blank', 'parentSessionId', 'origin', 'cwd']),
        projections: object(row.projections) ? { kind: row.projections.kind, ...projections(row.projections) } : undefined })) }
    }
    case 'directory.list': return { ...fields(value, ['path', 'home', 'truncated']),
      crumbs: list(value?.crumbs, 128, item => fields(item, ['name', 'path', 'hidden'])), entries: list(value?.entries, 2000, item => fields(item, ['name', 'path', 'hidden'])) }
    case 'permissions.catalog': return permissions(value)
    case 'session.create': return fields(value, ['sessionId', 'agentPreset'])
    case 'session.prompt': case 'session.cancel': return fields(value, ['accepted'])
    case 'session.archived.delete.prepare': case 'session.archived.delete':
      return fields(value, ['ticket', 'sessionId', 'archiveVersion', 'archivedAt', 'expiresAt', 'executionDevice', 'status', 'deleted', 'deletedAt'])
    case 'artifact.list': return { ...fields(value, ['workspaceId', 'directory', 'nextCursor']),
      entries: list(value?.entries, 100, item => fields(item, ['name', 'relativePath', 'kind', 'size', 'version'])) }
    case 'artifact.prepare': return fields(value, ['ticket', 'workspaceId', 'relativePath', 'fileName', 'version', 'size', 'sha256', 'chunkBytes', 'expiresAt'])
    case 'artifact.read': return fields(value, ['ticket', 'offset', 'size', 'version', 'sha256', 'bytesBase64'])
    case 'artifact.close': return fields(value, ['ticket', 'closed'])
    case 'attachment.cancel': return fields(value, ['uploadId', 'cancelled'])
    case 'attachment.prepare': case 'attachment.write': case 'attachment.status': case 'attachment.commit':
      return { ...fields(value, ['uploadId', 'sessionId', 'name', 'size', 'sha256', 'received', 'status', 'chunkBytes', 'expiresAt']),
        ...(object(value?.content) ? { content: fields(value.content, ['type', 'uploadId']) } : {}),
        ...(object(value?.file) ? { file: attachment(value.file) } : {}) }
    default: throw new ConnectionPluginError('protocol_error', 'Unknown DSH result projection.')
  }
}

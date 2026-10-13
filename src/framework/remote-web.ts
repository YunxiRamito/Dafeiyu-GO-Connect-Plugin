import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import { homedir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { ConnectionPluginError } from './errors.ts'
import { publicDshControlFrame, publicDshFollowFrame, publicDshPage, publicDshProjections, publicDshResult, publicDshWorkspaceFrame } from './remote-public.ts'
import type { RemoteDshHostAdapter, RemoteDshHostContext } from './remote-host.ts'

export const REMOTE_WEB_LIMITS = Object.freeze({ requestBytes: 64 * 1024, chunkBytes: 48 * 1024,
  responseBytes: 8 * 1024 * 1024, frameBytes: 96 * 1024, queueBytes: 512 * 1024, streams: 16, sockets: 4 })
export const REMOTE_WEB_OPERATIONS = ['web.http', 'web.socket', 'web.socket.send', 'web.socket.close'] as const
const ID = /^[A-Za-z0-9_-]{8,128}$/
const HEADER_NAMES = new Set(['accept', 'content-type', 'if-none-match', 'if-modified-since'])
const RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'etag', 'last-modified', 'content-encoding'])
const STATIC_PATH = /^(?:\/$|\/(?:assets|static|fonts|images)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$|\/plugins\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/client(?:\.[A-Za-z0-9._-]+)?\.js$|\/(?:favicon\.ico|manifest\.json|manifest\.webmanifest|[^/]+\.(?:js|css|png|svg|woff2?|ico))$)/
function object(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fail(code: 'validation_failed' | 'permission_denied' | 'protocol_error' | 'request_cancelled' | 'unsupported' | 'conflict' | 'request_timeout', message: string): never { throw new ConnectionPluginError(code, message) }
function active(signal: AbortSignal) { if (signal.aborted) fail('request_cancelled', 'Remote web operation cancelled.') }

/** Reject encoded traversal before WHATWG URL normalizes dot segments. */
export function remoteWebPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith('/') || raw.startsWith('//') || /[\x00-\x20\x7f\\#]/.test(raw)) fail('validation_failed', 'Invalid remote web path.')
  // The real Modules host emits one immutable combo URL, not arbitrary query
  // parameters: /plugins/??@scope/package/client.js,...&rev=<12 hex>.
  if (raw.startsWith('/plugins/??')) {
    const match = /^\/plugins\/\?\?((?:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/client\.js)(?:,(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/client\.js)*)&rev=([a-f0-9]{12})$/.exec(raw)
    if (!match || match[1].split(',').length > 128 || match[1].split('/').some(part => part === '.' || part === '..')) fail('permission_denied', 'Invalid remote module bundle.')
    return raw
  }
  const [pathname, query] = raw.split('?')
  if (raw.split('?').length > 2) fail('validation_failed', 'Invalid remote web query.')
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { fail('validation_failed', 'Invalid path encoding.') }
  if (/[\\\x00-\x20\x7f%]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) fail('permission_denied', 'Remote path escapes its allowed route.')
  const parameters = new URLSearchParams(query ?? '')
  for (const [key, value] of parameters) {
    if (!['v', 't', 'hash', 'rev'].includes(key) || !/^[A-Za-z0-9._-]{0,128}$/.test(value)) fail('permission_denied', 'Remote authentication and arbitrary queries are unavailable.')
  }
  return raw
}

export function validateRemoteWebHttp(input: Record<string, any>): { method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body: Buffer } {
  if (Object.keys(input).some(key => !['method', 'path', 'headers', 'body_base64'].includes(key))) fail('permission_denied', 'Remote HTTP fields are restricted.')
  if (!['GET', 'POST'].includes(input.method)) fail('permission_denied', 'Remote HTTP method is unavailable.')
  const path = remoteWebPath(input.path)
  const route = path.split('?')[0]
  if (input.method === 'GET' ? !(STATIC_PATH.test(route) || path.startsWith('/plugins/??')) : !(route === '/api' || /^\/api\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(route))) fail('permission_denied', 'Remote web route is unavailable.')
  if (input.headers !== undefined && (!object(input.headers) || Object.keys(input.headers).length > 8)) fail('validation_failed', 'Invalid remote HTTP headers.')
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!HEADER_NAMES.has(name.toLowerCase())) fail('permission_denied', 'Authentication and transport headers remain on the PC.')
    if (typeof value !== 'string' || value.length > 512 || /[\x00-\x1f\x7f]/.test(value) || Object.hasOwn(headers, name.toLowerCase())) fail('validation_failed', 'Invalid remote HTTP header.')
    headers[name.toLowerCase()] = value
  }
  const encoded = input.body_base64 ?? ''
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(REMOTE_WEB_LIMITS.requestBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('validation_failed', 'Invalid remote HTTP body.')
  const body = Buffer.from(encoded, 'base64')
  if (body.length > REMOTE_WEB_LIMITS.requestBytes || (input.method === 'GET' && body.length)) fail('validation_failed', 'Remote HTTP body limit exceeded.')
  if (input.method === 'POST' && !/^application\/json(?:\s*;.*)?$/i.test(headers['content-type'] ?? '')) fail('validation_failed', 'Remote RPC requires JSON.')
  return { method: input.method, path, headers, body }
}

export type RemoteWebHttpFrame = { kind: 'http.head'; status: number; headers: Record<string, string> } |
  { kind: 'http.chunk'; index: number; bytes: string } | { kind: 'http.end'; size: number; sha256: string }
export async function* remoteWebHttpFrames(status: number, headers: Record<string, string>, body: Buffer): AsyncIterable<RemoteWebHttpFrame> {
  if (!Number.isSafeInteger(status) || status < 200 || status > 599 || body.length > REMOTE_WEB_LIMITS.responseBytes) fail('protocol_error', 'Invalid upstream HTTP response.')
  yield { kind: 'http.head', status, headers }
  for (let start = 0, index = 0; start < body.length; start += REMOTE_WEB_LIMITS.chunkBytes, index++)
    yield { kind: 'http.chunk', index, bytes: body.subarray(start, start + REMOTE_WEB_LIMITS.chunkBytes).toString('base64') }
  yield { kind: 'http.end', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }
}

/** A consumer acknowledges by advancing its iterator; producers cannot outrun this byte budget. */
class WebQueue<T> {
  private entries: Array<{ value: T; bytes: number }> = []
  private bytes = 0
  private ended = false
  private changed: Array<() => void> = []
  private failure?: unknown
  private wake() { for (const resume of this.changed.splice(0)) resume() }
  private wait(signal: AbortSignal): Promise<void> {
    active(signal)
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.changed = this.changed.filter(fn => fn !== finish); resolve() }
      const abort = () => { finish(); reject(new ConnectionPluginError('request_cancelled', 'Web stream cancelled.')) }
      this.changed.push(finish)
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { finish(); reject(new ConnectionPluginError('request_timeout', 'Web stream consumer timed out.')) }, 30_000)
      timer.unref()
    })
  }
  async push(value: T, signal: AbortSignal): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (bytes > REMOTE_WEB_LIMITS.frameBytes) fail('protocol_error', 'Web stream frame limit exceeded.')
    while (!this.ended && this.bytes + bytes > REMOTE_WEB_LIMITS.queueBytes) await this.wait(signal)
    active(signal)
    if (this.ended) fail('request_cancelled', 'Web stream already ended.')
    this.entries.push({ value, bytes }); this.bytes += bytes; this.wake()
  }
  close(error?: unknown) { this.ended = true; this.failure = error; this.wake() }
  async *read(signal: AbortSignal): AsyncIterable<T> {
    while (true) {
      active(signal)
      const row = this.entries.shift()
      if (row) { this.bytes -= row.bytes; this.wake(); yield row.value }
      else if (this.ended) { if (this.failure) throw this.failure; return }
      else await this.wait(signal)
    }
  }
}

/** PC-private, same-authority Cookie jar. No upstream authorization value enters the public result. */
export class RemoteWebStaticClient {
  private root = ''
  private cookie = ''
  private token = ''
  private authentication?: Promise<void>
  private readonly baseUrl: () => string
  private readonly authenticatedUrl: (root: string) => string
  constructor(baseUrl: () => string, authenticatedUrl: (root: string) => string) { this.baseUrl = baseUrl; this.authenticatedUrl = authenticatedUrl }
  private async request(url: URL, headers: Record<string, string>, signal: AbortSignal, limit = REMOTE_WEB_LIMITS.responseBytes): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    active(signal)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) fail('permission_denied', 'Upstream web server must be PC loopback.')
    return new Promise((resolve, reject) => {
      const request = http.request(url, { method: 'GET', headers: { ...headers, host: url.host, origin: url.origin, 'accept-encoding': 'gzip' }, signal }, response => {
        const blocks: Buffer[] = []; let size = 0
        if (Number(response.headers['content-length'] ?? 0) > limit) { response.destroy(); reject(new ConnectionPluginError('protocol_error', 'Upstream response limit exceeded.')); return }
        response.on('data', block => {
          size += block.length
          if (size > limit) { response.destroy(new ConnectionPluginError('protocol_error', 'Upstream response limit exceeded.')); return }
          blocks.push(block)
        })
        response.on('error', reject)
        response.on('end', () => resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(blocks, size) }))
      })
      request.setTimeout(15_000, () => request.destroy(new ConnectionPluginError('request_timeout', 'PC web server timed out.')))
      request.on('error', reject); request.end()
    })
  }
  private async authenticate(signal: AbortSignal) {
    const root = new URL(this.baseUrl())
    if (root.protocol !== 'http:' || root.hostname !== '127.0.0.1' || root.pathname !== '/' || root.search || root.username || root.password) fail('permission_denied', 'Invalid PC web server authority.')
    if (this.root === root.href && this.cookie) return
    if (!this.authentication) this.authentication = (async () => {
      const authenticated = new URL(this.authenticatedUrl(root.href))
      if (authenticated.origin !== root.origin || authenticated.pathname !== '/' || !authenticated.searchParams.get('token')) fail('permission_denied', 'PC web authentication is unavailable.')
      const response = await this.request(authenticated, {}, signal, 8192)
      if (response.status !== 303 || response.headers.location !== './') fail('permission_denied', 'PC web authentication was rejected.')
      const cookies = response.headers['set-cookie'] ?? []
      if (cookies.length !== 1 || cookies[0].length > 4096) fail('protocol_error', 'Invalid PC web authentication response.')
      const cookie = cookies[0].split(';')[0]
      if (!/^[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/.test(cookie)) fail('protocol_error', 'Invalid PC session cookie.')
      this.root = root.href; this.cookie = cookie; this.token = authenticated.searchParams.get('token')!
    })().finally(() => { this.authentication = undefined })
    await this.authentication
  }
  async get(input: ReturnType<typeof validateRemoteWebHttp>, signal: AbortSignal) {
    await this.authenticate(signal)
    const response = await this.request(new URL(input.path, this.root), { ...input.headers, cookie: this.cookie }, signal)
    if (response.status === 401 || response.status === 403) { this.cookie = ''; fail('permission_denied', 'PC web session expired.') }
    // Redirecting a browser to an upstream authority or token is never allowed.
    if (response.status >= 300 && response.status < 400 && response.status !== 304) fail('permission_denied', 'Upstream redirects cannot leave the phone proxy.')
    const encoding = response.headers['content-encoding']
    if (encoding !== undefined && encoding !== 'identity' && encoding !== 'gzip') fail('protocol_error', 'Unknown upstream content encoding.')
    let publicBody: Buffer
    try { publicBody = encoding === 'gzip' ? gunzipSync(response.body, { maxOutputLength: 32 * 1024 * 1024 }) : response.body }
    catch { fail('protocol_error', 'Invalid or oversized compressed upstream response.') }
    if ([this.cookie, this.cookie.split('=')[1], this.token].some(secret => secret && publicBody.includes(Buffer.from(secret)))) fail('permission_denied', 'Upstream page contains private authentication data.')
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(response.headers)) if (RESPONSE_HEADERS.has(key) && typeof value === 'string' && value.length <= 1024 && !/[\r\n]/.test(value)) headers[key] = value
    return { status: response.status, headers, body: response.body }
  }
}

const READ_RPC: Record<string, string> = { 'session/modelCatalog': 'models.catalog', 'session/list': 'session.list', 'permissionPresets/catalog': 'permissions.catalog', 'directoryPicker/list': 'directory.list' }
const TASK_RPC: Record<string, string> = { 'session/create': 'session.create', 'session/prompt': 'session.prompt', 'session/cancel': 'session.cancel', 'session/selectModel': 'session.selectModel' }
const STREAM_RPC = new Set(['session/follow', 'session/control', 'workspace/follow', '$events'])

/** Positive RPC policy shared by HTTP and mux; unknown config/credential methods cannot fall through. */
export class RemoteWebRpcRouter {
  private readonly base: RemoteDshHostAdapter
  private readonly gateway: () => any
  private readonly events?: (signal: AbortSignal) => AsyncIterable<unknown>
  constructor(base: RemoteDshHostAdapter, gateway: () => any, events?: (signal: AbortSignal) => AsyncIterable<unknown>) { this.base = base; this.gateway = gateway; this.events = events }
  async invoke(method: string, args: Record<string, any>, requestId: string, signal: AbortSignal, context?: RemoteDshHostContext): Promise<unknown> {
    active(signal)
    const operation = READ_RPC[method] ?? TASK_RPC[method]
    if (operation) {
      const expected = method === 'session/list' ? '_request' : ['session/create', 'session/prompt', 'session/cancel', 'session/selectModel'].includes(method) ? 'request' : method === 'directoryPicker/list' ? 'path' : undefined
      if (Object.keys(args).some(key => key !== expected)) fail('permission_denied', 'Remote RPC fields are restricted.')
      let payload = expected === 'path' ? { path: args.path } : expected ? args[expected] : {}
      if (!object(payload)) fail('validation_failed', 'Invalid remote RPC request.')
      if (method === 'session/prompt' && Object.keys(payload).some(key => !['sessionId', 'requestId', 'mode', 'content', 'clientTimeZone'].includes(key))) fail('permission_denied', 'Remote prompt fields are restricted.')
      // The real browser retires its optimistic prompt by the exact receipt
      // identity in user/message.source.rpcId. The outer HTTP intent remains
      // durable independently, so retain this stable inner prompt identity.
      const executionId = method === 'session/prompt' ? payload.requestId : requestId
      if (method === 'session/prompt' && !ID.test(executionId ?? '')) fail('validation_failed', 'Invalid browser prompt receipt.')
      const result: any = await this.base.execute(operation, payload, executionId, signal, context)
      return method === 'session/selectModel' ? { selected: result.selected, persisted: result.persisted } : result
    }
    // View-only capabilities must never open a local app on the PC.
    if (method === 'session/canOpenWorkspacePath' && !Object.keys(args).length) return false
    if (method === 'session/initializeDefaultModel' && !Object.keys(args).length) return null
    if (method === 'session/page' || method === 'session/projections') {
      if (Object.keys(args).some(key => key !== 'request') || !object(args.request)) fail('permission_denied', 'Remote display read fields are restricted.')
      const allowed = method === 'session/page' ? ['address', 'throughSeq', 'beforeSeq', 'maxMessages', 'turnWindow'] : ['sessionId']
      if (Object.keys(args.request).some(key => !allowed.includes(key))) fail('permission_denied', 'Remote display read fields are restricted.')
      const gateway = this.gateway()
      if (typeof gateway?.invoke !== 'function') fail('unsupported', 'DSH display gateway is unavailable.')
      const value = await gateway.invoke({ namespace: 'session', method: method.split('/')[1], args, signal })
      return method === 'session/page' ? publicDshPage(value) : value === null ? null : publicDshProjections(value)
    }
    fail('permission_denied', 'This RPC remains controlled by the PC.')
  }
  async open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    if (!STREAM_RPC.has(endpoint) || !object(payload) || Object.keys(payload).some(key => key !== 'args') || !object(payload.args)) fail('permission_denied', 'Remote stream endpoint is unavailable.')
    const expected = endpoint === 'session/follow' ? 'request' : undefined
    if (Object.keys(payload.args).some(key => key !== expected) || (expected && !object(payload.args.request))) fail('permission_denied', 'Remote stream arguments are restricted.')
    if (endpoint === 'session/follow' && Object.keys(payload.args.request).some(key => !['address', 'maxMessages', 'turnWindow', 'assistantStream'].includes(key))) fail('permission_denied', 'Remote follow fields are restricted.')
    if (endpoint === '$events') {
      // This listener never registers as an operator Remote event client:
      // approval/authentication waterfalls continue to the actual PC UI.
      if (!this.events) fail('unsupported', 'Remote display notifications are unavailable.')
      return this.events(signal)
    }
    const gateway = this.gateway()
    if (typeof gateway?.wireStream?.open !== 'function') fail('unsupported', 'DSH stream gateway is unavailable.')
    // These two streams have no client uplink. Browser item frames are rejected
    // rather than forwarded to arbitrary Gateway event waterfalls.
    const empty = (async function* () {})()
    const source: AsyncIterable<any> = await gateway.wireStream.open(endpoint, payload, empty, undefined, signal)
    return (async function* () { for await (const frame of source) yield endpoint === 'session/follow' ? publicDshFollowFrame(frame) : endpoint === 'workspace/follow' ? publicDshWorkspaceFrame(frame) : publicDshControlFrame(frame) })()
  }
}

async function* publicWebEvents(ctx: any, signal: AbortSignal): AsyncIterable<unknown> {
  if (typeof ctx?.on !== 'function') fail('unsupported', 'DSH display event source is unavailable.')
  const queue = new WebQueue<unknown>()
  const disposers: Array<() => void> = []
  const emit = (event: string, args: unknown[]) => { void queue.push({ type: 'emit', event, args }, signal).catch(error => queue.close(error)) }
  const listen = (event: string, listener: (...args: any[]) => void) => { disposers.push(ctx.on(event, listener)) }
  try {
    listen('api-session/added', row => emit('api-session/added', [(publicDshResult('session.list', { items: [row] }) as any).items[0]]))
    listen('api-session/removed', id => emit('api-session/removed', [String(id)]))
    listen('api-session/status', (id, running) => emit('api-session/status', [String(id), running === true]))
    listen('api-session/activity', (id, updatedAt) => emit('api-session/activity', [String(id), updatedAt]))
    listen('api-session/error', id => emit('api-session/error', [String(id), 'Remote session failed.']))
    listen('llm/adapters-updated', () => emit('llm/adapters-updated', []))
    yield { type: 'ready', clientId: randomUUID(), host: { home: homedir() } }
    yield* queue.read(signal)
  } finally { for (const dispose of disposers) dispose(); queue.close() }
}

interface SocketState { scope: string; requestId: string; controller: AbortController; queue: WebQueue<unknown>; streams: Map<string, AbortController>; sequence: number; lastHash?: string; writes: Promise<void>; timer: ReturnType<typeof setTimeout> }

/** Wraps the production typed adapter, with the web capability deliberately off until real E2E is recorded. */
export function createCordisRemoteWebAdapter(ctx: any, base: RemoteDshHostAdapter): RemoteDshHostAdapter {
  const get = (key: string) => typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key]
  const rpc = new RemoteWebRpcRouter(base, () => get('typertGateway'), signal => publicWebEvents(ctx, signal))
  const staticClient = new RemoteWebStaticClient(() => {
    const port = get('webServer')?.port
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('unsupported', 'PC web server is unavailable.')
    return `http://127.0.0.1:${port}/`
  }, root => { if (typeof get('connection')?.authenticatedUrl !== 'function') fail('unsupported', 'PC web authentication is unavailable.'); return get('connection').authenticatedUrl(root) })
  const responses = new Map<string, { status: number; headers: Record<string, string>; body: Buffer }>()
  const httpPending = new Set<string>()
  const sockets = new Map<string, SocketState>()
  const scope = (context?: RemoteDshHostContext) => { if (!context) fail('permission_denied', 'Web calls require authenticated sender context.'); return `${context.group}\0${context.peer}` }
  const socketFor = (payload: Record<string, any>, context?: RemoteDshHostContext) => {
    if (!ID.test(payload.socket_id ?? '')) fail('validation_failed', 'Invalid web socket generation.')
    const state = sockets.get(payload.socket_id)
    if (!state || state.scope !== scope(context)) fail('permission_denied', 'Web socket generation no longer exists.')
    return state
  }
  const close = (id: string) => {
    const state = sockets.get(id)
    if (!state) return
    clearTimeout(state.timer); state.controller.abort(); state.queue.close()
    for (const stream of state.streams.values()) stream.abort()
    sockets.delete(id)
  }
  return {
    capabilities: () => base.capabilities(),
    refreshCapabilities: () => base.refreshCapabilities?.() ?? Promise.resolve(),
    revoke: async (group, peer) => {
      for (const [id, state] of sockets) if (state.scope === `${group}\0${peer}` || peer === undefined && state.scope.startsWith(`${group}\0`)) close(id)
      await base.revoke?.(group, peer)
    },
    dispose: async () => { for (const id of sockets.keys()) close(id); responses.clear(); await base.dispose?.() },
    execute: async (operation, payload, requestId, signal, context) => {
      if (!REMOTE_WEB_OPERATIONS.includes(operation as any)) return base.execute(operation, payload, requestId, signal, context)
      active(signal); scope(context)
      if (operation === 'web.http') {
        if (httpPending.size >= 4) fail('request_timeout', 'Remote HTTP concurrency limit reached.')
        const input = validateRemoteWebHttp(payload)
        httpPending.add(requestId)
        try {
        let result: { status: number; headers: Record<string, string>; body: Buffer }
        if (input.method === 'GET') result = await staticClient.get(input, signal)
        else {
          let body: any
          try { body = JSON.parse(input.body.toString('utf8')) } catch { fail('validation_failed', 'Invalid RPC JSON.') }
          if (!object(body) || Object.keys(body).some(key => !['type', 'rpcId', 'method', 'payload'].includes(key)) || body.type !== 'client-request' ||
              !ID.test(body.rpcId ?? '') || typeof body.method !== 'string' || !object(body.payload) || Object.keys(body.payload).some(key => key !== 'args') || !object(body.payload.args) ||
              (input.path !== '/api' && input.path !== `/api/${body.method}`)) fail('validation_failed', 'Invalid RPC envelope.')
          let envelope: any
          try { envelope = { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: await rpc.invoke(body.method, body.payload.args, requestId, signal, context) } } }
          catch (error) { envelope = { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: error instanceof ConnectionPluginError ? error.code : 'remote_execution_failed', message: 'Remote RPC was not accepted.', details: {} } } } }
          result = { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from(JSON.stringify(envelope)) }
        }
        if (result.body.length > REMOTE_WEB_LIMITS.responseBytes) fail('protocol_error', 'Remote HTTP response limit exceeded.')
        responses.set(requestId, result)
        return { stream: 'http' }
        } catch (error) { httpPending.delete(requestId); throw error }
      }
      if (operation === 'web.socket') {
        if (Object.keys(payload).some(key => key !== 'path') || payload.path !== '/api/remote.mux') fail('permission_denied', 'Remote WebSocket route is unavailable.')
        if (sockets.size >= REMOTE_WEB_LIMITS.sockets) fail('request_timeout', 'Remote socket concurrency limit reached.')
        const id = 'ws-' + randomUUID().replaceAll('-', '')
        const timer = setTimeout(() => close(id), 5 * 60_000); timer.unref()
        const state: SocketState = { scope: scope(context), requestId, controller: new AbortController(), queue: new WebQueue(), streams: new Map(), sequence: 0, writes: Promise.resolve(), timer }
        signal.addEventListener('abort', () => close(id), { once: true })
        sockets.set(id, state)
        return { socket_id: id, path: '/api/remote.mux' }
      }
      const state = socketFor(payload, context)
      if (operation === 'web.socket.close') { if (Object.keys(payload).some(key => key !== 'socket_id')) fail('validation_failed', 'Invalid close fields.'); close(payload.socket_id); return { closed: true } }
      if (Object.keys(payload).some(key => !['socket_id', 'sequence', 'frame'].includes(key)) || !Number.isSafeInteger(payload.sequence) || payload.sequence < 0 || !object(payload.frame)) fail('validation_failed', 'Invalid socket send.')
      const frame = payload.frame
      if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > REMOTE_WEB_LIMITS.requestBytes || !ID.test(frame.streamId ?? '') || !['open', 'item', 'end', 'cancel'].includes(frame.type) ||
          Object.keys(frame).some(key => !(frame.type === 'open' ? ['type', 'streamId', 'endpoint', 'payload'] : frame.type === 'item' ? ['type', 'streamId', 'value'] : ['type', 'streamId']).includes(key))) fail('validation_failed', 'Invalid mux frame.')
      const fingerprint = createHash('sha256').update(JSON.stringify(frame)).digest('hex')
      const write = state.writes.catch(() => {}).then(async () => {
        active(state.controller.signal)
        if (payload.sequence === state.sequence - 1 && state.lastHash === fingerprint) return
        if (payload.sequence !== state.sequence) fail('conflict', 'Socket send sequence changed; reconnect without replaying a write.')
        if (frame.type === 'open') {
          if (state.streams.has(frame.streamId) || state.streams.size >= REMOTE_WEB_LIMITS.streams) fail('conflict', 'Mux stream limit or duplicate id.')
          const stream = new AbortController()
          state.streams.set(frame.streamId, stream)
          const abort = () => stream.abort()
          state.controller.signal.addEventListener('abort', abort, { once: true })
          void (async () => { try {
            const source = await rpc.open(frame.endpoint, frame.payload, stream.signal)
            for await (const value of source) await state.queue.push({ type: 'item', streamId: frame.streamId, value }, stream.signal)
            await state.queue.push({ type: 'end', streamId: frame.streamId }, state.controller.signal)
          } catch (error) {
            if (!state.controller.signal.aborted) await state.queue.push({ type: 'error', streamId: frame.streamId, error: { code: error instanceof ConnectionPluginError ? error.code : 'remote_execution_failed', message: 'Remote stream ended.', details: {} } }, state.controller.signal)
          } finally { state.streams.delete(frame.streamId); state.controller.signal.removeEventListener('abort', abort) } })().catch(error => { state.queue.close(error); close(payload.socket_id) })
        } else if (frame.type === 'item') fail('permission_denied', 'Client uplink is unavailable for public read streams.')
        else if (frame.type === 'cancel') state.streams.get(frame.streamId)?.abort()
        // end half-closes a read-only uplink; it does not cancel the downlink.
        state.sequence++; state.lastHash = fingerprint
      })
      state.writes = write; await write
      return { accepted: true, next_sequence: state.sequence }
    },
    follow: async function* (payload, signal, operation, requestId, context) {
      if (operation === 'web.http') {
        const response = responses.get(requestId!)
        if (!response) fail('conflict', 'HTTP result generation changed.')
        try { for await (const frame of remoteWebHttpFrames(response.status, response.headers, response.body)) { active(signal); yield frame } }
        finally { responses.delete(requestId!); httpPending.delete(requestId!); response.body.fill(0) }
      } else if (operation === 'web.socket') {
        const match = [...sockets.entries()].find(([, value]) => value.scope === scope(context) && value.requestId === requestId)
        // The execution result, not client input, chooses the socket generation.
        if (!match) fail('conflict', 'Web socket execution generation changed.')
        const id = match[0]
        const state = socketFor({ socket_id: id }, context)
        try { for await (const frame of state.queue.read(signal)) yield { kind: 'ws.frame', frame } }
        finally { close(id) }
      } else if (base.follow) yield* base.follow(payload, signal, operation, requestId, context)
    },
    cancel: sessionId => base.cancel(sessionId),
  }
}

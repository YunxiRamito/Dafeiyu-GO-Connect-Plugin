import path from 'node:path'
import { constants, type BigIntStats } from 'node:fs'
import { type FileHandle, lstat, open, opendir, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { ConnectionPluginError } from './errors.ts'
import { decideSyncPath } from './path-policy.ts'
import type { RemoteDshHostContext } from './remote-host.ts'

type Value = Record<string, any>
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^[a-f0-9]{64}$/
const IGNORED = ['.git', 'node_modules', '.venv', '__pycache__', '.cache']
export const ARTIFACT_OPERATIONS = Object.freeze(['artifact.list', 'artifact.prepare', 'artifact.read', 'artifact.close'])
export const ARTIFACT_CHUNK_BYTES = 48 * 1024

function fail(code: 'validation_failed' | 'permission_denied' | 'conflict' | 'unsupported' | 'request_cancelled' | 'disk_space_low', message: string): never {
  throw new ConnectionPluginError(code, message)
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value))
    fail('validation_failed', 'Invalid artifact identity.')
  return value
}
function relativePath(value: unknown, empty = false): string {
  if (value === '' && empty) return ''
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\\') || value.includes(':') || /[\x00-\x1f\x7f]/.test(value))
    fail('validation_failed', 'Invalid relative artifact path.')
  const segments = value.split('/')
  if (segments.length > 64 || segments.some(item => !item || item.length > 255 || ['.', '..'].includes(item)))
    fail('validation_failed', 'Artifact path must remain inside the workspace.')
  return value
}
function fields(payload: Value, allowed: string[]): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.includes(key)))
    fail('permission_denied', 'Unknown artifact request field.')
}
function samePath(left: string, right: string): boolean { return path.relative(left, right) === '' }
function version(info: BigIntStats): string {
  return createHash('sha256').update([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')).digest('hex')
}
interface Root { workspaceId: string; declared: string; canonical: string; identity: string }
interface Ticket {
  id: string; group: string; peer: string; root: Root; relativePath: string; handle: FileHandle;
  version: string; size: number; sha256: string; expiresAt: number;
}
interface ActiveRequest {
  group: string; peer: string; controller: AbortController; done: Promise<void>;
}

/** Only an explicit prepare opens a user file. There is no directory sync or arbitrary-path endpoint. */
export class RemoteArtifactReader {
  private tickets = new Map<string, Ticket>()
  private closed = false
  private preparing = 0
  private activeReads = 0
  private requests = new Set<ActiveRequest>()
  private revokedGroups = new Set<string>()
  private revokedPeers = new Set<string>()
  private readonly maxBytes: number
  private readonly ttlMillis: number
  private readonly maxTickets: number
  private readonly ctx: any
  constructor(ctx: any, options: { maxBytes?: number; ttlMillis?: number; maxTickets?: number } = {}) {
    this.ctx = ctx
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024
    this.ttlMillis = options.ttlMillis ?? 30 * 60 * 1000
    this.maxTickets = options.maxTickets ?? 16
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0 || this.maxBytes > 512 * 1024 * 1024 ||
        !Number.isSafeInteger(this.ttlMillis) || this.ttlMillis < 1 || this.ttlMillis > 30 * 60 * 1000 ||
        !Number.isSafeInteger(this.maxTickets) || this.maxTickets < 1 || this.maxTickets > 32)
      fail('validation_failed', 'Invalid artifact resource bounds.')
  }
  private get registry(): any { return typeof this.ctx?.get === 'function' ? this.ctx.get('workspaceRegistry') : this.ctx?.workspaceRegistry }
  available(): boolean { return !this.closed && typeof this.registry?.get === 'function' }
  private active(signal: AbortSignal): void {
    if (this.closed || signal.aborted) fail('request_cancelled', 'Artifact request cancelled.')
  }
  private async root(workspaceId: unknown): Promise<Root> {
    const id = identifier(workspaceId), workspace = this.registry?.get(id)
    if (!workspace || workspace.id !== id || typeof workspace.path !== 'string' || !path.isAbsolute(workspace.path))
      fail('permission_denied', 'Artifact workspace is unavailable.')
    const declared = path.normalize(workspace.path), info = await lstat(declared, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) fail('permission_denied', 'Artifact workspace cannot be a link.')
    return { workspaceId: id, declared, canonical: await realpath(declared), identity: `${info.dev}:${info.ino}` }
  }
  private async rootStillCurrent(root: Root): Promise<void> {
    const now = await this.root(root.workspaceId)
    if (!samePath(now.declared, root.declared) || !samePath(now.canonical, root.canonical) || now.identity !== root.identity)
      fail('conflict', 'Artifact workspace changed.')
  }
  private async candidate(root: Root, relative: string, directory: boolean): Promise<{ file: string; info: BigIntStats }> {
    const file = path.join(root.canonical, ...relative.split('/').filter(Boolean))
    if (!decideSyncPath(root.canonical, file, IGNORED).allowed) fail('permission_denied', 'Artifact path is unavailable.')
    let current = root.canonical
    for (const segment of relative.split('/').filter(Boolean)) {
      current = path.join(current, segment)
      const part = await lstat(current, { bigint: true })
      if (part.isSymbolicLink()) fail('permission_denied', 'Artifact links are unavailable.')
    }
    const info = await lstat(file, { bigint: true }), canonical = await realpath(file)
    if (!samePath(file, canonical) || !(directory ? info.isDirectory() : info.isFile()))
      fail('permission_denied', 'Artifact path has an unsupported type.')
    if (!directory && (info.size < 0 || info.size > BigInt(this.maxBytes))) fail('disk_space_low', 'Artifact exceeds the download bound.')
    await this.rootStillCurrent(root)
    return { file, info }
  }
  private async expire(): Promise<void> {
    const expired = [...this.tickets.values()].filter(value => value.expiresAt <= Date.now())
    for (const value of expired) { this.tickets.delete(value.id); await value.handle.close().catch(() => {}) }
  }
  async execute(operation: string, payload: Value, _requestId: string, signal: AbortSignal, context?: RemoteDshHostContext): Promise<unknown> {
    this.active(signal)
    if (!this.available()) fail('unsupported', 'Artifact service is unavailable.')
    if (!context) fail('permission_denied', 'Artifact requests require an authenticated relationship.')
    identifier(context.group); identifier(context.peer)
    if (this.revokedGroups.has(context.group) || this.revokedPeers.has(`${context.group}\n${context.peer}`))
      fail('permission_denied', 'Artifact relationship has been revoked.')
    if (this.requests.size >= 64) fail('disk_space_low', 'Too many active artifact requests.')
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    let finish!: () => void
    const request: ActiveRequest = { group: context.group, peer: context.peer, controller,
      done: new Promise(resolve => { finish = resolve }) }
    this.requests.add(request)
    try {
      await this.expire(); this.active(controller.signal)
      const result = await this.dispatch(operation, payload, controller.signal, context)
      this.active(controller.signal)
      return result
    } finally {
      signal.removeEventListener('abort', cancel)
      this.requests.delete(request)
      finish()
    }
  }
  private async dispatch(operation: string, payload: Value, signal: AbortSignal, context: RemoteDshHostContext): Promise<unknown> {
    switch (operation) {
      case 'artifact.list': return this.list(payload, signal)
      case 'artifact.prepare': return this.prepare(payload, signal, context)
      case 'artifact.read': return this.read(payload, signal, context)
      case 'artifact.close': {
        fields(payload, ['ticket'])
        const id = identifier(payload.ticket), ticket = this.tickets.get(id)
        if (ticket && (ticket.group !== context.group || ticket.peer !== context.peer)) fail('permission_denied', 'Artifact ticket belongs to another relationship.')
        if (ticket) { this.tickets.delete(id); await ticket.handle.close() }
        return { ticket: id, closed: true }
      }
      default: fail('unsupported', 'Unknown artifact operation.')
    }
  }
  /** A terminal relationship revokes its operations without disabling unrelated or newly paired groups. */
  async revoke(group: string, peer?: string): Promise<void> {
    identifier(group)
    if (peer !== undefined) { identifier(peer); this.revokedPeers.add(`${group}\n${peer}`) }
    else this.revokedGroups.add(group)
    const matches = (value: { group: string; peer: string }) => value.group === group && (peer === undefined || value.peer === peer)
    const requests = [...this.requests].filter(matches)
    for (const request of requests) request.controller.abort()
    const tickets = [...this.tickets.values()].filter(matches)
    for (const ticket of tickets) this.tickets.delete(ticket.id)
    // FileHandle.close waits for an outstanding read. Request completion also
    // waits for prepare's finally block to close its unpublished handle.
    await Promise.allSettled([...requests.map(request => request.done), ...tickets.map(ticket => ticket.handle.close())])
  }
  private async list(payload: Value, signal: AbortSignal): Promise<unknown> {
    fields(payload, ['workspaceId', 'directory', 'cursor', 'limit'])
    const root = await this.root(payload.workspaceId), relative = relativePath(payload.directory ?? '', true)
    const cursor = payload.cursor === undefined ? null : relativePath(payload.cursor)
    if (cursor !== null && cursor.includes('/')) fail('validation_failed', 'Artifact cursor must be a basename.')
    const limit = payload.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('validation_failed', 'Invalid artifact page size.')
    const directory = await this.candidate(root, relative, true), names: string[] = []
    for await (const entry of await opendir(directory.file)) {
      this.active(signal)
      if (names.length >= 10_000) fail('disk_space_low', 'Choose a smaller artifact directory.')
      names.push(entry.name)
    }
    names.sort()
    const entries: Value[] = []
    let hasMore = false
    for (const name of names) {
      this.active(signal)
      if (cursor !== null && name <= cursor) continue
      let item: { file: string; info: BigIntStats }
      const child = relative ? `${relative}/${name}` : name
      try {
        relativePath(child)
        const info = await lstat(path.join(directory.file, name), { bigint: true })
        if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) continue
        item = await this.candidate(root, child, info.isDirectory())
      } catch (error) {
        if ((error as any)?.code === 'ENOENT' || (error as any)?.code === 'permission_denied' || (error as any)?.code === 'validation_failed' || (error as any)?.code === 'disk_space_low') continue
        throw error
      }
      if (entries.length === limit) { hasMore = true; break }
      entries.push({ name, relativePath: child, kind: item.info.isDirectory() ? 'directory' : 'file',
        size: item.info.isFile() ? Number(item.info.size) : 0, version: version(item.info) })
    }
    this.active(signal); await this.rootStillCurrent(root)
    return { workspaceId: root.workspaceId, directory: relative, entries, nextCursor: hasMore ? entries.at(-1)!.name : null }
  }
  private async prepare(payload: Value, signal: AbortSignal, context: RemoteDshHostContext): Promise<unknown> {
    fields(payload, ['workspaceId', 'relativePath', 'version'])
    if (typeof payload.version !== 'string' || !HASH.test(payload.version)) fail('validation_failed', 'Prepare requires the selected file version.')
    if (this.preparing >= 4 || this.tickets.size + this.preparing >= this.maxTickets) fail('disk_space_low', 'Too many artifact downloads.')
    this.preparing++
    let handle: FileHandle | undefined
    try {
      const root = await this.root(payload.workspaceId), relative = relativePath(payload.relativePath)
      const source = await this.candidate(root, relative, false)
      if (version(source.info) !== payload.version) fail('conflict', 'Selected artifact changed; refresh the directory.')
      this.active(signal)
      handle = await open(source.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const original = await handle.stat({ bigint: true })
      if (!original.isFile() || version(original) !== payload.version) fail('conflict', 'Artifact changed while opening.')
      const checked = await this.candidate(root, relative, false)
      if (version(checked.info) !== payload.version) fail('conflict', 'Artifact path changed while opening.')
      const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(ARTIFACT_CHUNK_BYTES)
      let offset = 0
      while (offset < Number(original.size)) {
        this.active(signal)
        const count = Math.min(buffer.length, Number(original.size) - offset)
        const { bytesRead } = await handle.read(buffer, 0, count, offset)
        if (bytesRead !== count) fail('conflict', 'Artifact changed while hashing.')
        digest.update(buffer.subarray(0, count)); offset += count
      }
      if (version(await handle.stat({ bigint: true })) !== payload.version) fail('conflict', 'Artifact changed while hashing.')
      await this.rootStillCurrent(root); this.active(signal)
      const ticket: Ticket = { id: randomUUID(), group: context.group, peer: context.peer, root, relativePath: relative,
        handle, version: payload.version, size: Number(original.size), sha256: digest.digest('hex'), expiresAt: Date.now() + this.ttlMillis }
      this.tickets.set(ticket.id, ticket); handle = undefined
      return { ticket: ticket.id, workspaceId: root.workspaceId, relativePath: relative, fileName: path.posix.basename(relative),
        version: ticket.version, size: ticket.size, sha256: ticket.sha256, chunkBytes: ARTIFACT_CHUNK_BYTES, expiresAt: ticket.expiresAt }
    } finally { this.preparing--; await handle?.close().catch(() => {}) }
  }
  private async read(payload: Value, signal: AbortSignal, context: RemoteDshHostContext): Promise<unknown> {
    fields(payload, ['ticket', 'offset', 'length'])
    const ticket = this.tickets.get(identifier(payload.ticket))
    if (!ticket || ticket.group !== context.group || ticket.peer !== context.peer) fail('permission_denied', 'Artifact ticket is unavailable for this relationship.')
    const offset = payload.offset, length = payload.length
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > ticket.size || !Number.isInteger(length) || length < 1 || length > ARTIFACT_CHUNK_BYTES)
      fail('validation_failed', 'Invalid artifact byte range.')
    if (this.activeReads >= 32) fail('disk_space_low', 'Artifact read concurrency exceeded.')
    this.activeReads++
    try {
      await this.rootStillCurrent(ticket.root)
      const source = await this.candidate(ticket.root, ticket.relativePath, false)
      if (version(source.info) !== ticket.version || version(await ticket.handle.stat({ bigint: true })) !== ticket.version)
        fail('conflict', 'Artifact changed during download.')
      this.active(signal)
      const count = Math.min(length, ticket.size - offset), buffer = Buffer.allocUnsafe(count)
      const { bytesRead } = await ticket.handle.read(buffer, 0, count, offset)
      if (bytesRead !== count || version(await ticket.handle.stat({ bigint: true })) !== ticket.version)
        fail('conflict', 'Artifact changed during download.')
      this.active(signal)
      return { ticket: ticket.id, offset, size: ticket.size, version: ticket.version, sha256: ticket.sha256, bytesBase64: buffer.toString('base64') }
    } finally { this.activeReads-- }
  }
  async dispose(): Promise<void> {
    this.closed = true
    const requests = [...this.requests]
    for (const request of requests) request.controller.abort()
    const tickets = [...this.tickets.values()]; this.tickets.clear()
    await Promise.allSettled([...requests.map(request => request.done), ...tickets.map(ticket => ticket.handle.close())])
  }
}

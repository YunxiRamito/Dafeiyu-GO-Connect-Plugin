import { ConnectionPluginError } from './errors.ts'

const SENSITIVE_QUERY_KEYS = /^(token|access_token|refresh_token|api[_-]?key|authorization|auth|signature|sig|session|session_id|cookie|password|secret|private_key|key)$/i
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const SENSITIVE_TEXT = /(?:authorization\s*:|cookie\s*:|set-cookie\s*:|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session(?:[_-]?id)?|bearer|token|secret|password)\s*[=:])/i

export interface BroadcastInput { url: string; title?: string; selection?: string; message?: string; sender_device_id: string; created_at?: string }
export interface BroadcastPayload { kind: 'dsh_web_broadcast'; url: string; title: string; selection: string; message: string; sender_device_id: string; created_at: string }
function boundedText(value: unknown, max: number): string { return String(value ?? '').replaceAll('\u0000', '').trim().slice(0, max) }
function safeText(value: unknown, max: number): string { const text = boundedText(value, max); if (SENSITIVE_TEXT.test(text)) throw new ConnectionPluginError('validation_failed', '网页广播文本包含敏感凭据模式。'); return text }

export function sanitizeBroadcastUrl(value: string, options: { allowLocalHttp?: boolean } = {}): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ConnectionPluginError('validation_failed', '网页 URL 无效。') }
  const local = LOCAL_HOSTS.has(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(options.allowLocalHttp === true && local && url.protocol === 'http:')) throw new ConnectionPluginError('validation_failed', '网页广播只允许 HTTPS；本地 HTTP 必须显式允许。')
  if (url.username || url.password) { url.username = ''; url.password = '' }
  for (const key of [...url.searchParams.keys()]) if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.delete(key)
  url.hash = ''
  return url.toString()
}

export function createBroadcastPayload(input: BroadcastInput, options: { allowLocalHttp?: boolean; includeSelection?: boolean; maxTitleLength?: number; maxSelectionLength?: number; maxMessageLength?: number } = {}): BroadcastPayload {
  return { kind: 'dsh_web_broadcast', url: sanitizeBroadcastUrl(input.url, options), title: safeText(input.title, options.maxTitleLength ?? 240), selection: options.includeSelection === true ? safeText(input.selection, options.maxSelectionLength ?? 4000) : '', message: safeText(input.message, options.maxMessageLength ?? 2000), sender_device_id: boundedText(input.sender_device_id, 128), created_at: input.created_at ?? new Date().toISOString() }
}
export function sanitizeIncomingBroadcast(payload: Partial<BroadcastPayload>): BroadcastPayload {
  const safe = createBroadcastPayload({ url: String(payload.url ?? ''), title: payload.title, selection: payload.selection, message: payload.message, sender_device_id: payload.sender_device_id ?? '', created_at: payload.created_at }, { includeSelection: true })
  return { ...safe, title: stripMarkup(safe.title), selection: stripMarkup(safe.selection), message: stripMarkup(safe.message) }
}
export function stripMarkup(value: string): string { return value.replace(/<[^>]*>/g, '').replace(/javascript\s*:/gi, '').replace(/on\w+\s*=/gi, '') }

export class MessageDeduplicator {
  #seen = new Set<string>()
  readonly maxEntries: number
  constructor(maxEntries = 1000) { this.maxEntries = maxEntries }
  accept(messageId: string): boolean { if (!messageId || this.#seen.has(messageId)) return false; this.#seen.add(messageId); if (this.#seen.size > this.maxEntries) this.#seen.delete(this.#seen.values().next().value as string); return true }
  clear(): void { this.#seen.clear() }
}


import { createHash, randomUUID } from 'node:crypto';
import { BroadcastError, DEFAULT_BROADCAST_CONFIG } from './types.js';
                                                                                    

                                                                

const SENSITIVE_QUERY_KEY = /(?:^|[-_])(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|session(?:[-_]?id)?|secret|password|passwd|signature|sig|cookie|credential)(?:$|[-_])/i;
const SENSITIVE_TEXT = /(?:authorization\s*:|cookie\s*:|set-cookie\s*:|(?:api[-_]?key|access[-_]?token|refresh[-_]?token|session(?:[-_]?id)?|bearer|token)\s*[=:])/i;
const LOOPBACK_HOST = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function clampText(value         , maxLength        , field        )         {
  if (typeof value !== 'string') throw new BroadcastError('invalid_input', `${field} must be text.`);
  const normalized = value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (normalized.length === 0) throw new BroadcastError('invalid_input', `${field} must not be empty.`);
  if (normalized.length > maxLength) throw new BroadcastError('length_limit', `${field} exceeds the configured length limit.`);
  return normalized;
}

export function isLocalDshUrl(value     )          {
  return LOOPBACK_HOST.has(value.hostname.toLowerCase()) && value.port !== '';
}

export function sanitizeUrl(raw         , config                                                                  = DEFAULT_BROADCAST_CONFIG)         {
  if (typeof raw !== 'string' || raw.trim() === '') throw new BroadcastError('invalid_url', 'A URL is required.');
  if (raw.length > config.maxUrlLength * 4) throw new BroadcastError('length_limit', 'URL exceeds the allowed input size.');

  let url     ;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BroadcastError('invalid_url', 'URL is not valid.');
  }

  const scheme = url.protocol.toLowerCase();
  const localDsh = isLocalDshUrl(url);
  if (scheme !== 'https:' && !(config.allowLocalDsh && localDsh && scheme === 'http:')) {
    throw new BroadcastError('insecure_url', 'Only HTTPS URLs are allowed; local DSH HTTP must be explicitly enabled.');
  }
  if (url.username || url.password) throw new BroadcastError('sensitive_url', 'URLs containing user information are not allowed.');
  if (url.hostname === '' || url.hostname.includes('..')) throw new BroadcastError('invalid_url', 'URL host is not valid.');

  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      url.searchParams.delete(key);
      continue;
    }
    for (const value of url.searchParams.getAll(key)) {
      if (SENSITIVE_TEXT.test(value)) throw new BroadcastError('sensitive_url', 'URL contains a credential-like value.');
    }
  }
  url.hash = '';
  const result = url.toString();
  if (result.length > config.maxUrlLength) throw new BroadcastError('length_limit', 'Sanitized URL exceeds the configured length limit.');
  if (SENSITIVE_TEXT.test(result)) throw new BroadcastError('sensitive_url', 'URL contains a credential-like value.');
  return result;
}

export function assertSafePayload(value         )                                    {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BroadcastError('unsafe_payload', 'Broadcast payload must be an object.');
  const object = value                           ;
  const forbidden = /^(?:authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|session(?:[-_]?id)?|secret|password|passwd|private[-_]?key|content[-_]?key|signature|credential|command|browser[-_]?command)$/i;
  for (const [key, child] of Object.entries(object)) {
    if (forbidden.test(key)) throw new BroadcastError('unsafe_payload', `Payload field ${key} is forbidden.`);
    if (typeof child === 'object' && child !== null) assertNoForbiddenFields(child, forbidden);
    if (typeof child === 'string' && SENSITIVE_TEXT.test(child)) throw new BroadcastError('unsafe_payload', 'Payload contains credential-like text.');
  }
}

function assertNoForbiddenFields(value        , forbidden        )       {
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.test(key)) throw new BroadcastError('unsafe_payload', `Payload field ${key} is forbidden.`);
    if (typeof child === 'object' && child !== null) assertNoForbiddenFields(child, forbidden);
    if (typeof child === 'string' && SENSITIVE_TEXT.test(child)) throw new BroadcastError('unsafe_payload', 'Payload contains credential-like text.');
  }
}

export function buildBroadcastPayload(input                , config                          = DEFAULT_BROADCAST_CONFIG)                   {
  const title = clampText(input.title ?? (input.selectedText ? 'DSH 选中文本' : ''), config.maxTitleLength, 'title');
  const selectedText = input.selectedText?.trim() ?? '';
  const hasSelection = selectedText.length > 0;
  const hasUrl = typeof input.url === 'string' && input.url.trim() !== '';
  if (!hasUrl && !(hasSelection && input.selectionConfirmed === true)) {
    throw new BroadcastError('missing_content', 'Provide a title and URL, or explicitly confirm selected text.');
  }
  if (hasUrl && !input.title?.trim()) throw new BroadcastError('missing_title', 'A title is required when broadcasting a URL.');

  const payload                   = {
    schemaVersion: 1,
    messageId: randomUUID(),
    kind: hasUrl ? 'link' : 'selection',
    title,
    sentAt: new Date().toISOString(),
  };
  if (hasUrl) payload.url = sanitizeUrl(input.url, config);
  if (hasSelection) payload.text = clampText(selectedText, config.maxTextLength, 'selectedText');
  assertSafePayload(payload);
  return payload;
}

export function messageFingerprint(payload                                                                                                       )         {
  return createHash('sha256').update(JSON.stringify([
    payload.messageId, payload.kind, payload.title, payload.url ?? '', payload.text ?? '', payload.sourceDeviceId ?? '', payload.sentAt,
  ])).digest('hex');
}

export function safeRemotePayload(value         , config                          = DEFAULT_BROADCAST_CONFIG)                   {
  assertSafePayload(value);
  const candidate = value                           ;
  if (candidate.schemaVersion !== 1 || (candidate.kind !== 'link' && candidate.kind !== 'selection')) throw new BroadcastError('invalid_payload', 'Unsupported broadcast payload.');
  const title = clampText(candidate.title, config.maxTitleLength, 'title');
  const sentAt = typeof candidate.sentAt === 'string' && !Number.isNaN(Date.parse(candidate.sentAt)) ? new Date(candidate.sentAt).toISOString() : null;
  if (!sentAt) throw new BroadcastError('invalid_payload', 'Broadcast timestamp is invalid.');
  const result                   = {
    schemaVersion: 1,
    messageId: typeof candidate.messageId === 'string' && candidate.messageId.length <= 128 ? candidate.messageId : messageFingerprint({ ...candidate, title, sentAt }                    ),
    kind: candidate.kind,
    title,
    sentAt,
  };
  if (candidate.url !== undefined) result.url = sanitizeUrl(candidate.url, config);
  if (candidate.text !== undefined) result.text = clampText(candidate.text, config.maxTextLength, 'text');
  if (result.kind === 'link' && !result.url) throw new BroadcastError('invalid_payload', 'Link payload has no URL.');
  if (result.kind === 'selection' && !result.text) throw new BroadcastError('invalid_payload', 'Selection payload has no text.');
  if (typeof candidate.sourceDeviceId === 'string' && candidate.sourceDeviceId.length <= 200) result.sourceDeviceId = candidate.sourceDeviceId;
  assertSafePayload(result);
  return result;
}


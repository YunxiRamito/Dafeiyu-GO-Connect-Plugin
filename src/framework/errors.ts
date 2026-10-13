export const ERROR_CODES = Object.freeze({
  launcher_unavailable: 'launcher_unavailable',
  connection_unavailable: 'connection_unavailable',
  pairing_incomplete: 'pairing_incomplete',
  presence_unknown: 'presence_unknown',
  remote_offline: 'remote_offline',
  revoked: 'revoked',
  permission_denied: 'permission_denied',
  transport_unavailable: 'transport_unavailable',
  tls_failure: 'tls_failure',
  request_timeout: 'request_timeout',
  request_cancelled: 'request_cancelled',
  validation_failed: 'validation_failed',
  unsupported: 'unsupported',
  disk_space_low: 'disk_space_low',
  conflict: 'conflict',
  retry_exhausted: 'retry_exhausted',
  cache_cleanup_pending: 'cache_cleanup_pending',
  cache_cleanup_partial: 'cache_cleanup_partial',
  cache_cleanup_idempotency: 'cache_cleanup_idempotency',
  protocol_error: 'protocol_error',
} as const)

export type ErrorCode = keyof typeof ERROR_CODES

export class ConnectionPluginError extends Error {
  readonly code: ErrorCode
  readonly requestId: string
  readonly retryable: boolean
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, options: { requestId?: string; retryable?: boolean; details?: unknown } = {}) {
    super(message)
    this.name = 'ConnectionPluginError'
    this.code = code
    this.requestId = options.requestId ?? ''
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

export interface ErrorEnvelope {
  success: false
  request_id: string
  error_code: ErrorCode
  message: string
  retryable?: boolean
}

export function toErrorEnvelope(error: unknown, requestId: string): ErrorEnvelope {
  if (error instanceof ConnectionPluginError) {
    return { success: false, request_id: requestId, error_code: error.code, message: error.message, retryable: error.retryable }
  }
  return { success: false, request_id: requestId, error_code: 'protocol_error', message: '未处理的插件错误。', retryable: false }
}

export function classifyConnectionState(state: { server_connected: boolean; pairing_status: string; remote_device?: { online: string } | null }): ErrorCode | null {
  if (!state.server_connected) return 'connection_unavailable'
  if (state.pairing_status !== 'paired') return 'pairing_incomplete'
  if (!state.remote_device) return 'presence_unknown'
  if (state.remote_device.online === 'unknown') return 'presence_unknown'
  if (state.remote_device?.online === 'offline') return 'remote_offline'
  return null
}



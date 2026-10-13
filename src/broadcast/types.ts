/** High-level launcher boundary for DSH web broadcast. */
export type BroadcastConnectionStatus = 'connected' | 'launcher_unavailable' | 'server_disconnected' | 'not_paired' | 'revoked' | 'unknown';
export type RemotePresence = 'online' | 'offline' | 'unknown';

export interface BroadcastConnectionContext {
  serverConnected: boolean;
  pairingComplete: boolean;
  groupId: string;
  localDeviceId?: string;
  remotePresence?: RemotePresence;
  status?: BroadcastConnectionStatus;
}

export interface BroadcastPayload {
  schemaVersion: 1;
  messageId: string;
  kind: 'link' | 'selection';
  title: string;
  url?: string;
  text?: string;
  sourceDeviceId?: string;
  sentAt: string;
}

export interface BroadcastEnvelope extends BroadcastPayload {
  sourceDeviceId: string;
  receivedAt: string;
}

export interface BroadcastProvider {
  getConnectionContext(signal?: AbortSignal): Promise<BroadcastConnectionContext>;
  sendBroadcast(payload: BroadcastPayload, signal?: AbortSignal): Promise<void>;
  subscribeBroadcast(handler: (payload: unknown) => void | Promise<void>): () => void;
}

export interface BroadcastConfig {
  enabled?: boolean;
  allowLocalDsh?: boolean;
  maxTitleLength?: number;
  maxUrlLength?: number;
  maxTextLength?: number;
  maxHistoryEntries?: number;
  dedupeWindowMs?: number;
}

export interface BroadcastInput {
  title?: string;
  url?: string;
  selectedText?: string;
  selectionConfirmed?: boolean;
}

export interface BroadcastNotice {
  envelope: BroadcastEnvelope;
  /** Intentionally plain text. The controller never executes or renders remote HTML. */
  displayText: string;
  muted: boolean;
  open: () => Promise<never>;
}

export interface BroadcastCallbacks {
  onNotice?: (notice: BroadcastNotice) => void;
  onError?: (error: BroadcastError) => void;
}

export interface SendBroadcastResult {
  accepted: boolean;
  messageId?: string;
  reason?: string;
}

export class BroadcastError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.cause = cause;
  }
}

export const DEFAULT_BROADCAST_CONFIG: Required<BroadcastConfig> = {
  enabled: false,
  allowLocalDsh: false,
  maxTitleLength: 200,
  maxUrlLength: 2048,
  maxTextLength: 4000,
  maxHistoryEntries: 100,
  dedupeWindowMs: 10 * 60 * 1000,
};

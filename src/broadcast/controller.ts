import { BroadcastError, DEFAULT_BROADCAST_CONFIG } from './types.ts';
import type {
  BroadcastCallbacks,
  BroadcastConnectionContext,
  BroadcastEnvelope,
  BroadcastInput,
  BroadcastNotice,
  BroadcastPayload,
  BroadcastProvider,
  BroadcastConfig,
  SendBroadcastResult,
} from './types.ts';
import { buildBroadcastPayload, messageFingerprint, safeRemotePayload } from './security.ts';
import type { RequiredBroadcastConfig } from './security.ts';

export class BroadcastController {
  private readonly config: RequiredBroadcastConfig;
  private readonly provider: BroadcastProvider;
  private readonly callbacks: BroadcastCallbacks;
  private readonly history: BroadcastEnvelope[] = [];
  private readonly seen = new Map<string, number>();
  private unsubscribe: (() => void) | undefined;
  private enabled: boolean;
  private receivingPaused = false;
  private muted = false;

  constructor(provider: BroadcastProvider, config: BroadcastConfig = {}, callbacks: BroadcastCallbacks = {}) {
    if (!provider || typeof provider.getConnectionContext !== 'function' || typeof provider.sendBroadcast !== 'function' || typeof provider.subscribeBroadcast !== 'function') {
      throw new BroadcastError('provider_invalid', 'A high-level broadcast Provider is required.');
    }
    this.provider = provider;
    this.config = { ...DEFAULT_BROADCAST_CONFIG, ...config };
    this.callbacks = callbacks;
    this.enabled = this.config.enabled;
    this.unsubscribe = provider.subscribeBroadcast((payload) => void this.receive(payload));
  }

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }
  mute(): void { this.muted = true; }
  resume(): void { this.muted = false; }
  isMuted(): boolean { return this.muted; }
  pauseReceiving(): void { this.receivingPaused = true; }
  resumeReceiving(): void { this.receivingPaused = false; }
  isReceivingPaused(): boolean { return this.receivingPaused; }
  clearHistory(): void { this.history.splice(0, this.history.length); }
  historySnapshot(): readonly BroadcastEnvelope[] { return this.history.slice(); }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }

  async send(input: BroadcastInput, signal?: AbortSignal): Promise<SendBroadcastResult> {
    if (!this.enabled) return { accepted: false, reason: 'disabled' };
    let payload: BroadcastPayload;
    try {
      payload = buildBroadcastPayload(input, this.config);
      const context = await this.provider.getConnectionContext(signal);
      this.assertSendable(context);
      await this.provider.sendBroadcast(payload, signal);
      return { accepted: true, messageId: payload.messageId };
    } catch (error) {
      const failure = error instanceof BroadcastError ? error : new BroadcastError('send_failed', 'Broadcast send failed.', error);
      try { this.callbacks.onError?.(failure); } catch { /* Host diagnostics must not block DSH. */ }
      return { accepted: false, reason: failure.code };
    }
  }

  private assertSendable(context: BroadcastConnectionContext): void {
    if (!context || context.serverConnected !== true) throw new BroadcastError('server_disconnected', 'Launcher or Aries server is unavailable.');
    if (context.pairingComplete !== true || !context.groupId) throw new BroadcastError('not_paired', 'No completed current pairing is available.');
    if (context.status === 'revoked') throw new BroadcastError('revoked', 'Current pairing has been revoked.');
  }

  private async receive(raw: unknown): Promise<void> {
    if (!this.enabled || this.receivingPaused) return;
    try {
      const payload = safeRemotePayload(raw, this.config);
      const sourceDeviceId = typeof (raw as Record<string, unknown>)?.sourceDeviceId === 'string'
        ? String((raw as Record<string, unknown>).sourceDeviceId).slice(0, 200)
        : payload.sourceDeviceId ?? 'unknown';
      const fingerprint = messageFingerprint({ ...payload, sourceDeviceId });
      const now = Date.now();
      this.pruneSeen(now);
      if (this.seen.has(fingerprint) || (payload.messageId && this.seen.has(payload.messageId))) return;
      this.seen.set(fingerprint, now);
      if (payload.messageId) this.seen.set(payload.messageId, now);
      const envelope: BroadcastEnvelope = { ...payload, sourceDeviceId, receivedAt: new Date(now).toISOString() };
      this.history.push(envelope);
      while (this.history.length > this.config.maxHistoryEntries) this.history.shift();
      if (!this.muted) this.callbacks.onNotice?.(this.makeNotice(envelope));
    } catch (error) {
      const failure = error instanceof BroadcastError ? error : new BroadcastError('receive_failed', 'Broadcast receive failed.', error);
      try { this.callbacks.onError?.(failure); } catch { /* Host diagnostics must not block DSH. */ }
    }
  }

  private makeNotice(envelope: BroadcastEnvelope): BroadcastNotice {
    const body = envelope.text ?? envelope.url ?? '';
    const displayText = `${envelope.title}${body ? `\n${body}` : ''}`;
    return {
      envelope,
      displayText,
      muted: this.muted,
      open: async () => { throw new BroadcastError('user_action_required', 'Opening a broadcast requires an explicit host UI action.'); },
    };
  }

  private pruneSeen(now: number): void {
    for (const [key, timestamp] of this.seen) if (now - timestamp > this.config.dedupeWindowMs) this.seen.delete(key);
  }
}


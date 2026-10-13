import { BroadcastError, DEFAULT_BROADCAST_CONFIG } from './types.js';
             
                     
                             
                    
                 
                  
                   
                    
                  
                      
                    
import { buildBroadcastPayload, messageFingerprint, safeRemotePayload } from './security.js';
                                                             

export class BroadcastController {
                   config                         ;
                   provider                   ;
                   callbacks                    ;
                   history                      = [];
                   seen = new Map                ();
          unsubscribe                          ;
          enabled         ;
          receivingPaused = false;
          muted = false;

  constructor(provider                   , config                  = {}, callbacks                     = {}) {
    if (!provider || typeof provider.getConnectionContext !== 'function' || typeof provider.sendBroadcast !== 'function' || typeof provider.subscribeBroadcast !== 'function') {
      throw new BroadcastError('provider_invalid', 'A high-level broadcast Provider is required.');
    }
    this.provider = provider;
    this.config = { ...DEFAULT_BROADCAST_CONFIG, ...config };
    this.callbacks = callbacks;
    this.enabled = this.config.enabled;
    this.unsubscribe = provider.subscribeBroadcast((payload) => void this.receive(payload));
  }

  enable()       { this.enabled = true; }
  disable()       { this.enabled = false; }
  isEnabled()          { return this.enabled; }
  mute()       { this.muted = true; }
  resume()       { this.muted = false; }
  isMuted()          { return this.muted; }
  pauseReceiving()       { this.receivingPaused = true; }
  resumeReceiving()       { this.receivingPaused = false; }
  isReceivingPaused()          { return this.receivingPaused; }
  clearHistory()       { this.history.splice(0, this.history.length); }
  historySnapshot()                               { return this.history.slice(); }
  dispose()       { this.unsubscribe?.(); this.unsubscribe = undefined; }

  async send(input                , signal              )                               {
    if (!this.enabled) return { accepted: false, reason: 'disabled' };
    let payload                  ;
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

          assertSendable(context                            )       {
    if (!context || context.serverConnected !== true) throw new BroadcastError('server_disconnected', 'Launcher or Aries server is unavailable.');
    if (context.pairingComplete !== true || !context.groupId) throw new BroadcastError('not_paired', 'No completed current pairing is available.');
    if (context.status === 'revoked') throw new BroadcastError('revoked', 'Current pairing has been revoked.');
  }

          async receive(raw         )                {
    if (!this.enabled || this.receivingPaused) return;
    try {
      const payload = safeRemotePayload(raw, this.config);
      const sourceDeviceId = typeof (raw                           )?.sourceDeviceId === 'string'
        ? String((raw                           ).sourceDeviceId).slice(0, 200)
        : payload.sourceDeviceId ?? 'unknown';
      const fingerprint = messageFingerprint({ ...payload, sourceDeviceId });
      const now = Date.now();
      this.pruneSeen(now);
      if (this.seen.has(fingerprint) || (payload.messageId && this.seen.has(payload.messageId))) return;
      this.seen.set(fingerprint, now);
      if (payload.messageId) this.seen.set(payload.messageId, now);
      const envelope                    = { ...payload, sourceDeviceId, receivedAt: new Date(now).toISOString() };
      this.history.push(envelope);
      while (this.history.length > this.config.maxHistoryEntries) this.history.shift();
      if (!this.muted) this.callbacks.onNotice?.(this.makeNotice(envelope));
    } catch (error) {
      const failure = error instanceof BroadcastError ? error : new BroadcastError('receive_failed', 'Broadcast receive failed.', error);
      try { this.callbacks.onError?.(failure); } catch { /* Host diagnostics must not block DSH. */ }
    }
  }

          makeNotice(envelope                   )                  {
    const body = envelope.text ?? envelope.url ?? '';
    const displayText = `${envelope.title}${body ? `\n${body}` : ''}`;
    return {
      envelope,
      displayText,
      muted: this.muted,
      open: async () => { throw new BroadcastError('user_action_required', 'Opening a broadcast requires an explicit host UI action.'); },
    };
  }

          pruneSeen(now        )       {
    for (const [key, timestamp] of this.seen) if (now - timestamp > this.config.dedupeWindowMs) this.seen.delete(key);
  }
}


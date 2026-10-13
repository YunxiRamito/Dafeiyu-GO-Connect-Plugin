import test from 'node:test';
import assert from 'node:assert/strict';
import { BroadcastController, BroadcastError, buildBroadcastPayload, sanitizeUrl, safeRemotePayload } from '../../src/broadcast/index.ts';

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof BroadcastError && error.code === code);
}

class FakeProvider {
  context = { serverConnected: true, pairingComplete: true, groupId: 'group-current', remotePresence: 'unknown' };
  sent = [];
  listeners = new Set();
  failSend = false;
  async getConnectionContext() { return this.context; }
  async sendBroadcast(payload) {
    if (this.failSend) throw new Error('offline');
    this.sent.push(payload);
  }
  subscribeBroadcast(handler) { this.listeners.add(handler); return () => this.listeners.delete(handler); }
  async emit(payload) { await Promise.all([...this.listeners].map((listener) => listener(payload))); }
}

test('configuration defaults and HTTPS/local DSH policy', () => {
  assert.equal(sanitizeUrl('https://example.test/path?a=1#fragment'), 'https://example.test/path?a=1');
  expectCode(() => sanitizeUrl('http://example.test/path'), 'insecure_url');
  expectCode(() => sanitizeUrl('http://localhost:8787/?token=secret'), 'insecure_url');
  assert.equal(sanitizeUrl('http://localhost:8787/?token=secret&x=1', { allowLocalDsh: true, maxUrlLength: 2048 }), 'http://localhost:8787/?x=1');
  assert.equal(sanitizeUrl('https://example.test/?token=secret&api_key=x&keep=1'), 'https://example.test/?keep=1');
});

test('URL credentials and sensitive values are rejected or removed', () => {
  expectCode(() => sanitizeUrl('https://user:pass@example.test/'), 'sensitive_url');
  expectCode(() => sanitizeUrl('https://example.test/?next=https%3A%2F%2Fexample.test%2F%3Ftoken%3Dx'), 'sensitive_url');
  expectCode(() => safeRemotePayload({ schemaVersion: 1, kind: 'link', title: 'x', url: 'https://example.test/', sentAt: new Date().toISOString(), cookie: 'a=b' }), 'unsafe_payload');
  expectCode(() => safeRemotePayload({ schemaVersion: 1, kind: 'link', title: 'x', url: 'https://example.test/', sentAt: new Date().toISOString(), headers: { Authorization: 'Bearer x' } }), 'unsafe_payload');
});

test('input requires title plus URL or explicit selected text', () => {
  expectCode(() => buildBroadcastPayload({ url: 'https://example.test/' }), 'invalid_input');
  expectCode(() => buildBroadcastPayload({ title: 'x', selectedText: 'chosen' }), 'missing_content');
  const link = buildBroadcastPayload({ title: 'Docs', url: 'https://example.test/docs' });
  assert.equal(link.kind, 'link');
  const selection = buildBroadcastPayload({ selectedText: 'chosen text', selectionConfirmed: true });
  assert.equal(selection.kind, 'selection');
  assert.equal(selection.text, 'chosen text');
});

test('title, URL and selected text limits are enforced', () => {
  expectCode(() => buildBroadcastPayload({ title: 'x'.repeat(201), url: 'https://example.test/' }), 'length_limit');
  expectCode(() => buildBroadcastPayload({ title: 'x', url: 'https://example.test/', selectedText: 'x'.repeat(4001), selectionConfirmed: true }), 'length_limit');
  expectCode(() => buildBroadcastPayload({ title: 'x', url: `https://example.test/${'x'.repeat(2050)}` }), 'length_limit');
});

test('send uses only the high-level provider and failure does not reject the main flow', async () => {
  const provider = new FakeProvider();
  const errors = [];
  const controller = new BroadcastController(provider, { enabled: true }, { onError: (error) => errors.push(error) });
  const sent = await controller.send({ title: 'Docs', url: 'https://example.test/docs?token=secret' });
  assert.equal(sent.accepted, true);
  assert.equal(provider.sent[0].url, 'https://example.test/docs');
  provider.failSend = true;
  const failed = await controller.send({ title: 'Docs', url: 'https://example.test/docs' });
  assert.equal(failed.accepted, false);
  assert.equal(failed.reason, 'send_failed');
  assert.equal(errors.length, 1);
  controller.disable();
  assert.deepEqual(await controller.send({ title: 'Docs', url: 'https://example.test/docs' }), { accepted: false, reason: 'disabled' });
  controller.dispose();
});

test('not paired or disconnected state is reported without calling send', async () => {
  const provider = new FakeProvider();
  provider.context = { serverConnected: false, pairingComplete: true, groupId: 'group-current' };
  const controller = new BroadcastController(provider, { enabled: true });
  const result = await controller.send({ title: 'Docs', url: 'https://example.test/docs' });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'server_disconnected');
  assert.equal(provider.sent.length, 0);
  provider.context = { serverConnected: true, pairingComplete: false, groupId: '' };
  assert.equal((await controller.send({ title: 'Docs', url: 'https://example.test/docs' })).reason, 'not_paired');
  controller.dispose();
});

test('receive defaults to notification only, records source/time, deduplicates, and keeps remote content plain', async () => {
  const provider = new FakeProvider();
  const notices = [];
  const controller = new BroadcastController(provider, { enabled: true }, { onNotice: (notice) => notices.push(notice) });
  const payload = { schemaVersion: 1, messageId: 'message-1', kind: 'selection', title: 'Remote', text: '<script>globalThis.pwned=1</script>', sourceDeviceId: 'device-remote', sentAt: '2026-10-11T00:00:00Z' };
  await provider.emit(payload);
  await provider.emit(payload);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].envelope.sourceDeviceId, 'device-remote');
  assert.match(notices[0].envelope.receivedAt, /^20/);
  assert.match(notices[0].displayText, /<script>/);
  await assert.rejects(() => notices[0].open(), (error) => error.code === 'user_action_required');
  assert.equal(controller.historySnapshot().length, 1);
  controller.dispose();
});

test('mute, pause, resume and clear history are independent controls', async () => {
  const provider = new FakeProvider();
  const notices = [];
  const controller = new BroadcastController(provider, { enabled: true }, { onNotice: (notice) => notices.push(notice) });
  controller.mute();
  await provider.emit({ schemaVersion: 1, messageId: 'm1', kind: 'link', title: 'One', url: 'https://example.test/1', sentAt: new Date().toISOString(), sourceDeviceId: 'd' });
  assert.equal(notices.length, 0);
  assert.equal(controller.historySnapshot().length, 1);
  controller.pauseReceiving();
  await provider.emit({ schemaVersion: 1, messageId: 'm2', kind: 'link', title: 'Two', url: 'https://example.test/2', sentAt: new Date().toISOString(), sourceDeviceId: 'd' });
  assert.equal(notices.length, 0);
  controller.resumeReceiving();
  controller.resume();
  await provider.emit({ schemaVersion: 1, messageId: 'm3', kind: 'link', title: 'Three', url: 'https://example.test/3', sentAt: new Date().toISOString(), sourceDeviceId: 'd' });
  assert.equal(notices[0].muted, false);
  controller.clearHistory();
  assert.equal(controller.historySnapshot().length, 0);
  controller.dispose();
});

test('invalid remote HTML/script command fields are rejected as data', async () => {
  expectCode(() => safeRemotePayload({ schemaVersion: 1, kind: 'selection', title: 'x', text: '<img src=x onerror=alert(1)>', command: 'open-browser', sentAt: new Date().toISOString() }), 'unsafe_payload');
  expectCode(() => safeRemotePayload({ schemaVersion: 1, kind: 'selection', title: 'x', text: 'hello', browserCommand: 'open', sentAt: new Date().toISOString() }), 'unsafe_payload');
});



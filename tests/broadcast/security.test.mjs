import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafePayload, safeRemotePayload } from '../../src/broadcast/index.ts';

test('payload security rejects sensitive keys at every nesting level', () => {
  for (const key of ['cookie', 'Authorization', 'apiKey', 'token', 'session', 'privateKey', 'contentKey']) {
    assert.throws(() => assertSafePayload({ nested: { [key]: 'secret' } }));
  }
});

test('remote content is bounded and remains ordinary strings', () => {
  const value = safeRemotePayload({ schemaVersion: 1, kind: 'selection', messageId: 'safe', title: 'title', text: 'plain <b>text</b>', sentAt: '2026-10-11T00:00:00Z' });
  assert.equal(typeof value.text, 'string');
  assert.equal(value.text, 'plain <b>text</b>');
});

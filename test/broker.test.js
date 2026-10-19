import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Broker, durableIds } from '../src/broker.js';
import { Dialogs } from '../src/dialogs.js';
import { Observer } from '../src/cdp.js';

export class FakeCdp extends EventEmitter {
  alive = true;
  calls = [];
  async send(method, params, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === 'Target.setAutoAttach' && !sessionId) {
      this.emit('event', { method: 'Target.attachedToTarget', params: {
        sessionId: 'page-session', targetInfo: { targetId: 'page-target', type: 'page' }, waitingForDebugger: true,
      } });
    }
    return {};
  }
  close() { if (this.alive) { this.alive = false; this.emit('disconnect'); } }
}

test('launch waits for subscriptions, is idempotent across callers, and never reconnects implicitly', async () => {
  let launches = 0;
  let opens = 0;
  let sequence = 0;
  const identifiers = { status: 'ready', pid: 123, hwnd: null, windows_session_id: 3 };
  const chrome = {
    async ensure() { launches++; return { endpoint: 'private', identifiers }; },
    async identity() { return {}; }, identifiers() { return identifiers; },
    async close() { return { status: 'closed' }; },
  };
  const sockets = [];
  const dialogs = new Dialogs(() => ++sequence);
  const broker = new Broker(chrome, dialogs, async () => { opens++; const cdp = new FakeCdp(); sockets.push(cdp); return cdp; });
  assert.deepEqual(await broker.call('get_dialog_status'), { status: 'not_connected' });
  assert.equal(opens, 0);
  assert.deepEqual(await Promise.all([broker.call('launch_chrome'), broker.call('launch_chrome')]), [identifiers, identifiers]);
  assert.equal(launches, 1);
  assert.equal(opens, 1);
  assert.ok(sockets[0].calls.some(call => call.method === 'Page.enable'));
  const pageEnable = sockets[0].calls.findIndex(c => c.method === 'Page.enable');
  const resume = sockets[0].calls.findIndex(c => c.method === 'Runtime.runIfWaitingForDebugger');
  assert.ok(resume > pageEnable);
  const { capture_id } = await broker.call('start_dialog_capture');
  sockets[0].emit('event', { method: 'Page.javascriptDialogOpening', sessionId: 'page-session', params: { type: 'confirm', url: 'https://example.com', message: 'First' } });
  const oldId = (await broker.call('get_captured_dialog', { capture_id })).dialog_id;
  sockets[0].close();
  assert.deepEqual(await broker.call('get_dialog_status'), { status: 'not_connected' });
  assert.deepEqual(await broker.call('respond_to_dialog', { dialog_id: oldId, action: 'accept' }), { status: 'not_connected' });
  assert.equal(opens, 1);
  assert.deepEqual(await broker.call('launch_chrome'), identifiers);
  assert.equal(opens, 2);
  assert.deepEqual(await broker.call('get_dialog_status'), { status: 'no_dialog' });
  assert.deepEqual(await broker.call('get_captured_dialog', { capture_id }), { status: 'invalid_capture' });
  assert.deepEqual(await broker.call('respond_to_dialog', { dialog_id: oldId, action: 'accept' }), { status: 'stale_dialog' });
  assert.deepEqual(await broker.call('close_chrome'), { status: 'closed' });
  assert.equal(sockets[1].alive, false);
});

test('launch fails closed for absent, wrong or unobservable Chrome', async () => {
  for (const failure of ['identity', 'connection', 'subscription']) {
    const chrome = { async ensure() { if (failure === 'identity') throw new Error('wrong Chrome'); return { endpoint: 'private' }; } };
    const dialogs = new Dialogs(() => 1);
    const broker = new Broker(chrome, dialogs, async () => {
      if (failure === 'connection') throw new Error('connection failed');
      const cdp = new FakeCdp();
      cdp.send = async () => { throw new Error('subscription failed'); };
      return cdp;
    });
    assert.deepEqual(await broker.call('launch_chrome'), { status: 'launch_failed' });
    assert.deepEqual(dialogs.status(), { status: 'not_connected' });
  }
});

test('events from an old observer cannot modify records on a new connection', async () => {
  const dialogs = new Dialogs(() => 1);
  const first = new FakeCdp();
  const old = new Observer(first, dialogs);
  await old.ready();
  old.close();
  const current = new Observer(new FakeCdp(), dialogs);
  await current.ready();
  first.emit('event', { method: 'Page.javascriptDialogOpening', sessionId: 'page-session', params: { type: 'confirm', url: 'https://old.example', message: 'Old' } });
  first.emit('event', { method: 'Target.detachedFromTarget', params: { sessionId: 'page-session' } });
  assert.deepEqual(dialogs.status(), { status: 'no_dialog' });
  assert.equal(dialogs.sessions.size, 1);
});

test('dialog IDs survive broker restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dialog-id-test-'));
  try {
    const first = durableIds(directory);
    assert.equal(first(), 1);
    assert.equal(first(), 2);
    assert.equal(durableIds(directory)(), 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('idempotent launch cannot report ready if observation is lost during identity lookup', async () => {
  const cdp = new FakeCdp();
  let sequence = 0;
  const dialogs = new Dialogs(() => ++sequence);
  const chrome = {
    async ensure() { return { endpoint: 'private', identifiers: { status: 'ready' } }; },
    async identity() { cdp.close(); return {}; },
    identifiers() { return { status: 'ready' }; },
  };
  const broker = new Broker(chrome, dialogs, async () => cdp);
  assert.equal((await broker.call('launch_chrome')).status, 'ready');
  assert.deepEqual(await broker.call('launch_chrome'), { status: 'launch_failed' });
  assert.deepEqual(dialogs.status(), { status: 'not_connected' });
});

test('the old lookup is unavailable and a failed capture cannot authorise its replacement', async () => {
  let sequence = 0;
  const cdp = new FakeCdp();
  const dialogs = new Dialogs(() => ++sequence);
  const chrome = { async ensure() { return { endpoint: 'private', identifiers: { status: 'ready' } }; } };
  const broker = new Broker(chrome, dialogs, async () => cdp);
  await broker.call('launch_chrome');
  const { capture_id } = await broker.call('start_dialog_capture');
  const opening = { method: 'Page.javascriptDialogOpening', sessionId: 'page-session', params: { type: 'confirm', url: 'https://example.com', message: 'Identical' } };
  cdp.emit('event', opening);
  cdp.emit('event', { method: 'Page.javascriptDialogClosed', sessionId: 'page-session' });
  cdp.emit('event', opening);
  assert.deepEqual(await broker.call('get_captured_dialog', { capture_id }), { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 2 });
  assert.deepEqual(await broker.call('get_pending_dialog'), { status: 'invalid_request' });
  assert.deepEqual(await broker.call('respond_to_dialog', { dialog_id: 2, action: 'dismiss' }), { status: 'dialog_not_captured' });
  assert.equal(cdp.calls.filter(call => call.method === 'Page.handleJavaScriptDialog').length, 0);
  assert.deepEqual(await broker.call('get_dialog_status'), { status: 'dialog_pending', pending_count: 1 });
});

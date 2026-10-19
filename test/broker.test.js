import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserSession as Broker, Broker as SessionManager, durableIds } from '../src/broker.js';
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

test('a graceful shutdown inspection error uses the verified close fallback', async () => {
  let closes = 0;
  const dialogs = new Dialogs(() => 1);
  const chrome = {
    async ensure() { return { endpoint: 'private', identifiers: { status: 'ready' } }; },
    async waitForExit() { throw new Error('Inspection unavailable'); },
    async close() {
      closes++;
      assert.deepEqual(dialogs.status(), { status: 'not_connected' });
      return { status: 'closed' };
    },
  };
  const broker = new Broker(chrome, dialogs, async () => new FakeCdp());
  await broker.call('launch_chrome');
  assert.deepEqual(await broker.call('close_chrome'), { status: 'closed' });
  assert.equal(closes, 1);
});

test('graceful close succeeds if Chrome exits before the verified fallback', async () => {
  const chrome = {
    async ensure() { return { endpoint: 'private', identifiers: { status: 'ready' } }; },
    async waitForExit() { return false; },
    async close() { return { status: 'not_running' }; },
  };
  const broker = new Broker(chrome, new Dialogs(() => 1), async () => new FakeCdp());
  await broker.call('launch_chrome');
  assert.deepEqual(await broker.call('close_chrome'), { status: 'closed' });
});

async function managedSessions(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dialog-sessions-test-'));
  const browsers = new Map();
  const connections = [];
  const options = {
    chrome(profileDirectory) {
      if (!browsers.has(profileDirectory)) {
        const identifiers = { status: 'ready', pid: browsers.size + 100, hwnd: null, windows_session_id: 1 };
        browsers.set(profileDirectory, {
          running: false, launches: 0, closeFails: false,
          async ensure({ launchIfMissing }) {
            if (!this.running) {
              if (!launchIfMissing) throw new Error('No replacement allowed');
              this.running = true; this.launches++;
            }
            return { endpoint: profileDirectory, identifiers };
          },
          async identity() { return this.running ? {} : null; },
          identifiers() { return identifiers; },
          async close() {
            if (this.closeFails) throw new Error('Close failed');
            const status = this.running ? 'closed' : 'not_running';
            this.running = false;
            return { status };
          },
        });
      }
      return browsers.get(profileDirectory);
    },
    async open(endpoint) { const cdp = new FakeCdp(); cdp.endpoint = endpoint; connections.push(cdp); return cdp; },
  };
  const manager = new SessionManager(directory, options);
  t.after(async () => { connections.forEach(cdp => cdp.close()); await rm(directory, { recursive: true, force: true }); });
  const call = (token, method, args = {}) => manager.call(method, { browser_token: token, ...args });
  const opening = token => manager.sessions.get(token).observer.cdp.emit('event', {
    method: 'Page.javascriptDialogOpening', sessionId: 'page-session',
    params: { type: 'confirm', url: 'https://example.com', message: 'Same message' },
  });
  return { manager, call, opening, directory, options, browsers, connections };
}

test('tokenless launches create distinct browsers; only an explicit token reuses one', async t => {
  const { manager, call, browsers } = await managedSessions(t);
  const [a, b] = await Promise.all([manager.call('launch_chrome'), manager.call('launch_chrome')]);
  assert.equal(a.status, 'ready'); assert.equal(b.status, 'ready');
  assert.match(a.browser_token, /^[a-f0-9]{64}$/);
  assert.notEqual(a.browser_token, b.browser_token);
  assert.notEqual(a.pid, b.pid);
  assert.equal(browsers.size, 2);
  assert.deepEqual(await call(a.browser_token, 'launch_chrome'), a);
  assert.equal(browsers.size, 2);
  assert.deepEqual([...browsers.values()].map(browser => browser.launches), [1, 1]);
});

test('sessions isolate event counts, capture tokens, dialog IDs and close operations', async t => {
  const { manager, call, opening } = await managedSessions(t);
  const a = (await manager.call('launch_chrome')).browser_token;
  const b = (await manager.call('launch_chrome')).browser_token;
  const ca = (await call(a, 'start_dialog_capture')).capture_id;
  const cb = (await call(b, 'start_dialog_capture')).capture_id;
  opening(a); opening(b); opening(b);
  assert.deepEqual(await call(b, 'get_captured_dialog', { capture_id: ca }), { status: 'invalid_capture' });
  const captured = await call(a, 'get_captured_dialog', { capture_id: ca });
  assert.equal(captured.status, 'captured');
  assert.deepEqual(await call(b, 'get_captured_dialog', { capture_id: cb }), { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 2 });
  assert.deepEqual(await call(b, 'respond_to_dialog', { dialog_id: captured.dialog_id, action: 'accept' }), { status: 'stale_dialog' });
  const otherId = [...manager.sessions.get(b).dialogs.pending.values()][0].dialog_id;
  assert.deepEqual(await call(a, 'respond_to_dialog', { dialog_id: otherId, action: 'accept' }), { status: 'stale_dialog' });
  assert.equal((await call(a, 'respond_to_dialog', { dialog_id: captured.dialog_id, action: 'dismiss' })).status, 'responded');
  const otherSocket = manager.sessions.get(b).observer.cdp;
  assert.equal(otherSocket.calls.filter(call => call.method === 'Page.handleJavaScriptDialog').length, 0);
  assert.deepEqual(await call(a, 'close_chrome'), { status: 'closed' });
  assert.equal(otherSocket.alive, true);
  assert.deepEqual(await call(b, 'get_dialog_status'), { status: 'dialog_pending', pending_count: 1 });
});

test('unknown, missing and malformed tokens never create or select a session', async t => {
  const { manager, directory, browsers } = await managedSessions(t);
  for (const token of [undefined, null, '', '../escape', 'A'.repeat(64), 'a'.repeat(64)]) {
    for (const method of ['get_dialog_status', 'start_dialog_capture', 'get_captured_dialog', 'respond_to_dialog', 'close_chrome']) {
      assert.deepEqual(await manager.call(method, { browser_token: token }), { status: 'invalid_browser_token' });
    }
    if (token !== undefined) assert.deepEqual(await manager.call('launch_chrome', { browser_token: token }), { status: 'invalid_browser_token' });
  }
  assert.equal(browsers.size, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('restart retains browser capabilities but requires explicit reconnection and invalidates captures', async t => {
  const { manager, call, opening, directory, options, connections, browsers } = await managedSessions(t);
  const launched = await manager.call('launch_chrome');
  const token = launched.browser_token;
  const { capture_id } = await call(token, 'start_dialog_capture');
  opening(token);
  const captured = await call(token, 'get_captured_dialog', { capture_id });
  connections.forEach(cdp => cdp.close());
  const restored = new SessionManager(directory, options);
  const invoke = (method, args = {}) => restored.call(method, { browser_token: token, ...args });
  assert.deepEqual(await invoke('get_dialog_status'), { status: 'not_connected' });
  assert.equal(connections.length, 1);
  assert.deepEqual(await invoke('launch_chrome'), launched);
  assert.equal(connections.length, 2);
  assert.deepEqual(await invoke('get_captured_dialog', { capture_id }), { status: 'invalid_capture' });
  assert.deepEqual(await invoke('respond_to_dialog', { dialog_id: captured.dialog_id, action: 'accept' }), { status: 'stale_dialog' });
  assert.equal([...browsers.values()][0].launches, 1);
  // An externally closed process must never be replaced behind the same token.
  [...browsers.values()][0].running = false;
  connections[1].close();
  assert.equal((await invoke('launch_chrome')).status, 'launch_failed');
  assert.equal([...browsers.values()][0].launches, 1);
});

test('close revokes tokens durably; failed close preserves a token for explicit retry', async t => {
  const { manager, call, directory, options, browsers } = await managedSessions(t);
  const token = (await manager.call('launch_chrome')).browser_token;
  const browser = [...browsers.values()][0];
  browser.closeFails = true;
  assert.deepEqual(await call(token, 'close_chrome'), { status: 'close_failed' });
  assert.deepEqual(await call(token, 'get_dialog_status'), { status: 'not_connected' });
  browser.closeFails = false;
  assert.deepEqual(await call(token, 'close_chrome'), { status: 'closed' });
  assert.deepEqual(await call(token, 'launch_chrome'), { status: 'invalid_browser_token' });
  const restored = new SessionManager(directory, options);
  assert.deepEqual(await restored.call('launch_chrome', { browser_token: token }), { status: 'invalid_browser_token' });
  assert.equal(browser.launches, 1);
});

test('a failed initial observation still returns a session token for cleanup', async t => {
  const { manager, call, browsers } = await managedSessions(t);
  manager.open = async () => { throw new Error('Cannot observe'); };
  const failed = await manager.call('launch_chrome');
  assert.equal(failed.status, 'launch_failed');
  assert.match(failed.browser_token, /^[a-f0-9]{64}$/);
  assert.equal([...browsers.values()][0].running, true);
  assert.deepEqual(await call(failed.browser_token, 'close_chrome'), { status: 'closed' });
  assert.equal([...browsers.values()][0].running, false);
});

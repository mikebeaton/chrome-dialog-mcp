// Opt in: launches disposable Chrome. CDP navigation and responses below are test drivers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeRoot = process.env.CHROME_DIALOG_PACKAGE_ROOT
  ? pathToFileURL(path.resolve(process.env.CHROME_DIALOG_PACKAGE_ROOT) + path.sep) : new URL('../', import.meta.url);
const { startBroker } = await import(new URL('src/broker.js', runtimeRoot));
const { Cdp } = await import(new URL('src/cdp.js', runtimeRoot));
const { configuration } = await import(new URL('src/ipc.js', runtimeRoot));

async function connectAdapter(stateDir) {
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('src/adapter.js', runtimeRoot))],
    env: { ...process.env, CHROME_DIALOG_STATE_DIR: stateDir }, stderr: 'pipe',
  }));
  return client;
}

async function until(fn, predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (predicate(result)) return result;
    await delay(50);
  }
  throw new Error(message);
}

test('installed Chrome: isolated browser sessions, exact counts, two adapters, prompts, replacement and connection loss', {
  skip: process.env.CHROME_DIALOG_INTEGRATION !== '1' || process.platform !== 'win32', timeout: 180000,
}, async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dialog-capture-integration-'));
  const config = configuration({ CHROME_DIALOG_STATE_DIR: stateDir });
  let brokerResponses = 0;
  const { broker, server } = await startBroker(config, { open: async endpoint => {
    const cdp = await Cdp.open(endpoint);
    const send = cdp.send.bind(cdp);
    cdp.send = (...args) => {
      if (args[0] === 'Page.handleJavaScriptDialog') brokerResponses++;
      return send(...args);
    };
    return cdp;
  } });
  const clients = [];
  let driver;
  let otherDriver;
  let browserToken;
  const ownedTokens = new Set();
  const web = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Dialog capture integration</title><p>Disposable capture test.</p>');
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    let cleanupFailed = false;
    // Failed launches can still leave a process, even if the test never received its token.
    for (const browser_token of new Set([...ownedTokens, ...broker.sessions.keys()])) {
      const result = await broker.call('close_chrome', { browser_token });
      if (!['closed', 'not_running', 'invalid_browser_token'].includes(result.status)) {
        cleanupFailed = true;
        t.diagnostic(`Disposable browser cleanup returned ${result.status}`);
      }
    }
    driver?.close();
    otherDriver?.close();
    await Promise.all(clients.map(client => client.close()));
    web.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => web.close(resolve))]);
    if (cleanupFailed) t.diagnostic(`Retained temporary state for explicit cleanup: ${stateDir}`);
    else await rm(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });
  const a = await connectAdapter(stateDir); clients.push(a);
  const b = await connectAdapter(stateDir); clients.push(b);
  const tool = async (client, name, args = {}) => (await client.callTool({ name, arguments: {
    ...(browserToken ? { browser_token: browserToken } : {}), ...args,
  } })).structuredContent;
  const status = () => tool(a, 'get_dialog_status');
  const arm = async () => {
    const result = await tool(a, 'start_dialog_capture');
    assert.equal(result.status, 'capturing');
    return result.capture_id;
  };
  const read = capture_id => tool(b, 'get_captured_dialog', { capture_id });
  const noDialog = () => until(status, result => result.status === 'no_dialog', 'dialog did not close');
  const launched = await tool(a, 'launch_chrome');
  browserToken = launched.browser_token;
  if (browserToken) ownedTokens.add(browserToken);
  assert.equal(launched.status, 'ready');
  assert.deepEqual(Object.keys(launched).sort(), ['browser_token', 'hwnd', 'pid', 'status', 'windows_session_id']);
  assert.equal((await tool(b, 'launch_chrome')).pid, launched.pid);
  const session = broker.sessions.get(browserToken);
  const { endpoint } = await session.chrome.ensure({ launchIfMissing: false });
  driver = await Cdp.open(endpoint);
  const send = driver.send.bind(driver);
  driver.send = async (...args) => {
    try { return await send(...args); }
    catch (cause) { throw new Error(`Test driver command failed: ${args[0]}`, { cause }); }
  };
  const { targetInfos } = await driver.send('Target.getTargets');
  const target = targetInfos.find(info => info.type === 'page');
  assert.ok(target);
  const { sessionId } = await driver.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await driver.send('Page.enable', {}, sessionId);
  if (process.env.CHROME_DIALOG_START_URL === undefined) {
    const startupUrl = new URL('assets/start.html', runtimeRoot).href;
    await until(() => driver.send('Runtime.evaluate', {
      expression: '({url: location.href, text: document.body?.innerText})', returnByValue: true,
    }, sessionId), r => r.result?.value?.url === startupUrl &&
      r.result.value.text?.includes('choose any valid website yourself and manually type its address'),
    'bundled file startup instructions did not load');
  }
  const url = `http://127.0.0.1:${web.address().port}/settings`;
  await driver.send('Page.navigate', { url }, sessionId);
  await until(() => driver.send('Runtime.evaluate', { expression: 'location.href' }, sessionId), r => r.result?.value === url, 'fixture did not load');
  const trigger = async () => {
    await driver.send('Runtime.evaluate', { expression: 'setTimeout(() => window.testResult = confirm("Same harmless test message"), 0)' }, sessionId);
    await until(status, result => result.status === 'dialog_pending', 'opening event not observed');
  };
  const manualDismiss = async () => {
    await driver.send('Page.handleJavaScriptDialog', { accept: false }, sessionId);
    await noDialog();
  };

  const empty = await arm();
  const emptyResult = await a.callTool({ name: 'get_captured_dialog', arguments: { browser_token: browserToken, capture_id: empty } });
  assert.equal(emptyResult.isError, true);
  assert.deepEqual(emptyResult.structuredContent, { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 0 });
  assert.deepEqual(await read(empty), { status: 'invalid_capture' });

  let priorId;
  for (const action of ['accept', 'dismiss']) {
    const token = await arm();
    await trigger();
    assert.deepEqual(await tool(b, 'start_dialog_capture'), { status: 'dialog_already_pending' });
    const captured = await read(token);
    assert.equal(captured.status, 'captured');
    assert.equal(captured.url, url);
    assert.equal(captured.type, 'confirm');
    assert.equal('frame_id' in captured, false);
    assert.equal((await tool(b, 'respond_to_dialog', { dialog_id: captured.dialog_id, action })).status, 'responded');
    assert.equal((await driver.send('Runtime.evaluate', { expression: 'window.testResult' }, sessionId)).result.value, action === 'accept');
    assert.equal((await tool(a, 'respond_to_dialog', { dialog_id: captured.dialog_id, action })).status, 'stale_dialog');
    await noDialog();
    priorId = captured.dialog_id;
  }
  assert.equal(brokerResponses, 2);

  // Simulate the human intervention: accept/dismiss one, then launch an identical replacement.
  const replaced = await arm();
  await trigger();
  await manualDismiss();
  await trigger();
  const countResult = await a.callTool({ name: 'get_captured_dialog', arguments: { browser_token: browserToken, capture_id: replaced } });
  assert.equal(countResult.isError, true);
  assert.deepEqual(countResult.structuredContent, { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 2 });
  assert.equal('dialog_id' in countResult.structuredContent, false);
  const replacementId = [...session.dialogs.pending.values()][0].dialog_id;
  assert.deepEqual(await tool(b, 'respond_to_dialog', { dialog_id: replacementId, action: 'accept' }), { status: 'dialog_not_captured' });
  assert.equal(brokerResponses, 2);
  await manualDismiss();

  const closed = await arm();
  await trigger();
  await manualDismiss();
  assert.deepEqual(await read(closed), { status: 'dialog_not_pending' });

  // Replacing AFTER successful inspection must still invalidate that response ID.
  const inspected = await arm();
  await trigger();
  const captured = await read(inspected);
  await manualDismiss();
  await trigger();
  assert.deepEqual(await tool(b, 'respond_to_dialog', { dialog_id: captured.dialog_id, action: 'accept' }), { status: 'stale_dialog' });
  assert.equal(brokerResponses, 2);
  await manualDismiss();

  // Text goes through both stdio and broker validation, then Chrome returns the exact value.
  for (const text of ['Renamed target', '', 'Renamed — 日本語', null]) {
    const token = await arm();
    await driver.send('Runtime.evaluate', { expression: 'setTimeout(() => window.testResult = prompt("Rename target", "Original target"), 0)' }, sessionId);
    await until(status, result => result.status === 'dialog_pending', 'prompt opening event not observed');
    const prompt = await read(token);
    assert.equal(prompt.status, 'captured');
    assert.equal(prompt.type, 'prompt');
    assert.equal(prompt.url, url);
    assert.equal(prompt.default_prompt, 'Original target');
    assert.deepEqual(await tool(b, 'respond_to_dialog', { dialog_id: prompt.dialog_id, action: 'accept' }), { status: 'invalid_request' });
    const params = { dialog_id: prompt.dialog_id, action: text === null ? 'dismiss' : 'accept',
      ...(text === null ? {} : { prompt_text: text }) };
    assert.equal((await tool(b, 'respond_to_dialog', params)).status, 'responded');
    assert.equal((await driver.send('Runtime.evaluate', { expression: 'window.testResult' }, sessionId)).result.value, text);
    await noDialog();
  }

  // A second adapter's tokenless launch gets its own process/profile and event counts.
  const other = (await b.callTool({ name: 'launch_chrome', arguments: {} })).structuredContent;
  if (other.browser_token) ownedTokens.add(other.browser_token);
  assert.equal(other.status, 'ready');
  assert.notEqual(other.browser_token, browserToken);
  assert.notEqual(other.pid, launched.pid);
  const otherSession = broker.sessions.get(other.browser_token);
  assert.notEqual(otherSession.chrome.profile, session.chrome.profile);
  const otherEndpoint = (await otherSession.chrome.ensure({ launchIfMissing: false })).endpoint;
  otherDriver = await Cdp.open(otherEndpoint);
  const otherTarget = (await otherDriver.send('Target.getTargets')).targetInfos.find(info => info.type === 'page');
  const otherPage = (await otherDriver.send('Target.attachToTarget', { targetId: otherTarget.targetId, flatten: true })).sessionId;
  await otherDriver.send('Page.enable', {}, otherPage);
  await otherDriver.send('Page.navigate', { url }, otherPage);
  await until(() => otherDriver.send('Runtime.evaluate', { expression: 'location.href' }, otherPage), r => r.result?.value === url, 'second fixture did not load');
  const otherTool = (name, args = {}) => tool(b, name, { ...args, browser_token: other.browser_token });
  const otherStatus = () => otherTool('get_dialog_status');
  const firstCapture = await arm();
  const secondCapture = (await otherTool('start_dialog_capture')).capture_id;
  await trigger();
  assert.deepEqual(await otherStatus(), { status: 'no_dialog' });
  for (let i = 0; i < 2; i++) {
    await otherDriver.send('Runtime.evaluate', { expression: 'setTimeout(() => confirm("Other session"), 0)' }, otherPage);
    await until(otherStatus, r => r.status === 'dialog_pending', 'other session dialog not observed');
    if (i === 0) {
      await otherDriver.send('Page.handleJavaScriptDialog', { accept: false }, otherPage);
      await until(otherStatus, r => r.status === 'no_dialog', 'other session dialog did not close');
    }
  }
  assert.deepEqual(await otherTool('get_captured_dialog', { capture_id: firstCapture }), { status: 'invalid_capture' });
  const firstDialog = await read(firstCapture);
  assert.equal(firstDialog.status, 'captured');
  assert.deepEqual(await otherTool('get_captured_dialog', { capture_id: secondCapture }), { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 2 });
  assert.deepEqual(await otherTool('respond_to_dialog', { dialog_id: firstDialog.dialog_id, action: 'accept' }), { status: 'stale_dialog' });
  assert.equal((await tool(a, 'respond_to_dialog', { dialog_id: firstDialog.dialog_id, action: 'dismiss' })).status, 'responded');
  await noDialog();
  assert.deepEqual(await otherStatus(), { status: 'dialog_pending', pending_count: 1 });
  await otherDriver.send('Page.handleJavaScriptDialog', { accept: false }, otherPage);
  await until(otherStatus, r => r.status === 'no_dialog', 'other session cleanup failed');

  const interrupted = await arm();
  await trigger();
  session.observer.close();
  assert.deepEqual(await read(interrupted), { status: 'not_connected' });
  assert.deepEqual(await tool(b, 'respond_to_dialog', { dialog_id: priorId, action: 'accept' }), { status: 'not_connected' });
  // Driver-only cleanup: the broker must not reconstruct this dialog after connection loss.
  let interruptedDialogClosed = false;
  const closedEvent = event => {
    if (event.method === 'Page.javascriptDialogClosed' && event.sessionId === sessionId) interruptedDialogClosed = true;
  };
  driver.on('event', closedEvent);
  try {
    await driver.send('Page.handleJavaScriptDialog', { accept: false }, sessionId);
    await until(async () => interruptedDialogClosed, Boolean, 'interrupted dialog close event not received');
  } finally { driver.off('event', closedEvent); }
  const reconnected = await tool(a, 'launch_chrome');
  assert.equal(reconnected.status, 'ready', `Explicit reconnection returned ${reconnected.status}`);
  assert.equal(reconnected.pid, launched.pid);
  assert.deepEqual(await read(interrupted), { status: 'invalid_capture' });
  assert.deepEqual(await status(), { status: 'no_dialog' });
  assert.deepEqual(await otherStatus(), { status: 'no_dialog' });
  await a.close(); clients.splice(clients.indexOf(a), 1);
  assert.deepEqual(await tool(b, 'get_dialog_status'), { status: 'no_dialog' });
  assert.equal((await tool(b, 'close_chrome')).status, 'closed');
  assert.deepEqual(await tool(b, 'get_dialog_status'), { status: 'invalid_browser_token' });
  assert.deepEqual(await otherStatus(), { status: 'no_dialog' });
  assert.equal((await otherTool('launch_chrome')).pid, other.pid);
  assert.equal((await otherTool('close_chrome')).status, 'closed');
});

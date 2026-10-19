// Opt in: launches disposable Chrome. CDP navigation and responses below are test drivers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startBroker } from '../src/broker.js';
import { Cdp } from '../src/cdp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

async function connectAdapter(stateDir) {
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/adapter.js', import.meta.url))],
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

test('installed Chrome: exact event counts, two adapters, response eligibility, replacement and connection loss', {
  skip: process.env.CHROME_DIALOG_INTEGRATION !== '1' || process.platform !== 'win32', timeout: 120000,
}, async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dialog-capture-integration-'));
  const config = { stateDir, endpoint: `\\\\.\\pipe\\chrome-dialog-mcp-${createHash('sha256').update(stateDir.toLowerCase()).digest('hex').slice(0, 24)}` };
  const { broker, server } = await startBroker(config);
  let brokerResponses = 0;
  broker.open = async endpoint => {
    const cdp = await Cdp.open(endpoint);
    const send = cdp.send.bind(cdp);
    cdp.send = (...args) => {
      if (args[0] === 'Page.handleJavaScriptDialog') brokerResponses++;
      return send(...args);
    };
    return cdp;
  };
  const clients = [];
  let driver;
  const web = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Dialog capture integration</title><p>Disposable capture test.</p>');
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await broker.call('close_chrome');
    driver?.close();
    await Promise.all(clients.map(client => client.close()));
    web.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => web.close(resolve))]);
    await rm(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });
  const a = await connectAdapter(stateDir); clients.push(a);
  const b = await connectAdapter(stateDir); clients.push(b);
  const tool = async (client, name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
  const status = () => tool(a, 'get_dialog_status');
  const arm = async () => {
    const result = await tool(a, 'start_dialog_capture');
    assert.equal(result.status, 'capturing');
    return result.capture_id;
  };
  const read = capture_id => tool(b, 'get_captured_dialog', { capture_id });
  const noDialog = () => until(status, result => result.status === 'no_dialog', 'dialog did not close');
  assert.deepEqual(await status(), { status: 'not_connected' });
  const launched = await tool(a, 'launch_chrome');
  assert.equal(launched.status, 'ready');
  assert.deepEqual(Object.keys(launched).sort(), ['hwnd', 'pid', 'status', 'windows_session_id']);
  assert.equal((await tool(b, 'launch_chrome')).pid, launched.pid);
  const { endpoint } = await broker.chrome.ensure();
  driver = await Cdp.open(endpoint);
  const { targetInfos } = await driver.send('Target.getTargets');
  const target = targetInfos.find(info => info.type === 'page');
  assert.ok(target);
  const { sessionId } = await driver.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await driver.send('Page.enable', {}, sessionId);
  if (process.env.CHROME_DIALOG_START_URL === undefined) {
    const startupUrl = new URL('../assets/start.html', import.meta.url).href;
    await until(() => driver.send('Runtime.evaluate', {
      expression: '({url: location.href, text: document.body?.innerText})', returnByValue: true,
    }, sessionId), r => r.result?.value?.url === startupUrl &&
      r.result.value.text?.includes('please manually navigate once to any valid URL in this window'),
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
  const emptyResult = await a.callTool({ name: 'get_captured_dialog', arguments: { capture_id: empty } });
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
  const countResult = await a.callTool({ name: 'get_captured_dialog', arguments: { capture_id: replaced } });
  assert.equal(countResult.isError, true);
  assert.deepEqual(countResult.structuredContent, { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 2 });
  assert.equal('dialog_id' in countResult.structuredContent, false);
  const replacementId = [...broker.dialogs.pending.values()][0].dialog_id;
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

  const interrupted = await arm();
  await trigger();
  broker.observer.close();
  assert.deepEqual(await read(interrupted), { status: 'not_connected' });
  assert.deepEqual(await tool(b, 'respond_to_dialog', { dialog_id: priorId, action: 'accept' }), { status: 'not_connected' });
  // Driver-only cleanup: the broker must not reconstruct this dialog after connection loss.
  await driver.send('Page.handleJavaScriptDialog', { accept: false }, sessionId);
  assert.equal((await tool(a, 'launch_chrome')).pid, launched.pid);
  assert.deepEqual(await read(interrupted), { status: 'invalid_capture' });
  assert.deepEqual(await status(), { status: 'no_dialog' });
  await a.close(); clients.splice(clients.indexOf(a), 1);
  assert.deepEqual(await tool(b, 'get_dialog_status'), { status: 'no_dialog' });
  assert.equal((await tool(b, 'close_chrome')).status, 'closed');
  assert.deepEqual(await tool(b, 'get_dialog_status'), { status: 'not_connected' });
});

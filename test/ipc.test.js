import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createIpcServer, request, secret, BrokerClient } from '../src/ipc.js';
import { startBroker } from '../src/broker.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dialog-ipc-test-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\dialog-test-${randomUUID()}` : path.join(stateDir, 'broker.sock');
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, endpoint };
}

test('two independent adapters reuse an authenticated broker', async t => {
  const config = await fixture(t);
  const key = await secret(config.stateDir, true);
  let calls = 0;
  const server = createIpcServer(key, async method => ({ status: method, calls: ++calls }));
  await new Promise(resolve => server.listen(config.endpoint, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const a = new BrokerClient(config);
  const b = new BrokerClient(config);
  const results = await Promise.all([a.call('launch_chrome'), b.call('launch_chrome')]);
  assert.deepEqual(results.map(r => r.calls).sort(), [1, 2]);
  assert.equal((await b.call('get_dialog_status')).calls, 3);
  assert.equal(await readFile(path.join(config.stateDir, 'ipc.key'), 'utf8'), key);
});

test('absent broker is not started by inspection, response or close', async t => {
  const config = await fixture(t);
  const client = new BrokerClient(config);
  assert.deepEqual(await client.call('get_dialog_status'), { status: 'not_connected' });
  assert.deepEqual(await client.call('start_dialog_capture'), { status: 'not_connected' });
  assert.deepEqual(await client.call('get_captured_dialog', { capture_id: randomUUID() }), { status: 'not_connected' });
  assert.deepEqual(await client.call('respond_to_dialog', { dialog_id: 1, action: 'accept' }), { status: 'not_connected' });
  assert.deepEqual(await client.call('close_chrome'), { status: 'not_running' });
  await assert.rejects(readFile(path.join(config.stateDir, 'ipc.key')), { code: 'ENOENT' });
});

test('an unrelated IPC service is rejected without spawning a replacement', async t => {
  const config = await fixture(t);
  const server = net.createServer(socket => socket.end('{"service":"unrelated"}\n'));
  await new Promise(resolve => server.listen(config.endpoint, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(request(config, 'launch_chrome'), /Unexpected IPC service/);
  assert.deepEqual(await new BrokerClient(config).call('launch_chrome'), { status: 'broker_unavailable' });
});

test('a service with a different key cannot impersonate the broker', async t => {
  const config = await fixture(t);
  await secret(config.stateDir, true);
  let acted = false;
  const server = createIpcServer('0'.repeat(64), () => { acted = true; return {}; });
  await new Promise(resolve => server.listen(config.endpoint, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(request(config, 'respond_to_dialog', { dialog_id: 1, action: 'accept' }));
  assert.equal(acted, false);
});

test('the IPC endpoint admits only one broker and startup does not connect to Chrome', async t => {
  const config = await fixture(t);
  const { server, broker } = await startBroker(config);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(startBroker(config), { code: 'EADDRINUSE' });
  assert.equal(broker.observer, null);
  assert.deepEqual(await request(config, 'get_dialog_status'), { status: 'not_connected' });
  await assert.rejects(readFile(path.join(config.stateDir, 'chrome.json')), { code: 'ENOENT' });
});

test('concurrent launchers start one persistent broker process on demand', { timeout: 30000 }, async t => {
  const config = await fixture(t);
  // Use the same endpoint derivation as the adapter/broker CLI.
  const { createHash } = await import('node:crypto');
  config.endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\chrome-dialog-mcp-${createHash('sha256').update(config.stateDir.toLowerCase()).digest('hex').slice(0, 24)}`
    : path.join(config.stateDir, 'broker.sock');
  const children = [];
  const start = (command, args, options) => {
    // Launch cannot open Chrome, even when the suite runs outside the sandbox.
    const child = spawn(command, args, { ...options, env: { ...options.env, CHROME_DIALOG_CHROME_PATH: path.join(config.stateDir, 'missing-chrome.exe') } });
    children.push(child);
    return child;
  };
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }));
  });
  const a = new BrokerClient(config, start);
  const b = new BrokerClient(config, start);
  assert.deepEqual(await a.call('get_dialog_status'), { status: 'not_connected' });
  assert.equal(children.length, 0);
  const results = await Promise.all([a.call('launch_chrome'), b.call('launch_chrome')]);
  assert.deepEqual(results, [{ status: 'launch_failed' }, { status: 'launch_failed' }]);
  assert.ok(children.length >= 1);
  assert.deepEqual(await new BrokerClient(config).call('get_dialog_status'), { status: 'not_connected' });
  assert.deepEqual(await a.call('close_chrome'), { status: 'not_running' });
  // Explicit browser close leaves the persistent service running.
  assert.deepEqual(await request(config, 'get_dialog_status'), { status: 'not_connected' });
});

test('the capture adapter refuses a legacy broker rather than using its unsafe response flow', async t => {
  const config = await fixture(t);
  const challenge = 'a'.repeat(64);
  const server = net.createServer(socket => socket.end(JSON.stringify({ service: 'chrome-dialog-broker/v1', challenge }) + '\n'));
  await new Promise(resolve => server.listen(config.endpoint, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(await new BrokerClient(config).call('launch_chrome'), { status: 'broker_unavailable' });
});

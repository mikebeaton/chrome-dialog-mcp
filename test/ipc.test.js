import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { configuration, createIpcServer, request, secret, BrokerClient } from '../src/ipc.js';
import { pathToFileURL } from 'node:url';
import { startBroker } from '../src/broker.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dialog-ipc-test-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\dialog-test-${randomUUID()}` : path.join(stateDir, 'broker.sock');
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { stateDir, endpoint };
}

test('default and custom state roots automatically use the installed package version', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const local = path.resolve('local-app-data');
  const defaultConfig = configuration({ LOCALAPPDATA: local });
  assert.equal(defaultConfig.stateRoot, path.join(local, 'ChromeDialogMcp'));
  assert.equal(defaultConfig.stateDir, path.join(local, 'ChromeDialogMcp', version));
  assert.equal(configuration({}).stateDir, path.join(os.homedir(), 'ChromeDialogMcp', version));
  const custom = configuration({ CHROME_DIALOG_STATE_DIR: 'custom-state', LOCALAPPDATA: local });
  assert.equal(custom.stateRoot, path.resolve('custom-state'));
  assert.equal(custom.stateDir, path.join(custom.stateRoot, version));
  assert.deepEqual(configuration({ CHROME_DIALOG_STATE_DIR: custom.stateRoot }), custom);
});

test('different installed versions use separate files and brokers, leaving legacy state untouched', async t => {
  const { stateDir: root } = await fixture(t);
  const stateRoot = path.join(root, 'shared-state');
  const configurations = [];
  for (const version of ['0.2.0-rc.1', '0.2.0-rc.2']) {
    const packageDir = path.join(root, version);
    await mkdir(path.join(packageDir, 'src'), { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ type: 'module', version }));
    await copyFile(new URL('../src/ipc.js', import.meta.url), path.join(packageDir, 'src', 'ipc.js'));
    const { configuration: installedConfiguration } = await import(pathToFileURL(path.join(packageDir, 'src', 'ipc.js')));
    const config = installedConfiguration({ CHROME_DIALOG_STATE_DIR: stateRoot });
    assert.equal(config.stateDir, path.join(stateRoot, version));
    configurations.push(config);
  }
  const hash = createHash('sha256').update(stateRoot.toLowerCase()).digest('hex').slice(0, 24);
  const legacy = { stateDir: stateRoot, endpoint: process.platform === 'win32'
    ? `\\\\.\\pipe\\chrome-dialog-mcp-${hash}` : path.join(stateRoot, 'broker.sock') };
  const configs = [legacy, ...configurations];
  assert.equal(new Set(configs.map(config => config.endpoint)).size, 3);
  const keys = [];
  const calls = [];
  for (const [index, config] of configs.entries()) {
    const key = await secret(config.stateDir, true);
    keys.push(key);
    const server = createIpcServer(key, () => { calls.push(index); return { status: `broker-${index}` }; });
    await new Promise(resolve => server.listen(config.endpoint, resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  assert.equal(new Set(keys).size, 3);
  for (const [index, config] of configurations.entries()) {
    assert.deepEqual(await new BrokerClient(config).call('get_dialog_status'), { status: `broker-${index + 1}` });
  }
  assert.deepEqual(calls, [1, 2]);
  assert.equal(await readFile(path.join(stateRoot, 'ipc.key'), 'utf8'), keys[0]);
});

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
  assert.deepEqual(await client.call('close_chrome'), { status: 'not_connected' });
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
  assert.equal(broker.sessions.size, 0);
  assert.deepEqual(await request(config, 'get_dialog_status'), { status: 'invalid_browser_token' });
  await assert.rejects(readFile(path.join(config.stateDir, 'chrome.json')), { code: 'ENOENT' });
});

test('concurrent launchers start one persistent broker process on demand', { timeout: 30000 }, async t => {
  const { stateDir: stateRoot } = await fixture(t);
  const config = configuration({ CHROME_DIALOG_STATE_DIR: stateRoot });
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
  assert.deepEqual(results.map(result => result.status), ['launch_failed', 'launch_failed']);
  assert.notEqual(results[0].browser_token, results[1].browser_token);
  assert.ok(children.length >= 1);
  assert.deepEqual(await new BrokerClient(config).call('get_dialog_status', { browser_token: results[0].browser_token }), { status: 'not_connected' });
  assert.deepEqual(await a.call('close_chrome', { browser_token: results[0].browser_token }), { status: 'not_running' });
  // Explicit browser close leaves the persistent service running.
  assert.deepEqual(await request(config, 'get_dialog_status', { browser_token: results[1].browser_token }), { status: 'not_connected' });
});

for (const legacyVersion of ['v1', 'v2', 'v3']) test(`the adapter refuses a legacy ${legacyVersion} broker rather than ignoring required safeguards`, async t => {
  const config = await fixture(t);
  const challenge = 'a'.repeat(64);
  const server = net.createServer(socket => socket.end(JSON.stringify({ service: `chrome-dialog-broker/${legacyVersion}`, challenge }) + '\n'));
  await new Promise(resolve => server.listen(config.endpoint, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(await new BrokerClient(config).call('launch_chrome'), { status: 'broker_unavailable' });
});

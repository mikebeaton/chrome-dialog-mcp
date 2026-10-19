import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpoint, windowsArguments, Chrome } from '../src/chrome.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('only a loopback browser WebSocket endpoint can be derived', () => {
  assert.equal(validateEndpoint('12345\r\n/devtools/browser/abc-123\r\n'), 'ws://127.0.0.1:12345/devtools/browser/abc-123');
  for (const invalid of ['0\n/devtools/browser/a', '65536\n/devtools/browser/a', '1234\nws://evil', '1234\n/devtools/page/a', '1234\n/devtools/browser/a?x=1']) {
    assert.throws(() => validateEndpoint(invalid));
  }
});

test('Windows profile argument matching respects whole arguments and spaces', () => {
  for (const argument of ['"--user-data-dir=C:\\Some Folder\\profile"', '--user-data-dir="C:\\Some Folder\\profile"']) {
    assert.ok(windowsArguments(`"C:\\Program Files\\chrome.exe" ${argument} --remote-debugging-port=0`).includes('--user-data-dir=C:\\Some Folder\\profile'));
  }
  assert.ok(!windowsArguments('chrome.exe --user-data-dir=C:\\profile-other').includes('--user-data-dir=C:\\profile'));
});

test('PID reuse, changed executable and wrong profile fail identity verification', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dialog-chrome-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const chrome = new Chrome(directory);
  const actual = { pid: 123, created: 'original-time', executable: 'C:\\chrome.exe', commandLine: `chrome.exe "--user-data-dir=${chrome.profile}" --remote-debugging-port=0` };
  await writeFile(chrome.metadataFile, JSON.stringify(actual));
  chrome.inspect = async () => actual;
  assert.equal(await chrome.identity(), actual);
  for (const change of [{ created: 'new-time' }, { executable: 'C:\\other.exe' }, { commandLine: `chrome.exe "--user-data-dir=${chrome.profile}-other" --remote-debugging-port=0` }]) {
    chrome.inspect = async () => ({ ...actual, ...change });
    await assert.rejects(chrome.identity(), /identity mismatch/);
  }
  chrome.inspect = async () => null;
  assert.equal(await chrome.identity(), null);
});

test('explicit reuse of a missing Chrome cannot launch a replacement process', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dialog-no-replacement-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const chrome = new Chrome(directory);
  chrome.inspect = async () => ({});
  chrome.identity = async () => null;
  chrome.executable = async () => { assert.fail('Reuse must not try to launch Chrome'); };
  await assert.rejects(chrome.ensure({ launchIfMissing: false }), /no longer running/);
});

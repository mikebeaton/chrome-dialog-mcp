import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpoint, windowsArguments, Chrome } from '../src/chrome.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

for (const [name, lookup, expected] of [
  ['live window', 'function Get-Process { [pscustomobject]@{MainWindowHandle=[IntPtr]42} }', '2A'],
  ['process exits before Get-Process', "function Get-Process { throw 'Process exited' }", null],
  ['process exits while reading MainWindowHandle', "function Get-Process { $w=[pscustomobject]@{}; Add-Member -InputObject $w -MemberType ScriptProperty -Name MainWindowHandle -Value { throw 'Process exited' }; $w }", null],
]) test(`Windows identity inspection retains CIM identity: ${name}`, { skip: process.platform !== 'win32' }, async () => {
  const snapshot = "function Get-CimInstance { [pscustomobject]@{ProcessId=123; CreationDate=[datetime]'2026-10-19T00:00:00Z'; ExecutablePath='C:\\chrome.exe'; CommandLine='chrome.exe'; SessionId=1} }; ";
  const chrome = new Chrome('unused', { run: (command, args, options) => execute(command,
    [...args.slice(0, -1), snapshot + lookup + '; ' + args.at(-1)], options) });
  const actual = await chrome.inspect(123);
  assert.equal(actual.pid, 123);
  assert.equal(actual.executable, 'C:\\chrome.exe');
  assert.equal(actual.commandLine, 'chrome.exe');
  assert.equal(actual.hwnd, expected);
});

test('CIM inspection errors still fail closed', { skip: process.platform !== 'win32' }, async () => {
  const chrome = new Chrome('unused', { run: (command, args, options) => execute(command,
    [...args.slice(0, -1), "function Get-CimInstance { throw 'Identity unavailable' }; " + args.at(-1)], options) });
  await assert.rejects(chrome.inspect(123), /Identity unavailable/);
});

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

test('close succeeds when Chrome exits between verification and taskkill', async () => {
  let lookups = 0;
  let kills = 0;
  const chrome = new Chrome('unused', { run: async (command, args) => {
    kills++;
    assert.equal(command, 'taskkill.exe');
    assert.deepEqual(args, ['/PID', '123', '/T', '/F']);
    throw new Error('Process not found');
  } });
  chrome.identity = async () => ++lookups === 1 ? { pid: 123 } : null;
  assert.deepEqual(await chrome.close(), { status: 'closed' });
  assert.equal(lookups, 2);
  assert.equal(kills, 1);
});

for (const failure of ['still running', 'identity unavailable', 'PID reused']) test(`failed taskkill cannot report success: ${failure}`, async () => {
  const killError = new Error('Taskkill failed');
  let lookups = 0;
  const chrome = new Chrome('unused', { run: async () => { throw killError; } });
  chrome.identity = async () => {
    if (++lookups === 1 || failure === 'still running') return { pid: 123 };
    throw new Error(failure);
  };
  await assert.rejects(chrome.close(), failure === 'still running' ? killError : new RegExp(failure));
});

for (const exited of [true, false]) test(`successful taskkill still verifies process exit: ${exited}`, async () => {
  const chrome = new Chrome('unused', { run: async () => ({}) });
  chrome.identity = async () => ({ pid: 123 });
  chrome.waitForExit = async () => exited;
  if (exited) assert.deepEqual(await chrome.close(), { status: 'closed' });
  else await assert.rejects(chrome.close(), /did not exit/);
});

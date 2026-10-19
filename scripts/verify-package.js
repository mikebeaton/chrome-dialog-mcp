import assert from 'node:assert/strict';
import { readFile, mkdir, readdir, mkdtemp, appendFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const filename = `${pkg.name}-${pkg.version}.tgz`;
const archive = path.join(root, 'dist', filename);
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
assert.equal(await readFile(`${archive}.sha256`, 'utf8'), `${digest}  ${filename}\n`);
if (!process.env.npm_execpath) throw new Error('Run through npm run release:verify');

const installParent = path.join(root, '.work', 'release-verify');
await mkdir(installParent, { recursive: true });
// Refuse overwrites; spaces exercise paths used by a normal npm installation.
const installDir = path.join(installParent, `${pkg.version} installed package`);
await mkdir(installDir);
await execute(process.execPath, [process.env.npm_execpath, 'install', '--prefix', installDir,
  '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', archive],
{ cwd: root, windowsHide: true, timeout: 120000 });

const packageRoot = path.join(installDir, 'node_modules', pkg.name);
const installed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
assert.equal(installed.name, pkg.name);
assert.equal(installed.version, pkg.version);
// Verify the installed runtime is the source that was checked before packaging.
for (const file of ['package.json', 'npm-shrinkwrap.json', 'assets/start.html', 'src/adapter.js',
  'src/broker.js', 'src/cdp.js', 'src/chrome.js', 'src/dialogs.js', 'src/ipc.js']) {
  assert.deepEqual(await readFile(path.join(packageRoot, file)), await readFile(path.join(root, file)), file);
}
for (const doc of ['README.md', 'DEVELOPMENT.md', 'RELEASES.md', 'chrome-dialog-mcp-spec.md']) {
  await readFile(path.join(packageRoot, doc));
}
const contents = await readdir(packageRoot);
for (const absent of ['.git', '.work', 'test']) assert.ok(!contents.includes(absent));

const stateDir = await mkdtemp(path.join(installDir, 'smoke-state-'));
assert.ok(path.resolve(stateDir).startsWith(path.resolve(installDir) + path.sep));
const client = new Client({ name: 'release-smoke-test', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(packageRoot, 'src', 'adapter.js')], cwd: installDir,
    env: { ...process.env, CHROME_DIALOG_STATE_DIR: stateDir }, stderr: 'pipe' }));
  assert.equal(client.getServerVersion().version, pkg.version);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['close_chrome', 'get_captured_dialog', 'get_dialog_status', 'launch_chrome', 'respond_to_dialog', 'start_dialog_capture']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.properties.browser_token.type, 'string');
    assert.equal(tool.inputSchema.required?.includes('browser_token') ?? false, tool.name !== 'launch_chrome');
  }
  assert.deepEqual((await client.callTool({ name: 'get_dialog_status', arguments: { browser_token: 'a'.repeat(64) } })).structuredContent, { status: 'not_connected' });
  assert.deepEqual(await readdir(stateDir), []);
} finally {
  await client.close();
  await rm(stateDir, { recursive: true, force: true });
}
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `CHROME_DIALOG_PACKAGE_ROOT=${packageRoot}\n`);
await writeFile(path.join(installDir, 'verification.json'), JSON.stringify({ packageRoot, node: process.version, sha256: digest }, null, 2) + '\n');
console.log(`Verified installed package ${pkg.version}\nPackage root: ${packageRoot}`);

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) throw new Error('Package and shrinkwrap versions must match');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Release tag must match the package version');
if (!process.env.npm_execpath) throw new Error('Run through npm run release:pack');
const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
const dirty = Boolean((await execute('git', ['status', '--porcelain'], { cwd: root, windowsHide: true })).stdout.trim());
if (process.env.GITHUB_REF_TYPE === 'tag' && dirty) throw new Error('Tagged release must have a clean working tree');
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });
const filename = `${pkg.name}-${pkg.version}.tgz`;
try { await access(path.join(output, filename)); throw new Error('Artifact already exists; use a new version or explicitly remove the previous build'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const { stdout } = await execute(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', output], { cwd: root, windowsHide: true });
const [packed] = JSON.parse(stdout);
const expected = new Set(['package.json', 'npm-shrinkwrap.json', 'README.md', 'DEVELOPMENT.md', 'RELEASES.md', 'chrome-dialog-mcp-spec.md', 'assets/start.html',
  'src/adapter.js', 'src/broker.js', 'src/cdp.js', 'src/chrome.js', 'src/dialogs.js', 'src/ipc.js']);
if (packed.filename !== filename || packed.files.length !== expected.size || packed.files.some(file => !expected.has(file.path))) throw new Error('Unexpected release contents');
const sha256 = createHash('sha256').update(await readFile(path.join(output, filename))).digest('hex');
const info = { name: pkg.name, version: pkg.version, filename, sha256, commit, dirty };
await writeFile(path.join(output, `${filename}.sha256`), `${sha256}  ${filename}\n`);
await writeFile(path.join(output, `${pkg.name}-${pkg.version}-build-info.json`), JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify({ ...info, files: packed.files.map(file => file.path) }, null, 2));

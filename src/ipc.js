import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Earlier brokers lack session isolation (v3), prompt semantics (v2) or capture eligibility (v1).
const SERVICE = 'chrome-dialog-broker/v4';
const MAX_MESSAGE = 1024 * 1024;

export function configuration() {
  const stateDir = path.resolve(process.env.CHROME_DIALOG_STATE_DIR ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'ChromeDialogMcp'));
  const hash = createHash('sha256').update(stateDir.toLowerCase()).digest('hex').slice(0, 24);
  return { stateDir, endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\chrome-dialog-mcp-${hash}` : path.join(stateDir, 'broker.sock') };
}

export async function secret(stateDir, create = false) {
  if (create) {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    try { await writeFile(path.join(stateDir, 'ipc.key'), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = await readFile(path.join(stateDir, 'ipc.key'), 'utf8');
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid IPC key');
  return key;
}

function mac(key, body) {
  return createHmac('sha256', key).update(JSON.stringify(body)).digest('hex');
}

function valid(key, body, signature) {
  return typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature) &&
    timingSafeEqual(Buffer.from(mac(key, body), 'hex'), Buffer.from(signature, 'hex'));
}

// One bounded JSON message per line; callbacks never expose raw IPC/CDP errors to MCP.
function lines(socket, receive) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_MESSAGE) { socket.destroy(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try { receive(JSON.parse(line)); } catch { socket.destroy(); }
    }
  });
}

export function createIpcServer(key, handle) {
  return net.createServer(socket => {
    socket.on('error', () => {});
    socket.setTimeout(30000, () => socket.destroy());
    const challenge = randomBytes(32).toString('hex');
    let used = false;
    socket.write(JSON.stringify({ service: SERVICE, challenge }) + '\n');
    lines(socket, message => {
      if (used) { socket.destroy(); return; }
      used = true;
      const { body, signature } = message;
      if (!body || body.service !== SERVICE || body.challenge !== challenge ||
          typeof body.nonce !== 'string' || !valid(key, body, signature)) { socket.destroy(); return; }
      Promise.resolve().then(() => handle(body.method, body.params)).catch(() => ({ status: 'broker_error' })).then(result => {
        const response = { service: SERVICE, nonce: body.nonce, challenge, result };
        socket.end(JSON.stringify({ body: response, signature: mac(key, response) }) + '\n');
      });
    });
  });
}

export async function request(config, method, params = {}) {
  // Connect first so an absent broker is distinguishable from a corrupt/missing key.
  const socket = net.createConnection(config.endpoint);
  return new Promise((resolve, reject) => {
    let finished = false;
    let challenge;
    let key;
    const nonce = randomBytes(32).toString('hex');
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(30000, () => finish(new Error('IPC timeout')));
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('IPC closed')));
    lines(socket, message => {
      if (!challenge) {
        if (message.service !== SERVICE || !/^[a-f0-9]{64}$/.test(message.challenge ?? '')) {
          finish(new Error('Unexpected IPC service')); return;
        }
        challenge = message.challenge;
        void secret(config.stateDir).then(value => {
          key = value;
          const body = { service: SERVICE, challenge, nonce, method, params };
          socket.write(JSON.stringify({ body, signature: mac(key, body) }) + '\n');
        }).catch(error => finish(error));
      } else {
        const { body, signature } = message;
        if (!key || !body || body.service !== SERVICE || body.nonce !== nonce || body.challenge !== challenge || !valid(key, body, signature)) {
          finish(new Error('Unauthenticated IPC response')); return;
        }
        finish(null, body.result);
      }
    });
  });
}

export class BrokerClient {
  constructor(config = configuration(), spawnProcess = spawn) {
    this.config = config;
    this.spawnProcess = spawnProcess;
  }

  async call(method, params = {}) {
    try { return await request(this.config, method, params); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) return { status: 'broker_unavailable' };
      if (method !== 'launch_chrome') return { status: 'not_connected' };
    }
    // Pipe bind elects the single broker; simultaneous launchers may spawn losing candidates.
    const child = this.spawnProcess(process.execPath, [fileURLToPath(new URL('./broker.js', import.meta.url))], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, CHROME_DIALOG_STATE_DIR: this.config.stateDir },
    });
    let failed = false;
    child.on('error', () => { failed = true; });
    child.unref();
    const deadline = Date.now() + 10000;
    while (!failed && Date.now() < deadline) {
      await delay(100);
      try { return await request(this.config, method, params); }
      catch (error) {
        // Only IPC startup is retried. Never replay an operation after ambiguous delivery.
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) break;
      }
    }
    return { status: 'broker_unavailable' };
  }
}

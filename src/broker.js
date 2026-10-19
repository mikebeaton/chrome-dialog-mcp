import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome, readJson, writeJson } from './chrome.js';
import { Cdp, Observer } from './cdp.js';
import { Dialogs } from './dialogs.js';
import { configuration, createIpcServer, secret } from './ipc.js';

export function durableIds(stateDir) {
  const file = path.join(stateDir, 'dialog-sequence.json');
  let next = 0;
  try { next = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Number.isSafeInteger(next) || next < 0) throw new Error('Invalid dialog sequence');
  return () => {
    if (next >= Number.MAX_SAFE_INTEGER) throw new Error('Dialog IDs exhausted');
    const id = next + 1;
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(id), { mode: 0o600, flush: true });
    renameSync(temporary, file);
    next = id;
    return id;
  };
}

export class BrowserSession {
  constructor(chrome, dialogs, open = Cdp.open, { allowLaunch = true } = {}) {
    this.chrome = chrome;
    this.dialogs = dialogs;
    this.open = open;
    this.observer = null;
    this.allowLaunch = allowLaunch;
    this.queue = Promise.resolve();
  }

  call(method, params = {}) {
    const operation = this.queue.then(() => this.perform(method, params));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async perform(method, params) {
    switch (method) {
      case 'launch_chrome': {
        const launchIfMissing = this.allowLaunch;
        // A token may reconnect to its original process, never create a replacement.
        this.allowLaunch = false;
        if (this.observer?.cdp.alive && this.dialogs.connection === this.observer) {
          try {
            const actual = await this.chrome.identity();
            if (!actual || !this.observer.cdp.alive || this.dialogs.connection !== this.observer) {
              throw new Error('Chrome unavailable');
            }
            return this.chrome.identifiers(actual);
          } catch {
            this.observer.close();
            return { status: 'launch_failed' };
          }
        }
        this.observer?.close();
        this.dialogs.disconnect();
        try {
          const { endpoint, identifiers } = await this.chrome.ensure({ launchIfMissing });
          this.observer = new Observer(await this.open(endpoint), this.dialogs);
          await this.observer.ready();
          return identifiers;
        } catch {
          this.observer?.close();
          this.dialogs.disconnect();
          return { status: 'launch_failed' };
        }
      }
      case 'get_dialog_status': return this.dialogs.status();
      case 'start_dialog_capture': return this.dialogs.startCapture();
      case 'get_captured_dialog': return this.dialogs.getCaptured(params?.capture_id);
      case 'respond_to_dialog': {
        if (!params || typeof params !== 'object') return { status: 'invalid_request' };
        const result = await this.dialogs.respond(params.dialog_id, params.action,
          (...args) => this.observer.cdp.send(...args), params.prompt_text);
        if (!this.dialogs.connection) this.observer?.close();
        return result;
      }
      case 'close_chrome': {
        // Invalidate before shutdown; a failed close never leaves permission records usable.
        this.dialogs.disconnect();
        try {
          if (this.observer?.cdp.alive) {
            await this.observer.cdp.send('Browser.close').catch(() => {});
            if (this.chrome.waitForExit && await this.chrome.waitForExit()) return { status: 'closed' };
          }
          return await this.chrome.close();
        } catch { return { status: 'close_failed' }; }
        finally { this.observer?.close(); }
      }
      default: return { status: 'invalid_request' };
    }
  }
}

const tokenPattern = /^[a-f0-9]{64}$/;
const methods = new Set(['launch_chrome', 'get_dialog_status', 'start_dialog_capture', 'get_captured_dialog', 'respond_to_dialog', 'close_chrome']);

// Tokens are capabilities, not agent identities. No implicit reuse or token listing.
export class Broker {
  constructor(stateDir, { chrome = directory => new Chrome(directory), open = Cdp.open } = {}) {
    this.stateDir = stateDir;
    this.createChrome = chrome;
    this.open = open;
    this.allocateId = durableIds(stateDir);
    this.sessions = new Map();
    this.queue = Promise.resolve();
  }

  call(method, params = {}) {
    const operation = this.queue.then(() => this.perform(method, params));
    this.queue = operation.catch(() => {});
    return operation;
  }

  directory(token) {
    return path.join(this.stateDir, 'sessions', createHash('sha256').update(token).digest('hex'));
  }

  createSession(directory, allowLaunch) {
    return new BrowserSession(this.createChrome(directory), new Dialogs(this.allocateId), this.open, { allowLaunch });
  }

  async perform(method, params) {
    if (!methods.has(method) || !params || typeof params !== 'object' || Array.isArray(params)) return { status: 'invalid_request' };
    let token = params.browser_token;
    let session;
    if (method === 'launch_chrome' && token === undefined) {
      token = randomBytes(32).toString('hex');
      const directory = this.directory(token);
      await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      await writeJson(path.join(directory, 'session.json'), { version: 1, status: 'active' });
      session = this.createSession(directory, true);
      this.sessions.set(token, session);
    } else {
      if (typeof token !== 'string' || !tokenPattern.test(token)) return { status: 'invalid_browser_token' };
      session = this.sessions.get(token);
      if (!session) {
        const metadata = await readJson(path.join(this.directory(token), 'session.json'));
        if (metadata?.version !== 1 || metadata.status !== 'active') return { status: 'invalid_browser_token' };
        // Loading a known session never attaches or launches Chrome implicitly.
        session = this.createSession(this.directory(token), false);
        this.sessions.set(token, session);
      }
    }
    const result = await session.call(method, params);
    if (method === 'close_chrome' && ['closed', 'not_running'].includes(result.status)) {
      await writeJson(path.join(this.directory(token), 'session.json'), { version: 1, status: 'closed' });
      this.sessions.delete(token);
    }
    // Even failed initial launches return a handle for explicit cleanup of a possible process.
    return method === 'launch_chrome' ? { ...result, browser_token: token } : result;
  }
}

export async function startBroker(config = configuration(), options = {}) {
  const key = await secret(config.stateDir, true);
  let broker;
  const server = createIpcServer(key, (method, params) => broker.call(method, params));
  // One service owns the session registry and durable sequence for this directory.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.endpoint, resolve);
  });
  try { broker = new Broker(config.stateDir, options); }
  catch (error) { server.close(); throw error; }
  return { server, broker };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBroker().catch(() => { process.exitCode = 1; });
}

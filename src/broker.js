import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Chrome } from './chrome.js';
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

export class Broker {
  constructor(chrome, dialogs, open = Cdp.open) {
    this.chrome = chrome;
    this.dialogs = dialogs;
    this.open = open;
    this.observer = null;
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
          const { endpoint, identifiers } = await this.chrome.ensure();
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
          (...args) => this.observer.cdp.send(...args));
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

export async function startBroker(config = configuration()) {
  const key = await secret(config.stateDir, true);
  let broker;
  const server = createIpcServer(key, (method, params) => broker.call(method, params));
  // No file lock, ownership lease, or agent lock: the IPC listener is the singleton.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.endpoint, resolve);
  });
  try { broker = new Broker(new Chrome(config.stateDir), new Dialogs(durableIds(config.stateDir))); }
  catch (error) { server.close(); throw error; }
  return { server, broker };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBroker().catch(() => { process.exitCode = 1; });
}

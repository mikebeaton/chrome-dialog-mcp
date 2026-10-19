import { EventEmitter } from 'node:events';

export class Cdp extends EventEmitter {
  constructor(socket, timeout = 10000) {
    super();
    this.socket = socket;
    this.timeout = timeout;
    this.nextId = 0;
    this.requests = new Map();
    this.alive = true;
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.id) {
          const request = this.requests.get(message.id);
          if (!request) return;
          this.requests.delete(message.id);
          clearTimeout(request.timer);
          if (message.error) request.reject(new Error('CDP command failed', { cause: message.error }));
          else request.resolve(message.result ?? {});
        } else if (message.method) {
          this.emit('event', message);
        }
      } catch {
        this.close();
      }
    });
    socket.addEventListener('close', () => this.lost());
    socket.addEventListener('error', () => this.close());
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    if (!this.alive || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Disconnected'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), this.timeout);
      this.requests.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { this.close(); }
    });
  }

  lost() {
    if (!this.alive) return;
    this.alive = false;
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Disconnected'));
    }
    this.requests.clear();
    this.emit('disconnect');
  }

  close() {
    this.lost();
    this.socket.close();
  }
}

// No reconnection: creating another observer requires an explicit launch request.
export class Observer {
  constructor(cdp, dialogs) {
    this.cdp = cdp;
    this.dialogs = dialogs;
    this.initializing = new Set();
    this.failed = false;
    dialogs.connect(this);
    cdp.on('disconnect', () => { if (dialogs.connection === this) dialogs.disconnect(); });
    cdp.on('event', event => this.event(event));
  }

  async ready() {
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    await this.cdp.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'page' }, { type: 'iframe' }, { exclude: true }],
    });
    // Attached events precede the command response. Include recursively attached frames.
    while (this.initializing.size) await Promise.all([...this.initializing]);
    if (this.failed || !this.cdp.alive || this.dialogs.connection !== this) throw new Error('Observer unavailable');
  }

  event({ method, params = {}, sessionId }) {
    if (this.dialogs.connection !== this) return;
    switch (method) {
      case 'Target.attachedToTarget': {
        const task = this.attach(params).catch(() => {
          this.failed = true;
          this.close();
        }).finally(() => this.initializing.delete(task));
        this.initializing.add(task);
        break;
      }
      case 'Target.detachedFromTarget': this.dialogs.detach(params.sessionId); break;
      case 'Target.targetDestroyed':
      case 'Target.targetCrashed': this.dialogs.destroyTarget(params.targetId); break;
      case 'Inspector.detached':
      case 'Inspector.targetCrashed': this.dialogs.detach(sessionId); break;
      case 'Page.javascriptDialogOpening': this.dialogs.opening(sessionId, params); break;
      case 'Page.javascriptDialogClosed': this.dialogs.closed(sessionId); break;
    }
  }

  async attach({ sessionId, targetInfo, waitingForDebugger }) {
    this.dialogs.attach(sessionId, targetInfo.targetId);
    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'iframe' }, { exclude: true }],
    }, sessionId);
    if (waitingForDebugger) await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  close() { this.cdp.close(); }
}

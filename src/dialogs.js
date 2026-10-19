import { randomUUID } from 'node:crypto';

// Events update state synchronously, including while a response command is in flight.
export class Dialogs {
  constructor(allocateId) {
    this.allocateId = allocateId;
    this.connection = null;
    this.sessions = new Map();
    this.pending = new Map();
    this.captures = new Map();
    this.responding = false;
  }

  connect(connection) {
    this.disconnect();
    this.connection = connection;
  }

  disconnect() {
    this.connection = null;
    this.sessions.clear();
    this.pending.clear();
    this.captures.clear();
  }

  attach(session, target) {
    if (!this.connection) return;
    if (this.sessions.get(session) !== target) this.pending.delete(session);
    this.sessions.set(session, target);
  }

  detach(session) {
    this.sessions.delete(session);
    this.pending.delete(session);
  }

  destroyTarget(target) {
    for (const [session, id] of this.sessions) {
      if (id === target) this.detach(session);
    }
  }

  opening(session, event) {
    if (!this.connection) return;
    // Count every observed opening, including ones whose provenance is unusable.
    // Closing, replacing or detaching a dialog never subtracts from this count.
    for (const capture of this.captures.values()) capture.openingCount++;
    // A new event replaces any earlier dialog in this session, even malformed ones.
    this.pending.delete(session);
    if (!this.sessions.has(session) || typeof event.url !== 'string' || typeof event.message !== 'string' ||
        !['alert', 'confirm', 'prompt', 'beforeunload'].includes(event.type)) return;
    const record = {
      connection: this.connection, session, target: this.sessions.get(session),
      dialog_id: this.allocateId(), url: event.url,
      type: event.type, message: event.message, options: ['accept', 'dismiss'],
      responseEnabled: false,
    };
    this.pending.set(session, record);
    for (const capture of this.captures.values()) {
      if (capture.openingCount === 1) capture.record = record;
    }
  }

  closed(session) {
    this.pending.delete(session);
  }

  status() {
    if (!this.connection) return { status: 'not_connected' };
    return this.pending.size
      ? { status: 'dialog_pending', pending_count: this.pending.size }
      : { status: 'no_dialog' };
  }

  startCapture() {
    if (!this.connection) return { status: 'not_connected' };
    if (this.responding) return { status: 'busy' };
    if (this.pending.size) return { status: 'dialog_already_pending' };
    const capture_id = randomUUID();
    this.captures.set(capture_id, { connection: this.connection, openingCount: 0, record: null });
    return { status: 'capturing', capture_id };
  }

  getCaptured(captureId) {
    if (!this.connection) return { status: 'not_connected' };
    const capture = this.captures.get(captureId);
    if (!capture || capture.connection !== this.connection) return { status: 'invalid_capture' };
    // Reading seals and consumes the interval, on success AND on failure.
    this.captures.delete(captureId);
    if (capture.openingCount !== 1) {
      return { status: 'incorrect_dialog_count', expected_count: 1, observed_count: capture.openingCount };
    }
    const record = capture.record;
    if (!record || this.pending.get(record.session) !== record ||
        this.sessions.get(record.session) !== record.target) return { status: 'dialog_not_pending' };
    record.responseEnabled = true;
    const { dialog_id, url, type, message, options } = record;
    return { status: 'captured', dialog_id, url, type, message, options: [...options] };
  }

  async respond(id, action, send) {
    if (!this.connection) return { status: 'not_connected' };
    if (!Number.isSafeInteger(id) || !['accept', 'dismiss'].includes(action)) {
      return { status: 'invalid_request' };
    }
    const record = [...this.pending.values()].find(d => d.dialog_id === id);
    if (!record || record.connection !== this.connection ||
        this.sessions.get(record.session) !== record.target) return { status: 'stale_dialog' };
    if (!record.responseEnabled) return { status: 'dialog_not_captured' };
    if (this.responding) return { status: 'busy' };
    // Consume before sending. A timeout or error can never make this ID reusable.
    this.pending.delete(record.session);
    this.responding = true;
    try {
      await send('Page.handleJavaScriptDialog', { accept: action === 'accept' }, record.session);
      return record.connection === this.connection
        ? { status: 'responded', dialog_id: id, action }
        : { status: 'not_connected' };
    } catch {
      // Any ambiguous handling result invalidates the whole observation connection.
      if (record.connection === this.connection) this.disconnect();
      return { status: 'not_connected' };
    } finally {
      this.responding = false;
    }
  }
}

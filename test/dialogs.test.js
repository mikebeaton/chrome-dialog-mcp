import test from 'node:test';
import assert from 'node:assert/strict';
import { Dialogs } from '../src/dialogs.js';

const event = (message = 'Delete item?', url = 'https://example.com/settings') => ({ url, message, type: 'confirm' });
function fixture() {
  let sequence = 0;
  const dialogs = new Dialogs(() => ++sequence);
  dialogs.connect({});
  dialogs.attach('session-a', 'target-a');
  return dialogs;
}
const arm = dialogs => {
  const result = dialogs.startCapture();
  assert.equal(result.status, 'capturing');
  return result.capture_id;
};
const noSend = () => assert.fail('No CDP response must be sent');

test('zero openings returns a neutral count failure and consumes the token', () => {
  const dialogs = fixture();
  const token = arm(dialogs);
  assert.deepEqual(dialogs.getCaptured(token), { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 0 });
  dialogs.opening('session-a', event());
  assert.deepEqual(dialogs.getCaptured(token), { status: 'invalid_capture' });
});

test('a sole still-pending event releases provenance and a separate one-use dialog ID', () => {
  const dialogs = fixture();
  const token = arm(dialogs);
  dialogs.opening('session-a', event());
  assert.deepEqual(dialogs.status(), { status: 'dialog_pending', pending_count: 1 });
  assert.deepEqual(dialogs.getCaptured(token), {
    status: 'captured', dialog_id: 1, url: 'https://example.com/settings', type: 'confirm',
    message: 'Delete item?', options: ['accept', 'dismiss'],
  });
  assert.deepEqual(dialogs.getCaptured(token), { status: 'invalid_capture' });
});

for (const action of ['accept', 'dismiss']) {
  test(`captured confirm ${action} is routed to its session once`, async () => {
    const dialogs = fixture();
    const token = arm(dialogs);
    dialogs.opening('session-a', event());
    const captured = dialogs.getCaptured(token);
    const calls = [];
    const send = async (...args) => calls.push(args);
    assert.equal((await dialogs.respond(captured.dialog_id, action, send)).status, 'responded');
    assert.deepEqual(calls, [['Page.handleJavaScriptDialog', { accept: action === 'accept' }, 'session-a']]);
    assert.equal((await dialogs.respond(captured.dialog_id, action, send)).status, 'stale_dialog');
    assert.equal(calls.length, 1);
    assert.deepEqual(dialogs.status(), { status: 'no_dialog' });
  });
}

test('guessing an observed sequence ID cannot bypass a successful capture', async () => {
  const dialogs = fixture();
  dialogs.opening('session-a', event());
  assert.deepEqual(await dialogs.respond(1, 'accept', noSend), { status: 'dialog_not_captured' });
  assert.deepEqual(dialogs.startCapture(), { status: 'dialog_already_pending' });
  assert.deepEqual(dialogs.getCaptured('unknown'), { status: 'invalid_capture' });
});

test('replacement before inspection counts both openings even with identical provenance and text', async () => {
  const dialogs = fixture();
  const token = arm(dialogs);
  dialogs.opening('session-a', event());
  dialogs.closed('session-a');
  dialogs.opening('session-a', event());
  assert.deepEqual(dialogs.getCaptured(token), { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 2 });
  assert.deepEqual(await dialogs.respond(2, 'dismiss', noSend), { status: 'dialog_not_captured' });
  assert.deepEqual(await dialogs.respond(1, 'accept', noSend), { status: 'stale_dialog' });
  assert.deepEqual(dialogs.startCapture(), { status: 'dialog_already_pending' });
});

test('all openings count, rather than just the dialogs remaining pending', () => {
  const dialogs = fixture();
  const token = arm(dialogs);
  for (let i = 0; i < 3; i++) {
    dialogs.opening('session-a', event());
    dialogs.closed('session-a');
  }
  assert.deepEqual(dialogs.status(), { status: 'no_dialog' });
  assert.deepEqual(dialogs.getCaptured(token), { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 3 });
});

test('counting includes other targets, detached sessions and unattributable opening events', () => {
  const dialogs = fixture();
  const token = arm(dialogs);
  dialogs.opening('session-a', event());
  dialogs.destroyTarget('target-a');
  dialogs.attach('session-b', 'target-b');
  dialogs.opening('session-b', event());
  dialogs.opening('unknown-session', event());
  assert.deepEqual(dialogs.getCaptured(token), { status: 'incorrect_dialog_count', expected_count: 1, observed_count: 3 });
});

test('an already-closed opening before arming is excluded from the interval', () => {
  const dialogs = fixture();
  dialogs.opening('session-a', event('Before capture'));
  dialogs.closed('session-a');
  const token = arm(dialogs);
  dialogs.opening('session-a', event('During capture'));
  const captured = dialogs.getCaptured(token);
  assert.equal(captured.status, 'captured');
  assert.equal(captured.message, 'During capture');
  assert.equal(captured.dialog_id, 2);
});

for (const lifecycle of ['close', 'detach', 'destroy', 'session-replacement', 'malformed']) {
  test(`one opening followed by ${lifecycle} cannot release a response ID`, async () => {
    const dialogs = fixture();
    const token = arm(dialogs);
    if (lifecycle === 'malformed') dialogs.opening('session-a', { type: 'confirm', message: 'No URL' });
    else dialogs.opening('session-a', event());
    if (lifecycle === 'close') dialogs.closed('session-a');
    if (lifecycle === 'detach') dialogs.detach('session-a');
    if (lifecycle === 'destroy') dialogs.destroyTarget('target-a');
    if (lifecycle === 'session-replacement') dialogs.attach('session-a', 'another-target');
    assert.deepEqual(dialogs.getCaptured(token), { status: 'dialog_not_pending' });
    assert.deepEqual(dialogs.getCaptured(token), { status: 'invalid_capture' });
    assert.equal((await dialogs.respond(1, 'accept', noSend)).status, 'stale_dialog');
  });
}

test('closing and replacing a successfully inspected dialog invalidates its ID', async () => {
  const dialogs = fixture();
  const token = arm(dialogs);
  dialogs.opening('session-a', event('Inspected'));
  const captured = dialogs.getCaptured(token);
  dialogs.closed('session-a');
  dialogs.opening('session-a', event('Replacement'));
  assert.deepEqual(await dialogs.respond(captured.dialog_id, 'accept', noSend), { status: 'stale_dialog' });
  assert.deepEqual(await dialogs.respond(2, 'accept', noSend), { status: 'dialog_not_captured' });
});

test('independent capture tokens observe the same interval without granting browser ownership', () => {
  const dialogs = fixture();
  const first = arm(dialogs);
  const second = arm(dialogs);
  assert.notEqual(first, second);
  dialogs.opening('session-a', event());
  assert.equal(dialogs.getCaptured(first).dialog_id, 1);
  assert.equal(dialogs.getCaptured(second).dialog_id, 1);
});

test('connection loss invalidates captures and response IDs; reconnection never resurrects them', async () => {
  const dialogs = fixture();
  const token = arm(dialogs);
  dialogs.opening('session-a', event());
  const captured = dialogs.getCaptured(token);
  const other = fixture();
  const interrupted = arm(other);
  other.disconnect();
  assert.deepEqual(other.getCaptured(interrupted), { status: 'not_connected' });
  dialogs.disconnect();
  assert.deepEqual(dialogs.status(), { status: 'not_connected' });
  assert.deepEqual(await dialogs.respond(captured.dialog_id, 'accept', noSend), { status: 'not_connected' });
  dialogs.connect({});
  dialogs.attach('session-a', 'target-a');
  assert.deepEqual(dialogs.getCaptured(token), { status: 'invalid_capture' });
  assert.deepEqual(await dialogs.respond(captured.dialog_id, 'accept', noSend), { status: 'stale_dialog' });
  const fresh = arm(dialogs);
  dialogs.opening('session-a', event('Fresh'));
  assert.equal(dialogs.getCaptured(fresh).dialog_id, 2);
});

test('concurrent responses consume the captured ID before sending the asynchronous command', async () => {
  const dialogs = fixture();
  const token = arm(dialogs);
  dialogs.opening('session-a', event());
  const { dialog_id } = dialogs.getCaptured(token);
  let complete;
  const first = dialogs.respond(dialog_id, 'accept', () => new Promise(resolve => { complete = resolve; }));
  assert.deepEqual(dialogs.startCapture(), { status: 'busy' });
  assert.equal((await dialogs.respond(dialog_id, 'dismiss', noSend)).status, 'stale_dialog');
  complete();
  assert.equal((await first).status, 'responded');
});

test('an ambiguous response failure invalidates all state without retry', async () => {
  const dialogs = fixture();
  const token = arm(dialogs);
  dialogs.opening('session-a', event());
  const captured = dialogs.getCaptured(token);
  let calls = 0;
  assert.deepEqual(await dialogs.respond(captured.dialog_id, 'accept', async () => { calls++; throw new Error('unknown result'); }), { status: 'not_connected' });
  assert.equal(calls, 1);
  assert.deepEqual(dialogs.status(), { status: 'not_connected' });
});

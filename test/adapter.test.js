import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function adapter(stateDir) {
  const client = new Client({ name: 'dialog-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/adapter.js', import.meta.url))],
    env: { ...process.env, CHROME_DIALOG_STATE_DIR: stateDir },
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}

test('real stdio initialization exposes the capture flow without starting a broker or Chrome', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dialog-adapter-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const client = await adapter(stateDir);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['close_chrome', 'get_captured_dialog', 'get_dialog_status', 'launch_chrome', 'respond_to_dialog', 'start_dialog_capture']);
  assert.match(tools.find(tool => tool.name === 'respond_to_dialog').description, /Security requirement/);
  assert.equal(tools.find(tool => tool.name === 'respond_to_dialog').inputSchema.properties.prompt_text.type, 'string');
  for (const tool of tools) {
    assert.equal(tool.inputSchema.properties.browser_token.type, 'string');
    assert.equal(tool.inputSchema.required?.includes('browser_token') ?? false, tool.name !== 'launch_chrome');
  }
  const missingToken = await client.callTool({ name: 'get_dialog_status' });
  assert.equal(missingToken.isError, true);
  const token = 'a'.repeat(64);
  const result = await client.callTool({ name: 'get_dialog_status', arguments: { browser_token: token } });
  assert.deepEqual(result.structuredContent, { status: 'not_connected' });
  assert.deepEqual(await readdir(stateDir), []);
  const invalid = await client.callTool({ name: 'respond_to_dialog', arguments: { browser_token: token, dialog_id: 1, action: 'click' } });
  assert.equal(invalid.isError, true);
  const invalidToken = await client.callTool({ name: 'get_captured_dialog', arguments: { browser_token: token, capture_id: 'invalid' } });
  assert.equal(invalidToken.isError, true);
  const invalidText = await client.callTool({ name: 'respond_to_dialog', arguments: { browser_token: token, dialog_id: 1, action: 'accept', prompt_text: 7 } });
  assert.equal(invalidText.isError, true);
});

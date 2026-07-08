import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatMcpMessage,
  handleMcpRequest,
  parseMcpMessages,
} from '../src/mcp.js';

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'ace-mcp-'));
}

test('mcp lists ACE tools', async () => {
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });

  assert.strictEqual(response.result.tools.some((tool) => tool.name === 'ace_experience'), true);
  assert.strictEqual(response.result.tools.some((tool) => tool.name === 'ace_note'), true);
});

test('mcp initialize returns server instructions', async () => {
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
    },
  });

  assert.strictEqual(response.result.serverInfo.name, 'ai-change-evidence');
  assert.match(response.result.instructions, /ace_experience/);
  assert.match(response.result.instructions, /ace_run/);
});

test('mcp parses newline-delimited stdio messages', () => {
  const input = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  const parsed = parseMcpMessages(input);

  assert.strictEqual(parsed.messages.length, 1);
  assert.strictEqual(parsed.messages[0].transport, 'line');
  assert.strictEqual(JSON.parse(parsed.messages[0].body).method, 'tools/list');
  assert.strictEqual(parsed.rest.length, 0);
  assert.match(formatMcpMessage({ jsonrpc: '2.0', id: 1, result: {} }, 'line'), /\n$/);
});

test('mcp parses content-length stdio messages', () => {
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
  const input = Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`);
  const parsed = parseMcpMessages(input);

  assert.strictEqual(parsed.messages.length, 1);
  assert.strictEqual(parsed.messages[0].transport, 'header');
  assert.strictEqual(JSON.parse(parsed.messages[0].body).method, 'tools/list');
  assert.strictEqual(parsed.rest.length, 0);
  assert.match(formatMcpMessage({ jsonrpc: '2.0', id: 1, result: {} }, 'header'), /^Content-Length:/);
});

test('mcp parses LF-only content-length stdio messages', () => {
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
  const input = Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\n\n${body}`);
  const parsed = parseMcpMessages(input);

  assert.strictEqual(parsed.messages.length, 1);
  assert.strictEqual(parsed.messages[0].transport, 'header');
  assert.strictEqual(JSON.parse(parsed.messages[0].body).method, 'tools/list');
  assert.strictEqual(parsed.rest.length, 0);
});

test('mcp exposes the experience packet tool', async () => {
  const workdir = tempProject();
  await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'ace_start',
      arguments: {
        workdir,
        objective: 'Repair renderer build',
        reset: true,
      },
    },
  });
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'ace_experience',
      arguments: {
        workdir,
        noEvidence: true,
      },
    },
  });
  const packet = JSON.parse(response.result.content[0].text);

  assert.strictEqual(packet.schema, 'ace.experience-packet.v1');
  assert.strictEqual(packet.objective, 'Repair renderer build');
});

test('mcp marks failed ace_run results as tool errors with command details', async () => {
  const workdir = tempProject();
  const response = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'ace_run',
      arguments: {
        workdir,
        command: 'node -e "process.exit(9)"',
      },
    },
  });
  const result = JSON.parse(response.result.content[0].text);

  assert.strictEqual(response.result.isError, true);
  assert.strictEqual(result.status, 'failed-command');
  assert.strictEqual(result.entry.exitCode, 9);
});

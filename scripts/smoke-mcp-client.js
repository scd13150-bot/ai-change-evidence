#!/usr/bin/env node
import { spawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const repoRoot = resolve(process.cwd());
const tempRoot = mkdtempSync(join(tmpdir(), 'ace-mcp-client-smoke-'));
const targetDir = join(tempRoot, 'target-project');
const serverPath = join(repoRoot, 'src', 'mcp.js');

let nextId = 1;

async function main() {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'package.json'), JSON.stringify({
    type: 'module',
  }, null, 2));

  const client = new McpClient(process.execPath, [serverPath], {
    cwd: targetDir,
    env: process.env,
  });

  try {
    await client.start();

    const initialized = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'ace-local-stdio-smoke',
        version: '0.0.0',
      },
    });
    assertEqual(initialized.result.serverInfo.name, 'ai-change-evidence', 'server name');
    assertIncludes(initialized.result.instructions, 'ace_experience', 'server instructions');

    client.notify('notifications/initialized', {});

    const listed = await client.request('tools/list');
    const toolNames = listed.result.tools.map((tool) => tool.name);
    for (const expected of ['ace_experience', 'ace_start', 'ace_note', 'ace_run', 'ace_status', 'ace_brief']) {
      assertIncludes(toolNames, expected, 'MCP tools/list');
    }

    await callTool(client, 'ace_start', {
      workdir: targetDir,
      objective: 'Third-party MCP client smoke',
      reset: true,
    });
    await callTool(client, 'ace_note', {
      workdir: targetDir,
      text: 'Do not repeat shell fallback for MCP client smoke; stdio tools/call is the target.',
    });

    const failed = await callTool(client, 'ace_run', {
      workdir: targetDir,
      command: 'node -e "console.error(\'ghp_abcdefghijklmnopqrstuvwxyz123456\'); process.exit(9)"',
      timeoutSeconds: 10,
      maxOutputBytes: 2000,
    });
    assertEqual(failed.result.isError, true, 'failed ace_run isError');
    const failedPayload = parseToolJson(failed);
    assertEqual(failedPayload.status, 'failed-command', 'failed ace_run status');
    assertEqual(failedPayload.entry.exitCode, 9, 'failed ace_run exit');

    const experience = await callTool(client, 'ace_experience', {
      workdir: targetDir,
      noEvidence: true,
    });
    const packet = parseToolJson(experience);
    assertEqual(packet.schema, 'ace.experience-packet.v1', 'packet schema');
    assertIncludes(packet.doNotRepeat.join('\n'), 'stdio tools/call is the target', 'do-not-repeat note');
    assertEqual(packet.validation.state, 'failed', 'packet validation state after failing command');

    const unknown = await client.request('tools/call', {
      name: 'ace_unknown_tool',
      arguments: {},
    });
    if (!unknown.error || !String(unknown.error.message).includes('Unknown tool')) {
      throw new Error(`Unknown tool did not return a JSON-RPC error: ${JSON.stringify(unknown)}`);
    }

    const ledgerText = readFileSync(join(targetDir, '.ace', 'ledger.json'), 'utf-8');
    assertIncludes(ledgerText, '[REDACTED]', 'redacted ledger');
    if (ledgerText.includes('ghp_abcdefghijklmnopqrstuvwxyz123456')) {
      throw new Error('Raw fake GitHub token leaked into MCP-written ledger.');
    }

    console.log('MCP client smoke passed: initialize, tools/list, tools/call, failed-command, unknown-tool error, redaction.');
  } finally {
    await client.stop();
    cleanupTempRoot();
  }
}

async function callTool(client, name, args) {
  const response = await client.request('tools/call', {
    name,
    arguments: args,
  });
  if (response.error) {
    throw new Error(`Tool call failed for ${name}: ${response.error.message}`);
  }
  return response;
}

function parseToolJson(response) {
  const text = response.result?.content?.[0]?.text;
  if (!text) throw new Error(`Tool response did not include text content: ${JSON.stringify(response)}`);
  return JSON.parse(text);
}

class McpClient {
  constructor(command, args, options) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.child = null;
    this.stdout = Buffer.alloc(0);
    this.pending = new Map();
    this.stderr = '';
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf-8');
    });
    this.child.on('exit', (code, signal) => {
      const error = new Error(`MCP server exited unexpectedly: code=${code} signal=${signal} stderr=${this.stderr}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  notify(method, params = {}) {
    this.write({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  request(method, params = {}) {
    const id = nextId++;
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    };
    const response = new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}. stderr=${this.stderr}`));
      }, 10000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.write(message);
    return response;
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error('MCP server stdin is not writable.');
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`);
  }

  onStdout(chunk) {
    this.stdout = Buffer.concat([this.stdout, chunk]);
    while (true) {
      const parsed = readHeaderFrame(this.stdout);
      if (!parsed) break;
      this.stdout = parsed.rest;
      const message = JSON.parse(parsed.body);
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  async stop() {
    if (!this.child) return;
    for (const pending of this.pending.values()) pending.reject(new Error('MCP client stopped before response.'));
    this.pending.clear();
    this.child.stdin.end();
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      if (this.child.exitCode === null) this.child.kill('SIGKILL');
    }
  }
}

function readHeaderFrame(buffer) {
  let headerEnd = buffer.indexOf('\r\n\r\n');
  let separatorLength = 4;
  if (headerEnd === -1) {
    headerEnd = buffer.indexOf('\n\n');
    separatorLength = 2;
  }
  if (headerEnd === -1) return null;

  const header = buffer.subarray(0, headerEnd).toString('utf-8');
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) throw new Error(`Invalid MCP response header: ${header}`);
  const length = Number(match[1]);
  const bodyStart = headerEnd + separatorLength;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return null;
  return {
    body: buffer.subarray(bodyStart, bodyEnd).toString('utf-8'),
    rest: buffer.subarray(bodyEnd),
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(container, expected, label) {
  if (Array.isArray(container)) {
    if (!container.includes(expected)) throw new Error(`${label} did not include ${expected}`);
    return;
  }
  if (!String(container).includes(expected)) throw new Error(`${label} did not include ${expected}`);
}

function cleanupTempRoot() {
  if (process.env.ACE_KEEP_SMOKE_TEMP) {
    console.log(`Kept MCP smoke temp directory: ${tempRoot}`);
    return;
  }
  const resolved = resolve(tempRoot);
  const temp = resolve(tmpdir());
  if (!resolved.startsWith(temp) || !resolved.includes('ace-mcp-client-smoke-')) {
    throw new Error(`Refusing to remove unexpected temp directory: ${resolved}`);
  }
  if (existsSync(resolved)) removeTreeWithRetries(resolved);
}

function removeTreeWithRetries(path) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isTransientRemoveError(error) || attempt === 7) throw error;
      sleepSync(50 * (attempt + 1));
    }
  }
}

function isTransientRemoveError(error) {
  return ['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

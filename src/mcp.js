#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';
import {
  collectEvidence,
} from './evidence.js';
import {
  appendNote,
  buildExperiencePacket,
  buildHandoffBrief,
  formatStatus,
  readLedger,
  recordCommand,
  resolveProjectDir,
  startLedger,
} from './ledger.js';

const SERVER_INFO = {
  name: 'ai-change-evidence',
  version: '0.1.0',
};

const SERVER_INSTRUCTIONS = [
  'Use ACE to transfer engineering experience between AI coding sessions.',
  'Before editing, call ace_experience and inspect objective, failed commands, do-not-repeat notes, validation state, and missing evidence.',
  'Record abandoned or disproven approaches with ace_note.',
  'Run important validation through ace_run only when command execution is appropriate for the trusted project.',
  'Before handoff, call ace_brief or ace_experience for the next agent.',
].join(' ');

const TOOLS = [
  {
    name: 'ace_experience',
    description: 'Return the current ACE engineering experience packet for an AI coding task.',
    inputSchema: objectSchema({
      workdir: stringProp('Project directory. Defaults to the server process cwd.'),
      noEvidence: booleanProp('Skip git/evidence collection and return ledger-only experience.'),
      semantic: booleanProp('Include bounded semantic evidence when collecting current project evidence.'),
    }),
  },
  {
    name: 'ace_start',
    description: 'Start or replace the current ACE objective.',
    inputSchema: objectSchema({
      workdir: stringProp('Project directory. Defaults to the server process cwd.'),
      objective: requiredStringProp('Current AI coding task objective.'),
      reset: booleanProp('Reset the existing ledger before writing this objective.'),
    }, ['objective']),
  },
  {
    name: 'ace_note',
    description: 'Record an engineering note, especially a do-not-repeat warning.',
    inputSchema: objectSchema({
      workdir: stringProp('Project directory. Defaults to the server process cwd.'),
      text: requiredStringProp('Note text to add to the ACE ledger.'),
    }, ['text']),
  },
  {
    name: 'ace_run',
    description: 'Run a local validation command through ACE so output and failure signatures are recorded. This executes with the MCP server process permissions in the configured workdir.',
    inputSchema: objectSchema({
      workdir: stringProp('Project directory. Defaults to the server process cwd.'),
      command: requiredStringProp('Command to run.'),
      timeoutSeconds: numberProp('Optional timeout in seconds.'),
      maxOutputBytes: numberProp('Optional max stdout/stderr bytes per stream.'),
    }, ['command']),
  },
  {
    name: 'ace_status',
    description: 'Return a human-readable ACE ledger status.',
    inputSchema: objectSchema({
      workdir: stringProp('Project directory. Defaults to the server process cwd.'),
    }),
  },
  {
    name: 'ace_brief',
    description: 'Build a human-readable ACE handoff brief.',
    inputSchema: objectSchema({
      workdir: stringProp('Project directory. Defaults to the server process cwd.'),
      noEvidence: booleanProp('Skip git/evidence collection.'),
      semantic: booleanProp('Include bounded semantic evidence when collecting current project evidence.'),
      compact: stringProp('Prompt budget label such as 8k.'),
    }),
  },
];

export async function handleMcpRequest(message) {
  if (!message || typeof message !== 'object') {
    return errorResponse(null, -32600, 'Invalid Request');
  }

  const { id, method, params = {} } = message;
  try {
    if (method === 'initialize') {
      return resultResponse(id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') {
      return resultResponse(id, { tools: TOOLS });
    }
    if (method === 'tools/call') {
      return resultResponse(id, await callTool(params));
    }
    if (method === 'ping') return resultResponse(id, {});
    return errorResponse(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    return errorResponse(id, -32000, error.message);
  }
}

async function callTool(params) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (!TOOLS.some((tool) => tool.name === name)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  if (name === 'ace_experience') {
    const projectDir = resolveProjectDir(args.workdir);
    const ledger = readLedger(projectDir);
    let evidencePack = null;
    let evidenceError = null;
    if (!args.noEvidence) {
      try {
        evidencePack = await collectEvidence({
          workdir: projectDir,
          noWrite: true,
          run: [],
          semantic: Boolean(args.semantic),
        });
      } catch (error) {
        evidenceError = error.message;
      }
    }
    return jsonToolResult(buildExperiencePacket({ ledger, evidencePack, evidenceError }));
  }

  if (name === 'ace_start') {
    const result = startLedger({
      workdir: args.workdir,
      objective: args.objective,
      reset: Boolean(args.reset),
    });
    return jsonToolResult({
      objective: result.ledger.objective,
      ledgerPath: result.path,
    });
  }

  if (name === 'ace_note') {
    const result = appendNote({
      workdir: args.workdir,
      text: args.text,
    });
    return jsonToolResult({
      entry: result.entry,
      ledgerPath: result.path,
    });
  }

  if (name === 'ace_run') {
    const result = await recordCommand({
      workdir: args.workdir,
      command: args.command,
      timeoutMs: args.timeoutSeconds ? Number(args.timeoutSeconds) * 1000 : undefined,
      maxOutputBytes: args.maxOutputBytes ? Number(args.maxOutputBytes) : undefined,
    });
    return jsonToolResult({
      status: result.entry.exitCode === 0 ? 'passed' : 'failed-command',
      entry: {
        id: result.entry.id,
        command: result.entry.command,
        exitCode: result.entry.exitCode,
        durationMs: result.entry.durationMs,
        failureSignature: result.entry.failureSignature,
      },
      ledgerPath: result.path,
    }, { isError: result.entry.exitCode !== 0 });
  }

  if (name === 'ace_status') {
    const projectDir = resolveProjectDir(args.workdir);
    return textToolResult(formatStatus(readLedger(projectDir)));
  }

  if (name === 'ace_brief') {
    const projectDir = resolveProjectDir(args.workdir);
    const ledger = readLedger(projectDir);
    let evidencePack = null;
    let evidenceError = null;
    if (!args.noEvidence) {
      try {
        evidencePack = await collectEvidence({
          workdir: projectDir,
          noWrite: true,
          run: [],
          semantic: Boolean(args.semantic),
        });
      } catch (error) {
        evidenceError = error.message;
      }
    }
    return textToolResult(buildHandoffBrief({
      ledger,
      evidencePack,
      evidenceError,
      compactBudget: args.compact || null,
    }));
  }

  throw new Error(`Unhandled tool: ${name}`);
}

function jsonToolResult(value, options = {}) {
  return {
    ...(options.isError ? { isError: true } : {}),
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function textToolResult(text) {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

function resultResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function errorResponse(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

function objectSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function stringProp(description) {
  return { type: 'string', description };
}

function requiredStringProp(description) {
  return stringProp(description);
}

function booleanProp(description) {
  return { type: 'boolean', description };
}

function numberProp(description) {
  return { type: 'number', description };
}

function startServer() {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', async (chunk) => {
    debugLog('stdin.chunk', {
      bytes: chunk.length,
      utf8: chunk.toString('utf-8'),
      hex: chunk.toString('hex'),
    });
    buffer = Buffer.concat([buffer, chunk]);
    const parsed = parseMcpMessages(buffer);
    debugLog('stdin.parsed', {
      messages: parsed.messages.map((message) => ({
        transport: message.transport,
        body: message.body,
      })),
      restBytes: parsed.rest.length,
      restUtf8: parsed.rest.toString('utf-8'),
    });
    buffer = parsed.rest;
    for (const messageFrame of parsed.messages) {
      let message = null;
      try {
        message = JSON.parse(messageFrame.body);
      } catch (error) {
        writeMessage(errorResponse(null, -32700, `Parse error: ${error.message}`), messageFrame.transport);
        continue;
      }
      const response = await handleMcpRequest(message);
      if (response) writeMessage(response, messageFrame.transport);
    }
  });
}

export function parseMcpMessages(buffer) {
  const messages = [];
  let rest = buffer;
  while (true) {
    rest = trimLeadingLineBreaks(rest);
    if (rest.length === 0) break;

    const prefix = rest.subarray(0, Math.min(rest.length, 32)).toString('utf-8');
    if (/^Content-Length:/i.test(prefix)) {
      const parsed = parseHeaderFrame(rest);
      if (!parsed) break;
      messages.push({ body: parsed.body, transport: 'header' });
      rest = parsed.rest;
      continue;
    }

    const newline = rest.indexOf('\n');
    if (newline === -1) break;
    const line = rest.subarray(0, newline).toString('utf-8').trim();
    rest = rest.subarray(newline + 1);
    if (line) messages.push({ body: line, transport: 'line' });
  }
  return { messages, rest };
}

function parseHeaderFrame(buffer) {
  let headerEnd = buffer.indexOf('\r\n\r\n');
  let separatorLength = 4;
  if (headerEnd === -1) {
    headerEnd = buffer.indexOf('\n\n');
    separatorLength = 2;
  }
  if (headerEnd === -1) return null;
  const header = buffer.subarray(0, headerEnd).toString('utf-8');
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;
  const length = Number(match[1]);
  const bodyStart = headerEnd + separatorLength;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return null;
  return {
    body: buffer.subarray(bodyStart, bodyEnd).toString('utf-8'),
    rest: buffer.subarray(bodyEnd),
  };
}

function trimLeadingLineBreaks(buffer) {
  let index = 0;
  while (index < buffer.length && (buffer[index] === 10 || buffer[index] === 13)) {
    index += 1;
  }
  return index === 0 ? buffer : buffer.subarray(index);
}

export function formatMcpMessage(message, transport = 'line') {
  const body = JSON.stringify(message);
  if (transport === 'header') {
    return `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`;
  }
  return `${body}\n`;
}

function writeMessage(message, transport) {
  const formatted = formatMcpMessage(message, transport);
  debugLog('stdout.message', {
    transport,
    body: JSON.stringify(message),
    formatted,
  });
  process.stdout.write(formatted);
}

function debugLog(event, data = {}) {
  const logPath = process.env.ACE_MCP_DEBUG_LOG;
  if (!logPath) return;
  try {
    const resolved = resolve(logPath);
    mkdirSync(dirname(resolved), { recursive: true });
    appendFileSync(resolved, `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data,
    })}\n`, 'utf-8');
  } catch {
    // Debug logging must never affect the MCP transport.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

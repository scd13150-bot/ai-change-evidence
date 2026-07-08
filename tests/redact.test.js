import { test } from 'node:test';
import assert from 'node:assert';
import {
  redactObject,
  redactText,
} from '../src/redact.js';

test('redacts common secret-shaped strings', () => {
  const text = [
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
    'https://user:pass@example.com/private.git',
    'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456',
    'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP',
    [
      '-----BEGIN PRIVATE KEY-----',
      'sensitive-private-key-material',
      '-----END PRIVATE KEY-----',
    ].join('\n'),
  ].join('\n');
  const redacted = redactText(text);

  assert.match(redacted, /\[REDACTED\]/);
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(redacted, /user:pass/);
  assert.doesNotMatch(redacted, /AKIAABCDEFGHIJKLMNOP/);
  assert.doesNotMatch(redacted, /sensitive-private-key-material/);
});

test('redacts nested objects without mutating the original', () => {
  const original = {
    command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"',
    output: {
      stderr: 'TOKEN=secret-value',
    },
  };
  const redacted = redactObject(original);

  assert.notStrictEqual(redacted, original);
  assert.match(redacted.command, /\[REDACTED\]/);
  assert.match(redacted.output.stderr, /\[REDACTED\]/);
  assert.match(original.command, /abcdefghijklmnopqrstuvwxyz123456/);
});

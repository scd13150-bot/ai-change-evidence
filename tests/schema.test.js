import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import {
  buildExperiencePacket,
  readLedger,
  startLedger,
} from '../src/ledger.js';

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'ace-schema-'));
}

function validateSchema(value, schema) {
  return validateNode(value, schema, schema, '$');
}

function validateNode(value, schema, root, path) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.$ref) {
    return validateNode(value, resolveRef(schema.$ref, root), root, path);
  }

  if (schema.anyOf) {
    const results = schema.anyOf.map((item) => validateNode(value, item, root, path));
    if (results.some((item) => item.length === 0)) return [];
    return [`${path} should match one anyOf branch`];
  }

  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    errors.push(`${path} should equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} should be one of ${schema.enum.join(', ')}`);
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} should be ${schema.type}`);
    return errors;
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path} should be >= ${schema.minimum}`);
  }

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of schema.required || []) {
      if (!Object.hasOwn(value, field)) errors.push(`${path}.${field} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties || {}, field)) {
          errors.push(`${path}.${field} is not allowed`);
        }
      }
    }
    for (const [field, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, field)) {
        errors.push(...validateNode(value[field], childSchema, root, `${path}.${field}`));
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateNode(item, schema.items, root, `${path}[${index}]`));
    });
  }

  return errors;
}

function resolveRef(ref, root) {
  assert.ok(ref.startsWith('#/'), `unsupported ref: ${ref}`);
  return ref.slice(2).split('/').reduce((node, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return node[key];
  }, root);
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

test('experience packet schema artifact covers generated packet top-level fields', () => {
  const schema = JSON.parse(readFileSync('schemas/experience-packet.schema.json', 'utf-8'));
  const workdir = tempProject();
  startLedger({ workdir, objective: 'Check schema', reset: true });
  const packet = buildExperiencePacket({
    ledger: readLedger(workdir),
    evidenceError: 'not a git repository',
  });

  assert.strictEqual(schema.properties.schema.const, 'ace.experience-packet.v1');
  assert.strictEqual(schema.properties.role.const, 'engineering-experience-handoff');
  for (const field of schema.required) {
    assert.ok(Object.hasOwn(packet, field), `generated packet should include ${field}`);
  }
  assert.ok(schema.properties.experienceSummary.properties.status.enum.includes(packet.experienceSummary.status));
  assert.ok(schema.properties.validation.properties.state.enum.includes(packet.validation.state));
  assert.deepStrictEqual(validateSchema(packet, schema), []);
});

test('published failure handoff example matches the experience packet schema', () => {
  const schema = JSON.parse(readFileSync('schemas/experience-packet.schema.json', 'utf-8'));
  const example = JSON.parse(readFileSync('examples/failure-handoff/experience.json', 'utf-8'));

  assert.deepStrictEqual(validateSchema(example, schema), []);
});

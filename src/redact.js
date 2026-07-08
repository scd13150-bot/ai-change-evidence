const REDACTION = '[REDACTED]';

const SECRET_PATTERNS = [
  {
    name: 'authorization-bearer',
    pattern: /\b(authorization\s*[:=]\s*bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (_match, prefix) => `${prefix}${REDACTION}`,
  },
  {
    name: 'basic-auth-url',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (_match, scheme) => `${scheme}${REDACTION}:${REDACTION}@`,
  },
  {
    name: 'openai-style-key',
    pattern: /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
    replace: REDACTION,
  },
  {
    name: 'github-token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
    replace: REDACTION,
  },
  {
    name: 'aws-access-key',
    pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: REDACTION,
  },
  {
    name: 'secret-assignment',
    pattern: /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*\s*[:=]\s*)(["']?)([^\s"',;]+)/gi,
    replace: (_match, prefix, quote) => `${prefix}${quote}${REDACTION}`,
  },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: `-----BEGIN PRIVATE KEY-----\n${REDACTION}\n-----END PRIVATE KEY-----`,
  },
];

export function redactText(value) {
  let text = String(value || '');
  for (const item of SECRET_PATTERNS) {
    text = text.replace(item.pattern, item.replace);
  }
  return text;
}

export function redactObject(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (!value || typeof value !== 'object') return value;

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = redactObject(item);
  }
  return result;
}

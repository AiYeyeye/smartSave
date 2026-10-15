import { DEBUG_BODY_CHAR_LIMIT, traceModel, type DebugDetail, type DebugLog } from '../domain/debug-log';

const SECRET_FIELD =
  /^(?:authorization|proxy-authorization|x-api-key|api[-_]?key|key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|client[-_]?secret|secret|password|encrypted_content)$/i;
const SECRET_JSON_VALUE =
  /("(?:authorization|proxy-authorization|x-api-key|api[-_]?key|key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|client[-_]?secret|secret|password|encrypted_content)"\s*:\s*)"(?:\\.|[^"\\])*"/gi;

/** Redact before truncating, including credentials echoed inside text or malformed JSON/SSE. */
export function redactModelDiagnosticText(text: string, credential: string): string {
  let safe = text;
  if (credential) {
    for (const spelling of new Set([
      credential,
      JSON.stringify(credential).slice(1, -1),
      encodeURIComponent(credential),
    ]))
      safe = safe.split(spelling).join('[redacted]');
  }
  return safe
    .replace(SECRET_JSON_VALUE, '$1"[redacted]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]');
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([field, child]) => [field, SECRET_FIELD.test(field) ? '[redacted]' : redactJson(child)]),
  );
}

/** Capture JSON values (with credential fields redacted), or raw text for malformed JSON/SSE. */
export function modelBodyDiagnostics(body: string, credential: string): DebugDetail {
  let safe = body;
  let format = 'text';
  try {
    safe = JSON.stringify(redactJson(JSON.parse(body)));
    format = 'json';
  } catch {
    /* Malformed JSON and SSE must still be visible for diagnosis. */
  }
  safe = redactModelDiagnosticText(safe, credential);
  return {
    format,
    bodyChars: body.length,
    capturedChars: Math.min(safe.length, DEBUG_BODY_CHAR_LIMIT),
    truncated: safe.length > DEBUG_BODY_CHAR_LIMIT,
    body: safe.slice(0, DEBUG_BODY_CHAR_LIMIT),
  };
}

/** Every stage carries the same invocation/attempt identity; body factories run only when enabled. */
export function modelDiagnosticLog(context: DebugDetail, credential: string): DebugLog {
  return (event, detail) =>
    traceModel(event, () => {
      const resolved = typeof detail === 'function' ? detail() : detail;
      return Object.fromEntries(
        Object.entries({ ...context, ...resolved }).map(([field, value]) => [
          field,
          typeof value === 'string' ? redactModelDiagnosticText(value, credential) : value,
        ]),
      );
    });
}

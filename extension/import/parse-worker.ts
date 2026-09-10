import { ImportParseError, type ParseRequest, type ParseResponse } from './contracts';
import { parseImport } from './parsers';
export type { ParseRequest, ParseResponse } from './contracts';
export function handleParseRequest(request: ParseRequest): ParseResponse {
  try { return { ok: true, result: parseImport(new Uint8Array(request.bytes), request.format) }; }
  catch (error) { return { ok: false, code: error instanceof ImportParseError ? error.code : 'malformed', message: error instanceof Error ? error.message : 'Parser failed' }; }
}
self.onmessage = (event: MessageEvent<ParseRequest>) => self.postMessage(handleParseRequest(event.data));

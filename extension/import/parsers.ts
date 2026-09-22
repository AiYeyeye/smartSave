import { importURLDiagnostic } from '../domain/import-url';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseTree, getNodePath, findNodeAtLocation, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { decodeImportBytes } from './encoding';

import {
  IMPORT_RESOURCE_BUDGET,
  ImportParseError,
  type ImportFormat,
  type ImportResult,
  type SourceSpan,
} from './contracts';
export { IMPORT_RESOURCE_BUDGET, ImportParseError } from './contracts';
export type { ImportFormat, SourceSpan, ImportItem, SourceCandidate, ImportResult } from './contracts';
export { resolveSourceCandidates } from './source-candidates';

const span = (start: number, end: number): SourceSpan => ({ start, end });
const fail = (message: string): never => {
  throw new ImportParseError('malformed', message);
};
function checkDepth(depth: number) {
  if (depth > IMPORT_RESOURCE_BUDGET.depth)
    throw new ImportParseError('resource', 'Structural depth exceeds tested parser budget');
}
function jsonTree(text: string): JsonNode {
  // Bound recursive library work before entering it; brackets inside strings are not nesting.
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') checkDepth(++depth);
    else if (char === ']' || char === '}') depth--;
  }
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (!root || errors.length) return fail('Invalid strict JSON');
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'object') {
      const keys = node.children?.map(p => p.children?.[0]?.value);
      if (keys && new Set(keys).size !== keys.length)
        fail('Duplicate JSON property cannot have unambiguous provenance');
    }
    stack.push(...(node.children ?? []));
  }
  return root;
}
export function parseImport(bytes: Uint8Array, format: ImportFormat): ImportResult {
  if (bytes.byteLength > IMPORT_RESOURCE_BUDGET.bytes)
    throw new ImportParseError('resource', 'File exceeds tested parser byte budget');
  let decoded: ReturnType<typeof decodeImportBytes>;
  try {
    decoded = decodeImportBytes(bytes);
  } catch {
    throw new ImportParseError('encoding', 'Unsupported or malformed encoding');
  }
  const { text } = decoded;
  const result: ImportResult = { ...decoded, items: [], candidates: [] };
  const add = (
    rawURL: string,
    title: string,
    oldPath: string[],
    sourceSpan: SourceSpan,
    urlSpan = sourceSpan,
    sourcePath?: (string | number)[],
  ) => {
    const diagnostic = importURLDiagnostic(rawURL);
    result.items.push({
      sourceOrdinal: result.items.length,
      sourceSpan,
      rawURL,
      title,
      oldPath,
      provenance: { format, urlSpan, ...(sourcePath ? { sourcePath } : {}) },
      ...(diagnostic ? { diagnostic } : {}),
    });
  };
  const bare = (value: string, offset: number) => {
    for (const match of value.matchAll(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>"`]+/g)) {
      const start = offset + match.index;
      add(match[0], '', [], span(start, start + match[0].length));
    }
  };
  try {
    if (format === 'txt') bare(text, 0);
    else if (format === 'json') {
      const root = jsonTree(text);
      const field = (n: JsonNode, key: string) => findNodeAtLocation(n, [key]);
      const formatNode = field(root, 'format');
      if (formatNode?.value === 'markora.bookmarks' && field(root, 'schemaVersion')?.value !== 1)
        fail('Unsupported export schemaVersion');
      const stack: { node: JsonNode; path: string[] }[] = [{ node: root, path: [] }];
      while (stack.length) {
        const { node, path } = stack.pop()!;
        if (node.type === 'string' && node.parent?.type !== 'property')
          result.candidates.push({
            sourcePath: getNodePath(node),
            value: node.value,
            sourceSpan: span(node.offset, node.offset + node.length),
          });
        if (node.type === 'object') {
          const url = field(node, 'url');
          const title = field(node, 'title');
          if (url) {
            if (url.type !== 'string') fail('URL field must be a string');
            add(
              url.value,
              title?.type === 'string' ? title.value : '',
              path,
              span(node.offset, node.offset + node.length),
              span(url.offset, url.offset + url.length),
              getNodePath(url),
            );
          }
          const nextPath = field(node, 'children') && title?.type === 'string' ? [...path, title.value] : path;
          for (const property of [...(node.children ?? [])].reverse()) {
            const value = property.children?.[1];
            if (!value) continue;
            if (value.type === 'string')
              result.candidates.push({
                sourcePath: getNodePath(value),
                value: value.value,
                sourceSpan: span(value.offset, value.offset + value.length),
              });
            else stack.push({ node: value, path: nextPath });
          }
        } else if (node.type === 'array')
          for (const child of [...(node.children ?? [])].reverse()) stack.push({ node: child, path });
      }
    } else if (format === 'csv') {
      const rows = csvRows(text);
      const header = rows.shift();
      if (!header) return result;
      const names = header.map(cell => cell.value.toLowerCase());
      const urlColumn = names.indexOf('url');
      const titleColumn = names.indexOf('title');
      const pathColumn = names.indexOf('path');
      for (const [rowIndex, row] of rows.entries()) {
        if (row.length !== header.length) fail('CSV row width differs from header');
        row.forEach((cell, column) =>
          result.candidates.push({
            sourcePath: [rowIndex + 1, column],
            value: cell.value,
            sourceSpan: cell.sourceSpan,
          }),
        );
        if (urlColumn >= 0) {
          const url = row[urlColumn]!;
          add(
            url.value,
            row[titleColumn]?.value ?? '',
            row[pathColumn]?.value ? [row[pathColumn]!.value] : [],
            span(row[0]!.sourceSpan.start, row.at(-1)!.sourceSpan.end),
            url.sourceSpan,
            [rowIndex + 1, urlColumn],
          );
        }
      }
    } else if (format === 'html') {
      type HNode = DefaultTreeAdapterMap['node'];
      const root = parse(text, { sourceCodeLocationInfo: true });
      const content = (node: HNode): string => {
        const queue = [node];
        let value = '';
        while (queue.length) {
          const n = queue.pop()!;
          if ('value' in n) value += n.value;
          if ('childNodes' in n) queue.push(...[...n.childNodes].reverse());
        }
        return value;
      };
      const stack: { node: HNode; path: string[]; depth: number }[] = [{ node: root, path: [], depth: 0 }];
      while (stack.length) {
        const { node, path, depth } = stack.pop()!;
        checkDepth(depth);
        if ('tagName' in node && ['script', 'style', 'template'].includes(node.tagName)) continue;
        if ('tagName' in node && node.tagName === 'a') {
          const href = node.attrs.find(a => a.name === 'href');
          const loc = node.sourceCodeLocation;
          const attr = loc?.attrs?.href;
          if (href && loc && attr)
            add(
              href.value,
              content(node),
              path,
              span(loc.startOffset, loc.endOffset),
              span(attr.startOffset, attr.endOffset),
            );
        }
        if ('childNodes' in node) {
          let folder = '';
          const pending: typeof stack = [];
          for (const child of node.childNodes) {
            if ('tagName' in child && child.tagName === 'dt' && 'childNodes' in child) {
              const heading = child.childNodes.find(n => 'tagName' in n && n.tagName === 'h3');
              if (heading) folder = content(heading);
            }
            if ('tagName' in child && child.tagName === 'h3') folder = content(child);
            pending.push({
              node: child,
              path: 'tagName' in child && child.tagName === 'dl' && folder ? [...path, folder] : path,
              depth: depth + 1,
            });
          }
          stack.push(...pending.reverse());
        }
      }
    } else if (format === 'markdown') {
      const root = fromMarkdown(text);
      type MNode = typeof root | (typeof root.children)[number];
      const nodes: { node: MNode; depth: number }[] = [{ node: root, depth: 0 }];
      const all: MNode[] = [];
      while (nodes.length) {
        const { node, depth } = nodes.pop()!;
        checkDepth(depth);
        all.push(node);
        if ('children' in node)
          for (const child of [...node.children].reverse()) nodes.push({ node: child as MNode, depth: depth + 1 });
      }
      const definitions = new Map<string, Extract<MNode, { type: 'definition' }>>();
      for (const node of all)
        if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
      const label = (node: MNode): string =>
        'value' in node
          ? String(node.value)
          : 'children' in node
            ? node.children.map(n => label(n as MNode)).join('')
            : '';
      const visit = (node: MNode) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        if (
          node.type === 'code' ||
          node.type === 'inlineCode' ||
          node.type === 'html' ||
          node.type === 'definition' ||
          node.type === 'image' ||
          node.type === 'imageReference'
        )
          return;
        if (node.type === 'link') {
          add(node.url, label(node), [], span(start, end));
          return;
        }
        if (node.type === 'linkReference') {
          const definition = definitions.get(node.identifier);
          if (definition)
            add(
              definition.url,
              label(node),
              [],
              span(start, end),
              span(definition.position!.start.offset!, definition.position!.end.offset!),
            );
          return;
        }
        if (node.type === 'text') {
          bare(text.slice(start, end), start);
          return;
        }
        if ('children' in node) node.children.forEach(n => visit(n as MNode));
      };
      visit(root);
    } else throw new ImportParseError('unsupported-format', 'Unsupported file format');
  } catch (error) {
    if (error instanceof ImportParseError) throw error;
    if (error instanceof RangeError) throw new ImportParseError('resource', 'Parser exhausted structural resources');
    throw new ImportParseError('malformed', 'Unable to reliably parse input');
  }
  return result;
}

interface CsvCell {
  value: string;
  sourceSpan: SourceSpan;
}
/** RFC4180 scanner: quoted commas/newlines/doubled quotes; CRLF record separators. */
function csvRows(text: string): CsvCell[][] {
  if (!text) return [];
  const rows: CsvCell[][] = [];
  let row: CsvCell[] = [];
  let i = 0;
  while (i <= text.length) {
    const start = i;
    let value = '';
    if (text[i] === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else value += text[i++];
      }
      if (!closed) fail('Unclosed CSV quote');
    } else {
      while (i < text.length && ![',', '\r', '\n'].includes(text[i]!)) {
        if (text[i] === '"') fail('Quote in unquoted CSV field');
        value += text[i++];
      }
    }
    row.push({ value, sourceSpan: span(start, i) });
    if (i === text.length) {
      rows.push(row);
      break;
    }
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text.slice(i, i + 2) !== '\r\n') fail('Expected RFC4180 comma or CRLF');
    rows.push(row);
    row = [];
    i += 2;
    if (i === text.length) break;
  }
  return rows;
}

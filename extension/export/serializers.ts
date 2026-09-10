import { assertExportProjection, boundExportText, type ExportNode, type ExportProjection } from '../domain/export-projection';
import { isExportLinkClickable } from './link-policy';

const html = (text: string): string => text.replace(/[&<>"'\r\n]/g, char => `&#${char.charCodeAt(0)};`);
// Encode ASCII syntax, including line breaks, so a title cannot create Markdown/HTML nodes.
const markdown = (text: string): string => [...text].map(char => char.charCodeAt(0) <= 127 ? `&#${char.charCodeAt(0)};` : char).join('');
export function serializeExportJSON(projection: ExportProjection): string {
  assertExportProjection(projection);
  return `${JSON.stringify(projection.document, null, 2)}\n`;
}
export function serializeExportHTML(projection: ExportProjection): string {
  assertExportProjection(projection);
  const node = (value: ExportNode): string => {
    if (value.type === 'folder') return `<DT><H3>${html(value.title)}</H3>\n<DL><p>\n${value.children.map(node).join('')}</DL><p>\n`;
    if (!isExportLinkClickable(value.url)) return `<DT><SPAN>${html(value.title)}</SPAN> <CODE>${html(value.url)}</CODE>\n`;
    return `<DT><A HREF="${html(value.url)}">${html(value.title)}</A>\n`;
  };
  return boundExportText('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<META HTTP-EQUIV="Content-Security-Policy" CONTENT="default-src \'none\'; base-uri \'none\'; form-action \'none\'">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' + projection.document.roots.map(node).join('') + '</DL><p>\n');
}
export function serializeExportMarkdown(projection: ExportProjection): string {
  assertExportProjection(projection);
  const node = (value: ExportNode, depth: number): string => {
    const prefix = `${'  '.repeat(depth)}- `;
    if (value.type === 'folder') return `${prefix}${markdown(value.title)}\n${value.children.map(child => node(child, depth + 1)).join('')}`;
    if (!isExportLinkClickable(value.url)) return `${prefix}${markdown(value.title)} <code>${markdown(value.url)}</code>\n`;
    return `${prefix}[${markdown(value.title)}](<${markdown(value.url)}>)\n`;
  };
  return boundExportText(projection.document.roots.map(root => node(root, 0)).join(''));
}

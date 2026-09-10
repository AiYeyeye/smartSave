import { pinyin } from 'pinyin-pro';
import type { TreeSnapshot } from './node-reference';
export interface SearchHit { id: string; title: string; url: string; path: string }
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
const compact = (text: string) => text.replace(/\s+/g, '');
// Bounded Levenshtein: fuzzy work never scales quadratically with arbitrary input length.
function nearPrefix(a: string, b: string, limit: number): boolean {
  if (b.length < a.length - limit) return false;
  const size = Math.min(b.length, a.length + limit);
  let previous = Array.from({ length: size + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(size + 1).fill(limit + 1); row[0] = i;
    let minimum = limit + 1;
    for (let j = Math.max(1, i - limit); j <= Math.min(size, i + limit); j++) {
      row[j] = Math.min(row[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      minimum = Math.min(minimum, row[j]!);
    }
    if (minimum > limit) return false;
    previous = row;
  }
  return previous.slice(Math.max(0, a.length - limit)).some(distance => distance <= limit);
}
export class SearchIndex {
  private readonly entries: { hit: SearchHit; title: string; fields: string[]; phonetic: string[]; words: string[] }[];
  constructor(tree: TreeSnapshot) {
    const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
    const phonetics = new Map<string, string[]>();
    const transliterate = (text: string) => {
      let value = phonetics.get(text);
      if (!value) { value = [compact(pinyin(text, { toneType: 'none' })), compact(pinyin(text, { pattern: 'first', toneType: 'none' }))].map(normalize); phonetics.set(text, value); }
      return value;
    };
    this.entries = tree.nodes.filter(node => node.ref.kind === 'bookmark' && node.url !== undefined).map(node => {
      const path: string[] = []; const seen = new Set([node.ref.nativeId]); let parent = node.parentId;
      while (parent !== undefined) {
        if (seen.has(parent)) throw Error('invalid-tree'); seen.add(parent);
        const folder = nodes.get(parent); if (!folder) throw Error('invalid-tree');
        path.unshift(folder.title); parent = folder.parentId;
      }
      let host = ''; let pathname = '';
      try { const url = new URL(node.url!); host = url.hostname; pathname = decodeURI(url.pathname); } catch { /* Historical unsupported URLs remain searchable, not openable. */ }
      const title = normalize(node.title);
      const fields = [node.url!, host, pathname, path.join(' / ')].map(normalize);
      const phonetic = [node.title, ...path].flatMap(transliterate);
      const words = [...new Set([title, ...fields, ...phonetic].flatMap(field => [field, ...field.split(/[^\p{L}\p{N}]+/u)]).filter(Boolean))];
      return { hit: { id: node.ref.nativeId, title: node.title, url: node.url!, path: path.join(' / ') }, title, fields, phonetic, words };
    });
  }
  query(query: string): SearchHit[] {
    const tokens = normalize(query).trim().split(/\s+/).filter(Boolean); if (!tokens.length) return [];
    const fuzzy = new Map<string, boolean>();
    return this.entries.flatMap((entry, order) => {
      let score = 0;
      for (const token of tokens) {
        if (entry.title === token) continue;
        if (entry.title.includes(token)) { score += 1; continue; }
        if (entry.fields.some(field => field.includes(token))) { score += 2; continue; }
        if (entry.phonetic.some(field => field.includes(token))) { score += 3; continue; }
        if (token.length >= 3 && token.length <= 64 && entry.words.some(word => {
          const limit = token.length < 6 ? 1 : 2;
          const prefix = word.slice(0, token.length + limit);
          const key = `${token}\u0000${prefix}`;
          const cached = fuzzy.get(key); if (cached !== undefined) return cached;
          const matched = nearPrefix(token, prefix, limit);
          fuzzy.set(key, matched); return matched;
        })) { score += 4; continue; }
        return [];
      }
      return [{ hit: entry.hit, score, order }];
    }).sort((a, b) => a.score - b.score || a.order - b.order).map(entry => entry.hit);
  }
}

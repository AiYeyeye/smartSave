import type { TreeSnapshot } from './node-reference';
import type { SearchHit } from './search-index';

export interface LocalSearchRule {
  kind: 'site' | 'folder';
  value: string;
  matches(hit: SearchHit): boolean;
}
const SITES: Record<string, string> = {
  知乎: 'zhihu.com',
  zhihu: 'zhihu.com',
  github: 'github.com',
  掘金: 'juejin.cn',
  哔哩哔哩: 'bilibili.com',
  bilibili: 'bilibili.com',
};
function domain(value: string): string | undefined {
  const text = value.toLowerCase();
  if (Object.hasOwn(SITES, text)) return SITES[text];
  if (text.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text)) return text;
}
/** Whole-query shortcuts only. Any extra topic, negation or ambiguity falls back to the full semantic scan. */
export function localSearchRule(query: string, tree: TreeSnapshot): LocalSearchRule | undefined {
  const text = query
    .normalize('NFKC')
    .trim()
    .replace(/[。！？!?]$/, '')
    .trim();
  const folder =
    /^(?:folder|文件夹)\s*:\s*(?:"([^"]+)"|(.+))$/i.exec(text)?.slice(1).find(Boolean) ??
    /^(?:查找|搜索|列出|显示)?(?:文件夹[“"]([^”"]+)[”"]|[“"]([^”"]+)[”"]文件夹)(?:中|里|内|下面)?(?:的)?(?:所有|全部)?书签$/
      .exec(text)
      ?.slice(1)
      .find(Boolean);
  if (folder) {
    const found = tree.nodes.filter(node => node.ref.kind === 'folder' && node.title === folder);
    if (found.length !== 1) return;
    const root = found[0]!.ref.nativeId;
    const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
    return {
      kind: 'folder',
      value: folder,
      matches(hit) {
        const seen = new Set<string>();
        let parent = nodes.get(hit.id)?.parentId;
        while (parent !== undefined && !seen.has(parent)) {
          if (parent === root) return true;
          seen.add(parent);
          parent = nodes.get(parent)?.parentId;
        }
        return false;
      },
    };
  }
  const direct = /^(?:site|网站)\s*:\s*([^\s]+)$/i.exec(text)?.[1];
  const english =
    /^(?:find |show |list |get )?(?:all )?(?:my )?(?:bookmarks|articles|pages|links|content) (?:from|on) ([a-z0-9.-]+)$/i.exec(
      text,
    )?.[1];
  const chinese =
    /^(?:(?:我)?(?:想要|想找|需要|查找|搜索|找出|查看|列出|显示))?\s*(?:(?:所有|全部)的?)?\s*([\p{Script=Han}a-zA-Z0-9.-]+?)(?:上|里面|里)?的?(?:所有|全部)?(?:书签|文章|内容|网页|链接|收藏)$/u.exec(
      text,
    )?.[1];
  const host = domain(direct ?? english ?? chinese ?? text);
  if (!host) return;
  return {
    kind: 'site',
    value: host,
    matches(hit) {
      try {
        const url = new URL(hit.url);
        return (
          ['http:', 'https:'].includes(url.protocol) && (url.hostname === host || url.hostname.endsWith(`.${host}`))
        );
      } catch {
        return false;
      }
    },
  };
}

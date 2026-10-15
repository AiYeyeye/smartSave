import type { AiPrivacy } from './ai-payload';
import type { TreeSnapshot } from './node-reference';
import { matchSiteRule, ruleFolder, type SiteRule } from './site-rules';

export function localClassification(tree: TreeSnapshot, bookmarkId: string, privacy: AiPrivacy, rules: SiteRule[]) {
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const excluded = new Set(
    privacy.excludedFolders.filter(f => f.installationId === tree.installationId).map(f => f.nativeId),
  );
  const allowed = (id: string) => {
    const seen = new Set<string>();
    let node = nodes.get(id);
    while (node) {
      if (excluded.has(node.ref.nativeId) || seen.has(node.ref.nativeId)) return false;
      seen.add(node.ref.nativeId);
      if (!node.parentId) return true;
      node = nodes.get(node.parentId);
    }
    return false;
  };
  const bookmark = nodes.get(bookmarkId);
  const writable = tree.nodes.filter(n => n.childrenWritable && allowed(n.ref.nativeId));
  const writableIds = new Set(writable.map(f => f.ref.nativeId));
  const host = (url: string | undefined) => {
    try {
      const parsed = new URL(url ?? '');
      return /^https?:$/.test(parsed.protocol) ? parsed.hostname : undefined;
    } catch {
      return undefined;
    }
  };
  const bookmarkHost = host(bookmark?.url);
  const votes = new Map<string, number>();
  let total = 0;
  for (const node of tree.nodes) {
    if (
      !bookmarkHost ||
      node.ref.nativeId === bookmarkId ||
      !node.url ||
      host(node.url) !== bookmarkHost ||
      !node.parentId ||
      !writableIds.has(node.parentId) ||
      !allowed(node.ref.nativeId)
    )
      continue;
    votes.set(node.parentId, (votes.get(node.parentId) ?? 0) + 1);
    total++;
  }
  const majority = [...votes].sort((a, b) => b[1] - a[1]);
  let choice: { source: 'rule' | 'domain'; folderId: string } | undefined;
  if (bookmark?.url && bookmarkHost && allowed(bookmarkId)) {
    const rule = matchSiteRule(bookmark.url, rules);
    const destination = rule && ruleFolder(rule, tree);
    if (destination && writableIds.has(destination.ref.nativeId))
      choice = { source: 'rule', folderId: destination.ref.nativeId };
    else if (total >= 3 && majority[0] && majority[0][1] >= 3 && majority[0][1] / total >= 0.8)
      choice = { source: 'domain', folderId: majority[0][0] };
  }
  const words = (bookmark?.title.toLowerCase().match(/[a-z0-9]{2,}|\p{Script=Han}{2,}/gu) ?? []).flatMap(word =>
    /^\p{Script=Han}+$/u.test(word) ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word],
  );
  const ranked = writable
    .map((folder, order) => ({
      id: folder.ref.nativeId,
      order,
      score:
        (votes.get(folder.ref.nativeId) ?? 0) * 3 +
        words.filter(word => folder.title.toLowerCase().includes(word)).length,
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const candidates = new Set(ranked.slice(0, 30).map(f => f.id));
  // Keep native top-level destinations and every offered ancestor so the compact tree remains meaningful.
  for (const folder of writable) if (!nodes.get(folder.parentId ?? '')?.parentId) candidates.add(folder.ref.nativeId);
  for (const id of [...candidates]) {
    let current = nodes.get(id);
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      current = nodes.get(current.parentId);
      if (current && writableIds.has(current.ref.nativeId)) candidates.add(current.ref.nativeId);
    }
  }
  return {
    choice,
    folderIds: writable.filter(f => candidates.has(f.ref.nativeId)).map(f => f.ref.nativeId),
    sourceAllowed: Boolean(bookmark && allowed(bookmarkId)),
  };
}

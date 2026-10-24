import type { ModelSettingsReader } from '../adapters/feature-model-settings';
import type { TreeSnapshot } from '../domain/node-reference';
import { organizePaths } from '../domain/organize-review';
import { preferencePathEvidence, preferenceUsable, type PersonalPreference } from '../domain/personalization';
import type { OwnWriteGuard } from './own-write-guard';
import type { TreeProjection } from './tree-projection';
export type MoveInfo = { parentId: string; oldParentId: string; index: number; oldIndex: number };
export type ChangeInfo = { title: string; url?: string };
type BookmarkEvents = {
  [K in 'onMoved' | 'onChanged' | 'onImportBegan' | 'onImportEnded']: Pick<
    (typeof chrome.bookmarks)[K],
    'addListener' | 'removeListener'
  >;
};

/** Native events do not identify the originating UI. Exclude our own writes and imports. */
export function startNativePreferenceLearning(options: {
  projection: Pick<TreeProjection, 'subscribe' | 'fresh'>;
  bookmarks: BookmarkEvents;
  guard: OwnWriteGuard;
  settings: ModelSettingsReader;
  learn: (id: string, installationId: string, examples: PersonalPreference[]) => Promise<void>;
}) {
  let snapshot: TreeSnapshot | undefined,
    importing = false,
    closed = false;
  const stop = options.projection.subscribe(state => {
    if (state.status === 'ready') snapshot = state.snapshot;
  });
  async function record(id: string, kind: 'move' | 'update', value: string, oldParentId?: string) {
    if (options.guard.consumeEdit(id, kind, value) || importing || closed) return;
    const before = snapshot;
    const previous = before?.nodes.find(node => node.ref.nativeId === id);
    if (kind === 'update' && previous?.title === value) return;
    const tree = await options.projection.fresh();
    if (closed || importing) return;
    const node = tree.nodes.find(node => node.ref.nativeId === id && node.ref.kind === 'bookmark');
    if (!node || (kind === 'move' ? node.parentId !== value : node.title !== value)) return;
    if (previous && previous.url !== node.url) return;
    const { privacy } = await options.settings.snapshot();
    const paths = organizePaths(tree);
    const clip = (text: string) => Array.from(text).slice(0, 100).join('');
    const entry: PersonalPreference = {
      id: crypto.randomUUID(),
      source: 'choice',
      status: 'active',
      enabled: true,
      updatedAt: Date.now(),
      text:
        kind === 'move'
          ? `「${clip(node.title)}」 → 「${clip(paths.get(value) ?? '')}」`
          : `书签名称采用「${clip(node.title)}」${previous ? `（原名称「${clip(previous.title)}」）` : ''}`,
      scopes: kind === 'move' ? ['search', 'organize', 'save', 'import'] : ['search', 'rename', 'save', 'import'],
      evidence: [
        { id, title: node.title, url: node.url, parentId: node.parentId },
        ...(kind === 'move' ? preferencePathEvidence(tree, [oldParentId, node.parentId]) : []),
      ],
    };
    if (!preferenceUsable(entry, tree, privacy)) return;
    // A move out of an excluded folder must not reveal its former private contents.
    const oldTree = before ?? {
      ...tree,
      nodes: tree.nodes.map(item =>
        item.ref.nativeId === id ? { ...item, parentId: oldParentId ?? item.parentId } : item,
      ),
    };
    const old = oldTree.nodes.find(item => item.ref.nativeId === id);
    if (old && !preferenceUsable({ ...entry, evidence: [{ id, title: old.title, url: old.url }] }, oldTree, privacy))
      return;
    await options.learn(`native:${entry.id}`, tree.installationId, [entry]);
  }
  const moved = (id: string, info: MoveInfo) => {
    if (info.parentId === info.oldParentId) {
      options.guard.consumeEdit(id, 'move', info.parentId);
      return;
    }
    void record(id, 'move', info.parentId, info.oldParentId).catch(() => {});
  };
  const changed = (id: string, info: ChangeInfo) => {
    if (info.title !== undefined) void record(id, 'update', info.title).catch(() => {});
  };
  const begin = () => {
    importing = true;
  };
  const end = () => {
    importing = false;
  };
  options.bookmarks.onMoved.addListener(moved);
  options.bookmarks.onChanged.addListener(changed);
  options.bookmarks.onImportBegan.addListener(begin);
  options.bookmarks.onImportEnded.addListener(end);
  return () => {
    closed = true;
    stop();
    options.bookmarks.onMoved.removeListener(moved);
    options.bookmarks.onChanged.removeListener(changed);
    options.bookmarks.onImportBegan.removeListener(begin);
    options.bookmarks.onImportEnded.removeListener(end);
  };
}

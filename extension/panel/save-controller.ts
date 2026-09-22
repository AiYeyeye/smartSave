import type { TreeSnapshot } from '../domain/node-reference';
import { preflight, validateUrl } from '../domain/preflight';
import { matchSiteRule, ruleFolder, type SiteRule } from '../domain/site-rules';
import type { Command, ConfirmMutation } from '../schemas/messages';
import { prepareMutation } from './TreeDragController';
export interface SaveDraft {
  origin: 'manual' | 'rule' | 'ai' | 'existing';
  aiInvalidated?: boolean;
  proposedPath?: string[];
  snapshot: TreeSnapshot;
  url: string;
  title: string;
  parentId: string;
  existingId: string;
  folderTitle: string;
  newFolder: boolean;
  source: string;
  directoryEdited: boolean;
  rememberRule: boolean;
  includeSubdomains: boolean;
}
export function beginSave(snapshot: TreeSnapshot, page: { url: string; title: string }, rules: SiteRule[]): SaveDraft {
  validateUrl(page.url);
  const match = matchSiteRule(page.url, rules);
  const folder = match && ruleFolder(match, snapshot);
  return {
    snapshot: structuredClone(snapshot),
    ...page,
    origin: match ? 'rule' : 'manual',
    parentId: folder?.ref.nativeId ?? '',
    existingId: '',
    folderTitle: '',
    newFolder: false,
    source: match ? (folder ? '网站规则（仍需确认）' : '规则目录失效，请重新选择') : '原标题；可手动选择目录',
    directoryEdited: false,
    rememberRule: false,
    includeSubdomains: false,
  };
}
export function hydrateSaveRules(draft: SaveDraft, rules: SiteRule[]): SaveDraft {
  if (draft.directoryEdited || draft.origin === 'ai') return draft;
  const hydrated = beginSave(draft.snapshot, draft, rules);
  return { ...draft, parentId: hydrated.parentId, source: hydrated.source, origin: hydrated.origin };
}
export function saveDuplicates(draft: SaveDraft) {
  return draft.snapshot.nodes.filter(n => n.url === draft.url);
}
export function selectSaveDuplicate(draft: SaveDraft, id: string): SaveDraft {
  const node = saveDuplicates(draft).find(n => n.ref.nativeId === id);
  if (!node) throw Error('invalid-reference');
  return {
    ...draft,
    origin: 'existing',
    existingId: id,
    title: node.title,
    parentId: node.parentId ?? '',
    newFolder: false,
    directoryEdited: true,
    source: '编辑已有书签',
  };
}
export function prepareSave(draft: SaveDraft, current: TreeSnapshot): ConfirmMutation {
  if (draft.aiInvalidated) throw Error('stale-ai-proposal');
  const tree = draft.snapshot;
  const parent = tree.nodes.find(n => n.ref.nativeId === draft.parentId && n.childrenWritable);
  if (!parent) throw Error('invalid-destination');
  let request: ConfirmMutation;
  if (saveDuplicates(draft).length) {
    const node = saveDuplicates(draft).find(n => n.ref.nativeId === draft.existingId);
    if (!node || draft.newFolder) throw Error('select-existing');
    if (node.parentId === parent.ref.nativeId)
      request = prepareMutation(tree, { type: 'update', target: node.ref, changes: { title: draft.title } });
    else {
      const update = prepareMutation(tree, { type: 'update', target: node.ref, changes: { title: draft.title } });
      const move = prepareMutation(tree, {
        type: 'move',
        target: node.ref,
        parent: parent.ref,
        index: parent.childrenIds.length,
      });
      request = {
        ...move,
        command: {
          type: 'batch',
          operations: [
            {
              id: 'edit',
              dependsOn: [],
              command: update.command as Extract<typeof update.command, { type: 'update' }>,
            },
            {
              id: 'move',
              dependsOn: ['edit'],
              command: move.command as Extract<typeof move.command, { type: 'move' }>,
            },
          ],
          selectedOperationIds: ['edit', 'move'],
        },
      };
    }
  } else if (draft.newFolder && draft.proposedPath && draft.proposedPath.length > 1) {
    const operations: Extract<Command, { type: 'batch' }>['operations'] = [];
    let parentRef = parent.ref;
    for (const [index, title] of draft.proposedPath.entries()) {
      const id = `folder-${index}`;
      operations.push({
        id,
        dependsOn: index ? [`folder-${index - 1}`] : [],
        command: { type: 'create', parent: parentRef, title },
      });
      parentRef = { ...parent.ref, nativeId: `$batch:${id}:$created` };
    }
    operations.push({
      id: 'bookmark',
      dependsOn: [`folder-${draft.proposedPath.length - 1}`],
      command: { type: 'create', parent: parentRef, title: draft.title, url: draft.url },
    });
    request = {
      ...prepareMutation(tree, { type: 'create', parent: parent.ref, title: draft.title, url: draft.url }),
      command: { type: 'batch', operations, selectedOperationIds: operations.map(o => o.id) },
    };
  } else
    request = prepareMutation(
      tree,
      draft.newFolder
        ? {
            type: 'createFolderAndBookmark',
            parent: parent.ref,
            folderTitle: draft.folderTitle,
            title: draft.title,
            url: draft.url,
          }
        : { type: 'create', parent: parent.ref, title: draft.title, url: draft.url },
    );
  preflight(request, current);
  return request;
}
export function applySaveSuggestion(
  draft: SaveDraft,
  suggestion: { parentId: string; folderTitle?: string },
): SaveDraft {
  if (draft.directoryEdited || draft.existingId) return draft;
  const parent = draft.snapshot.nodes.find(n => n.ref.nativeId === suggestion.parentId && n.childrenWritable);
  if (!parent) return draft;
  return {
    ...draft,
    origin: 'ai',
    aiInvalidated: false,
    parentId: suggestion.parentId,
    newFolder: suggestion.folderTitle !== undefined,
    folderTitle: suggestion.folderTitle ?? '',
    source: suggestion.folderTitle === undefined ? 'AI建议目录（仍需确认）' : 'AI建议新建目录（仍需确认）',
  };
}
export function saveSuggestionPath(
  draft: SaveDraft,
  folderId: string,
  newFolders: { id: string; parentId: string; title: string }[],
): SaveDraft {
  const folders = new Map(newFolders.map(folder => [folder.id, folder]));
  if (
    folders.size !== newFolders.length ||
    newFolders.some(folder => draft.snapshot.nodes.some(node => node.ref.nativeId === folder.id))
  )
    throw Error('invalid-proposal');
  const path: string[] = [];
  const seen = new Set<string>();
  let parentId = folderId;
  while (folders.has(parentId)) {
    if (seen.has(parentId)) throw Error('invalid-proposal');
    seen.add(parentId);
    const folder = folders.get(parentId)!;
    if (!folder.title) throw Error('invalid-proposal');
    path.unshift(folder.title);
    parentId = folder.parentId;
  }
  if (!draft.snapshot.nodes.some(node => node.ref.nativeId === parentId && node.childrenWritable))
    throw Error('invalid-proposal');
  const next = applySaveSuggestion(draft, { parentId, ...(path.length ? { folderTitle: path[0] } : {}) });
  return next === draft ? draft : { ...next, proposedPath: path };
}

export function invalidateSaveSuggestion(draft: SaveDraft): SaveDraft {
  return draft.origin === 'ai' ? { ...draft, aiInvalidated: true } : draft;
}

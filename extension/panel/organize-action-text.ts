import type { OrganizeAction, OrganizeProposal } from '../domain/organize-proposal';
import { translate, translateKnown, type Language } from '../ui/i18n';

/** Only absent model reasons receive a UI-owned fallback. Even a reason matching a UI key stays literal. */
export function organizeActionReason(language: Language, action: OrganizeAction, proposal: OrganizeProposal): string {
  // Models can propose folder removals only. Bookmark deletions come from the local duplicate compiler.
  const source =
    action.kind === 'delete' ? proposal.tree.nodes.find(node => node.ref.nativeId === action.sourceId) : undefined;
  if (source?.ref.kind === 'bookmark' && action.reason) return translateKnown(language, action.reason);
  if (action.reason) return action.reason;
  switch (action.kind) {
    case 'create':
      return translate(language, '为相关内容建立统一分类。');
    case 'move':
      return translate(language, '归入更符合内容主题的分类。');
    case 'merge':
      return translate(language, '合并用途相同的分类，保留全部内容。');
    case 'rename':
      return translate(language, '使用更清晰、一致的分类名称。');
    case 'delete': {
      return translate(
        language,
        source?.ref.kind === 'folder'
          ? source.childrenIds.length
            ? '内容迁移后此分类为空，移除多余目录。'
            : '此分类为空，可清理；需要保留时取消勾选。'
          : '清理链接完全相同的重复书签，保留已明确指定的副本。',
      );
    }
  }
}

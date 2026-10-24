import type { ConfirmMutation } from '../schemas/messages';
import type { OperationRecord } from '../persistence/operations';
import { finalNodes } from './mutation-effect';
import { preferencePathEvidence, type PersonalPreference } from './personalization';
import { organizePaths } from './organize-review';

function shortEvidence(value: string, limit: number) {
  let result = value.slice(0, limit);
  while (JSON.stringify(result).length > limit) result = result.slice(0, Math.max(0, result.length - 10));
  return result;
}

/** Only explicit edit entrypoints call this; AI acceptance passes its displayed proposal as baseline. */
export function withCorrectionLearning(
  request: ConfirmMutation,
  baselines?: NonNullable<ConfirmMutation['learning']>,
): ConfirmMutation {
  const commands =
    request.command.type === 'batch'
      ? request.command.operations
          .filter(op => request.command.type === 'batch' && request.command.selectedOperationIds.includes(op.id))
          .map(op => op.command)
      : [request.command];
  const learning = commands.flatMap(command => {
    if (command.type !== 'update' && command.type !== 'move') return [];
    const node = request.before.find(
      node => node.ref.nativeId === command.target.nativeId && node.ref.kind === 'bookmark',
    );
    if (!node) return [];
    const base = baselines?.find(item => item.id === node.ref.nativeId) ?? {
      id: node.ref.nativeId,
      title: node.title,
      parentId: node.parentId,
    };
    const changed =
      command.type === 'update'
        ? command.changes.title !== undefined && command.changes.title !== base.title
        : command.parent.nativeId !== base.parentId;
    return changed ? [base] : [];
  });
  return learning.length
    ? { ...request, learning: [...new Map(learning.map(item => [item.id, item])).values()] }
    : request;
}

export function correctionExamples(record: OperationRecord): PersonalPreference[] {
  if (record.result?.status !== 'completed' || record.request.recovery || !record.backup) return [];
  const nodes = finalNodes(record);
  if (!nodes) return [];
  const snapshot = { installationId: record.request.installationId, epoch: '', observedRevision: 0, roots: [], nodes };
  const oldPaths = organizePaths({ ...snapshot, nodes: record.backup.nodes });
  const paths = organizePaths(snapshot);
  return (record.request.learning ?? []).flatMap(base => {
    const old = record.backup!.nodes.find(node => node.ref.nativeId === base.id);
    const node = nodes.find(node => node.ref.nativeId === base.id && node.ref.kind === 'bookmark');
    if (!old || !node || old.url !== node.url) return [];
    const named = node.title !== base.title;
    const moved = node.parentId !== base.parentId;
    if (!named && !moved) return [];
    return [
      {
        id: `correction:${record.requestId}:${base.id}`,
        text: [
          named
            ? `书签「${shortEvidence(old.title, 60)}」：建议名称「${shortEvidence(base.title, 60)}」，用户采用「${shortEvidence(node.title, 60)}」。`
            : '',
          moved
            ? `「${shortEvidence(node.title, 60)}」：从「${shortEvidence(oldPaths.get(base.parentId ?? '') ?? '', 60)}」改到「${shortEvidence(paths.get(node.parentId ?? '') ?? '', 60)}」。`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        source: 'choice' as const,
        status: 'active' as const,
        enabled: true,
        scopes: [
          ...new Set<PersonalPreference['scopes'][number]>([
            'search',
            'save',
            'import',
            ...(named ? ['rename' as const] : []),
            ...(moved ? ['organize' as const] : []),
          ]),
        ],
        updatedAt: Date.now(),
        evidence: [
          { id: base.id, title: node.title, url: node.url, parentId: node.parentId },
          ...(moved ? preferencePathEvidence(snapshot, [base.parentId, node.parentId]) : []),
        ],
      },
    ].map(entry => ({ ...entry, scopes: [...entry.scopes] }));
  });
}

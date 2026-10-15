import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelResult } from '../adapters/model-transport';
import type { OrganizeOutput } from '../schemas/model-output';
import type { MutationResult } from '../schemas/messages';
import type { TreeSnapshot, TreeState } from './node-reference';
import type { OrganizeProposal, OrganizeOptions } from './organize-proposal';
import type { OrganizePreference } from './organize-preferences';
import type { OrganizeRequest, approvedOrganizeFolders } from './organize-batches';
import type { DuplicateChoice } from './exact-duplicates';
import type { DuplicateGroup } from './suspected-duplicates';
import type { OrganizeRepair } from './organize-partial-repair';

export interface OrganizeState {
  task?: {
    id?: string;
    revision?: number;
    connected: boolean;
    needsCredential: boolean;
    requestId?: string;
    available: {
      id: string;
      updatedAt: number;
      stage: string;
      status: string;
      readable: boolean;
      requestId?: string;
    }[];
  };
  pipeline?: {
    stage: 'folders' | 'bookmarks' | 'complete';
    status: 'review' | 'running' | 'paused' | 'failed' | 'invalid';
    total: number;
    batchSize: number;
    folderCount: number;
    completed: number;
    analyzed?: number;
    concurrency?: number;
    elapsedMs?: number;
    activeSince?: number;
    batchCount: number;
    finished: { count: number; actionIds: string[] }[];
    lockedActionIds: string[];
  };
  tree: TreeState;
  scopeId: string;
  proposal?: OrganizeProposal;
  selected: string[];
  targets: Record<string, string>;
  duplicates: DuplicateGroup[];
  choices: Record<string, DuplicateChoice>;
  invalid: boolean;
  busy: boolean;
  message: string;
  repair?: { count: number; retained: number };
  failure?: {
    code: string;
    phase: '准备整理' | '模型生成' | '方案校验' | '书签请求准备';
    elapsedSeconds: number;
    bookmarkCount?: number;
    outputTokenLimit?: number;
  };
  result?: MutationResult;
  progress?: {
    phase: 'waiting' | 'receiving' | 'validating';
    streaming: boolean;
    receivedChars: number;
    preview: string[];
    timeoutSeconds: number;
    bookmarkCount: number;
    outputTokenLimit?: number;
  };
}
export type GenerationOptions = OrganizeOptions & {
  rejectedSignatures?: string[];
  staged?: boolean;
  batchSize?: number;
};
export type RunContext = Awaited<ReturnType<ModelAuthority['read']>> & {
  config: NonNullable<Awaited<ReturnType<ModelAuthority['read']>>['config']>;
};
export type StagedRun = {
  /** Volatile, unaccepted evidence. Restart requires regenerating this batch. */
  repair?: { ids: string[]; candidate: OrganizeRepair };
  requiresCredential?: boolean;
  checkpointBaseline?: TreeSnapshot;
  folderOutput?: OrganizeOutput;
  batchIds?: Map<string[], string>;
  finishedBatches?: { ids: string[]; output: OrganizeOutput }[];
  context: RunContext;
  preference: OrganizePreference;
  options: GenerationOptions;
  request: OrganizeRequest;
  bookmarkIds: string[];
  queue: string[][];
  acceptedBatches?: Map<string[], ModelResult>;
  concurrency?: number;
  approved?: ReturnType<typeof approvedOrganizeFolders>;
  folderReview?: { proposal: OrganizeProposal; selected: string[]; targets: Record<string, string> };
};

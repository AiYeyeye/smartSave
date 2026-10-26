/**
 * Receipts for browser-native saves (star / Ctrl+D) that Zhilan auto-classified, skipped or failed on.
 * The popup reads these so the user can always see whether AI ran, where the bookmark went and undo it.
 * Stored locally only; contains bookmark titles/URLs but never keys or page text.
 */
import type { SaveTiming } from '../domain/save-performance';
import type { NodeRef } from '../domain/node-reference';

export const SAVE_RECEIPTS_KEY = 'nativeSaveReceipts';
export const SAVE_RECEIPTS_LIMIT = 30;

export type SaveReceiptStatus = 'classifying' | 'moved' | 'kept' | 'skipped' | 'failed' | 'undone';

export type SaveReceipt = {
  id: string;
  bookmarkId: string;
  installationId?: string;
  correction?: { requestId: string; target: NodeRef; status: 'pending' | 'completed' | 'rejected' };
  title: string;
  url: string;
  at: number;
  status: SaveReceiptStatus;
  /** Machine reason, e.g. save-feature-unconfigured, http-401. */
  reason?: string;
  fromParentId: string;
  fromIndex: number;
  fromPath: string;
  toId?: string;
  toPath?: string;
  createdFolderIds?: string[];
  /** e.g. "gpt-4o-mini · OpenRouter"; never contains keys. */
  model?: string;
  source?: 'rule' | 'domain' | 'ai';
  ms?: number;
  timing?: SaveTiming;
  suggestedTitle?: string;
  /** Explicit read-only re-recognition; applied only through the ordinary review confirmation. */
  suggestedFolderId?: string;
  aiRetry?: { id: string; status: 'pending' | 'ready' | 'failed'; reason?: string };
  nameStatus?: 'pending' | 'ready' | 'unchanged' | 'uncertain' | 'failed';
  nameReview?: 'kept' | 'applied';
  nameRequestId?: string;
  /** Explicit review only; closing the dialog does not resolve a receipt. */
  reviewedAt?: number;
  /** Hides only the reminder; never claims an uncertain bookmark write was reviewed. */
  dismissedAt?: number;
  reviewRequestId?: string;
};

type LocalArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export async function readSaveReceipts(storage: LocalArea): Promise<SaveReceipt[]> {
  try {
    const data = await storage.get(SAVE_RECEIPTS_KEY);
    const value = data[SAVE_RECEIPTS_KEY];
    return Array.isArray(value) ? (value as SaveReceipt[]) : [];
  } catch {
    return [];
  }
}

/** Latest receipt per bookmark that still waits for an explicit review (newest first, like the stored list). */
export function pendingSaveReceipts(receipts: SaveReceipt[]) {
  const seen = new Set<string>();
  return receipts.filter(receipt => {
    const key = JSON.stringify([receipt.installationId, receipt.bookmarkId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return (
      !receipt.reviewedAt &&
      receipt.dismissedAt === undefined &&
      receipt.status !== 'undone' &&
      receipt.reason !== 'missing-bookmark'
    );
  });
}

/** Serialized writer: the service worker is the only owner, so one promise chain is enough. */
export class SaveReceiptLog {
  private chain: Promise<unknown> = Promise.resolve();
  private actions = new Map<string, Promise<unknown>>();
  constructor(private readonly storage: LocalArea) {}

  /** Shared worker owner serializes explicit correction and native undo for one receipt. */
  async withAction<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.actions.get(id) ?? Promise.resolve()).then(operation, operation);
    this.actions.set(id, next);
    try {
      return await next;
    } finally {
      if (this.actions.get(id) === next) this.actions.delete(id);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Run once on worker startup, before any new receipt writes. Never replay native writes. */
  interruptPending() {
    return this.enqueue(async () => {
      const list = await readSaveReceipts(this.storage);
      let count = 0;
      const next = list.map(receipt => {
        if (receipt.aiRetry?.status === 'pending') {
          count++;
          receipt = {
            ...receipt,
            aiRetry: { ...receipt.aiRetry, status: 'failed', reason: 'recognition-interrupted' },
          };
        }
        if (receipt.status !== 'classifying') {
          if (receipt.nameStatus === 'pending') {
            count++;
            return { ...receipt, nameStatus: 'failed' as const };
          }
          return receipt;
        }
        count++;
        return { ...receipt, status: 'failed' as const, reason: 'worker-interrupted' };
      });
      if (count) await this.storage.set({ [SAVE_RECEIPTS_KEY]: next });
      return count;
    });
  }

  upsert(receipt: SaveReceipt) {
    return this.enqueue(async () => {
      const list = await readSaveReceipts(this.storage);
      const index = list.findIndex(item => item.id === receipt.id);
      if (index >= 0) {
        const dismissedAt = list[index]!.dismissedAt;
        list[index] = dismissedAt === undefined ? receipt : { ...receipt, dismissedAt };
      } else list.unshift(receipt);
      await this.storage.set({
        [SAVE_RECEIPTS_KEY]: list.filter(
          (item, index) => index < SAVE_RECEIPTS_LIMIT || (!!item.suggestedTitle && !item.nameReview),
        ),
      });
      return receipt;
    });
  }

  patch(id: string, changes: Partial<SaveReceipt>) {
    return this.enqueue(async () => {
      const list = await readSaveReceipts(this.storage);
      const index = list.findIndex(item => item.id === id);
      if (index < 0) return undefined;
      const next = { ...list[index]!, ...changes };
      list[index] = next;
      await this.storage.set({ [SAVE_RECEIPTS_KEY]: list });
      return next;
    });
  }

  /** Strict durable dismissal: failed reads must not look like an already removed reminder. */
  dismiss(id: string) {
    return this.enqueue(async () => {
      const data = await this.storage.get(SAVE_RECEIPTS_KEY);
      const stored = data[SAVE_RECEIPTS_KEY];
      if (stored !== undefined && !Array.isArray(stored)) throw Error('invalid-receipts');
      const list = (stored ?? []) as SaveReceipt[];
      const receipt = list.find(item => item.id === id);
      if (!receipt || receipt.dismissedAt !== undefined) return;
      await this.storage.set({
        [SAVE_RECEIPTS_KEY]: list.map(item => (item.id === id ? { ...item, dismissedAt: Date.now() } : item)),
      });
    });
  }

  async get(id: string) {
    await this.chain;
    return (await readSaveReceipts(this.storage)).find(item => item.id === id);
  }
  async latestForBookmark(bookmarkId: string) {
    await this.chain;
    return (await readSaveReceipts(this.storage)).find(item => item.bookmarkId === bookmarkId);
  }
}

/** Human-readable explanation for a receipt reason (UI copy, Chinese). */
export function receiptReasonText(reason: string | undefined): string {
  switch (reason) {
    case undefined:
    case '':
      return '';
    case 'save-feature-unconfigured':
      return '还没给「智能收藏」选择模型，未调用 AI';
    case 'service-missing':
      return '「智能收藏」绑定的连接已被删除';
    case 'no-key':
      return '后台拿不到 API Key（连接时没勾选“记住密钥”）';
    case 'permission':
      return '没有访问模型主机的权限';
    case 'timeout':
      return '模型响应超时';
    case 'http-401':
    case 'http-403':
      return 'API Key 无效或无权限';
    case 'http-429':
      return '模型服务限流（429）';
    case 'http-error':
      return '模型服务返回错误';
    case 'provider-error':
      return '模型服务生成失败，可重试或检查 AI 设置。';
    case 'schema':
      return '模型返回的内容无法解析（打开 Debug 日志可看到原因）';
    case 'empty':
      return '模型响应中没有可用文字；请在 Debug 日志检查返回正文和协议结束状态';
    case 'incomplete':
      return '模型回复未完成，请重试。';
    case 'refused':
      return '模型服务因内容规则拒绝了本次请求。';
    case 'recognition-interrupted':
      return '识别已中断，请重试。';
    case 'stale-context':
      return '分类过程中书签或设置发生变化，已停止后续操作';
    case 'settings-unavailable':
      return '无法读取隐私或模型设置，未调用 AI';
    case 'native-write-uncertain':
      return '书签操作结果未能确认，请检查当前目录；不会自动重复执行';
    case 'worker-interrupted':
      return '后台已重启，自动归类结果未能确认；请检查书签位置，不会自动重复执行';
    case 'connection-or-configuration':
      return '无法连接模型服务';
    case 'payload-too-large':
      return '书签目录太大，超过单次请求上限';
    case 'missing-bookmark':
      return '书签已被删除';
    case 'already-in-destination':
    case 'same-folder':
      return 'AI 认为当前位置已经合适';
    case 'excluded':
      return '所在目录在隐私排除范围内';
    case 'user-placed':
      return '你已手动选好位置，智栏没有再移动';
    default:
      return reason;
  }
}

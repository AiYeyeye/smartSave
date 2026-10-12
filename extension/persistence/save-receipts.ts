/**
 * Receipts for browser-native saves (star / Ctrl+D) that Zhilan auto-classified, skipped or failed on.
 * The popup reads these so the user can always see whether AI ran, where the bookmark went and undo it.
 * Stored locally only; contains bookmark titles/URLs but never keys or page text.
 */
export const SAVE_RECEIPTS_KEY = 'nativeSaveReceipts';
export const SAVE_RECEIPTS_LIMIT = 30;

export type SaveReceiptStatus = 'classifying' | 'moved' | 'kept' | 'skipped' | 'failed' | 'undone';

export type SaveReceipt = {
  id: string;
  bookmarkId: string;
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
  ms?: number;
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

/** Serialized writer: the service worker is the only owner, so one promise chain is enough. */
export class SaveReceiptLog {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: LocalArea) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }

  upsert(receipt: SaveReceipt) {
    return this.enqueue(async () => {
      const list = await readSaveReceipts(this.storage);
      const index = list.findIndex(item => item.id === receipt.id);
      if (index >= 0) list[index] = receipt;
      else list.unshift(receipt);
      await this.storage.set({ [SAVE_RECEIPTS_KEY]: list.slice(0, SAVE_RECEIPTS_LIMIT) });
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

  async get(id: string) {
    await this.chain;
    return (await readSaveReceipts(this.storage)).find(item => item.id === id);
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
    case 'schema':
      return '模型返回的内容无法解析';
    case 'stale-context':
      return '分类过程中书签或设置发生变化，已放弃';
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
    default:
      return reason;
  }
}

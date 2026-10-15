import { browserMessage } from '../domain/browser-message';
import { z } from 'zod';
import type { OrganizeTaskView } from './organize-task-owner';
import type { OrganizeCheckpointStore } from '../persistence/organize-checkpoints';
import type { ActionBadgeOwner, BadgeStyle } from './action-badge';

const STORAGE_KEY = 'organize.badge.v1';
const markerSchema = z.strictObject({
  id: z.string().min(1).max(256),
  phase: z.string().max(64),
  eventRevision: z.number().int().nonnegative(),
  seen: z.boolean(),
});
type Marker = z.infer<typeof markerSchema>;
type Summary = {
  id: string;
  revision: number;
  stage: string;
  status: string;
  total: number;
  analyzed: number;
  needsCredential: boolean;
  selected: number;
  submitted: boolean;
};
type Session = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

/** Display-only observer. Never restores controllers, acquires lifetime, requests a model or grants a write. */
export class OrganizeTaskBadge {
  private current?: Summary;
  private marker?: Marker;
  private version = 0;
  private writes = Promise.resolve();
  constructor(
    private badges: Pick<ActionBadgeOwner, 'organize'>,
    private session?: Session,
  ) {}
  async restore(store: Pick<OrganizeCheckpointStore, 'get' | 'list'>) {
    const version = this.version;
    try {
      const [rows, raw] = await Promise.all([store.list(), this.session?.get(STORAGE_KEY)]);
      const marker = markerSchema.safeParse(raw?.[STORAGE_KEY]).data;
      const row = rows.find(row => row.id === marker?.id && row.readable) ?? rows.find(row => row.readable);
      const checkpoint = row ? await store.get(row.id) : undefined;
      if (version !== this.version || !checkpoint) return;
      this.marker = marker?.id === checkpoint.id ? marker : undefined;
      this.update({
        id: checkpoint.id,
        revision: checkpoint.revision,
        stage: checkpoint.stage,
        status: checkpoint.status === 'running' ? 'paused' : checkpoint.status,
        total: checkpoint.bookmarkIds.length,
        analyzed: checkpoint.batches
          .filter(batch => batch.status !== 'pending')
          .reduce((sum, batch) => sum + batch.itemIds.length, 0),
        needsCredential: checkpoint.requiresCredential,
        selected: checkpoint.selection.selected.length,
        submitted: !!checkpoint.submission,
      });
    } catch {
      /* Unknown/unreadable checkpoints remain untouched; no fabricated success. */
    }
  }
  /** Only explicit start/continue changes focus. Historical get/list and late old task updates cannot steal it. */
  focus(view: OrganizeTaskView) {
    if (view.revision < 0) return;
    if (view.id === this.current?.id && view.revision < this.current.revision) return;
    if (this.current?.id !== view.id) this.marker = undefined;
    this.update(this.summary(view));
  }
  observe(view: OrganizeTaskView) {
    if (view.id === this.current?.id && view.revision >= this.current.revision) this.update(this.summary(view));
  }
  seen(id: string, revision: number) {
    const current = this.current,
      marker = this.marker;
    if (
      !current ||
      !marker ||
      current.id !== id ||
      revision < marker.eventRevision ||
      revision > current.revision ||
      marker.seen ||
      current.status === 'running'
    )
      return;
    marker.seen = true;
    this.saveMarker();
    this.render();
  }
  private summary(view: OrganizeTaskView): Summary {
    const pipeline = view.state.pipeline;
    return {
      id: view.id,
      revision: view.revision,
      stage: pipeline?.stage ?? 'folders',
      status: view.state.invalid ? 'invalid' : (pipeline?.status ?? (view.state.busy ? 'running' : 'failed')),
      total: pipeline?.total ?? 0,
      analyzed: pipeline?.analyzed ?? pipeline?.completed ?? 0,
      needsCredential: view.needsCredential,
      selected: view.state.selected.length,
      submitted: !!view.submission,
    };
  }
  private update(summary: Summary) {
    ++this.version;
    const phase = summary.submitted ? 'submitted' : `${summary.stage}:${summary.status}`;
    if (this.marker?.id !== summary.id || this.marker.phase !== phase) {
      this.marker = { id: summary.id, phase, eventRevision: summary.revision, seen: false };
      this.saveMarker();
    }
    this.current = summary;
    this.render();
  }
  private saveMarker() {
    const value = this.marker && { ...this.marker };
    if (value && this.session)
      this.writes = this.writes
        .catch(() => {})
        .then(async () => {
          await this.session!.set({ [STORAGE_KEY]: value });
        })
        .catch(() => {});
  }
  private render() {
    const task = this.current;
    let style: BadgeStyle | undefined;
    if (task && !task.submitted && (task.status === 'running' || !this.marker?.seen)) {
      const analyzed = Math.max(0, Math.min(task.total, task.analyzed));
      const progress = [String(analyzed), String(task.total)];
      if (task.status === 'running')
        style =
          task.stage === 'bookmarks' && task.total > 0
            ? {
                text: `${Math.floor((analyzed / task.total) * 100)}%`,
                color: '#6366F1',
                title: browserMessage('organizeWorking', progress),
              }
            : {
                text: browserMessage('organizeWorkingBadge'),
                color: '#6366F1',
                title: browserMessage('organizeFolders'),
              };
      else if (task.status === 'review')
        style = {
          text: browserMessage('organizeReviewBadge'),
          color: '#6155A6',
          title:
            task.stage === 'folders'
              ? browserMessage('organizeFolderReview')
              : task.selected
                ? browserMessage('organizeBookmarkReview')
                : browserMessage('organizeNoSelection'),
        };
      else if (task.status === 'paused')
        style = {
          text: browserMessage('organizePausedBadge'),
          color: '#D97706',
          title: browserMessage(task.needsCredential ? 'organizePausedCredentials' : 'organizePaused', progress),
        };
      else style = { text: '!', color: '#D97706', title: browserMessage('organizeStopped') };
    }
    void this.badges.organize(style);
  }
}

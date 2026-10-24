import { z } from 'zod';
import { ModelTransport } from '../adapters/model-transport';
import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelSettingsReader } from '../adapters/feature-model-settings';
import { correctionExamples } from '../domain/correction-learning';
import { personalPreferenceSchema, preferenceUsable, type PersonalPreference } from '../domain/personalization';
import { browserPersonalizationStore, LEARNING_QUEUE_KEY } from '../persistence/personalization';
import type { OperationRecord } from '../persistence/operations';
import type { TreeProjection } from './tree-projection';
import { createWorkerTaskLifetime } from './worker-task-lifetime';
import { applyPreferenceUpdate, preferenceUpdatePlan } from '../domain/preference-update';

const jobSchema = z.strictObject({
  id: z.string(),
  installationId: z.string(),
  at: z.number(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'skipped']),
  examples: z.array(personalPreferenceSchema).max(1000),
  reason: z.string().optional(),
});
type Job = z.infer<typeof jobSchema>;
type Storage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

/** One durable event per actual edit; background ownership is independent of any UI document. */
export class CorrectionLearning {
  private chain: Promise<unknown> = Promise.resolve();
  private draining = false;
  private lifetime = createWorkerTaskLifetime();
  constructor(
    private projection: Pick<TreeProjection, 'fresh' | 'subscribe'>,
    private settings: ModelSettingsReader,
    private storage: Storage,
    private memory = browserPersonalizationStore(),
    private model = (authority: ModelAuthority) =>
      new ModelTransport(
        {
          fetch: (...args) => fetch(...args),
          contains: request => chrome.permissions.contains(request),
        },
        authority,
      ),
  ) {}
  private async jobs() {
    const data = await this.storage.get(LEARNING_QUEUE_KEY);
    return z
      .array(jobSchema)
      .max(5000)
      .parse(data[LEARNING_QUEUE_KEY] ?? []);
  }
  private change(change: (jobs: Job[]) => void) {
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        const jobs = await this.jobs();
        change(jobs);
        await this.storage.set({ [LEARNING_QUEUE_KEY]: z.array(jobSchema).max(5000).parse(jobs) });
      });
    this.chain = next;
    return next;
  }
  async start(records: OperationRecord[]) {
    await this.change(jobs => {
      for (const job of jobs)
        if (job.status === 'running') {
          job.status = 'failed';
          job.reason = 'worker-interrupted';
          job.examples = [];
        }
    });
    try {
      const tree = await this.projection.fresh();
      const legacy = await this.memory.migrate(tree.installationId);
      if (legacy?.enabled) {
        const entries = legacy.entries
          .filter(entry => entry.enabled && entry.status === 'active')
          .sort((a, b) => a.updatedAt - b.updatedAt);
        await this.enqueue(`migration:${legacy.revision}`, tree.installationId, entries);
      }
    } catch {
      // Import/read unavailability must not permanently disable the learning owner.
      // Legacy input remains local; the bounded read view is safe until a later startup can migrate it.
    }
    for (const record of records) if (record.request.learning?.length) await this.observe(record);
    void this.drain();
  }
  async observe(record: OperationRecord) {
    const examples = correctionExamples(record);
    if (!examples.length) return;
    const { privacy } = await this.settings.snapshot();
    // The original location may have been excluded even when the new location is public.
    const before = {
      installationId: record.request.installationId,
      epoch: '',
      observedRevision: 0,
      roots: [],
      nodes: record.backup?.nodes ?? [],
    };
    const allowed = examples.filter(entry => {
      const evidence = entry.evidence.map(item => {
        const old = before.nodes.find(node => node.ref.nativeId === item.id);
        return { id: item.id, title: old?.title ?? '', url: old?.url };
      });
      return preferenceUsable({ ...entry, evidence }, before, privacy);
    });
    await this.enqueue(record.requestId, record.request.installationId, allowed);
  }
  async enqueue(id: string, installationId: string, examples: PersonalPreference[]) {
    if (!examples.length) return;
    const enabled = (await this.memory.load(installationId)).enabled;
    await this.change(jobs => {
      if (jobs.some(job => job.id === id && job.installationId === installationId)) return;
      if (jobs.length >= 5000) throw Error('learning-capacity');
      jobs.push({
        id,
        installationId,
        examples: enabled ? examples : [],
        at: Date.now(),
        status: enabled ? 'queued' : 'skipped',
        ...(enabled ? {} : { reason: 'disabled' }),
      });
    });
    void this.drain();
  }
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    const release = this.lifetime.acquire();
    let exhausted = false;
    try {
      for (;;) {
        let job: Job | undefined;
        await this.change(jobs => {
          job = jobs.find(item => item.status === 'queued');
          if (job) {
            job.status = 'running';
            job = structuredClone(job);
          }
        });
        if (!job) {
          exhausted = true;
          break;
        }
        const currentJob = job;
        let status: Job['status'] = 'completed',
          reason: string | undefined;
        const authority: ModelAuthority = {
          read: async () => ({ ...(await this.settings.snapshot()), tree: await this.projection.fresh() }),
          subscribe: listener => {
            const stopSettings = this.settings.subscribe(() => listener('settings'));
            const stopTree = this.projection.subscribe(() => listener('tree'));
            const permissions = () => listener('permissions');
            globalThis.chrome?.permissions?.onRemoved?.addListener(permissions);
            return () => {
              stopSettings();
              stopTree();
              globalThis.chrome?.permissions?.onRemoved?.removeListener(permissions);
            };
          },
        };
        const model = this.model(authority);
        try {
          const context = await authority.read();
          if (context.tree.installationId !== job.installationId) throw Error('stale-context');
          const memory = await this.memory.load(job.installationId);
          if (!memory.enabled) throw Error('disabled');
          const examples = job.examples.filter(entry => preferenceUsable(entry, context.tree, context.privacy));
          if (!examples.length) throw Error('stale-context');
          // A user action can edit many items; keep separate bounded calls without dropping corrections.
          for (let offset = 0; offset < examples.length; offset += 20) {
            const batch = examples.slice(offset, offset + 20);
            // Raw actions stay in the durable job. Only a validated interpretation becomes a
            // preference, so pending/failed inference cannot expose an operation log as a rule.
            if (!context.config) throw Error('configuration');
            const original = await this.memory.load(job.installationId);
            const update = { revision: original.revision, additions: batch };
            const plan = preferenceUpdatePlan(original, update, context.tree, context.privacy);
            const result = await model.run({
              ...context,
              config: context.config,
              request: { task: 'preference-summary', examples: plan.examples, update },
            });
            if (result.status !== 'completed' || !('rules' in result.output))
              throw Error(result.status === 'completed' ? 'schema' : result.reason);
            const fresh = await authority.read();
            if (plan.sources.some(entry => !preferenceUsable(entry, fresh.tree, fresh.privacy)))
              throw Error('stale-context');
            const rules = result.output.rules;
            await this.memory.update(job.installationId, value => {
              if (!value.enabled || value.revision !== original.revision) throw Error('stale-context');
              return { ...value, entries: applyPreferenceUpdate(plan, rules, currentJob.id) };
            });
          }
        } catch (error) {
          reason = error instanceof Error ? error.message : 'learning-unavailable';
          status = ['disabled', 'stale-context'].includes(reason) ? 'skipped' : 'failed';
        } finally {
          model.dispose();
        }
        await this.change(jobs => {
          const stored = jobs.find(item => item.id === currentJob.id);
          if (stored) {
            stored.status = status;
            stored.reason = reason;
            if (status !== 'failed') stored.examples = [];
          }
        });
      }
    } catch {
      /* Persisted queued/running state remains inspectable; native writes are never replayed. */
    } finally {
      this.draining = false;
      release();
      // An enqueue can arrive after the last empty claim but before draining is released.
      if (exhausted)
        void this.jobs()
          .then(jobs => {
            if (jobs.some(job => job.status === 'queued')) void this.drain();
          })
          .catch(() => {});
    }
  }
}

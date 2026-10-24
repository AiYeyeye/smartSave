import { useEffect, useMemo, useRef, useState } from 'react';
import { browserModelAuthority } from '../adapters/model-authority';
import { featureModelSettings } from '../adapters/feature-model-settings';
import { ModelTransport } from '../adapters/model-transport';
import {
  emptyPersonalization,
  preferenceCharacters,
  preferenceFits,
  preferenceUsable,
  PREFERENCE_CHARACTER_LIMIT,
  PREFERENCE_TEXT_CODE_UNITS,
  type Personalization,
  type PersonalPreference,
  type PreferenceScope,
} from '../domain/personalization';
import type { TreeSnapshot } from '../domain/node-reference';
import { browserPersonalizationStore } from '../persistence/personalization';
import type { SettingsStore } from '../persistence/settings';
import type { AiServicesStore } from '../persistence/ai-services';
import { connectTree } from '../panel/tree-client';
import { useI18n } from '../ui/i18n';
import './personalization.css';
import { applyPreferenceUpdate, preferenceUpdatePlan } from '../domain/preference-update';
import { CorrectionLearningStatus } from './CorrectionLearningStatus';

const scopes: PreferenceScope[] = ['search', 'organize', 'save', 'import', 'rename'];
const scopeLabels = {
  search: '搜索',
  organize: 'AI 整理',
  save: '智能收藏',
  import: '导入分类',
  rename: 'AI 书签改名',
} as const;
function PreferenceEditor({
  entry,
  disabled,
  save,
  remove,
}: {
  entry: PersonalPreference;
  disabled: boolean;
  save: (entry: PersonalPreference) => Promise<void>;
  remove: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(entry.text);
  const [selectedScopes, setScopes] = useState(entry.scopes);
  const [enabled, setEnabled] = useState(entry.enabled);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) {
      setText(entry.text);
      setScopes(entry.scopes);
      setEnabled(entry.enabled);
    }
  }, [entry, dirty]);
  return (
    <article className="personal-preference">
      <textarea
        aria-label={t('偏好内容')}
        maxLength={PREFERENCE_TEXT_CODE_UNITS}
        value={text}
        disabled={disabled}
        onChange={event => {
          setText(Array.from(event.target.value).slice(0, PREFERENCE_CHARACTER_LIMIT).join(''));
          setDirty(true);
        }}
      />
      <div className="personal-scopes" role="group" aria-label={t('适用功能')}>
        {scopes.map(scope => (
          <label key={scope}>
            <input
              type="checkbox"
              checked={selectedScopes.includes(scope)}
              disabled={disabled}
              onChange={event => {
                setScopes(current =>
                  event.target.checked ? [...current, scope] : current.filter(value => value !== scope),
                );
                setDirty(true);
              }}
            />
            {t(scopeLabels[scope])}
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={event => {
              setEnabled(event.target.checked);
              setDirty(true);
            }}
          />
          {t('启用此偏好')}
        </label>
      </div>
      <div className="actions">
        <button
          disabled={disabled || !text.trim() || !selectedScopes.length}
          onClick={() =>
            void save({
              ...entry,
              text,
              scopes: selectedScopes,
              enabled,
              status: 'active',
              updatedAt: Date.now(),
              ...(dirty && entry.learnedFrom ? { learnedFrom: undefined, source: 'manual' as const } : {}),
            })
              .then(() => setDirty(false))
              .catch(() => {})
          }
        >
          {t(entry.status === 'pending' ? '确认并启用规则' : '保存修改')}
        </button>
        <button disabled={disabled} onClick={() => void remove().catch(() => {})}>
          {t('删除')}
        </button>
      </div>
    </article>
  );
}

export function PersonalizationSettings({
  settings,
  services,
  visible = true,
}: {
  settings?: SettingsStore;
  services?: AiServicesStore;
  visible?: boolean;
}) {
  const { t } = useI18n();
  const store = useMemo(browserPersonalizationStore, []);
  const [tree, setTree] = useState<TreeSnapshot>();
  const [memory, setMemory] = useState<Personalization>(emptyPersonalization);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [newText, setNewText] = useState('');
  const [adding, setAdding] = useState(false);
  const model = useRef<ModelTransport | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      model.current?.dispose();
    };
  }, []);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
    return connectTree(chrome.runtime, state => setTree(state.status === 'ready' ? state.snapshot : undefined));
  }, []);
  const installationId = tree?.installationId;
  useEffect(() => {
    if (!installationId || !visible) return;
    let current = true,
      sequence = 0;
    const read = async () => {
      const request = ++sequence;
      try {
        const value = await store.load(installationId);
        if (current && request === sequence) {
          setMemory(value);
          setLoaded(true);
          setError(false);
        }
      } catch {
        if (current && request === sequence) {
          setLoaded(false);
          setError(true);
        }
      }
    };
    void read();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[store.key(installationId)]) void read();
    };
    chrome.storage?.onChanged?.addListener(changed);
    return () => {
      current = false;
      chrome.storage?.onChanged?.removeListener(changed);
    };
  }, [installationId, store, visible]);
  async function update(change: (memory: Personalization) => Personalization) {
    if (!installationId || busy || !loaded) throw Error('unavailable');
    setBusy(true);
    setError(false);
    try {
      const original = await store.load(installationId);
      let proposed = change(original);
      if (!preferenceFits(proposed.entries)) {
        if (!settings) throw Error('configuration');
        const authority = browserModelAuthority(featureModelSettings(settings, services, 'organize'));
        const transport = new ModelTransport(
          { fetch: (...args) => fetch(...args), contains: request => chrome.permissions.contains(request) },
          authority,
        );
        model.current = transport;
        try {
          const context = await authority.read();
          if (!context.config || context.tree.installationId !== installationId) throw Error('configuration');
          const additions = proposed.entries.filter(
            entry => !original.entries.some(old => JSON.stringify(old) === JSON.stringify(entry)),
          );
          const update = { revision: original.revision, additions };
          const plan = preferenceUpdatePlan(original, update, context.tree, context.privacy);
          const result = await transport.run({
            ...context,
            config: context.config,
            request: { task: 'preference-summary', examples: plan.examples, update },
          });
          if (result.status !== 'completed' || !('rules' in result.output) || !alive.current) throw Error('failed');
          const fresh = await authority.read();
          preferenceUpdatePlan(await store.load(installationId), update, fresh.tree, fresh.privacy);
          if (plan.sources.some(entry => !preferenceUsable(entry, fresh.tree, fresh.privacy)))
            throw Error('stale-context');
          proposed = { ...proposed, entries: applyPreferenceUpdate(plan, result.output.rules, crypto.randomUUID()) };
        } finally {
          transport.dispose();
          model.current = undefined;
        }
      }
      const value = await store.update(installationId, current => {
        if (current.revision !== original.revision) throw Error('stale-context');
        return proposed;
      });
      if (alive.current) setMemory(value);
    } catch (cause) {
      if (alive.current) setError(true);
      throw cause;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const disabled = busy || !loaded;
  return (
    <section className="surface personalization-settings" aria-label={t('个性化偏好')}>
      <CorrectionLearningStatus />
      <label className="personalization-toggle">
        <input
          type="checkbox"
          checked={memory.enabled}
          disabled={disabled}
          onChange={event => {
            const enabled = event.target.checked;
            void update(current => ({ ...current, enabled })).catch(() => {});
          }}
        />
        <span>{t('记住并使用个性化偏好')}</span>
      </label>
      {error && <p role="alert">{t('偏好操作未完成，请检查本机存储或整理模型配置后重试。')}</p>}
      <div className="actions personalization-toolbar">
        <button disabled={disabled} onClick={() => setAdding(value => !value)}>
          {t(adding ? '取消' : '添加个人规则')}
        </button>
        {memory.entries.length > 0 && (
          <span className="hint">{t('已用 {count} / {limit} 字', { count: preferenceCharacters(memory.entries), limit: PREFERENCE_CHARACTER_LIMIT })}</span>
        )}
      </div>
      {adding && (
        <>
          <label>
            {t('添加个人规则')}
            <textarea
              aria-label={t('添加个人规则')}
              value={newText}
              maxLength={PREFERENCE_TEXT_CODE_UNITS}
              onChange={event => setNewText(Array.from(event.target.value).slice(0, PREFERENCE_CHARACTER_LIMIT).join(''))}
            />
          </label>
          <button
            disabled={disabled || !newText.trim()}
            onClick={() =>
              void update(current => ({
                ...current,
                entries: [
                  ...current.entries,
                  {
                    id: crypto.randomUUID(),
                    text: newText.trim(),
                    source: 'manual',
                    status: 'active',
                    enabled: true,
                    scopes: [...scopes],
                    updatedAt: Date.now(),
                    evidence: [],
                  },
                ],
              }))
                .then(() => {
                  setNewText('');
                  setAdding(false);
                })
                .catch(() => {})
            }
          >
            {t('保存个人规则')}
          </button>
        </>
      )}
      {loaded && !memory.entries.length && <p className="hint">{t('暂无')}</p>}
      {(['pending', 'active'] as const)
        .filter(status => memory.entries.some(entry => entry.status === status))
        .map(status => (
          <section key={status} aria-label={t(status === 'pending' ? '待确认的 AI 规则' : '已记住的偏好')}>
            <h3>
              {t(status === 'pending' ? '待确认的 AI 规则' : '已记住的偏好')}（
              {memory.entries.filter(entry => entry.status === status).length}）
            </h3>
            {memory.entries
              .filter(entry => entry.status === status)
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map(entry => (
                <PreferenceEditor
                  key={entry.id}
                  entry={entry}
                  disabled={disabled}
                  save={next =>
                    update(current => {
                      const saved = current.entries.find(item => item.id === entry.id);
                      if (!saved || saved.updatedAt !== entry.updatedAt) throw Error('conflict');
                      return { ...current, entries: current.entries.map(item => (item.id === entry.id ? next : item)) };
                    })
                  }
                  remove={() =>
                    update(current => ({ ...current, entries: current.entries.filter(item => item.id !== entry.id) }))
                  }
                />
              ))}
          </section>
        ))}
    </section>
  );
}

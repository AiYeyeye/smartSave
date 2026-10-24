import { useEffect, useRef, useState } from 'react';
import type { SettingsStore } from '../persistence/settings';
import type { AiServicesStore } from '../persistence/ai-services';
import { featureModelSettings } from '../adapters/feature-model-settings';
import { browserModelAuthority, type ModelAuthority } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
import { serializeAiPayload } from '../domain/ai-payload';
import { dependencyDigest, settingsIdentity } from '../domain/context-dependencies';
import { compileBookmarkRenames, type RenameRow } from '../domain/bookmark-rename';
import type { TreeSnapshot } from '../domain/node-reference';
import { organizePaths } from '../domain/organize-review';
import { connectTree } from './tree-client';
import { openOrganizerLease, type OrganizerLease } from './organizer-client';
import { submitMutation } from './mutation-client';
import type { MutationResult } from '../schemas/messages';
import { MutationFeedback } from './BookmarkActions';
import { useI18n } from '../ui/i18n';
import { Select } from '../ui/Select';

export function RenameWorkbench({ settings, aiServices }: { settings?: SettingsStore; aiServices?: AiServicesStore }) {
  const { t, message: localize } = useI18n();
  const [tree, setTree] = useState<TreeSnapshot>();
  const [rootId, setRootId] = useState('');
  const [rows, setRows] = useState<RenameRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<MutationResult>();
  const [count, setCount] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const owner = useRef<{ authority: ModelAuthority; model: ModelTransport } | undefined>(undefined);
  const frozen = useRef<
    { tree: TreeSnapshot; ids: string[]; rootId: string; settings: string; key?: string; digest: string } | undefined
  >(undefined);
  const lease = useRef<OrganizerLease | undefined>(undefined);
  const generation = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    if (!settings || typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
    const authority = browserModelAuthority(featureModelSettings(settings, aiServices, 'organize'));
    const model = new ModelTransport(
      { fetch: (...args) => fetch(...args), contains: value => chrome.permissions.contains(value) },
      authority,
    );
    owner.current = { authority, model };
    const stop = connectTree(chrome.runtime, state => setTree(state.status === 'ready' ? state.snapshot : undefined));
    return () => {
      generation.current++;
      model.dispose();
      stop();
      lease.current?.close();
      owner.current = undefined;
    };
  }, [settings, aiServices]);
  useEffect(() => {
    const current = lease.current;
    if (!current) return;
    if (invalid || (!busy && !applying && rows.length === 0)) {
      current.close();
      lease.current = undefined;
      return;
    }
    // Review and explicit confirmation still own this session, even after generation stops.
    current.setActive?.(true);
  }, [busy, applying, invalid, rows.length]);
  const paths = organizePaths(tree, t('根目录'));
  async function generate() {
    if (!owner.current || !rootId || lock.current) return;
    lock.current = true;
    const token = ++generation.current;
    setBusy(true);
    setRows([]);
    setResult(undefined);
    setMessage('正在生成名称建议…');
    setInvalid(false);
    setConfirming(false);
    lease.current?.close();
    let openedLease: OrganizerLease | undefined;
    try {
      const context = await owner.current.authority.read();
      if (token !== generation.current) return;
      if (!context.config) throw Error('configuration');
      const nodes = new Map(context.tree.nodes.map(node => [node.ref.nativeId, node]));
      const descendants = context.tree.nodes
        .filter(node => {
          if (node.ref.kind !== 'bookmark' || node.readOnly) return false;
          let id: string | undefined = node.parentId;
          const seen = new Set<string>();
          while (id !== undefined && !seen.has(id)) {
            if (id === rootId) return true;
            seen.add(id);
            id = nodes.get(id)?.parentId;
          }
          return false;
        })
        .map(node => node.ref.nativeId);
      const request = { task: 'rename' as const, itemIds: descendants, folderIds: [] };
      const payload: { items: { id: string }[] } = JSON.parse(
        serializeAiPayload(context.tree, context.privacy, request),
      );
      const ids = payload.items.map(item => item.id);
      setCount(ids.length);
      if (!ids.length) throw Error('empty');
      frozen.current = {
        tree: context.tree,
        ids,
        rootId,
        settings: settingsIdentity(context),
        key: context.key,
        digest: dependencyDigest(context.tree, { ...request, itemIds: ids }),
      };
      openedLease = await openOrganizerLease(() => {
        setInvalid(true);
        owner.current?.model.cancel();
      });
      if (token !== generation.current) {
        openedLease.close();
        return;
      }
      lease.current = openedLease;
      for (let offset = 0; offset < ids.length;) {
        let batch = ids.slice(offset, offset + 100);
        while (
          !owner.current.model.fits({ ...context, config: context.config, request: { ...request, itemIds: batch } })
        ) {
          if (batch.length === 1) throw Error('payload-too-large');
          batch = batch.slice(0, Math.ceil(batch.length / 2));
        }
        const response = await owner.current.model.run({
          ...context,
          config: context.config,
          request: { ...request, itemIds: batch },
        });
        if (token !== generation.current) return;
        if (response.status !== 'completed') throw Error(response.reason);
        if (!('suggestions' in response.output)) throw Error('schema');
        const additions = response.output.suggestions.map(entry => ({
          ...entry,
          original: nodes.get(entry.itemId)!.title,
          editedTitle: entry.title,
          selected: entry.decision === 'rename' && entry.title !== nodes.get(entry.itemId)!.title,
        }));
        setRows(current => [...current, ...additions]);
        offset += batch.length;
      }
      setMessage('名称建议已生成，请核对后确认。');
    } catch (error) {
      if (token === generation.current)
        setMessage(`名称建议未完成：${error instanceof Error ? error.message : 'unavailable'}`);
    } finally {
      if (token === generation.current) {
        setBusy(false);
        lock.current = false;
      }
    }
  }
  async function apply() {
    const base = frozen.current;
    if (lock.current || !base || !owner.current || !lease.current || invalid) return;
    lock.current = true;
    setApplying(true);
    setConfirming(false);
    try {
      const current = await owner.current.authority.read();
      if (
        settingsIdentity(current) !== base.settings ||
        current.key !== base.key ||
        current.tree.installationId !== base.tree.installationId ||
        dependencyDigest(current.tree, { task: 'rename', itemIds: base.ids, folderIds: [] }) !== base.digest
      )
        throw Error('stale-context');
      const request = compileBookmarkRenames(base.tree, base.rootId, rows, lease.current.token);
      const outcome = await submitMutation(request);
      setResult(outcome);
      setInvalid(true);
    } catch (error) {
      setMessage(`名称建议未完成：${error instanceof Error ? error.message : 'unavailable'}`);
      setInvalid(true);
    } finally {
      setApplying(false);
      lock.current = false;
      lease.current?.close();
    }
  }
  const selected = rows.filter(row => row.selected && row.editedTitle.trim() !== row.original).length;
  return (
    <section className="surface rename-workbench">
      <h2>{t('AI 书签改名')}</h2>
      <p>{t('选择目录，预览并修改名称建议，确认后才改名。使用整理模型，不读取网页正文。')}</p>
      <label className="field">
        {t('选择目录')}
        <Select
          aria-label={t('选择目录')}
          value={rootId}
          disabled={busy || applying}
          onChange={event => {
            setRootId(event.target.value);
            setRows([]);
            frozen.current = undefined;
            setResult(undefined);
            setConfirming(false);
            lease.current?.close();
          }}
        >
          <option value="">{t('请选择目录')}</option>
          {tree?.nodes
            .filter(node => node.ref.kind === 'folder' && node.childrenWritable)
            .map(node => (
              <option value={node.ref.nativeId} key={node.ref.nativeId}>
                {paths.get(node.ref.nativeId) || t('根目录')}
              </option>
            ))}
        </Select>
      </label>
      <div className="actions">
        <button disabled={!rootId || !tree || busy || applying} onClick={() => void generate()}>
          {t('生成名称建议')}
        </button>
        {busy && (
          <button
            onClick={() => {
              generation.current++;
              owner.current?.model.cancel();
              setBusy(false);
              lock.current = false;
              setMessage('已停止，已生成建议保留。');
            }}
          >
            {t('停止')}
          </button>
        )}
      </div>
      <p role="status">{t('已生成 {done} / {total} 条名称建议', { done: rows.length, total: count })}</p>
      {message && (
        <p role="status">
          {message.startsWith('名称建议未完成：')
            ? `${t('名称建议未完成')} · ${message.slice('名称建议未完成：'.length)}`
            : localize(message)}
        </p>
      )}
      {invalid && !result && <p role="alert">{t('名称建议已失效，请重新生成；已提交操作请查看恢复记录。')}</p>}
      {rows.length > 0 && (
        <div className="actions" aria-label={t('预览改名确认')}>
          <span>{t('已选 {count} 条待改名书签', { count: selected })}</span>
          <button disabled={busy || applying || invalid || !selected || !tree} onClick={() => setConfirming(true)}>
          {t('预览改名确认')}
          </button>
        </div>
      )}
      {confirming && (
        <div className="surface" role="group" aria-label={t('确认改名')}>
          <p>{t('将修改 {count} 条书签名称，网址和目录保持不变。', { count: selected })}</p>
          <button disabled={applying} onClick={() => void apply()}>
            {t('确认改名')}
          </button>
          <button onClick={() => setConfirming(false)}>{t('取消')}</button>
        </div>
      )}
      {rows.length > 0 && !busy && !invalid && selected === 0 && (
        <p role="status">{t('当前没有需要应用的改名。可以编辑建议名称并勾选条目，再预览确认。')}</p>
      )}
      <div className="rename-list">
        {rows.map(row => (
          <article key={row.itemId} className="rename-row">
            <label className="check">
              <input
                type="checkbox"
                checked={row.selected}
                disabled={busy || applying || invalid}
                onChange={event => {
                  setConfirming(false);
                  setRows(current =>
                    current.map(item =>
                      item.itemId === row.itemId ? { ...item, selected: event.target.checked } : item,
                    ),
                  );
                }}
              />
              <span title={row.original}>{row.original || t('无标题')}</span>
            </label>
            <input
              aria-label={t('建议名称')}
              maxLength={200}
              value={row.editedTitle}
              disabled={applying || invalid}
              onChange={event => {
                setConfirming(false);
                setRows(current =>
                  current.map(item =>
                    item.itemId === row.itemId ? { ...item, editedTitle: event.target.value, selected: true } : item,
                  ),
                );
              }}
            />
            <small>{row.decision === 'uncertain' ? t('信息不足，保留原名') : row.reason}</small>
          </article>
        ))}
      </div>
      {result && <MutationFeedback result={result} />}
    </section>
  );
}

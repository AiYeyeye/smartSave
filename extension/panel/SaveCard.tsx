import { useI18n } from '../ui/i18n';
import { saveStatusText } from './save-status-text';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiServicesStore } from '../persistence/ai-services';
import { featureModelSettings } from '../adapters/feature-model-settings';
import type { TreeSnapshot } from '../domain/node-reference';
import {
  beginSave,
  invalidateSaveSuggestion,
  hydrateSaveRules,
  prepareSave,
  rebaseSaveDraft,
  saveDuplicates,
  selectSaveDuplicate,
  saveSuggestionPath,
  type SaveDraft,
} from './save-controller';
import { submitMutation, type SendMutation } from './mutation-client';
import { MutationFeedback } from './BookmarkActions';
import { mutationResultSchema, type MutationResult } from '../schemas/messages';
import { SiteRulesStore } from '../persistence/site-rules';
import { siteHost, matchSiteRule, type SiteRule } from '../domain/site-rules';
import { SettingsStore } from '../persistence/settings';
import { ModelTransport } from '../adapters/model-transport';
import { browserModelAuthority, type ModelAuthorityChange } from '../adapters/model-authority';
import { completedSaveFolder, reconcileSave, type ReconcileSave } from './save-receipt';
import { openUrl } from '../domain/open-url';
import { Select } from '../ui/Select';
export function SaveCard({
  page,
  snapshot,
  connectionReady = true,
  settings,
  aiServices,
  rulesStore,
  onClose,
  send,
  extractBody,
  reconcile = reconcileSave,
  readOnlyTrial = false,
}: {
  page: { title: string; url: string; token?: string };
  snapshot: TreeSnapshot;
  connectionReady?: boolean;
  settings?: SettingsStore;
  aiServices?: AiServicesStore;
  rulesStore: SiteRulesStore;
  onClose: () => void;
  send?: SendMutation;
  reconcile?: ReconcileSave;
  extractBody?: () => Promise<string>;
  readOnlyTrial?: boolean;
}) {
  const { t, language, message: localize } = useI18n();
  const featureSettings = useMemo(
    () => settings && featureModelSettings(settings, aiServices, readOnlyTrial ? 'save' : 'classify'),
    [settings, aiServices, readOnlyTrial],
  );
  const [draft, setDraft] = useState<SaveDraft>(() => beginSave(snapshot, page, []));
  const [message, setMessage] = useState('正在读取规则；不会自动保存。');
  const automaticEligible = useRef(!readOnlyTrial);
  const [suggesting, setSuggesting] = useState(false);
  const suggestingLock = useRef(false);
  const [autoSuggest, setAutoSuggest] = useState(false);
  const [bodyEnabled, setBodyEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MutationResult>();
  const [pendingRule, setPendingRule] = useState<SiteRule>();
  const lock = useRef(false);
  const live = useRef(true);
  const transport = useRef<ModelTransport | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => {
    live.current = true;
    const authority =
      featureSettings && typeof chrome !== 'undefined' && chrome.permissions
        ? browserModelAuthority(featureSettings)
        : undefined;
    const revoke = () => {
      generation.current++;
      transport.current?.cancel();
      if (live.current) setDraft(current => invalidateSaveSuggestion(current));
    };
    // Tree changes are judged per destination by the snapshot effect below; settings/permissions revoke outright.
    const changed = (change?: ModelAuthorityChange) => {
      if (change !== 'tree') revoke();
    };
    if (authority)
      transport.current = new ModelTransport(
        { fetch: globalThis.fetch.bind(globalThis), contains: request => chrome.permissions.contains(request) },
        authority,
      );
    const stop = authority?.subscribe(changed) ?? featureSettings?.subscribe(changed);
    window.addEventListener('pagehide', revoke);
    if (readOnlyTrial) setMessage('准备好后点击试分类；不会创建或移动书签。');
    else
      void rulesStore
        .load()
        .then(rules => {
          if (!live.current) return;
          setDraft(current => hydrateSaveRules(current, rules));
          setMessage(
            matchSiteRule(page.url, rules) ? '已检查网站规则；仍需确认。' : '可请求AI建议，或直接手动选择目录。',
          );
          if (automaticEligible.current && !matchSiteRule(page.url, rules)) setAutoSuggest(true);
        })
        .catch(() => {
          if (live.current) setMessage('规则读取失败；可手动收藏，不会覆盖规则。');
        });
    return () => {
      live.current = false;
      revoke();
      stop?.();
      transport.current?.dispose();
      window.removeEventListener('pagehide', revoke);
    };
  }, [featureSettings, rulesStore, page, readOnlyTrial]);
  // The draft follows the live tree; only a changed or missing destination folder touches an accepted suggestion.
  useEffect(() => {
    setDraft(current => rebaseSaveDraft(current, snapshot));
  }, [snapshot]);
  useEffect(() => {
    if (!connectionReady) {
      automaticEligible.current = false;
      setAutoSuggest(false);
    }
  }, [connectionReady]);
  useEffect(() => {
    if (autoSuggest) {
      setAutoSuggest(false);
      if (automaticEligible.current && !saveDuplicates(draft).length) void suggest();
    }
  }, [autoSuggest]);
  function patch(value: Partial<SaveDraft>) {
    setDraft(current => ({
      ...current,
      ...value,
      ...(value.directoryEdited ? { origin: 'manual' as const, aiInvalidated: false, source: '用户明确选择目录' } : {}),
    }));
  }
  async function suggest() {
    automaticEligible.current = false;
    if (suggestingLock.current) return;
    if (!connectionReady || !featureSettings || !transport.current || result || lock.current) {
      setMessage(readOnlyTrial ? '智能收藏模型尚不可用，请先在 AI 服务中完成配置。' : '模型未配置；请手动选择目录。');
      return;
    }
    const token = ++generation.current;
    suggestingLock.current = true;
    setSuggesting(true);
    if (readOnlyTrial) setDraft(current => invalidateSaveSuggestion(current));
    setMessage(readOnlyTrial ? '正在试分类，仅生成目录建议。' : '正在请求建议；可继续编辑，迟到建议不会覆盖手改目录。');
    let snippet: string | undefined;
    try {
      const config = await featureSettings.snapshot();
      if (!config.config) throw Error('configuration');
      if (!readOnlyTrial && bodyEnabled && config.privacy.bodyEnabled && extractBody) {
        try {
          snippet = await extractBody();
        } catch {
          if (live.current) setMessage('正文获取失败，降级为标题与网址；仍可手动收藏。');
        }
      }
      if (!live.current || token !== generation.current) return;
      const root = draft.snapshot.nodes.find(n => n.parentId === undefined && n.ref.kind === 'folder');
      if (!root) throw Error();
      const itemId = `current-page:${crypto.randomUUID()}`;
      const response = await transport.current.run({
        config: config.config,
        key: config.key,
        privacy: config.privacy,
        tree: draft.snapshot,
        request: {
          task: 'save',
          targetId: root.ref.nativeId,
          item: { source: 'current-page', id: itemId, title: page.title, url: page.url },
          folderIds: draft.snapshot.nodes.filter(n => n.childrenWritable).map(n => n.ref.nativeId),
          ...(snippet ? { snippet } : {}),
        },
      });
      snippet = undefined;
      if (!live.current || token !== generation.current) return;
      if (response.status !== 'completed') {
        setMessage(`AI未完成：${response.reason}${readOnlyTrial ? '；可检查配置后重试。' : '；可手动收藏。'}`);
        return;
      }
      if (!('assignments' in response.output)) throw Error();
      const assignment = response.output.assignments.find(a => a.itemId === itemId);
      if (!assignment) throw Error();
      const suggestion = saveSuggestionPath(draft, assignment.folderId, response.output.newFolders);
      setDraft(current =>
        current.directoryEdited || current.existingId
          ? current
          : {
              ...suggestion,
              title: current.title,
              rememberRule: current.rememberRule,
              includeSubdomains: current.includeSubdomains,
            },
      );
      setMessage(readOnlyTrial ? '试分类完成；未创建或移动任何书签。' : 'AI建议仅供确认；不会自动保存。');
    } catch {
      if (live.current && token === generation.current)
        setMessage(
          readOnlyTrial
            ? '模型或建议不可用，请检查智能收藏的服务、密钥和模型配置。'
            : '模型或建议不可用；请手动选择目录。',
        );
    } finally {
      suggestingLock.current = false;
      if (live.current) setSuggesting(false);
    }
  }
  async function saveRule(rule: SiteRule) {
    try {
      await rulesStore.set(rule);
      if (live.current) {
        setPendingRule(undefined);
        setMessage('书签与显式规则均已保存。');
      }
    } catch {
      if (live.current) {
        setPendingRule(rule);
        setMessage('书签已完成，但规则保存失败；重试仅写规则，不重复收藏。');
      }
    }
  }
  async function confirm() {
    if (readOnlyTrial || !connectionReady || lock.current || result) return;
    let request;
    try {
      request = prepareSave(draft, snapshot);
      if (page.token) request = { ...request, saveContext: page.token };
    } catch {
      setMessage('目录或树已变化，请取消后重新确认；未提交。');
      return;
    }
    lock.current = true;
    setBusy(true);
    generation.current++;
    transport.current?.cancel();
    const response = await submitMutation(request, send);
    if (live.current) setResult(response);
    if (response.status === 'completed' && draft.rememberRule) {
      let folder = draft.snapshot.nodes.find(n => n.ref.nativeId === draft.parentId)?.ref;
      if (draft.newFolder) {
        try {
          const evidence = mutationResultSchema.parse(await reconcile(request.requestId));
          const index = draft.proposedPath && draft.proposedPath.length > 1 ? draft.proposedPath.length - 1 : 0;
          folder = completedSaveFolder(evidence, request.requestId, request.installationId, index);
        } catch {
          folder = undefined;
          if (live.current) setMessage('书签已完成；新目录身份无法可靠核实，未建立规则。请在规则设置中检查。');
        }
      }
      if (folder) await saveRule({ host: siteHost(page.url), folder, includeSubdomains: draft.includeSubdomains });
    }
    if (live.current) setBusy(false);
  }
  const duplicates = saveDuplicates(draft);
  if (readOnlyTrial) {
    const folder = draft.snapshot.nodes.find(node => node.ref.nativeId === draft.parentId);
    return (
      <section className="surface" aria-label={t('当前网页试分类')}>
        <h2>{t('当前网页试分类')}</h2>
        <p>{page.title}</p>
        <p style={{ overflowWrap: 'anywhere' }}>{page.url}</p>
        <p>{t('使用「智能收藏」的模型。仅发送标题、按隐私设置处理的网址和目录结构，不读取正文。')}</p>
        <p>{t('结果只作预览，不会创建目录、收藏或移动书签。')}</p>
        {!connectionReady && <p role="status">{t('正在恢复目录连接，请稍候。')}</p>}
        {draft.origin === 'ai' && !draft.aiInvalidated && (
          <p role="status">
            {t('建议目录：{folder}', { folder: folder?.title || t('根目录') })}
            {draft.proposedPath?.length ? t(' / {path}（新目录建议）', { path: draft.proposedPath.join(' / ') }) : ''}
          </p>
        )}
        {draft.aiInvalidated && <p role="alert">{t('建议已失效，请重新试分类。')}</p>}
        <p role="status">{saveStatusText(language, message)}</p>
        <div className="actions">
          <button type="button" disabled={!connectionReady || suggesting} onClick={() => void suggest()}>
            {suggesting ? t('正在试分类…') : t('发送并试分类')}
          </button>
          {suggesting && (
            <button
              type="button"
              onClick={() => {
                generation.current++;
                transport.current?.cancel();
                setMessage('已取消试分类。');
              }}
            >
              {t('取消试分类')}
            </button>
          )}
          <button type="button" onClick={onClose}>
            {t('关闭试分类')}
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="surface" aria-label={t('收藏确认卡')}>
      {!connectionReady && <p role="status">{t('连接恢复中，草稿已保留；暂不能请求建议或确认保存。')}</p>}
      <h2>{t('收藏当前页面')}</h2>
      <p>{page.url}</p>
      <p>{localize(draft.source)}</p>
      {draft.aiInvalidated && <p role="alert">{t('模型配置已变化，请重新请求建议或明确选择目录。')}</p>}
      {!!duplicates.length && (
        <div>
          <p>{t('此网址已有书签；请选择打开或编辑，不会重复新增。')}</p>
          {duplicates.map(node => (
            <div key={node.ref.nativeId}>
              <span>
                {t('{title} · 目录 {folder} · 编号 {id}', {
                  title: node.title,
                  folder: node.parentId ?? '',
                  id: node.ref.nativeId,
                })}
              </span>
              <button disabled={busy} onClick={() => openUrl(node.url!)}>
                {t('打开已有 {id}', { id: node.ref.nativeId })}
              </button>
              <button
                disabled={busy || !!result}
                onClick={() => setDraft(selectSaveDuplicate(draft, node.ref.nativeId))}
              >
                {t('编辑已有 {id}', { id: node.ref.nativeId })}
              </button>
            </div>
          ))}
        </div>
      )}
      <label className="field">
        {t('收藏标题')}
        <input
          value={draft.title}
          disabled={busy || !!result}
          onChange={event => patch({ title: event.target.value })}
        />
      </label>
      <label className="field">
        {t('收藏目标目录')}
        <Select
          value={draft.parentId}
          disabled={busy || !!result}
          onChange={event => patch({ parentId: event.target.value, directoryEdited: true, proposedPath: undefined })}
        >
          <option value="">{t('请明确选择目录')}</option>
          {draft.snapshot.nodes
            .filter(n => n.childrenWritable)
            .map(n => (
              <option key={n.ref.nativeId} value={n.ref.nativeId}>
                {n.title || t('根目录')}（{n.ref.nativeId}）
              </option>
            ))}
        </Select>
      </label>
      {!duplicates.length && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.newFolder}
              disabled={busy || !!result}
              onChange={event =>
                patch({ newFolder: event.target.checked, directoryEdited: true, proposedPath: undefined })
              }
            />
            {t('明确创建新目录')}
          </label>
          {draft.newFolder && (
            <>
              <label className="field">
                {t('新目录名称')}
                <input
                  disabled={busy || !!result || (draft.proposedPath?.length ?? 0) > 1}
                  value={draft.folderTitle}
                  onChange={event =>
                    patch({ folderTitle: event.target.value, directoryEdited: true, proposedPath: undefined })
                  }
                />
              </label>
              <p>
                {t('将创建 {count} 个目录：{path}。确认保存即接受此路径；可取消新建后手动选择。', {
                  count: draft.proposedPath?.length || 1,
                  path: draft.proposedPath?.join(' / ') || draft.folderTitle,
                })}
              </p>
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={bodyEnabled}
              disabled={busy || !!result}
              onChange={event => {
                generation.current++;
                transport.current?.cancel();
                setDraft(invalidateSaveSuggestion);
                setBodyEnabled(event.target.checked);
              }}
            />
            {t('本次允许正文辅助（最多1500字；还需模型隐私设置开启）')}
          </label>
          <button disabled={!connectionReady || busy || !!result} onClick={() => void suggest()}>
            {t('请求AI建议')}
          </button>
          <button
            onClick={() => {
              automaticEligible.current = false;
              generation.current++;
              transport.current?.cancel();
              setMessage('已取消AI请求；不会自动重试。');
            }}
          >
            {t('取消AI请求')}
          </button>
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          disabled={busy || !!result}
          checked={draft.rememberRule}
          onChange={event => patch({ rememberRule: event.target.checked })}
        />
        {t('以后此网站默认存到这里')}
      </label>
      <label className="check">
        <input
          type="checkbox"
          disabled={busy || !!result || !draft.rememberRule}
          checked={draft.includeSubdomains}
          onChange={event => patch({ includeSubdomains: event.target.checked })}
        />
        {t('包含子域名')}
      </label>
      <p role="status">{saveStatusText(language, message)}</p>
      {result && <MutationFeedback result={result} />}
      {pendingRule && (
        <button disabled={busy} onClick={() => void saveRule(pendingRule)}>
          {t('仅重试保存规则')}
        </button>
      )}
      <button disabled={busy} onClick={onClose}>
        {result ? t('关闭结果') : t('取消收藏')}
      </button>
      <button
        disabled={!connectionReady || busy || !!result || !draft.parentId || (!!duplicates.length && !draft.existingId)}
        onClick={() => void confirm()}
      >
        {t('确认收藏保存')}
      </button>
    </section>
  );
}

import { ImportWorkbench } from '../panel/ImportWorkbench';
import { OrganizeWorkbench } from '../panel/OrganizeWorkbench';
import { SearchResults } from '../panel/SearchResults';
import { CurrentPageSave } from '../panel/CurrentPageSave';
import { SaveReceiptCard } from '../panel/SaveReceiptCard';
import { useEffect, useMemo, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { SettingsStore } from '../persistence/settings';
import { ThemeProvider, ThemePicker } from './ThemeProvider';
import './theme.css';
import { BookmarkTree } from '../panel/BookmarkTree';
import { PanelChrome, PanelFooter, SearchBox, type PopupView } from './PanelChrome';
import { OptionsNav, parseOptionsHash, ROUTE_META, type OptionsRoute } from './OptionsNav';
import { PopupSettings } from './PopupSettings';
import { PanelModePicker } from './PanelModePicker';
import { useSearchKey, useSearchLaunch } from './search-entry';
import { LocaleProvider, LanguagePicker, useI18n } from './i18n';
import { ModelSettings } from '../options/ModelSettings';
import { SiteRulesSettings } from '../options/SiteRulesSettings';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { ExportSettings } from '../options/ExportSettings';
import { DebugLogPanel, SaveHistory } from '../options/DebugLogPanel';
import {
  AiServicesPage,
  parseAiServicesHash,
  TAB_HASH,
  useAiServices,
  type AiServicesTab,
} from '../options/ai-services';

export type Page = 'panel' | 'options';
export type { OptionsRoute } from './OptionsNav';
const OPTIONS_PAGE = 'options/index.html';

/** The options page starts from its `#hash`; the popup always starts browsing. */
export function initialRoute(page: Page, hash: string): { route: OptionsRoute; aiTab: AiServicesTab } {
  if (page === 'panel') return { route: 'browse', aiTab: 'connected' };
  return { route: parseOptionsHash(hash), aiTab: parseAiServicesHash(hash) ?? 'connected' };
}

/** Opens the options page at a route in a new tab; false means the browser boundary is unavailable (jsdom). */
export function openOptionsRoute(route: string): boolean {
  if (typeof chrome === 'undefined' || typeof chrome.tabs?.create !== 'function' || !chrome.runtime?.getURL)
    return false;
  void Promise.resolve(chrome.tabs.create({ url: chrome.runtime.getURL(`${OPTIONS_PAGE}#${route}`) })).catch(() => {});
  return true;
}

function useShared() {
  const [settingsStore] = useState(() =>
    typeof chrome !== 'undefined' && chrome.storage?.local ? new SettingsStore(chrome.storage.local) : undefined,
  );
  useEffect(() => () => settingsStore?.dispose(), [settingsStore]);
  const ai = useAiServices(settingsStore);
  const aiController = useMemo(
    () => ({
      services: ai.services,
      features: ai.features,
      persistService: ai.persistService,
      removeService: ai.removeService,
      assignFeature: ai.assignFeature,
      assignFeatures: ai.assignFeatures,
      importConfig: ai.importConfig,
      exportConfig: ai.exportConfig,
      getCredential: ai.getCredential,
    }),
    [ai],
  );
  return { settingsStore, ai, aiController };
}

export function App({ page, overlay = false }: { page: Page; overlay?: boolean }) {
  return (
    <LocaleProvider>
      <ThemeProvider>{page === 'panel' ? <PopupApp overlay={overlay} /> : <OptionsApp />}</ThemeProvider>
    </LocaleProvider>
  );
}

/** Overlay sidebar: ask the injected host (our content script) to slide the sidebar away. */
function closeOverlay() {
  try {
    window.parent.postMessage({ type: 'zhilan-overlay-close' }, '*');
  } catch {
    /* not framed */
  }
}

function PopupApp({ overlay = false }: { overlay?: boolean }) {
  const { t } = useI18n();
  const { settingsStore, ai } = useShared();
  const [view, setView] = useState<PopupView>('browse');
  const [query, setQuery] = useState('');
  const [batchNonce, setBatchNonce] = useState(0);
  const [trialNonce, setTrialNonce] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  useSearchKey(() => {
    setView('browse');
    setFocusRequest(value => value + 1);
  });

  // Workbenches open in a settings tab; the overlay sidebar gets out of the way, the side panel stays.
  function open(route: string) {
    if (openOptionsRoute(route) && overlay) closeOverlay();
  }

  useEffect(() => {
    if (!overlay) return;
    // Esc closes the overlay unless a field or menu already used it (e.g. clearing the search box).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closeOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay]);

  return (
    <div className="shell panel">
      <a className="skip-link" href="#main">
        {t('跳到主要内容')}
      </a>
      <PanelChrome
        focusRequest={focusRequest}
        view={view}
        query={query}
        onQuery={setQuery}
        onSettings={() => {
          setQuery('');
          setView('settings');
        }}
        onBack={() => setView('browse')}
        onClose={overlay ? closeOverlay : undefined}
      />
      <main id="main" tabIndex={-1}>
        <div hidden={view !== 'browse'}>
          <SaveReceiptCard onOpen={open} />
          <CurrentPageSave settings={settingsStore} aiServices={ai.store} trialNonce={trialNonce} />
          <SearchResults
            query={query}
            settings={settingsStore}
            services={ai.store}
            onOrganize={() => open('organize')}
          />
          <section className="directory" aria-label={t('书签目录')} hidden={query.trim().length > 0}>
            <BookmarkTree batchNonce={batchNonce} />
          </section>
        </div>
        {view === 'settings' && (
          <PopupSettings
            onTrial={() => {
              setQuery('');
              setView('browse');
              setTrialNonce(value => value + 1);
            }}
            services={ai.services}
            features={ai.features}
            onOpenRoute={open}
            onOpenAiServices={tab => open(TAB_HASH[tab])}
            onAssignFeature={(featureId, connId, modelId) => {
              void Promise.resolve(ai.assignFeature(featureId, connId, modelId));
            }}
          />
        )}
      </main>
      {view === 'browse' && (
        <PanelFooter
          onOrganize={() => open('organize')}
          onImport={() => open('import')}
          onExport={() => open('export')}
          onBatch={() => setBatchNonce(value => value + 1)}
        />
      )}
    </div>
  );
}

function OptionsApp() {
  const { t, message } = useI18n();
  const { settingsStore, ai, aiController } = useShared();
  const [initial] = useState(() => initialRoute('options', typeof location === 'undefined' ? '' : location.hash));
  const [route, setRouteState] = useState<OptionsRoute>(initial.route);
  const [aiTab, setAiTab] = useState<AiServicesTab>(initial.aiTab);
  const [query, setQuery] = useState('');
  const [batchNonce, setBatchNonce] = useState(0);
  const [visited, setVisited] = useState<Set<OptionsRoute>>(() => new Set([initial.route]));
  const [exportRecoveryOpen, setExportRecoveryOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const searchLaunch = useSearchLaunch(setQuery);
  useSearchKey(() => {
    go('browse');
    setFocusRequest(value => value + 1);
  });

  useEffect(() => {
    function onHash() {
      const next = parseOptionsHash(location.hash);
      setRouteState(next);
      setVisited(previous => (previous.has(next) ? previous : new Set(previous).add(next)));
      const tab = parseAiServicesHash(location.hash);
      if (tab) setAiTab(tab);
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function go(next: OptionsRoute, tab?: AiServicesTab) {
    setRouteState(next);
    setVisited(previous => (previous.has(next) ? previous : new Set(previous).add(next)));
    if (tab) setAiTab(tab);
    const hash = next === 'ai-services' ? TAB_HASH[tab ?? aiTab] : next;
    if (typeof location !== 'undefined' && location.hash.replace(/^#/, '') !== hash) {
      history.replaceState(null, '', `#${hash}`);
    }
    window.scrollTo?.({ top: 0 });
  }

  const saveFeature = ai.features.find(feature => feature.id === 'save');
  const attention = saveFeature?.connId && saveFeature.modelId ? undefined : { 'ai-services': t('未配置') };
  const meta = ROUTE_META[route];
  // Heavy pages mount on first visit and then stay mounted so drafts and in-flight work survive navigation.
  const mounted = (id: OptionsRoute) => visited.has(id);

  return (
    <div className="shell options">
      <a className="skip-link" href="#main">
        {t('跳到主要内容')}
      </a>
      <OptionsNav route={route} onRoute={next => go(next)} attention={attention} />
      <div className="content">
        <header className={`page-head${meta.wide ? ' is-wide' : ''}`}>
          <div>
            <h1>{message(meta.title)}</h1>
            <p>{message(meta.desc)}</p>
          </div>
          {route === 'browse' ? (
            <button type="button" onClick={() => setBatchNonce(value => value + 1)}>
              <ListChecks aria-hidden="true" />
              {t('批量管理')}
            </button>
          ) : null}
        </header>
        <main id="main" tabIndex={-1} className={meta.wide ? 'is-wide' : undefined}>
          <div className="view" hidden={route !== 'browse'}>
            <SearchBox
              value={query}
              onChange={setQuery}
              focusRequest={focusRequest}
              autoFocus={searchLaunch.requested}
            />
            {searchLaunch.status && <p role="status">{message(searchLaunch.status)}</p>}
            <details>
              <summary>{t('快速搜索入口')}</summary>
              <p>
                {t(
                  '按 Alt+Shift+K 打开搜索。也可在地址栏输入 zl，按 Tab 或空格后输入关键词。智栏内按 Ctrl+K（Mac：⌘K）聚焦搜索。',
                )}
              </p>
              <p>{t('若快捷键被其他扩展占用，可在浏览器中重新设置。')}</p>
              <button
                type="button"
                onClick={() => {
                  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {});
                }}
              >
                {t('设置浏览器搜索快捷键')}
              </button>
            </details>
            <SearchResults
              query={query}
              settings={settingsStore}
              services={ai.store}
              onOrganize={() => go('organize')}
            />
            <section className="directory" aria-label={t('书签目录')} hidden={query.trim().length > 0}>
              <BookmarkTree batchNonce={batchNonce} />
            </section>
          </div>
          <div className="view" hidden={route !== 'organize'}>
            <OrganizeWorkbench visible={route === 'organize'} settings={settingsStore} aiServices={ai.store} />
          </div>
          <div className="view" hidden={route !== 'import'}>
            <ImportWorkbench visible={route === 'import'} settings={settingsStore} aiServices={ai.store} />
          </div>
          {mounted('export') && (
            <div className="view" hidden={route !== 'export'}>
              <ExportSettings visible={route === 'export'} />
              <details
                className="surface workflow-help"
                onToggle={event => setExportRecoveryOpen(event.currentTarget.open)}
              >
                <summary>{t('备份与恢复记录')}</summary>
                <RecoveryWorkbench visible={route === 'export' && exportRecoveryOpen} />
              </details>
            </div>
          )}
          <div className="view" hidden={route !== 'ai-services'}>
            {route === 'ai-services' && (
              <AiServicesPage
                tab={aiTab}
                onTab={tab => go('ai-services', tab)}
                controller={aiController}
                settings={settingsStore}
              />
            )}
          </div>
          <div className="view" hidden={route !== 'appearance'}>
            <section className="surface" aria-label={t('外观设置')}>
              <LanguagePicker />
              <ThemePicker extra={<PanelModePicker />} />
            </section>
          </div>
          {mounted('privacy') && (
            <div className="view" hidden={route !== 'privacy'}>
              <ModelSettings showHeading={false} store={settingsStore} fields="privacy" />
              <SiteRulesSettings />
            </div>
          )}
          {mounted('debug') && (
            <div className="view" hidden={route !== 'debug'}>
              <SaveHistory onOpen={hash => go(parseOptionsHash(hash), parseAiServicesHash(hash) ?? undefined)} />
              <DebugLogPanel />
              <details className="surface settings-help">
                <summary>{t('旧版单连接模型配置（兼容）')}</summary>
                <p>
                  {t(
                    '新版请在「AI 服务」里连接并按功能分配模型；这里保留旧的单连接配置，供尚未迁移的搜索 / 整理 / 导入路径使用。',
                  )}
                </p>
                <ModelSettings showHeading={false} store={settingsStore} fields="model" />
              </details>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

import { ImportWorkbench } from '../panel/ImportWorkbench';
import { OrganizeWorkbench } from '../panel/OrganizeWorkbench';
import { SearchWorkspace } from '../panel/SearchWorkspace';
import type { SearchSource } from '../domain/history-search';
import { OnboardingSteps } from '../panel/OnboardingSteps';
import { useOnboarding } from '../panel/use-onboarding';
import { CurrentPageSave } from '../panel/CurrentPageSave';
import { SaveReviewLauncher, SaveReviewQueue } from '../panel/SaveReview';
import { useEffect, useMemo, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { SettingsStore } from '../persistence/settings';
import { ThemeProvider, ThemePicker } from './ThemeProvider';
import './theme.css';
import '../panel/save-dialog.css';
import { SAVE_CONFIRM_PORT } from '../persistence/save-confirm';
import { BookmarkTree } from '../panel/BookmarkTree';
import { PanelChrome, PanelFooter, SearchBox, type PopupView } from './PanelChrome';
import { OptionsNav, parseOptionsHash, ROUTE_META, type OptionsRoute } from './OptionsNav';
import { PopupSettings } from './PopupSettings';
import { PanelModePicker } from './PanelModePicker';
import { useSearchKey, useSearchLaunch } from './search-entry';
import { LocaleProvider, LanguagePicker, useI18n } from './i18n';
import { startPreferenceSync } from './preferences-sync';
import { ModelSettings } from '../options/ModelSettings';
import { SiteRulesSettings } from '../options/SiteRulesSettings';
import { RecoveryWorkbench } from '../options/RecoveryWorkbench';
import { ExportSettings } from '../options/ExportSettings';
import { TokenUsage } from '../options/TokenUsage';
import { PersonalizationSettings } from '../options/PersonalizationSettings';
import { DebugLogPanel, SaveHistory } from '../options/DebugLogPanel';
import {
  AiServicesPage,
  parseAiServicesHash,
  TAB_HASH,
  useAiServices,
  type AiServicesTab,
} from '../options/ai-services';

export type Page = 'panel' | 'options' | 'save';
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
  useEffect(startPreferenceSync, []);
  return (
    <LocaleProvider>
      <ThemeProvider>
        {page === 'panel' ? <PopupApp overlay={overlay} /> : page === 'save' ? <SaveApp /> : <OptionsApp />}
      </ThemeProvider>
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
  const [searchSource, setSearchSource] = useState<SearchSource>('bookmarks');
  const [recentBookmarks, setRecentBookmarks] = useState(false);
  const [batchNonce, setBatchNonce] = useState(0);
  const onboarding = useOnboarding();
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
        searchSource={searchSource}
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
          <SaveReviewLauncher />
          {onboarding.visible && !query.trim() && searchSource === 'bookmarks' && !recentBookmarks && (
            <OnboardingSteps
              onConfigure={() => open('ai-services/add')}
              onSearch={() => setFocusRequest(value => value + 1)}
              onOrganize={() => open('organize')}
              onDismiss={onboarding.dismiss}
            />
          )}
          {onboarding.saveFailed && <p role="status">{t('关闭状态未能保存，下次打开可能仍会显示步骤。')}</p>}
          <SearchWorkspace
            query={query}
            source={searchSource}
            onSource={setSearchSource}
            recentBookmarks={recentBookmarks}
            onRecentBookmarks={setRecentBookmarks}
            visible={view === 'browse'}
            settings={settingsStore}
            services={ai.store}
            onOrganize={() => open('organize')}
          />
          <section
            className="directory"
            aria-label={t('书签目录')}
            hidden={query.trim().length > 0 || searchSource !== 'bookmarks' || recentBookmarks}
          >
            <BookmarkTree
              batchNonce={batchNonce}
              positionActive={
                view === 'browse' &&
                !query.trim() &&
                searchSource === 'bookmarks' &&
                !recentBookmarks &&
                !onboarding.visible
              }
            />
          </section>
        </div>
        {view === 'settings' && (
          <PopupSettings
            onOnboarding={() => {
              setQuery('');
              setSearchSource('bookmarks');
              setRecentBookmarks(false);
              setView('browse');
              onboarding.show();
              document.getElementById('main')?.scrollTo?.({ top: 0 });
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

const closePopup = () => window.close();

/** The toolbar popup anchored by the bookmark star; it sizes itself to this content. */
function SaveApp() {
  const { settingsStore, ai } = useShared();
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) window.close();
    };
    window.addEventListener('keydown', close);
    // Presence only: when this popup goes away the worker returns the toolbar click to the sidebar.
    const presence =
      typeof chrome !== 'undefined' && chrome.runtime?.connect
        ? chrome.runtime.connect({ name: SAVE_CONFIRM_PORT })
        : undefined;
    return () => {
      window.removeEventListener('keydown', close);
      presence?.disconnect();
    };
  }, []);
  return (
    <main className="save-pop">
      <CurrentPageSave settings={settingsStore} aiServices={ai.store} dialog onActive={setCapturing} />
      <div className="save-pop-body" hidden={capturing}>
        <SaveReviewQueue onOpen={openOptionsRoute} onClose={closePopup} />
      </div>
    </main>
  );
}

function OptionsApp() {
  const { t, message } = useI18n();
  const { settingsStore, ai, aiController } = useShared();
  const [initial] = useState(() => initialRoute('options', typeof location === 'undefined' ? '' : location.hash));
  const [route, setRouteState] = useState<OptionsRoute>(initial.route);
  const [aiTab, setAiTab] = useState<AiServicesTab>(initial.aiTab);
  const [query, setQuery] = useState('');
  const [searchSource, setSearchSource] = useState<SearchSource>('bookmarks');
  const [recentBookmarks, setRecentBookmarks] = useState(false);
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
          </div>
          <LanguagePicker />
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
              source={searchSource}
              value={query}
              onChange={setQuery}
              focusRequest={focusRequest}
              autoFocus={searchLaunch.requested}
            />
            {searchLaunch.status && <p role="status">{message(searchLaunch.status)}</p>}
            <details>
              <summary>{t('快速搜索入口')}</summary>
              <button
                type="button"
                onClick={() => {
                  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {});
                }}
              >
                {t('设置浏览器搜索快捷键')}
              </button>
            </details>
            <SearchWorkspace
              query={query}
              source={searchSource}
              onSource={setSearchSource}
              recentBookmarks={recentBookmarks}
              onRecentBookmarks={setRecentBookmarks}
              visible={route === 'browse'}
              settings={settingsStore}
              services={ai.store}
              onOrganize={() => go('organize')}
            />
            <section
              className="directory"
              aria-label={t('书签目录')}
              hidden={query.trim().length > 0 || searchSource !== 'bookmarks' || recentBookmarks}
            >
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
          {mounted('token-usage') && (
            <div className="view" hidden={route !== 'token-usage'}>
              <TokenUsage visible={route === 'token-usage'} />
            </div>
          )}
          <div className="view" hidden={route !== 'appearance'}>
            <section className="surface" aria-label={t('外观设置')}>
              <p className="hint">{t('使用页面顶部的语言选项切换简体中文或 English，立即生效。')}</p>
              <ThemePicker extra={<PanelModePicker />} />
            </section>
          </div>
          {mounted('privacy') && (
            <div className="view" hidden={route !== 'privacy'}>
              <ModelSettings showHeading={false} store={settingsStore} fields="privacy" />
              <SiteRulesSettings />
            </div>
          )}
          {mounted('personalization') && (
            <div className="view" hidden={route !== 'personalization'}>
              <PersonalizationSettings
                settings={settingsStore}
                services={ai.store}
                visible={route === 'personalization'}
              />
            </div>
          )}
          {mounted('debug') && (
            <div className="view" hidden={route !== 'debug'}>
              <SaveHistory onOpen={hash => go(parseOptionsHash(hash), parseAiServicesHash(hash) ?? undefined)} />
              <DebugLogPanel />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

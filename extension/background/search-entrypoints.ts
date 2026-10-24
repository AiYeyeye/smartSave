import { browserMessage, onBrowserLanguageChange } from '../domain/browser-message';
import { SearchIndex, type SearchHit } from '../domain/search-index';
import { canOpenUrl } from '../domain/open-url';
import { extensionDocumentKind } from '../domain/trusted-sender';
import type { TreeProjection } from './tree-projection';
import type { BookmarkKeywordRecord } from '../domain/bookmark-keywords';

type Browser = Pick<typeof chrome, 'omnibox' | 'commands' | 'tabs' | 'runtime'>;
const escapeXml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);

/** Explicit browser gestures only. Queries stay in worker memory; page URLs contain only one-use launch tokens. */
export function startSearchEntrypoints(
  projection: Pick<TreeProjection, 'state' | 'fresh'>,
  browser: Browser = chrome,
  keywords?: () => Promise<BookmarkKeywordRecord[]>,
) {
  const launches = new Map<string, { query: string; expires: number }>();
  let generation = 0;
  let query = '';
  const offered = new Map<string, { hit: SearchHit; installationId: string }>();
  let cached: { snapshot: unknown; records: BookmarkKeywordRecord[] | undefined; index: SearchIndex } | undefined;

  async function navigate(url: string, disposition: string, tabId?: number) {
    if (disposition === 'currentTab' && tabId !== undefined) await browser.tabs.update(tabId, { url });
    else await browser.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
  }
  async function openSearch(text: string, disposition = 'newForegroundTab', tabId?: number) {
    for (const [id, value] of launches) if (value.expires < Date.now()) launches.delete(id);
    while (launches.size >= 16) launches.delete(launches.keys().next().value!);
    const token = crypto.randomUUID();
    launches.set(token, { query: text, expires: Date.now() + 60_000 });
    try {
      await navigate(browser.runtime.getURL(`options/index.html#search/${token}`), disposition, tabId);
    } catch {
      launches.delete(token);
    }
  }
  browser.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'claimSearchLaunch') return false;
    if (
      extensionDocumentKind(sender, browser.runtime.id) !== 'options' ||
      sender.frameId !== 0 ||
      typeof message.token !== 'string' ||
      sender.url !== browser.runtime.getURL(`options/index.html#search/${message.token}`)
    )
      return false;
    const launch = launches.get(message.token);
    launches.delete(message.token);
    reply(launch && launch.expires >= Date.now() ? { query: launch.query } : { error: 'expired' });
    return false;
  });
  browser.commands?.onCommand.addListener(command => {
    if (command === 'search-bookmarks') void openSearch('');
  });
  if (!browser.omnibox) return;
  const reset = () => {
    generation++;
    query = '';
    offered.clear();
  };
  browser.omnibox.onInputStarted.addListener(reset);
  browser.omnibox.onInputCancelled.addListener(reset);
  const refreshLanguage = () => browser.omnibox!.setDefaultSuggestion({ description: browserMessage('searchSuggestion') });
  refreshLanguage();
  onBrowserLanguageChange(refreshLanguage);
  browser.omnibox.onInputChanged.addListener((text, suggest) => {
    const current = ++generation;
    query = text;
    offered.clear();
    void (async () => {
      try {
        const snapshot = projection.state.status === 'ready' ? projection.state.snapshot : await projection.fresh();
        const records = await keywords?.().catch(() => undefined);
        if (current !== generation) return;
        if (cached?.snapshot !== snapshot || cached.records !== records)
          cached = { snapshot, records, index: new SearchIndex(snapshot, records) };
        const results = text.trim()
          ? cached.index
              .query(text)
              .filter(hit => canOpenUrl(hit.url))
              .slice(0, 8)
          : [];
        const suggestions = results.map(hit => {
          const content = `zhilan-result:${crypto.randomUUID()}`;
          offered.set(content, { hit, installationId: snapshot.installationId });
          return {
            content,
            description: `<match>${escapeXml(hit.title.slice(0, 200) || browserMessage('untitledBookmark'))}</match> <dim>${escapeXml(hit.path.slice(0, 200))}</dim>`,
          };
        });
        suggest(suggestions);
      } catch {
        if (current === generation) suggest([]);
      }
    })();
  });
  browser.omnibox.onInputEntered.addListener((text, disposition) => {
    const selection = offered.get(text);
    const fallback = selection || text.startsWith('zhilan-result:') ? query : text;
    reset();
    // Capture the activation tab before awaiting a native reread, never update a later active tab.
    const origin =
      disposition === 'currentTab' ? browser.tabs.query({ active: true, currentWindow: true }) : Promise.resolve([]);
    let tabId: number | undefined;
    void (async () => {
      tabId = (await origin)[0]?.id;
      if (selection) {
        const snapshot = await projection.fresh();
        const node = snapshot.nodes.find(
          node => node.ref.nativeId === selection.hit.id && node.ref.kind === 'bookmark',
        );
        if (
          snapshot.installationId === selection.installationId &&
          node?.url === selection.hit.url &&
          canOpenUrl(node.url)
        ) {
          await navigate(node.url, disposition, tabId);
          return;
        }
      }
      await openSearch(fallback, disposition, tabId);
    })().catch(() => {
      void openSearch(fallback, disposition, tabId);
    });
  });
}

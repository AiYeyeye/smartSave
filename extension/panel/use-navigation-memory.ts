import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { TreeSnapshot } from '../domain/node-reference';
import { NavigationMemory, type NavigationPosition } from './navigation-memory';

/** Restore only this visible directory, after its expansion has hydrated. Never follows storage events. */
export function useNavigationMemory(
  list: RefObject<HTMLUListElement | null>,
  snapshot: TreeSnapshot,
  active: boolean,
  ready: boolean,
) {
  const current = useRef({ snapshot, ready });
  current.current = { snapshot, ready };
  const restore = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const tree = list.current;
    const host = tree?.closest<HTMLElement>('.shell.panel > main');
    if (!active || !tree || !host || typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const memory = new NavigationMemory(chrome.storage.local);
    let live = true;
    let loaded = false;
    let settled = false;
    let interacted = false;
    let writable = true;
    let saved: NavigationPosition | undefined;
    let latest: NavigationPosition | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    let lastWrite = 0;
    let signature = '';
    let restoredTop: number | undefined;
    const visible = () => !tree.closest('[hidden]') && host.clientHeight > 0;
    const rows = () => Array.from(tree.children) as HTMLElement[];
    function capture() {
      if (!settled || !current.current.ready || !visible()) return;
      const items = rows();
      const top = host!.getBoundingClientRect().top + host!.clientTop;
      // Rows are ordered and flat, so finding the first visible one needs only O(log n) layout reads.
      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (items[middle]!.getBoundingClientRect().bottom <= top) low = middle + 1;
        else high = middle;
      }
      const row = items[Math.min(low, items.length - 1)];
      const anchor = row?.dataset.nodeId;
      if (!row || !anchor) return;
      const nodes = new Map(current.current.snapshot.nodes.map(node => [node.ref.nativeId, node]));
      const fallback: string[] = [];
      let parent = nodes.get(anchor)?.parentId;
      while (parent && fallback.length < 32 && !fallback.includes(parent)) {
        fallback.push(parent);
        parent = nodes.get(parent)?.parentId;
      }
      for (const neighbor of [items[low + 1], items[low - 1]]) {
        const id = neighbor?.dataset.nodeId;
        if (id) fallback.push(id);
      }
      latest = {
        version: 1,
        installationId: snapshot.installationId,
        anchor,
        fallback,
        offset: row.getBoundingClientRect().top - top,
        scrollTop: host!.scrollTop,
        at: Math.max(Date.now(), (latest?.at ?? 0) + 1),
      };
    }
    function flush() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!writable || !latest) return;
      const next = JSON.stringify([latest.anchor, latest.offset, latest.scrollTop, latest.fallback]);
      if (next === signature) return;
      signature = next;
      lastWrite = Date.now();
      void memory.save(latest).catch(() => {});
    }
    function scroll() {
      if (!settled || !visible()) return;
      if (restoredTop !== undefined) {
        const restored = host!.scrollTop === restoredTop;
        restoredTop = undefined;
        if (restored) return;
      }
      capture();
      if (Date.now() - lastWrite >= 150) flush();
      else {
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 150);
      }
    }
    function interaction() {
      // User intent wins over an asynchronous initial read or an animation finishing later.
      interacted = true;
      if (loaded) settled = true;
      capture();
      flush();
    }
    function leave() {
      // An untouched restored panel losing focus must not replace a newer visit from another window.
      if (interacted || latest) capture();
      flush();
    }
    const tryRestore = () => {
      if (!live || settled || !loaded || !current.current.ready || !visible()) return;
      if (interacted) {
        settled = true;
        capture();
        flush();
        return;
      }
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (!live || interacted || !current.current.ready || !visible()) return;
        if (saved) {
          const items = rows();
          const row = [saved.anchor, ...saved.fallback]
            .map(id => items.find(item => item.dataset.nodeId === id))
            .find(Boolean);
          const target = row
            ? host!.scrollTop +
              row.getBoundingClientRect().top -
              host!.getBoundingClientRect().top -
              host!.clientTop -
              saved.offset
            : saved.scrollTop;
          host!.scrollTop = Math.max(0, Math.min(target, host!.scrollHeight - host!.clientHeight));
          restoredTop = host!.scrollTop;
        }
        settled = true;
        // A restore is not a new user visit and must never overwrite a later visit in another panel.
      });
    };
    restore.current = tryRestore;
    host.addEventListener('scroll', scroll, { passive: true });
    // Capture phase snapshots the directory before a click hides it or opens a new browser tab.
    const shell = host.closest('.shell.panel')!;
    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
      shell.addEventListener(event, interaction, { capture: true, passive: true });
    shell.addEventListener('click', interaction, true);
    window.addEventListener('pagehide', leave);
    const visibility = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    document.addEventListener('visibilitychange', visibility);
    // Ignore the shell's entrance transform when measuring the anchor.
    const animations =
      host
        .getAnimations?.({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished) ?? [];
    void Promise.allSettled(animations).then(async () => {
      try {
        saved = await memory.load(snapshot.installationId);
      } catch {
        writable = false;
      }
      if (!live) return;
      loaded = true;
      tryRestore();
    });
    return () => {
      live = false;
      // The list may already be hidden/removed; use the last actual visible snapshot.
      flush();
      if (frame !== undefined) cancelAnimationFrame(frame);
      host.removeEventListener('scroll', scroll);
      for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
        shell.removeEventListener(event, interaction, true);
      shell.removeEventListener('click', interaction, true);
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', visibility);
      restore.current = () => {};
    };
  }, [active, snapshot.installationId, list]);
  useLayoutEffect(() => {
    restore.current();
  }, [ready, snapshot]);
}

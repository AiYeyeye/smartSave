# Zhilan quick guide

Zhilan works with native Chrome / Edge bookmarks. No Zhilan account is required. Start with local browsing and search; AI is optional.

1. **Install:** follow [installation](install.md), build the source and load `extension/dist` unpacked. Pin the toolbar icon. A click opens the overlay sidebar; Appearance can switch to the browser side panel. Settings opens the full workspace. A store link will be added after publication.
2. **Find bookmarks:** search by title, URL, folder, Chinese pinyin or initials locally. Click a result to open it. Use the context menu or actions button to edit, move, copy or delete. `Alt+Shift+K` opens search; `Ctrl+K` / `⌘K` focuses search inside Zhilan. In the address bar type `zl`, Tab/Space, then a query.
3. **Connect AI:** in **AI services**, add an existing provider, enter the endpoint/key, fetch and explicitly select a model, then assign models to features. Provider charges apply. Remembered keys are stored in plaintext in extension-local storage; the add-connection form currently selects remember by default. Temporary keys are page-scoped and are generally unavailable to background native-save classification. The current-page trial sends permitted page metadata but does not save or move a bookmark.
4. **Save:** once configured, use the browser star or `Ctrl+D`. Local rules may classify the bookmark without AI; otherwise the configured service may receive allowed metadata. If classification fails, the native bookmark remains. Inspect receipts to correct or undo; saving a website rule requires a separate confirmation.
5. **AI search:** click **AI help me find** explicitly. Deep search examines all allowed bookmarks in batches and can cost more. Ordinary search stays local.
6. **Organize:** select a scope, generate and review the folder plan, analyze bookmarks, inspect proposed changes, then confirm execution. Generation can continue in the background. Interrupted work requires explicit continuation. Review duplicate groups and original URLs before confirming deletion.
7. **Import/export:** import HTML, JSON, CSV, TXT or Markdown and review before applying. Export selected bookmarks as HTML, JSON or Markdown. Exports contain original URLs, exclude keys/settings/rules/logs and are not complete recovery backups. Optional automatic JSON output overwrites a dedicated authorized file while the browser is running.
8. **Recover:** open Export & backup, expand backup/recovery records, preview undo and confirm. For unknown outcomes, reconcile current state without replaying. Do not clear storage or uninstall to hide an unresolved operation; see [recovery](recovery.md).

Review **Privacy & rules** before enabling AI. Exclude private folders, optionally strip query/fragment from AI URLs, and keep page-body assistance off unless needed. AI exclusions do not change export scope. See the [privacy policy](privacy.en.md).

[Screenshots and Chinese walkthrough](user-guide.md) · [Silent video with synthetic bookmarks](media/zhilan-quick-tour.mp4) · [Support](../SUPPORT.md)

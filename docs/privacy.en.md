# Zhilan Privacy Policy

Effective and updated: October 15, 2026. Applies to the current Zhilan 0.1.0 candidate maintained by Astraxine. Contact: [mmgnosit@gmail.com](mailto:mmgnosit@gmail.com). [简体中文](privacy.md).

## Overview

Zhilan manages native browser bookmarks. It requires no Zhilan account and currently operates no product backend, telemetry, advertising or analytics service. The maintainer does not automatically receive your bookmarks, keys or diagnostic logs. Enabling AI sends permitted information to your chosen endpoint; the browser may independently synchronize bookmarks and preferences.

## Local data and synchronization

The extension reads bookmark titles, original URLs, folder hierarchy and native identifiers. Local extension storage and IndexedDB contain model connections, feature assignments, privacy choices, website rules, recent save receipts, generated search keywords, organization/import checkpoints, mutation evidence, backups and recovery records. Some contain original titles and URLs.

Remembered API keys are stored in **plaintext extension-local storage**, not an operating-system vault. The new-connection dialog currently selects remember by default. Unremembered credentials are held in the owning page or task's memory; closing/reloading the page or ending the worker/task can discard them. They are not a shared browser-session key.

Local Token accounting stores usage, model and purpose metadata, without keys, prompts, endpoints or bookmark content. It retains lifetime totals, approximately 30 days of daily groups and the latest 100 attempts; it currently has no individual clear control. Save receipts retain the latest 30 entries. Other records follow their individual capacity and state rules, with no universal automatic expiry.

Debug logging is off by default. If enabled, bounded, redacted request/response details remain local and **can still contain bookmark metadata and optional page snippets**. Limits are 400 entries, approximately 1 MiB overall and 64 Ki characters per body. Disable and clear them in Save history & debug. Inspect any diagnostic export before sharing it.

Only language, appearance mode and accent synchronize through browser storage.sync. Keys, endpoints, rules, bookmark keywords and recovery records do not use that preference-sync feature. Native bookmark synchronization is controlled by your browser account. Browser/profile or system backups may separately copy local data.

## AI requests

Requests go directly to your configured provider or gateway, including the required authentication. That service receives the request and connection metadata such as your IP address.

- Native-save classification can run automatically after a browser-star/Ctrl+D save when configured. It sends allowed title/URL, folder context and preferences unless a local rule avoids the request.
- Explicit current-page capture uses permitted title/URL and folder context. The separately confirmed trial sends no page body and performs no bookmark writes. Optional page-body assistance is off by default and, when enabled for an active save, extracts at most 1,500 Unicode characters. There is no background crawling.
- Ordinary search is local. Explicit fast AI search sends a query and up to 80 permitted candidates' titles, URLs and paths. Above 80 bookmarks, a query-only expansion request precedes local candidate retrieval. Explicit deep search examines all allowed bookmarks in bounded batches before comparing shortlisted results.
- Organization sends the selected allowed folder hierarchy/counts, a few title samples, batches of bookmark metadata, destinations and your instructions. Import classification sends parsed titles/URLs, bounded source paths/samples and destination context, without fetching imported websites.
- Model discovery authenticates to the configured endpoint. Connection tests use synthetic content; the current-page trial is a separate feature.

Full URL transmission, including query strings and fragments, currently defaults on. Disabling it strips these components only from AI URL fields; native bookmarks, exports and backups retain originals. Excluded folders and descendants are removed from AI context. Internal/loopback bookmark addresses are not automatically excluded. Export scope is independent of AI exclusions.

Provider retention, training, subprocessors, processing locations and deletion depend on the chosen service's terms. Zhilan cannot guarantee their practices or erase information already sent. Review the actual provider/gateway policy first. Local-model mode does not automatically fall back to the cloud. Model responses are validated data, not executable remote code; bulk native writes require preview and confirmation.

## Other connections and permissions

Optional, user-initiated OpenRouter sign-in requests identity and its host permission, opens the provider's authorization page and exchanges a code/PKCE verifier for API credentials. Zhilan does not receive your account password. See [OpenRouter privacy](https://openrouter.ai/privacy).

Favicons use the browser-owned favicon API, with no extension-integrated third-party icon service; the browser controls its own retrieval/cache. Opening a bookmark visits the destination under its policy. If you contact support by GitHub or email, the platform and maintainer process what you choose to send for support.

Required permissions support bookmarks, local settings/preferences, user-triggered current-tab extraction/overlay injection, context menus, favicons and the native side panel. Optional identity supports sign-in; optional HTTP(S) host access is requested for specific model hosts. Installation does not grant all-site access. The overlay document is web-accessible; there are no persistent manifest content scripts.

## Control, retention and deletion

You may disable AI, revoke host access, remove connections and clear diagnostics. Credentials can exist in both connection storage and a compatibility envelope: **deleting one connection/key does not guarantee all local copies are removed**. Revoke credentials at the provider to invalidate them completely.

There is currently no universal in-app data eraser. Recovery cleanup preserves required deduplication evidence and refuses some unresolved/referenced records. To remove all local extension data, first reconcile unknown operations, preserve needed information and stop automatic output, then use browser extension-data controls or uninstall. This loses local recovery capability. Zhilan does not intentionally delete native bookmarks or external exports on uninstall.

Bookmark exports contain selected titles, hierarchy and original URLs, without keys/settings/rules/logs; they are not complete recovery backups. Public AI configuration exports omit credentials but can include endpoints and model assignments. Automatic JSON output overwrites only a dedicated user-selected authorized file. Stopping/uninstalling does not remove it. Manage exported files, synchronized copies and provider-held data separately.

## Limited Use and updates

Zhilan uses data only for disclosed bookmark management, user-chosen AI assistance and necessary operations. It does not sell user data or use it for advertising, creditworthiness or unrelated purposes. The maintainer does not automatically read user content. The use and transfer of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

We update this policy when behavior changes and show the update date. New processing requiring consent should be disclosed in the product. Contact Astraxine at [mmgnosit@gmail.com](mailto:mmgnosit@gmail.com) for privacy questions or access/deletion requests relating to support information you provided. We cannot delete data held by your chosen provider on your behalf.

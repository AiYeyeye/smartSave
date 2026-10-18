# Bookmark export JSON v1

Status: bounded task11A source contract. No export UI, file writer or automatic output is delivered by this slice. JSON is a selected bookmark projection, **not a full recovery backup** or installation/native-write authorization.

## Public protocol

Machine-readable schema: `extension/export/json-schema.json` (JSON Schema draft-07).

```json
{
  "format": "markora.bookmarks",
  "schemaVersion": 1,
  "generatedAt": "2026-09-09T00:00:00Z",
  "roots": [{"type":"folder","id":"n1","title":"资料/参考","path":["资料/参考"],"children":[]}]
}
```

- `format` must be exactly `markora.bookmarks`; `schemaVersion` must be integer 1. Reject unknown versions, never reinterpret them as v1. The actual task10 JSON parser already rejects unknown versions for this format. That parser is a general link extractor, not a complete public-schema validator.
- `generatedAt` is an explicit caller-supplied RFC3339 timestamp representing projection creation, not successful file close. The native read model currently exposes no native timestamps; none are invented.
- `roots` is an ordered list of selected folder subtrees, not the browser virtual root. An empty list is valid when exclusions remove all selected roots. Selection itself must be explicit and nonempty. Duplicate roots collapse; selected descendants of selected ancestors collapse. Surviving root order follows first selection occurrence; children retain native `childrenIds` order.
- Folders have `type`, `id`, `title`, `children`; empty folders have `children: []`. Bookmarks have `type`, `id`, `title`, `url`, no children. Empty titles are permitted.
- IDs are unique **within this document**, allocated preorder as `n1`, `n2`, etc. They are not native IDs, stable cross-export identities, installation identities or recovery references. Do not join files by ID. Schema draft-07 cannot express global ID uniqueness; independent consumers must check it as a semantic invariant.
- The producer always emits `path`: an array of title segments, from the selected root through the current node **including its own title**. Names containing slashes, quotes or empty strings remain literal segments. Ancestors outside selected roots are not disclosed. Paths are optional in v1 schema for compatibility with the original technical `export-v1.json` fixture; when absent derive them from nesting. When present they must agree with nesting (semantic invariant beyond JSON Schema).
- URL is the exact original string, including query, fragment, credentials, historical unsupported protocols and unusual spelling. JSON does not execute it. Consumers must apply their own execution policy. Never inject JSON into inline HTML/script; parse as JSON and display strings as text.
- Schema rejects additional fields. No model settings, keys, body, rules, task logs, lineage or native IDs are output. AI URL reduction/exclusions do not control export. Export exclusions independently remove the folder and all descendants, including explicitly selected descendants of excluded ancestors. Missing/foreign/invalid references fail closed rather than falling back to all bookmarks.

## Shared callable API

`createExportProjection(tree, {roots: NodeRef[], excludedFolders: NodeRef[]}, generatedAt)` returns a deeply frozen `ExportProjection`. `serializeExportJSON`, `serializeExportHTML`, `serializeExportMarkdown` consume that same object and return strings; no downloads, handles, Chrome calls, model calls or file effects occur. The private WeakMap proof is page/worker-memory only; serialization rejects fabricated/cloned projection objects.

`assertExportProjectionCurrent(projection, currentTree)` rejects any source snapshot difference, including root deletion/rename/move, installation, epoch or revision changes. This conservative check includes unrelated changes. Future render/write owners must obtain a fresh snapshot and check after asynchronous boundaries; regenerate explicitly when stale. It is not a transactional guarantee against undelivered browser changes. Automatic JSON must reuse this projection/serializer, not rebuild a parallel scope algorithm. Actual file generation/permission/close handling remains task11B.

## Other formats and inert data

Netscape-style HTML uses escaped H3 folders and HTTP(S) anchors. Dangerous/invalid/unsupported URLs are escaped CODE text without href. A restrictive CSP is defense in depth; safety does not depend on it. Markdown uses nested lists and escaped entity labels/destinations for supported HTTP(S). Unsupported destinations use a fixed `<code>` element with entity-escaped original text, never Markdown links or user-controlled HTML. Entities preserve original controls in decoded text; visual whitespace remains renderer-dependent. Export execution eligibility belongs solely to `export/link-policy.ts::isExportLinkClickable`: parseable HTTP(S), no surrounding trim whitespace or ASCII controls/spaces. It does not import or delegate to import write eligibility; changing the import allowlist must not broaden exported executable links. Matching current HTTP(S) policies was architectural coupling, not evidence of an existing vulnerability. JSON remains the lossless machine protocol; HTML/Markdown preserve safe URL/title roundtrips through actual task10 parsers but do not promise unsupported URL re-import or lossless control-character display. Markdown parser does not reconstruct folder paths; task10 never promises preserve-directory import. HTML parser likewise extracts links, not empty folders.

## Resource/error contract

`EXPORT_RESOURCE_LIMITS`: 50,000 total source nodes, depth 64 (virtual root depth 0), 16 MiB UTF-8 source proof and output. Selection/exclusion reference count combined is capped at 50,000. These are engineering fail-closed guards, not browser performance/SLA claims. Full topology validation is iterative and checks depth before bounded recursive projection/serialization. Thus an over-deep unselected branch also rejects. Paths are accounted during projection; pretty JSON and each serializer output are byte checked. No partial output is returned. Format escaping can exceed the byte cap even when JSON fits and then rejects. Allocation is bounded by input caps and escaping expansion, not streaming.

Errors are `ExportProjectionError` with `code: 'scope-invalid-or-stale' | 'resource'`. Reduce/select a smaller valid snapshot only explicitly; never silently truncate nodes or switch scope. Cycles, duplicate/missing IDs and inconsistent parent/children topology reject. Native parser budgets remain unchanged: task10 32 MiB, structural depth 256. Export depth64 creates at most approximately132 JSON container levels, below that guard; maximum selected-depth JSON roundtrip is tested. HTML/Markdown independent extraction tests use bounded samples; no universal roundtrip claim at every library structural limit.

## Verification and licensing

`extension/tests/export.test.ts` exercises actual task10 parsers plus independent AJV draft-07 validation of generated JSON and the original technical fixture. AJV6.15.0 is an exact dev-only dependency, already present transitively for ESLint; added offline, no new downloaded packages. Inspected installed `ajv/LICENSE`: MIT, copyright2015–2017 Evgeny Poberezkin. It is not imported by production serializers or bundled as runtime export code. Existing parser dependencies/notices remain unchanged.


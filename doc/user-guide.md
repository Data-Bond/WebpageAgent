# Webpage Agent: User Guide

Chinese edition: [user-guide-cn.md](user-guide-cn.md).

Tasks you type in the panel are **instructions for the language model**. The model calls tools based on each round’s page snapshot; the extension (Harness) performs generic operations and returns honest page state. The Harness does not decide “which button to click” for you, and it does not run arbitrary scripts.

This document explains how to write clear tasks and documents all **20 public tools** the model can call (parameters, branches, and return fields). Legacy internal names (e.g. `clickByText`, `setVal`) map to these tools—you do not need to use them.

## 1. Writing instructions: you state the goal, the model picks targets

### 1.1 What a good instruction looks like

State **what to accomplish**, **what success looks like**, and **what must be asked if missing**. Use labels visible on the page (button text, section titles, file names), not CSS from “Copy selector”.

Good:

- On this page, complete the software release form: use the official name from the attachment for the title, keep the summary within the page’s limit. If email is missing, ask me—do not invent it.
- Open the menu for this material and stop; list nearby clickable items so I can choose.
- Record the download URL on the results page; do not navigate away.

Bad:

- Click `div.el-dropdown-menu > li:nth-child(3)` (selectors change every round and are not handles).
- Hover then click “Preview” in one batch (items that appear only after hover are not visible yet; hover first, then click in the next round).
- “Pick the relevant category yourself” (forces guessing; write verifiable conditions or allow `ask`).

### 1.2 Principles

1. **One goal per message, or split by causality.** Independent fields can share one message; “open menu then click an item inside” should wait for the receipt or the next snapshot.
2. **Name things with on-page text.** “Next”, “Submit”, “Software name” under “Basic info”. When names collide, add card title or section—not CSS.
3. **Put personal data in attachments or skill variables, not skill body text.** Use placeholders like `{{name}}` for local substitution.
4. **When only you know a value, tell the model to ask.** Write “ask if missing”; do not force fabrication.
5. **Uploads use attached files only.** Attach in the panel first, then instruct “upload to the file field named …”; do not click “Choose file” to open the OS dialog.
6. **Log in on the target site before opening the panel.** The extension only operates the current tab.

### 1.3 How the model sees the page

Each request includes a **snapshot** (`outline`): interactive controls as `[idx]<role name=accessible-name …>`. **idx is renumbered every round**; cross-round idx is invalid. Catalog idx in a tool receipt matches **the previous snapshot’s batch** only for the immediately following round.

When the snapshot is truncated (`truncated`), have the model `get` / `print` / `scroll` to explore—not switch to a new CSS hunt.

Overlay and iframe content appear in snapshot `panes` or `<PANE>` lines; use those idx values for `get` / `scroll`.

Read-only prose and block text live in snapshot `blocks`; `get` that idx. `print` still searches controls only. Like panes, `blocks` do not become `memorize` lastRead until you `get` them.

Captcha images appear in the outline (e.g. `[n]<IMG captcha w=… h=…>`) and in `images[]` (with round idx). `print` searching “captcha” lists images, not only inputs.

### 1.4 Targeting: idx, name—do not use CSS as a handle

The model locates a control with three kinds of input (tool parameter `target`):

| Form | Meaning | When to use |
| --- | --- | --- |
| Integer, e.g. `12` | idx in this round’s snapshot | Preferred when idx or catalog is visible |
| Short text, e.g. `"Next"` | Match accessible name / visible text | When name appears in the snapshot |
| `{ "text": "Enter", "within": "…" }` | Search by name inside a subtree | Many same-named buttons; container visible in snapshot |
| `"url"` / `"title"` | `get` only: read address or title | When you need the current URL |

Objects may also use `idx`, `selector`, `text`, `within`. CSS in skills or chat is **for comparing to this round’s snapshot only**—not a stable handle for `click` / `get` / `type`; use idx or name instead.

**click** short-text lookup and **get** short-text lookup use **different** tables: click searches this round’s indexed names (including `hidden` in the snapshot); get can live-lookup after truncation. On miss or ambiguity, the receipt includes a catalog for the next round.

## 2. Public tools the model can call

The model uses function calling for these tools. When tools are unsupported, it may fall back to JSON:

```json
{"action":"execute","calls":[{"tool":"type","args":{"target":5,"value":"Alice"}}]}
```

Two **non-tool** closing actions:

- `ask`: ask when only the user can supply information (`question`).
- `done`: answer the user or finish (`summary` for the user).

Up to ~20 tool calls per round. Batch when there is no causal dependency and the page is clear; otherwise one at a time, read receipts, then continue.

---

### `get` — read control, subtree, or page metadata

Read visible text and field state (written value, filter box text, dropdown open, visible options, validation hints). Does not mutate the page (`open: true` expands a dropdown first to harvest options).

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | idx / text / object / `"url"` / `"title"` / `"document"` | yes | Handle to read; `url` / `title` for address or title; `document` for the current PDF body |
| `limit` | integer | no | Max body chars, default ~10000, hard cap 500000 |
| `offset` | integer | no | Start at char N (0-based); slice with `limit` |
| `open` | boolean | no | If true, open dropdown/cascade before reading options |

**Branches**

- `target` is `url` or `title`: returns URL or title text.
- `target` is `document`: when the current page is a PDF, returns a body slice (`chars` / `limit` / `offset` / `truncated`). The snapshot shows `document: { kind, url, name }` even with an empty DOM. Not a PDF → `reason: not-pdf`.
- **One** node: `text`, `chars`, `fieldState`, visible `options`, `label`, `sec` (section).
- `fieldState.committed` is **shown display text** (selection chips / read-only innerText / box value)—**not** a “already selected” verdict. `filter` is the writable filter box value; read-only combobox has empty `filter`, `committed` still shows display text. `open` / `optionsTop` describe **this trigger’s visible popup**; option `sel` comes from DOM `aria-selected` / `--selected`, not string comparison by the engine.
- **Zero** or **many** nodes: `ok: false`, `reason` `not-found` or `ambiguous`, `catalog` for this round. Short text may live-lookup after truncation.
- `truncated: true`: increase `limit` or set `offset` and `get` again—do not re-target with CSS.

Use `memorize` to keep text across steps; snapshot pane bodies are not memory sources.

---

### `type` — type only; does not pick options

Write a string into an editable node or filter box. Does **not** auto-click dropdown items or “Create …”.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | idx / text / object | yes | Input or editable node |
| `value` | string | yes | Full text to write. `{}` or omit is not valid |

**Branches**

- Normal input / textarea / contenteditable: returns actual value and verification.
- Filter dropdown: types filter text, marks not-submitted state; you or a later round `click` / `select`.
- If a nearby list appears or options change: `typed-not-committed`, **`yieldBatch` stops the batch**. Options in receipt `options` / `fieldState.optionsTop`; click new items via next snapshot idx.
- Disabled or missing target: failure with catalog; batch stops unless engine marks continue.

Do not write “auto-pick first after typing”.

---

### `click` — left click, hover, right click, double click

Default is left activation. `button` selects pointer behavior.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | idx / text / object | yes | Handle to act on |
| `button` | `left` / `hover` / `right` / `dblclick` | no | Omit or `left` for left click |
| `within` | string | no | Search by name only inside this container |

**`button` branches**

| Value | Behavior | Same-batch follow-up on new items |
| --- | --- | --- |
| `left` or omit | Left click. Suggestions and cascade leaves OK. Rows with checkboxes return `selection` | Usually continues batch. After `type` stop-batch, click options next round. New tab → `openedTab`, **batch stops** |
| `hover` | Move pointer only; **no click, no menu pick** | **Batch stops** (`yieldBatch`). Use catalog or next snapshot, then `click` |
| `right` | Context menu only; **no prior left click, selection unchanged** | Batch stops. `selection` = current checked/highlighted rows; confirm dialogs in `statusMessages` |
| `dblclick` | Double click | Normal receipt; new tab same as left |

When a new tab opens, receipt includes:

- `openedTab`: `{ tabId, url, title, windowId }`. Multiple: `openedTabs`; `openedTab` is last record with confirmed opener.
- Records with `openerTabId` are confirmed by the service worker; records without are same-window candidates (`target=_blank` links often lack opener)—you judge via url/title and `intentUrl`.
- `yieldBatch: true`: batch stopped; hand off to next round.
- `intentUrl` / `target` (e.g. `_blank`): from the link node.

Next round: `delegate` to that tab or `tabClose`.

**Lookup by `target` (left short text)**

- **idx**: click this round’s number, including `hidden` in outline.
- **Short name**: search idx by name (exact > prefix > contains; innermost wrapper; disjoint names = multiple).
  - **1**: click (including hidden).
  - **Many**: fail `ambiguous`, catalog with idx / name / hidden / sec, **stop batch**.
  - **0**: scan **visible** nodes; still 0/1/many; 0 gives overlay short-name catalog, **stop batch**.
- **CSS**: only when it looks like a selector and matches a node; do not use long skill selectors as routine handles.

Do not write “hover then immediately click Preview”. Write: if item not visible, hover first, then click from the list.

If a click produces a file, the receipt carries `file` (name and body) and no system save dialog appears. The receipt’s `savedTo` records where the user saved it: the save picker window opens and the user chooses local disk or WebDAV; the model only reads the receipt. When the current page itself is a PDF, use `get` with `target` = `document`.

---

### `check` — toggle real checkbox / radio

For checkbox/radio only; idempotent if already in target state. Row clicks also return `selection`.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | idx / text / object | yes | Checkbox or radio |
| `value` | boolean | no | Omit = check (`true`). `false` = uncheck |

Not for ordinary buttons or menu items.

---

### `select` — unique match among current options

Opens the control and matches text among **currently expanded/harvested** options. Not unique → catalog, no random click.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | idx / text / object | yes | Dropdown, cascade, or custom select host |
| `value` | string | yes | Option label to select |
| `filter` | string | no | Type into filter box before matching |

**Branches**

- Unique hit: selected, returns actual text.
- Multiple candidates / not open / not found: `ok: false`, `options` or catalog.
- “Create/New” entries appear as options; **not** auto-clicked.
- Empty-state text (e.g. “No data”) still in `options`.
- `type` into filter does **not** auto-invoke `select`.

---

### `scroll` — scroll field region or page

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | idx / text / `"page"` / `"window"` | yes | Scroll container; `page` / `window` = whole page |
| `direction` | `up` / `down` | no | Default `down`. Other values fail (`bad-direction`) |

Use when snapshot is truncated or lists are collapsed.

---

### `wait` — wait for present, enabled, gone, or elapsed time

Timeout is an observation, not a crash; batch usually continues.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | idx / selector-like text | no | What to wait for. Omit = wait `timeout` ms |
| `until` | `present` / `enabled` / `gone` | no | With `target`: appear (default), become enabled, disappear |
| `timeout` | integer (ms) | no | Max wait, cap 8000. Without `target`, sleep duration |

Existing idx returns immediately with `found` / `disabled` / `busy` / `elapsedMs`. Use `until=enabled` for loading buttons.

---

### `upload` — send attached files to file input

**Do not** `click` “Upload” to open the OS file dialog. Attach in the panel first, then pass attachment keys.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | idx / text / object | yes | `<input type="file">` or site file control |
| `key` | string or string[] | yes | Panel attachment key(s) |

---

### `ocr` — read pixels from image or canvas

Reads text from current pixels. **Does not click or change the image.** To change image, `click` it first, then `ocr`. Not for online spreadsheets (`officeRead`).

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | idx / text / object | yes | Prefer round idx. `captcha`: pick best captcha-like visible image (still no click) |

Example: “Read the captcha on screen; do not click to refresh.” Use `captcha` or snapshot `[n]<IMG captcha …>` idx. To refresh: “Click captcha image, then read.”

**Branches**

- One image: text, `likelyCaptcha`, `refreshed: false`.
- Multiple bare `IMG`/`CANVAS`: `ambiguous` + catalog; does not default to first (often logo).
- Input still on page: use `ocrFill` below.

---

### `ocrFill` — OCR current image and fill input

Reads **current pixels** and fills input. **No click to refresh.** `submit` **only if passed**; omit = fill only (use `click` for login separately).

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `image` | idx / text / object | yes | Same as `ocr` target; `captcha` selects without click |
| `input` | target | yes | Input to fill |
| `submit` | target | no | Click only if provided |

Example: “Fill captcha into ‘Captcha’ field; do not refresh image; do not click Login.” If unclear: “Click captcha to refresh, then read, fill, then click Login.”

**Branches**

- Input gone: reject `inputMissing`—no guess “already logged in”, no OCR.
- Multiple images: same as `ocr`.
- Receipt: `filled`, `submitted`, `text`, `refreshed`, `likelyCaptcha`, `statusMessages`.

---

### `officeRead` — read online sheet / document

Only when the page is a supported online office surface. Web body uses `get`.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `addr` | string | no | Cell, e.g. `A1` |
| `range` | string | no | Range, e.g. `A1:C10` |

Default view when addr omitted. `office-missing` if not an office surface.

---

### `officeFill` — write cells or insert at selection

**Parameters** (one mode per call)

| Mode | Parameters | Description |
| --- | --- | --- |
| Single cell | `addr` (A1-style) + `value` | Write one cell |
| Multi cell | `cells` object | Write many |
| Document | `value` only | Insert at current selection |

Use `type` for normal web inputs.

---

### `print` — keyword catalog in chat

Lists matching outline rows; **does not consume get body budget** or memory. idx valid this round only.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Keyword or name |
| `limit` | integer | no | **Catalog row count** (not body chars), default ~20, max 80 |

`print` = catalog; `get` = body slice for one node.

---

### `memorize` — store one task-memory slot

Cross-step text (URL, read body, confirmed values). Each snapshot header lists memory **directory** only (name / chars / `same` / short head)—not full text.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Slot name, ~40 chars max |
| `value` | string | no | Full text. Empty, omit, or `{}` is **not** a value |

**Backfill when value missing (in order)**

1. Successful `get` / `print` in this batch;
2. Else `lastRead`;
3. Else fail (`missing-source`).

Snapshot panes and blocks are not backfill sources. ~32 slots max; long text truncated like `get`. Same name overwrites.

---

### `recall` — read memory by name (full or slice)

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Slot name |
| `limit` | integer | no | Same as `get` |
| `offset` | integer | no | Same as `get` |

If history or prior `get` already has same `same`, not truncated, and fields suffice, model **may skip** `recall`. If you require full memory text, say so. Engine returns when called. Check `chars` / `truncated`.

---

### `forget` — delete memory slot(s)

Does not delete chat or skill variables.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | one of | Slot to delete |
| `all` | boolean | one of | `true` clears all task memory for this origin |

---

### `goto` — open remembered or explicit URL

Model must call explicitly; `memorize` does **not** auto-navigate.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | at least one | Must be `http` or `https` |
| `name` | string | at least one | Load URL from memory slot |

Read current URL: `get` with `target` `url`, then `memorize`, then `goto` if needed. New tab from `goto` includes `openedTab` and stops batch.

---

### `delegate` — run sub-agent in opened tab

Parent model writes child task text; engine injects panel on tab and runs a new agent round. Parent blocks until child returns.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `task` | string | yes | Child user instruction verbatim |
| `return` | string[] | yes | Field names child must pass to `returnToParent` |
| `name` | string | no | Short child task name |
| `tab` | number or `"opened"` | no | Child `tabId` from this page’s `openedTab`/`openedTabs`; omit/`"opened"` = latest `openedTab` |

Engine checks keys exist in `return`, not value correctness. Parent panel shows “Waiting for child tab: {name}”. Parent stop cancels and closes pending child. Inject failure: `inject-failed`, `tabLeftOpen: true`.

---

### `returnToParent` — child returns fields

Only on a `delegate` child tab. Payload goes to parent; engine closes child tab and focuses parent.

Missing keys still close child; parent receipt has partial `returned` and `missing`. Child `done` without this tool: parent gets `returned.summary` from `done.summary`, `missing` = all `return` keys.

Do not close tabs from page scripts.

---

### `tabClose` — close extra opened tab

When model sees `openedTab` and chooses not to follow. Engine does not auto-close.

**Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `tab` | number or `"opened"` | no | `tabId` from `openedTab`/`openedTabs`; omit/`"opened"` = latest |

---

## 3. Common receipt fields

Compressed tool results appear under 【执行结果】. Common fields:

| Field | Meaning |
| --- | --- |
| `ok` | Step succeeded |
| `reason` | `not-found` / `ambiguous` / `disabled` / `missing-source` etc. |
| `catalog` | Clickable rows with `[idx]`, `name=`, `hidden`, `sec=` |
| `idxRoundOnly` | Numbers valid this round only |
| `yieldBatch` | Batch stopped (hover, right-click, new tab, …) |
| `openedTab` / `openedTabs` | New tabs; `openerTabId` = confirmed; without = candidate |
| `returned` / `missing` | `delegate` payload and missing `return` keys |
| `text` / `chars` / `truncated` | Body and slice state |
| `fieldState` | `committed` shown text, `filter` writable box, `open`/`optionsTop` popup—not “selected” verdict |
| `resolved` | Matched via `idx` / `name` / `selector` |
| `filled` / `submitted` | `ocrFill` write/submit |
| `refreshed` / `likelyCaptcha` | Image clicked before capture (false now); captcha cleanup |
| `statusMessages` | On-page toasts/dialog text—not engine judgment |
| `selection` | Current checked/highlighted rows (name + idx) |
| `file` | File produced by a click: `name`, `mime`, `chars`, `text`. PDFs arrive as body slices; no system save dialog |
| `saveDialog` | A system save dialog appeared and bytes were not captured |
| `savedTo` | Where the file was saved: `kind` = `local` / `webdav` / `none`, plus `path`. The user picks the destination in the save picker window; the model only reads the receipt |

You may write: “If ambiguous, stop and show catalog” or “Pick the row with sec=…”. Do not hard-code stale idx.

## 4. Skills and `{{variables}}`

Successful steps can be saved as WEB-SKILLS. `{{name}}` in skill text must appear **verbatim** in tool args; the engine substitutes local values. Do not let the model rename or pre-expand placeholders.

Keep personal data in skill variable tables, not shareable step descriptions.

## 5. What the Harness does not do

- Run model-invented JavaScript or `page.q(...)` scripts.
- Treat CSS as stable cross-page handles.
- Disambiguate same-named buttons by guessing from task prose.
- Click menu items in the same batch right after hover.
- Click captcha to refresh before read; or auto-submit without `submit`.
- Left-click before right-click to change selection—use `selection` and dialog text.
- Choose business categories or files for you—it lists honest catalogs or executes when you state unique conditions.

## 6. Install and configuration

Install, model APIs, OCR, and skill import/export: repo root [README.md](../README.md). Chinese: [README-cn.md](../README-cn.md). Log in on the target site before opening the panel; text attachments enter context directly; PDFs and images are recognized first.

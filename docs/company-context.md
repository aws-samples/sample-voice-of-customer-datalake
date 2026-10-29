# Company context, personal objectives and the design system

What the AI surfaces know about the company: its **vision and objectives** (company-wide), each user's
**own objectives and KPIs**, and the **design system** prototypes must follow. All travel as DATA blocks in the user
prompt (`<company_context>`, `<design_system>`) — never as system prompt:

- **Research, PR/FAQ, PRD, prototypes, personas and agent steps** (shared outputs) get the company vision and
  company objectives — never anyone's own objectives — together with the company memories
  (`lambda/shared/grounding.py`, policy SHARED; see docs/memory.md → "Who recalls what"). Only **prototypes** get
  the design system: research, PR/FAQs, PRDs and personas never read it (it describes how a prototype looks; in a
  written document the model took reference summaries for requirements). For a prototype it is a choice: the Build prototype dialog's "Also read"
  list has a **Design system** box (on by default when one is set up; disabled with a link to Knowledge → Design
  system when none is), sent as `use_design_system` on `POST /projects/{id}/build-prototype` — absent means on,
  so the agents runtime, the assistant and MCP keep reading it. The prototype's "Built from" footer says when it
  was read (`derivation.design_system_included`), and a revision keeps the base build's choice.
- **Category scope applies to the design system too.** Like the vision and objectives, guideline paragraphs,
  token entries and references whose text names a category the reader may not see are left out
  (`shared.scope_names.scoped_design_system`) — in `GET /settings/design-system` for a restricted caller and in
  the prompt of a document started by one.
- **The assistant** auto-injects a short `<company_context>` at the start of every run (`lambda/stream/src/assistant/runtime/company-brief.ts`):
  the vision (clipped), the company objective titles, and the caller's OWN objectives with their KPIs — read as the
  caller from `GET /settings/company-context` and `GET /settings/my-context` (keyed by the verified sub), at most
  2 KB. The `get_company_context`, `get_my_context` and `get_design_system` tools stay for full detail.
- **MCP** (`/mcp/global`) reads them through its tools.

| What | Route (settings Lambda) | Read | Write |
|---|---|---|---|
| Vision (markdown ≤ 20k) + objectives (≤ 50; horizon long / quarter / date) | `GET/PUT /settings/company-context` | everyone | admins |
| My objectives & KPIs | `GET/PUT /settings/my-context` | self | self (cannot touch company objectives) |
| Design system: tokens, guidelines, **components**, logo, references | `GET/PUT /settings/design-system`, `POST …/references`, `POST …/references/{id}/refresh`, `DELETE …/references/{id}` (archives) | everyone | admins |
| Use a reference as the design system | `POST …/references/{id}/apply` → 200 `{draft, changes}` (nothing saved), `POST …/references/{id}/logo` → 200 `{logo_id, logo_url}` (nothing saved; `PUT` with `logo_id` saves it) | — | admins |
| Figma / GitHub tokens | `PUT /settings/design-system/integrations` | nobody (GET reports `{figma, github}` booleans only) | admins |
| User flags `fallback_owner` (admins only, at most one), `memory_reviewer`; the way of working with AI `ai_mode`, `ai_writing_prfaq`, `ai_writing_prd` ([ways-of-working.md](ways-of-working.md)) | `PUT /users/{username}/flags` (users Lambda); own mode `GET /users/me/ai-mode` | admins (own mode: everyone) | admins |

Every editor on the Company page and on Account → Objectives (vision & objectives, design system, my objectives)
offers **Discard changes** beside Save while it holds unsaved edits: it drops the draft and shows the saved value again.

My objectives & KPIs (Company and Account → Objectives) checks the draft before Save with the server's rules: a row
left blank is dropped, any other objective needs a title and any other KPI a name and a target (each text capped as
on the server). A refused field is marked and explained in place and nothing is sent; a 400 naming a field
(`objectives[0].kpis[0].target is required`) is shown on that field.

Storage: aggregates rows `SETTINGS#company_context`, `SETTINGS#design_system`, `USERCTX#{sub}`, `USERFLAGS#{sub}`
(`sk = config`). Uploads (screenshots png/jpg/webp ≤ 5 MB, HTML ≤ 2 MB, the logo png/jpg/webp ≤ 5 MB) go to the raw bucket under
`company-context/design/` by presigned PUT and are kept when a reference is archived; the reference's logo
**preview** (`company-context/design/logo_preview_<ref id>.png|jpg|webp`, a copy made when it was read) is deleted
with the archive and its `preview_key` dropped from the row (one idempotent `DeleteObjects`; an S3 failure answers
503 with the reference already archived, and repeating the DELETE removes it). The logo picker also takes an
SVG (≤ 1 MB): the browser draws it to a PNG (longest side 1024 px, transparent background) and uploads only that PNG, so
the API still never receives an SVG; an SVG the browser cannot convert (some browsers refuse one with a
`<foreignObject>`, or one without a size) is explained with "export it as PNG and upload that". Figma and GitHub tokens live
in the Secrets Manager secret `voc/design-integrations-<account>-<region>` (Core stack, KMS, deleted with the stack), JSON
`{figma_token?, github_token?}`.

Infrastructure: the settings role gains `secretsmanager:GetSecretValue`/`PutSecretValue` on that one secret and
S3 read + put on `company-context/*`, and one delete: `s3:DeleteObject` on `company-context/design/logo_preview_*`
only (the archive's preview clean-up); its environment gains `DESIGN_INTEGRATIONS_SECRET_ARN` and
`RAW_DATA_BUCKET`. The users Lambda keeps its single-item aggregates grant (`GetItem`/`PutItem`).

## Components

The design system carries `components` (≤ 30) beside the tokens, so prototypes copy what a Button, an
Input or a Card actually look like instead of guessing. One validator (`shared/design_components.py`)
serves `PUT /settings/design-system` (400 naming the field) and a reference's `extracted_design` (an invalid
part is dropped, never an error):

```
{name ≤ 60 (unique, case-insensitive), description ≤ 300,
 variants ≤ 8: [{name ≤ 40,
   styles: {background?, color?, border_color?        a CSS colour, or "var:<token name>" (a colour token)
            border_width?, radius?, gap?, height?,     a CSS length
            width?,
            padding?                                   1-4 lengths
            font_family?, font_size?, font_weight?, letter_spacing?, text_transform? (none|uppercase|capitalize),
            shadow?},                                  ≤ 200, colour functions only (no url(), no expression())
   hover?: {background?, color?, border_color?, shadow?},
   focus?: {outline? ≤ 80, border_color?, shadow?}}],      the focus ring: outline, ring border colour, glow
 example_html? ≤ 2,000}
```

Unknown style keys are dropped. The editor (Company → Design system → Components) mirrors these rules in `frontend/src/api/designComponents.ts` — the same keys, 8 variants, the focus ring's border colour and glow under "Hover and focus" — so an applied reference's components survive Save unchanged. **`example_html` is rebuilt server-side by a deny-by-default sanitizer**
(`shared/html_sanitizer.py`): only `div span button a input label p h1-h6 ul li img` and the SVG basic shapes
survive; only `class style type placeholder role aria-* alt` attributes, `href` when `https://…` or `#…`, `src`
when `https://…` or a raster `data:image/…;base64`; inline styles lose any declaration with `url()`,
`expression()`, a backslash escape or `@`; `script`, `style`, `iframe`, `object`, `form` and their kin are
dropped with their content, every `on*` handler and `javascript:` URL is gone, and text is re-escaped. The app
never renders it in its own document (the editor uses a sandboxed iframe).

Prompts: `design_system_text` adds a **Components** section after the guidelines (≤ 4,000 of the block's 12,000
characters; each component cut to its share, then left out when nothing fits; long guidelines are cut so the
section still fits): per component its name, description and each variant's styles as `key=value`, then `hover:`
and `focus:` — never the HTML. The prototype instruction tells the model to use these styles for the buttons,
inputs, cards, tabs and badges they name, `var:<name>` being that colour token. Category scope applies: a
component whose name, description or a variant name names a hidden category is left out of GET and the prompt.

## References: what is read, and the extracted design

A reference is one of `website` (a live page), `github`, `figma`, `html` (upload) or `screenshot` (upload).
Each is processed in the background (`status` `pending` → `ready` | `error`) into a short
`extracted_summary` (what prompts read) and, when anything was found, an **`extracted_design`**:

```
{colors: [{name, value}], typography: [{role, family, size?, weight?}], spacing: [{name, value}],
 radius: [{name, value}], guidelines_md, components: [Component] (≤ 30, the shape above),
 logo: {source_url, content_type, preview_url?, rendered?} | null, source: computed_styles | repo_files | figma | html | screenshot}
```

Every value passes the token editor's own rules (`shared/company_context.py` `is_css_color` / `is_css_length` /
`is_font_family` / `is_font_weight` — colours may be `#hex`, `rgb()`, `hsl()`, `oklch()`/`oklab()`/`lab()`/`lch()`
or a keyword) and the injection check; an invalid entry is dropped, never stored. Each list holds at most 40
entries, `guidelines_md` at most 20,000 characters. The logo is only a candidate (PNG, JPEG or WebP; SVG is
refused). **Why SVG stays refused:** an SVG is a document that can carry script and external references, and
every consumer of the company logo is raster-only — the upload types, "Use this logo", the preview copy and the
Bedrock image blocks (PNG / JPEG / GIF / WebP). Rasterising needs a native renderer (cairo / librsvg) that no
Lambda layer carries, and serving a sanitised SVG from the app's CDN would put an active document type on it.
So an SVG logo is only ever **drawn by the managed browser** (`voc-design-capture`) and kept as a PNG. A
repository whose only logo is an SVG (`*logo*.svg`, or the one SVG in a `public/` directory) has it read through
the GitHub contents API (the token's path, so a private repository works; ≤ 1 MB), rebuilt deny-by-default
(`shared/design_svg.py`, below) and handed to `voc-design-capture` once the reference is recorded as ready
(`shared/design_logo_render.py`, async event `design_logo_render` with the sanitised markup and the read's
`fetched_at`). The worker sanitises it again, draws it as an `<img>` from a `data:` URL in a fresh `about:blank`
tab (one short browser session, the same render and PNG checks as below), stores the PNG as the preview and sets
`logo: {source_url: <raw.githubusercontent.com URL>, content_type: image/png, rendered: true}` — only while the
reference is still `ready` with the same `fetched_at` (a refresh or an archive in between wins). When it cannot be
drawn, or the hand-off cannot start, the guidelines get a `## Logo` note naming the file and asking for a PNG /
JPEG / WebP export (as they always do in a deployment without the capture function).
**The SVG sanitiser** (`shared/design_svg.py`) refuses a `<!DOCTYPE`, entity or processing instruction before
parsing (and the expat parser refuses them again), keeps only drawing elements (shapes, groups, gradients, clip
paths, masks, text, `use` / `symbol`) and presentation / geometry attributes; `script`, `foreignObject`, `style`,
`image`, `a`, `animate` / `set` go with their content, every `on*` handler goes, `href` survives only as `#id`,
`url()` only as `url(#id)`, and the root gets a width / height (its own, the measured box, else its `viewBox`);
at most 100,000 characters out. **A live website's SVG logo is rendered too** (`lambda/design_capture/logo_render.py`):
when the page's best logo is an https `.svg` of kind `header` or `og-image` that passes the URL policy and ranks
above the raster candidate (a header SVG beats a touch icon or favicon; a header PNG still beats a header SVG),
the managed browser draws it as an `<img>` — an image context never runs SVG script — in a separate fresh
`about:blank` tab of the same session, after the page has been read: transparent default background, the image
built with `createElement` and its URL handed over as a CDP call argument and set as a property (`img.src = url`,
never in a code or markup string), its natural size clamped to 64–1024 px on the longest side, `img.decode()`
raced against 8 s, then one PNG `Page.captureScreenshot` clipped to the image's box. The PNG is checked by its
bytes (`png_check.py`: a PNG, ≤ 2 MB, at least 8 px a side, not fully transparent) and stored as the preview,
`company-context/design/logo_preview_<ref id>.png`; the logo is recorded as
`{source_url: <the SVG's URL>, content_type: image/png, rendered: true}` (GET adds `preview_url`). Any failure
(decode timeout, no size, not a PNG, too large, empty or blank, a CDP error) just means no rendered logo — the
raster candidate is used as before and the capture is unaffected; the capture log gets one `SVG logo not
rendered` line with a short reason. The SVG's bytes are never stored or served. **An inline `<svg>` logo**
(markup in the header, no image URL) is read only when the page names no header logo image: one more evaluate
(`lambda/design_capture/page_inline_logo.py`) picks a visible `<svg>` (≥ 24 × 12 px, not nested, not in a cookie /
consent banner) in `header` / `nav` or a `*logo*` / `*brand*` container that is named `logo` / `brand` (id, class,
`aria-label`, within 4 ancestors), links to the site root, or has a `<title>` saying logo; it serialises a copy with
each element's computed fill / stroke / opacity and the root's colour (the page's stylesheets do not travel) and a
sprite's referenced `<symbol>`. The copy is sanitised as above and drawn from a `data:` URL the same way, recorded
with the PAGE's URL as `source_url`; anything refused or failed falls back to the raster candidate. When a candidate is found, the reader downloads it once through the same SSRF-guarded fetch as "Use this
logo" (≤ 2 MB, type decided by its bytes) to `company-context/design/logo_preview_<ref id>.<ext>`, and GET
returns `logo.preview_url`, a short-lived signed URL like `logo_url` (the key itself never leaves the API); any
failure just leaves it absent. A reference's `fetched_at` is the time its read FINISHED, ready or failed.

| Kind | How it is read | Runs on |
|---|---|---|
| `website` | The AWS-managed AgentCore browser opens the page (one session, at most 120 s). ONE in-page evaluate reads the `:root` custom properties, the computed styles of body/headings/links/buttons/inputs/nav/header/footer/cards, the most-used colours, lengths and fonts, logo candidates (header image, touch icon, `og:image`) and **component samples**: per kind (buttons grouped as filled / outlined / text, links, inputs/textareas/selects, cards with a border or shadow, nav/header, `[role=tab]`, badges/chips/pill spans, tables, dialogs) up to 3 visible, distinct elements with their computed styles in the component keys and a trimmed `outerHTML` (≤ 600), plus the `:hover` / `:focus-visible` rules of same-origin stylesheets (`:hover` cannot be computed; cross-origin sheets are skipped). Filled buttons are sampled one per background (at most two, so an outlined / text button keeps a slot) and named `primary` (a coloured fill), `inverse` (light neutral) or `neutral` (dark): a purple call-to-action and a white nav button are two variants. State rules are read when their selector names a known kind OR a class a sample carries; their `var(--x)` values are resolved through the page's `:root` properties, and a rule goes on a sample only when its SUBJECT (the compound after the last combinator; pseudo-elements excluded) matches that element — all its classes on the element, its tag the element's tag; `.site-nav a:hover` is skipped (the ancestry is unknown). Then ONE JPEG screenshot and ONE vision call that returns components grounded in the measured values. **The measured components win over the model's** (`shared/component_overlay.py`, by component name; a variant matches by name, else by background): their styles and focus keys override the model's, their hover REPLACES it (hover is invisible in a screenshot, so only a CSS rule is evidence — a model-guessed hover is dropped), the model's other variants follow (≤ 8), the model's description is kept and a measured snippet fills a missing `example_html`. Spacing tokens never come from layout: the page reports its centring margins (computed left = right > 0, e.g. `margin: auto` around a max-width column) and a spacing value equal to one (± 0.5 px), or a fractional px the page never measured, is dropped (`page_spacing.py`) | `voc-design-capture` (VocIngestionStack, 5 min) |
| `github` | ONE `git/trees/{ref}?recursive=1` call ranks the whole tree: token files, Tailwind v4 theme/palette CSS, font faces, Tailwind configs, entry CSS, design docs and `.kiro/steering/*design*` (up to 12 files × 20k; the README only when nothing else exists). CSS custom properties are parsed without a model. Up to 8 UI component sources are read too (`components/ui.tsx`, then `components/ui/{button,input,card,badge,tabs,dialog,select,…}.*`; a source that fails is skipped): `cva()` variant maps, class-string maps and `a ? '…' : '…'` chains become variants, and the common Tailwind utilities are resolved to the parsed tokens without a model (`bg-accent` → the accent colour, `rounded-lg` → `--radius-lg` or 0.5rem, `px-4` → 16px, `text-sm`, `font-semibold`, `w-9` → 36px, `shadow-[…var(--x)]`, `hover:`; `shared/tailwind_components.py`). `shadow-sm` / `shadow` / `shadow-2xl` take the repository's own `--shadow-sm` / `--shadow` / `--shadow-2xl` when it defines one (resolved through its `var()`s), Tailwind v4's default otherwise; `color-mix(in srgb|oklch, …)` with literal colours and `transparent` is computed to an `rgba()` / `#hex` (`shared/css_color_mix.py`; anything else is kept as written). Plain CSS component classes are read the same
way (`shared/css_component_rules.py`): `.btn { @apply …; }`, `.btn-ghost { background: …; color: var(--x) }`,
`.btn-primary:not(:disabled):hover`, `.input:focus-visible { outline: …; border-color: …; box-shadow: … }` (the whole focus ring), `.badge-ok` … `.badge-aim` (every tone a variant), `.tab-active`,
`.switch-on` — one component per class family (`btn`/`button`, `input`, `textarea`, `select`, `badge`, `tab`,
`card`, `switch`, `icon-btn`, `menu-item`, `link`, `dialog-panel` …), a `.<family>-<word>` class being a variant
only when the word is a variant word (primary, secondary, ghost, danger, ok, warn, active, on …; sizes such as
`-sm` and parts such as `-knob` are not — a part's styles go into the component's description, e.g. `Knob: height=16px, width=16px, …`); a UI source's own variant wins over a CSS class of the same name.
Stylesheets are parsed whole (up to 400k characters; the model's digest still gets 20k per file).
**Theme variants:** the token groups hold the default theme (the first declaration wins; Tailwind v4's
`@theme inline { --x: var(--x) }` self-aliases never count). The design system has one colour set, so the other
themes (`[data-theme="…"]`, `:root[data-mode=light]`, `html.dark` / `.dark`, `@media (prefers-color-scheme: …)`)
are kept as a `## Theme variants (read from the CSS)` section of `guidelines_md`: per theme a table of every
colour token whose value differs from the default (`shared/css_theme_modes.py`), which the generators read with
the rest of the guidelines. A text call then returns the components in the shape above; **the parsed components win over its version** the same way as a website's measured ones (`shared/component_overlay.py`). Logo: the best `*logo*` PNG/WebP (a `raw.githubusercontent.com` URL) | `voc-settings-assist` |
| `figma`, `html`, `screenshot` | As before, but the model now answers with the structured design too (HTML also has its CSS custom properties parsed) | `voc-settings-assist` |

**Security of the live-website path.** The URL must be https and passes the SSRF guard (`shared/url_policy.py`
`validate_url`: resolved, every address public) when the reference is created and again in the worker. After
navigation and redirects the FINAL URL is checked the same way (http(s) only, no private, loopback or link-local
address); a page that ends anywhere else is refused before anything it shows is read. The browser runs in AWS's
managed sandbox, outside the platform's network. A bot wall is reported (`The site blocked the secure browser
(Cloudflare) …`), never read as a design. A failed page says what happened and what to do next
(`lambda/design_capture/page_outcome.py`): a bot challenge or HTTP 401 / 403 / 429 is **blocked** (upload a
screenshot or the HTML instead), 404 / 410 is **not found** (check the address), 5xx is a **site error** (try
again later) and any other 4xx a **refused request**. The capture log's `Design capture finished` line names the
reference id, the page's host (never the URL, so no credentials or query), the managed browser session id, and on
failure a `reason` code and the `http_status`. Page text and statistics reach the model fenced as DATA.

**Apply.** `POST …/references/{id}/apply` merges the reference's `extracted_design` into the CURRENT design system
and returns the draft without saving: a token with the same name (role, for typography) is replaced in place,
new ones are appended up to 40 per group; components merge by name the same way (same name — any case —
replaced, new appended, ≤ 30); the guidelines gain a `## From <reference title>` section with the reference's own
guidelines (or take them as they are when there are none yet) — components are no longer listed there. `changes`
counts `{added, replaced}` per token group and for `components`, plus `guidelines_added`. The admin reviews it in the editor and saves with the usual
`PUT /settings/design-system`. 409 when the reference has no extracted design yet or is archived.

**Use this logo.** `POST …/references/{id}/logo` downloads the candidate server-side with the SSRF guard on the
URL and on every redirect hop (`shared/http_utils.fetch_public_url`: sockets pinned to the vetted address, no
https→http downgrade, no proxies), at most 2 MB, PNG/JPEG/WebP decided by the file's bytes, and stores the FILE
(`company-context/design/logo_<12 hex>.<ext>`) — the design system itself is not changed. It answers
`{logo_id, logo_url}` (`logo_url` a short-lived signed GET); the editor shows that logo in the same draft "Use as
design system" fills ("it becomes the company logo when you save the design system"), and **Save design system**
sends `logo_id` with the usual `PUT /settings/design-system`, which makes it the company logo (400 when `logo_id`
is malformed or its file does not exist). Discard — the apply banner's **Discard** and the save row's **Discard changes** are one action — drops the whole draft, the drafted logo and the banner, and shows the saved logo again; the unused file is kept, like every upload.
400 with the reason when the address is unsafe, the file is too large or not an image; 409 when there is no
candidate. A **rendered** candidate (a website's SVG logo, above) is never downloaded: the route copies its stored
preview PNG (`s3:GetObject` on the preview key, checked again: a PNG by its bytes, ≤ 2 MB; 400 otherwise) to a new
`logo_<12 hex>.png`, same answer; **409** `Refresh the reference to read its logo again` when the preview is gone.

**One address, one reference.** `POST …/references` answers **409** naming the existing reference when the URL is
already among the non-archived references (any link kind; `shared/reference_urls.py` compares the scheme and host
case-insensitively and ignores a trailing dot, the default port, a trailing slash, the fragment and userinfo; the
query and the path's case count). Nothing is read a second time; use **Fetch again** on that reference. The add
form says the same while typing (`frontend/src/pages/Company/referenceUrl.ts`, with "Fetch again" on the existing
one) and explains an address the API would refuse beside the field (not https — naming the scheme typed, `ftp://`,
`http://`, as the API's 400 does — not a URL, no host, and for a live
website a user name / password or localhost), announced to screen readers; private addresses are refused by the
API once the name is resolved. Archiving says what is kept per kind: the file for an upload, the link and what was
read from it for a link.

Infrastructure: `voc-design-capture` runs as its own role — the managed-browser statements (Start/Stop on
`aws.browser.v1`, the stream connect on `*`), `bedrock:InvokeModel` on the model allowlist, aggregates `GetItem`
on the `SETTINGS#design_system` and `SETTINGS#model` partitions and `UpdateItem` on `SETTINGS#design_system` only
(`dynamodb:LeadingKeys`), KMS for the table and bucket, `s3:PutObject` on
`company-context/design/logo_preview_*` only (the logo preview: a downloaded raster candidate or the PNG the
browser rendered from an SVG logo; env `RAW_DATA_BUCKET`); no read, no delete, no
secrets. Its second action, `design_logo_render` (a GitHub reference's SVG logo), uses the same grants. It is never retried (a retry opens another billed
session). The settings role may invoke it (`DESIGN_CAPTURE_FUNCTION`, by name: VocIngestionStack deploys before
VocApiStack).

## Getting the Figma and GitHub tokens

Administration → Sources → Integrations (`/admin?tab=sources&section=integrations`) carries the same steps in-page (a "Setup help"
disclosure per token, in every locale). Summary, checked against the providers' docs:

| Token | Needed for | Where to create it | Grant | Sent only to |
|---|---|---|---|---|
| Figma personal access token | every Figma reference | Figma → account menu (top left) → Settings → Security → Personal access tokens → Generate new token ([docs](https://developers.figma.com/docs/rest-api/personal-access-tokens/)) | the one scope `file_content:read` ([scopes](https://developers.figma.com/docs/rest-api/scopes/)) | `api.figma.com` |
| GitHub fine-grained personal access token | private repositories (public ones work anonymously, at GitHub's lower rate limit of 60 requests an hour — one repository read costs up to 21) | GitHub → profile picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token ([docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)); [pre-filled form](https://github.com/settings/personal-access-tokens/new?name=VoC+design+system&description=Read-only+design+references+for+VoC&contents=read) | Only select repositories; Repository permissions → Contents: Read-only (Metadata read-only is automatic) | `api.github.com` |

There is no Test button: a token is exercised when a reference is fetched. Add a Figma file or GitHub repository
reference under Company → Design system and reload: **Ready** with a summary means the token works; **Failed**
shows the backend's reason under the reference (`… refused access` = wrong/expired/under-scoped token; `… could
not find it (or the token cannot see it)` = wrong link or no access; GitHub answers 404 for a private repository
the token was not granted). Fix it and click **Fetch again**. Both tokens act as the user who created them: set an
expiry, rotate before it lapses, and revoke at the provider if one leaks. The design-system GitHub token is
separate from the GitHub Issues data-source token ([github-issues.md](github-issues.md)); do not reuse one for
the other.

## Navigation proposal (for the frontend tracks)

Company context, memory, the design system and a project's **Product** tab (`/projects/{id}?tab=product`) all
answer one question — what does the AI know about our company and product — so they belong together. Settings is
reduced to administration.

| Section | Items | Who |
|---|---|---|
| Insights | Dashboard, Categories, Problems, Prioritization | all |
| Ideation | Projects, **Autonomous agents**, AI chat | all (agent writes: admins) |
| **Knowledge** (new) | **Memory** (Company · Personal · Needs review · Imports), **Company** (vision, objectives — read for all, edit admins), **Design system** (read for all, edit admins), **My objectives & KPIs** | all; review tab admins + memory reviewers |
| Data | Data explorer (admins), Scrapers, Feedback forms | as today |
| Settings | Administration (5.09 tabs): General, Sources (data sources, integrations incl. Figma/GitHub tokens, email inbox, Radar), Taxonomy, Privacy & access (source policies, users incl. the two flags), AI models, System · Account: profile, **Connect AI tools** | Administration: admins; Account: everyone |

A project's **Product** tab stays per project (it describes that product: the description, filled by hand or by the AI assistant's guided interview, docs, report) but shows the
company context and design system it inherits, read-only, with a link to Knowledge — and can promote its findings
to company memory through `POST /memory/imports`.

## One MCP connection for the whole app

> Built: the global MCP on **Connect** ([mcp.md](mcp.md)). The per-project MCP tab has since been removed;
> the project header links to Connect with the project pre-selected. The original proposal follows.

A project's **MCP** tab (`/projects/{id}?tab=mcp`) used to mint a token for that project. Proposal: one per-user MCP
endpoint for the whole software under Account → **MCP tokens** (`/account?tab=access`, shipped), whose tools follow the user's own
access (projects by membership, reviews by category access, memory by scope) — the same delegated-principal model
the MCP and agent identities already use (never admin, capped at editor). The project tab becomes a shortcut that
pre-selects that project. Alongside the token, the page offers a downloadable **skill** (a link + instructions) so
Claude Cowork, GitHub Copilot or Amazon Quick can open it, connect over MCP and work from outside. Infra impact: the
MCP Lambda's delegation list (today metrics + projects) would gain the memory and agents APIs.

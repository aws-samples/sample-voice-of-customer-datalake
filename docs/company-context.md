# Company context, personal objectives and the design system

What the AI surfaces know about the company: its **vision and objectives** (company-wide), each user's
**own objectives and KPIs**, and the **design system** prototypes must follow. All travel as DATA blocks in the user
prompt (`<company_context>`, `<design_system>`) — never as system prompt:

- **Research, PR/FAQ, PRD, prototypes, personas and agent steps** (shared outputs) get the company vision and
  company objectives — never anyone's own objectives — together with the company memories
  (`lambda/shared/grounding.py`, policy SHARED; see docs/memory.md → "Who recalls what"). Prototypes, PRDs and
  PR/FAQs also get the design system. For a prototype it is a choice: the Build prototype dialog's "Also read"
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
| Use a reference as the design system | `POST …/references/{id}/apply` → 200 `{draft, changes}` (nothing saved), `POST …/references/{id}/logo` → 200 `{logo_url}` | — | admins |
| Figma / GitHub tokens | `PUT /settings/design-system/integrations` | nobody (GET reports `{figma, github}` booleans only) | admins |
| User flags `fallback_owner` (admins only, at most one), `memory_reviewer` | `PUT /users/{username}/flags` (users Lambda) | admins | admins |

Storage: aggregates rows `SETTINGS#company_context`, `SETTINGS#design_system`, `USERCTX#{sub}`, `USERFLAGS#{sub}`
(`sk = config`). Uploads (screenshots png/jpg/webp ≤ 5 MB, HTML ≤ 2 MB, the logo) go to the raw bucket under
`company-context/design/` by presigned PUT and are kept when a reference is archived. Figma and GitHub tokens live
in the Secrets Manager secret `voc/design-integrations-<account>-<region>` (Core stack, KMS, deleted with the stack), JSON
`{figma_token?, github_token?}`.

Infrastructure: the settings role gains `secretsmanager:GetSecretValue`/`PutSecretValue` on that one secret and
S3 read + put (no delete) on `company-context/*`; its environment gains `DESIGN_INTEGRATIONS_SECRET_ARN` and
`RAW_DATA_BUCKET`. The users Lambda keeps its single-item aggregates grant (`GetItem`/`PutItem`).

## Components

The design system carries `components` (≤ 30) beside the tokens, so prototypes copy what a Button, an
Input or a Card actually look like instead of guessing. One validator (`shared/design_components.py`)
serves `PUT /settings/design-system` (400 naming the field) and a reference's `extracted_design` (an invalid
part is dropped, never an error):

```
{name ≤ 60 (unique, case-insensitive), description ≤ 300,
 variants ≤ 6: [{name ≤ 40,
   styles: {background?, color?, border_color?        a CSS colour, or "var:<token name>" (a colour token)
            border_width?, radius?, gap?, height?,     a CSS length
            padding?                                   1-4 lengths
            font_family?, font_size?, font_weight?, letter_spacing?, text_transform? (none|uppercase|capitalize),
            shadow?},                                  ≤ 200, colour functions only (no url(), no expression())
   hover?: {background?, color?, border_color?, shadow?}, focus?: {outline? ≤ 80}}],
 example_html? ≤ 2,000}
```

Unknown style keys are dropped. **`example_html` is rebuilt server-side by a deny-by-default sanitizer**
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
 logo: {source_url, content_type, preview_url?} | null, source: computed_styles | repo_files | figma | html | screenshot}
```

Every value passes the token editor's own rules (`shared/company_context.py` `is_css_color` / `is_css_length` /
`is_font_family` / `is_font_weight` — colours may be `#hex`, `rgb()`, `hsl()`, `oklch()`/`oklab()`/`lab()`/`lch()`
or a keyword) and the injection check; an invalid entry is dropped, never stored. Each list holds at most 40
entries, `guidelines_md` at most 20,000 characters. The logo is only a candidate (PNG, JPEG or WebP; SVG is
refused). When it is found, the reader downloads it once through the same SSRF-guarded fetch as "Use this
logo" (≤ 2 MB, type decided by its bytes) to `company-context/design/logo_preview_<ref id>.<ext>`, and GET
returns `logo.preview_url`, a short-lived signed URL like `logo_url` (the key itself never leaves the API); any
failure just leaves it absent. A reference's `fetched_at` is the time its read FINISHED, ready or failed.

| Kind | How it is read | Runs on |
|---|---|---|
| `website` | The AWS-managed AgentCore browser opens the page (one session, at most 120 s). ONE in-page evaluate reads the `:root` custom properties, the computed styles of body/headings/links/buttons/inputs/nav/header/footer/cards, the most-used colours, lengths and fonts, logo candidates (header image, touch icon, `og:image`) and **component samples**: per kind (buttons grouped as filled / outlined / text, links, inputs/textareas/selects, cards with a border or shadow, nav/header, `[role=tab]`, badges/chips/pill spans, tables, dialogs) up to 3 visible, distinct elements with their computed styles in the component keys and a trimmed `outerHTML` (≤ 600), plus the `:hover` / `:focus-visible` rules of same-origin stylesheets (`:hover` cannot be computed; cross-origin sheets are skipped). Then ONE JPEG screenshot and ONE vision call that returns components grounded in the measured values; the measured components are the fallback and lend their snippet to a model component without one | `voc-design-capture` (VocIngestionStack, 5 min) |
| `github` | ONE `git/trees/{ref}?recursive=1` call ranks the whole tree: token files, Tailwind v4 theme/palette CSS, font faces, Tailwind configs, entry CSS, design docs and `.kiro/steering/*design*` (up to 12 files × 20k; the README only when nothing else exists). CSS custom properties are parsed without a model. Up to 8 UI component sources are read too (`components/ui.tsx`, then `components/ui/{button,input,card,badge,tabs,dialog,select,…}.*`; a source that fails is skipped): `cva()` variant maps, class-string maps and `a ? '…' : '…'` chains become variants, and the common Tailwind utilities are resolved to the parsed tokens without a model (`bg-accent` → the accent colour, `rounded-lg` → `--radius-lg` or 0.5rem, `px-4` → 16px, `text-sm`, `font-semibold`, `shadow-[…var(--x)]`, `hover:`; `shared/tailwind_components.py`). A text call then returns the components in the shape above, preferring those parsed styles. Logo: the best `*logo*` PNG/WebP (a `raw.githubusercontent.com` URL) | `voc-settings-assist` |
| `figma`, `html`, `screenshot` | As before, but the model now answers with the structured design too (HTML also has its CSS custom properties parsed) | `voc-settings-assist` |

**Security of the live-website path.** The URL must be https and passes the SSRF guard (`shared/url_policy.py`
`validate_url`: resolved, every address public) when the reference is created and again in the worker. After
navigation and redirects the FINAL URL is checked the same way (http(s) only, no private, loopback or link-local
address); a page that ends anywhere else is refused before anything it shows is read. The browser runs in AWS's
managed sandbox, outside the platform's network. A bot wall is reported (`The site blocked the secure browser
(Cloudflare) …`), never read as a design. Page text and statistics reach the model fenced as DATA.

**Apply.** `POST …/references/{id}/apply` merges the reference's `extracted_design` into the CURRENT design system
and returns the draft without saving: a token with the same name (role, for typography) is replaced in place,
new ones are appended up to 40 per group; components merge by name the same way (same name — any case —
replaced, new appended, ≤ 30); the guidelines gain a `## From <reference title>` section with the reference's own
guidelines (or take them as they are when there are none yet) — components are no longer listed there. `changes`
counts `{added, replaced}` per token group and for `components`, plus `guidelines_added`. The admin reviews it in the editor and saves with the usual
`PUT /settings/design-system`. 409 when the reference has no extracted design yet or is archived.

**Use this logo.** `POST …/references/{id}/logo` downloads the candidate server-side with the SSRF guard on the
URL and on every redirect hop (`shared/http_utils.fetch_public_url`: sockets pinned to the vetted address, no
https→http downgrade, no proxies), at most 2 MB, PNG/JPEG/WebP decided by the file's bytes, and stores it as the
company logo (`company-context/design/logo_*`, like an upload). 400 with the reason when the address is unsafe,
the file is too large or not an image; 409 when there is no candidate.

Infrastructure: `voc-design-capture` runs as its own role — the managed-browser statements (Start/Stop on
`aws.browser.v1`, the stream connect on `*`), `bedrock:InvokeModel` on the model allowlist, aggregates `GetItem`
on the `SETTINGS#design_system` and `SETTINGS#model` partitions and `UpdateItem` on `SETTINGS#design_system` only
(`dynamodb:LeadingKeys`), KMS for the table and bucket, `s3:PutObject` on
`company-context/design/logo_preview_*` only (the logo preview; env `RAW_DATA_BUCKET`); no read, no delete, no
secrets. It is never retried (a retry opens another billed
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

A project's **Product** tab stays per project (it describes that product: docs, interview, report) but shows the
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

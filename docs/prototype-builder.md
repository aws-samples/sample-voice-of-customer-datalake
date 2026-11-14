# Prototype builder

**Status: partly built.** Built: what [Today](#today) describes, Part 2's Back to vN (6.11.00) and drafts from an
instruction (6.12.00), the rest of Part 2 (6.14.00: the outline, the assistant's tools, Edit with the assistant),
Part 3: its read side (6.13.00) and Incorporate (6.15.00, [built](#built-so-far-part-3s-read-side-and-incorporate)),
and Part 4's sections (6.16.00, [built](#data-model-and-api)); see
[Slices and order](#slices-and-order). Every other route, tool, field and file below is a proposal and is marked
*planned*; the code does not have it.

The owner's request, in four parts:

1. **Guided demo (skippable)**: a prototype can carry a short walkthrough, popups on the prototype that walk
   people through it.
2. **Edit a prototype from a chat bubble**: ask for changes in words, see them, apply them.
3. **Feedback into the prototype**: see all of a prototype's feedback, select what to incorporate, and have the
   prototype revised.
4. **Documents in sections**: the project's documents grouped in sections. The request lists them as "PRD,
   Documents, PR/FAQ, Prototypes"; this page orders them PRD, PR/FAQ, Prototypes, Documents, ordered by
   [Decision 1](#decisions-2026-11-13).

The owner then settled the details of each part in a brief ("the brief" below). The brief is not published:
every point it settles comes from the owner and is recorded on this page, mostly under
[Decisions](#decisions-2026-11-13), so this page is the reference for them.

The methodology this serves is the one in [TENETS.md](../TENETS.md) (tenet 2): customer evidence → personas →
PR/FAQ → PRD → prototype → review. Parts 1 to 3 make the last two steps, prototype and review, a loop people
can run without leaving the prototype's page; part 4 makes the step each document belongs to visible.

## Today

What exists, read from the code (paths relative to `voc-datalake/`).

### Building and revising a prototype

- **The route.** `POST /projects/{id}/build-prototype` (`api_build_prototype` in
  `lambda/api/projects_handler.py`) answers 202 with a `job_id` and hands the work to the document-generator job
  (`lambda/jobs/document_generator/handler.py`, `_generate_prototype`). Its body: `title`, `response_language`,
  `brand`, `source_prd_id` / `source_prfaq_id` (default: the newest of each), `use_product_context`,
  `use_research` + `selected_research_ids`, `selected_product_doc_ids` (visual grounding), `use_design_system`
  (default on), and for a revision `feedback` + `base_prototype_id`. Every id is checked against the project
  before the job exists. A project with no PRD and no PR/FAQ is refused with 409 before any job
  (`lambda/shared/methodology.py`, [project-workspace.md → Methodology](project-workspace.md#methodology)).
- **The generator.** One model call on the `prototype` surface (`lambda/shared/converse.py`, up to 32,000 output
  tokens) returns one self-contained HTML document with inline CSS and JS. A revision adds a "USER FEEDBACK"
  section and the previous prototype's HTML (capped, with the pin widget stripped first), and asks for the full
  revised document. There is no partial edit: every revision regenerates the whole file.
- **Storage.** The HTML is written to the raw-data bucket (`RAW_DATA_BUCKET`) at
  `prototypes/{project_id}/{document_id}.html` (`lambda/shared/prototypes.py`, `prototype_s3_key`), with
  `IfNoneMatch='*'`: a prototype object is write-once. The row is a `PROTOTYPE#{document_id}` item in the project's
  partition with `document_type: prototype`, `prototype_format: html`, the object's `prototype_etag` /
  `prototype_version_id`, `source_prd_id` / `source_prfaq_id`, a `derivation` block, a `methodology` block and
  `job_id`. No HTML and no URL are stored on the row. Prototypes from before the S3 move keep their HTML inline in
  `content`, and the oldest are JSON specs rendered natively (`frontend/src/components/prototypeSpec.ts`).
- **Versions and lineage.** A prototype is a version-managed type (`VERSIONED_DOCUMENT_TYPES` in
  `lambda/shared/document_versions.py`), like a PRD or PR/FAQ: every build or revision is a **new document row**
  with its own id, in a series titled `Title (v1)`, `Title (v2)`, … ([project-workspace.md → Managed Document
  Versions](project-workspace.md#managed-document-versions)). Nothing is overwritten (D1). A revision records
  `revised_from_id` (the prototype it revises) and `revision_feedback` (the first 2,000 characters of the
  feedback); the SPA reads them with `resolveRevision` (`frontend/src/api/documentLineage.ts`) for the revision
  footer. `GET /projects/{id}/documents/{doc}/versions` lists a prototype's series like any managed series
  (`list_document_versions` in `lambda/shared/document_history.py`; an S3-backed prototype's `content` is empty
  there, its HTML being in the object). `PUT /projects/{id}/documents/{doc}` refuses a prototype's `content`
  ("Use the prototype revision workflow", `lambda/api/projects.py`). Until 6.11.00 the restore,
  `POST /projects/{id}/documents/{document_id}/versions/{version_id}/restore`, refused a prototype too; since
  6.11.00 it is Back to vN (part 2, built).
- **Provenance fields of a series.** Prose versions already record how they were made
  (`lambda/shared/document_history.py`): `edit_kind` (`edit`, `restore`, `revise`), `edited_by` (`{sub, kind}`),
  `edited_from_id`, `restored_from_id`, `restored_from_version`, and for a model-written version `llm_metadata:
  {model, prompt_version}` (`pass_llm_metadata` in `lambda/shared/document_revision.py`). Prototype versions set
  none of them today.
- **The row records no actor.** Who asked for a build or a revision is on the job row only, which is kept for
  its TTL; the document row has no `created_by`. This is the D4 gap TENETS.md already lists for project writes.

### Showing a prototype

- **Signed URLs.** The projects API signs a fresh CloudFront URL for each S3-backed prototype on every project
  read (`_with_signed_prototype_url` in `lambda/api/projects.py`, `prototype_signed_url`,
  `lambda/shared/cloudfront_signing.py`); `/prototypes/*` is restricted to a trusted key group and the URL lasts
  an hour ([project-workspace.md](project-workspace.md), "Signed media URLs").
- **The sandbox and its CSP.** `/prototypes/*` is a behaviour of the SPA's own distribution
  (`lib/stacks/core-cdn.ts`) with its own response-headers policy (`lib/utils/prototype-csp.ts`):
  `default-src 'none'`, inline script and style only, `img-src data:`, no `connect-src`, `frame-ancestors 'self'`,
  `form-action 'none'` and `sandbox allow-scripts allow-popups` (never `allow-same-origin`). A viewer-response
  CloudFront Function adds one `connect-src`, the full URL of the prototype's own pin-form submit route, and only
  when the S3 object's metadata names exactly that form. That metadata is written by the document generator and,
  since 6.11.00 (part 2's version from HTML, [below](#data-model-1)), by the projects Lambda, both through
  `prototype_object_metadata` with their own `PIN_SUBMIT_API_BASE` (`lib/stacks/api-stack.ts`). The in-app frame carries
  the same `sandbox` attribute (`HtmlPrototypeFrame` in `frontend/src/components/PrototypeRenderer.tsx`; pinned by
  `frontend/src/components/PrototypeRenderer.sandbox.test.tsx`).
- **The page.** In the project's **Documents** tab (`frontend/src/pages/ProjectDetail/DocumentsTab.tsx`) a
  prototype opens in its preview pane, not on the document canvas: `PrototypeView`
  (`frontend/src/pages/ProjectDetail/DocumentPrototypeView.tsx`) shows the live preview, **Revise with feedback**
  for editors (a dialog with one text box that starts a revision job through `build-prototype` with the base
  prototype's sources inherited), the open / download links, and the pins review
  (`frontend/src/components/PrototypePins/PrototypePinsReview.tsx`). Viewers see the preview read-only.

### Feedback on a prototype

- **Pins** are the only feedback a prototype has. Every built prototype gets one feedback form of type
  `prototype_pin` (`lambda/shared/prototype_pins.py`, form id derived from the document id) and a self-contained
  widget the server injects between two HTML comments (`lambda/shared/static/prototype-pin-widget.js`, no third-party
  code). A tester clicks an element and writes a comment; the pin records a CSS selector, the element's text, its
  bounding box, viewport, scroll, the in-prototype route, the user agent and recent console errors. It goes to the
  public `POST /feedback-forms/{id}/submit` route (inside the app via the host frame's `postMessage` bridge,
  standalone via the one `connect-src`; in the app the host forwards the pin to the form id named in the widget's
  message, `frontend/src/components/PrototypePins/usePinBridge.ts`). Pins live in the aggregates table (`PINS#{form_id}` / `PIN#{pin_id}`) with
  a status `open` / `addressed` / `resolved`, an `addressed_by` revision id and up to 50 replies. A pin records no
  author: the submit route is public and unauthenticated. A reply is `{by, name, text, at}`, written by the signed-in
  editor who posts it (`reply_to_prototype_pin` in `lambda/api/projects_handler.py`); nothing on a reply says a model
  wrote it.
- **Screening.** The comment is redacted (emails, tokens, digit runs) and screened for prompt injection
  (`injection_findings`, `lambda/shared/prompt_safety.py`); a flagged pin is kept but never reaches a model.
- **Reading pins needs EDIT on the project**, because a pin may quote what a tester typed. The gate's default
  for a GET is VIEW (`required_level` in `lambda/shared/project_access.py`, unless the route is listed in
  `_ROUTE_OVERRIDES`); the pin routes are not listed there and check EDIT in the handler instead (`_pin_form_for`
  in `lambda/api/projects_handler.py`). A job's status, `GET /projects/{id}/jobs/{job_id}`, is a GET at VIEW. The
  routes
  ([feedback-forms.md](feedback-forms.md), "Prototype pin forms"):

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects/{id}/prototypes/{document_id}/pins` | List pins (`?status=`), oldest first, at most 200 (`MAX_PINS_LISTED` in `lambda/shared/prototype_pins.py`), with no flag saying the list was cut |
| POST | `/projects/{id}/prototypes/{document_id}/pins/{pin_id}/replies` | Reply |
| POST | `/projects/{id}/prototypes/{document_id}/pins/{pin_id}/resolve` | Resolve |
| POST | `/projects/{id}/prototypes/{document_id}/pins/{pin_id}/reopen` | Reopen |
| POST | `/projects/{id}/prototypes/{document_id}/pins/addressed` | Mark open pins addressed by a revision |
| POST | `/projects/{id}/prototypes/{document_id}/pins/resolve` | Resolve addressed pins |

- **Agents** close the loop already: `collect_prototype_feedback` reads open, unflagged pins; `revise_prototype`
  (`lambda/agents/nodes/revise_prototype.py`, on the start / finish helpers in `lambda/agents/nodes/prototypes.py`)
  puts them in a `<prototype_pins>` DATA block of its revision prompt (`pins_block` in `lambda/agents/pins.py`: at
  most 15 pins, numbered, without their pin ids, 600 characters per comment, 6,000 per block), starts a
  revision through `build-prototype`, and marks them addressed (`mark_prototype_pins_addressed` in
  `lambda/api/projects_handler.py`, with `addressed_by` the revision's document id); a later passing review
  resolves them. The revision is written straight away: there is no preview or approval step.
- **Not feedback on a prototype today.** Comment threads exist only on PR/FAQs and PRDs
  (`lambda/shared/document_comments.py`, [document-review.md](document-review.md)), and so do share-for-review links.
  A standard feedback form can name a `project_id` and a `document_id`, documented for a PRD or PR/FAQ; its answers
  are ordinary feedback items in `voc-feedback` (read with `GET /feedback-forms/{id}/submissions`), and nothing
  ties them to a prototype's page.

### The assistant, MCP and the documents list

- **The assistant** is mounted once in the layout (`frontend/src/assistant/components/AssistantRoot.tsx`): a
  draggable launcher bubble and a floating panel, the same thread as `/chat`. Its page context
  (`frontend/src/assistant/page/pageContext.ts`, `pageContextSchema` in `lambda/stream/src/assistant/contract.ts`)
  carried the project and the tab, not the open document, until 6.14.00 (it now names an open prototype,
  `documentId`). Its server tool `get_project` lists documents with a `prototype: true` flag; before 6.14.00
  `get_documents` said "Prototype HTML is not available as text"
  (`lambda/stream/src/assistant/tools/server/project-shape.ts`) and the assistant could not read a prototype (it now
  reads its outline, part 2). Its client
  tool `build_prototype` (`lambda/stream/src/assistant/tools/client/plan-writes.ts`) starts a build or a
  feedback revision through `build-prototype` after the person approves its card. On a prose document the canvas
  shows the assistant's proposed edit as a diff before approval (`AssistantDiffOnCanvas.tsx` in
  `frontend/src/components/DocumentCanvas/actions/`).
- **MCP** (`lambda/shared/mcp_global_tools.py`, `lambda/shared/mcp_global_tools_steps.py`, [mcp.md](mcp.md)):
  `projects_get` lists documents (ids, types, titles, versions) in `document_sections`, grouped by section, last
  edit first within each ([Part 4](#part-4-documents-in-sections)); `documents_get` reads one (not a prototype's HTML);
  `documents_update` refuses prototypes; `projects_generate` with `step: prototype` builds one from the newest PRD
  or PR/FAQ, with only a `title` (no revision). No MCP tool reads or moderates pins.
- **The AI-mode gate does not cover prototypes.** `lambda/shared/ai_writing.py` gates only `prfaq` and `prd`
  (`GATED_DOC_TYPES`); TENETS.md tenet 3 says prototypes are AI-backed by design, in every mode.
- **The documents list** (`frontend/src/pages/ProjectDetail/DocumentList.tsx`) groups its rows (type badge,
  version or ordinal, last-edit date, title; every version a row of its own) in four sections, PRD, PR/FAQ,
  Prototypes and Documents, each a disclosure with its count and its own **New** for editors, last edit first
  within each ([Part 4](#part-4-documents-in-sections)). It is a strip above the page below 1280 px, with a row of
  section buttons above it, and a column beside it from there.
- **The project export** is two operator scripts, not a route ([project-export.md](project-export.md)): the
  bundle's `manifest.json` holds one summary per project (rows, object counts and `document_sections`, the
  documents per section), and `items.jsonl` every row, as stored.

## Part 1: guided demo (skippable)

### Behaviour

A prototype can carry a **walkthrough**: one to ten steps, each a small popup anchored to an element of the
prototype, with a title (at most 80 characters) and a body (at most 280 characters, plain text). The popup has
**Next**, **Back**, **Skip** and **Don't show again**; the last step's Next reads **Done**. A step shows "Step 2 of
5".

- **Anchors.** A step is anchored by the element's CSS selector (the same stable selector the pin widget
  records) or, when no selector fits, by a position: the bounding box as a share of the viewport plus the
  in-prototype route, exactly the pin's `anchor` shape. When the selector matches nothing on the current screen,
  the popup falls back to the recorded position; when the step's route is not the current one, the step waits
  until the prototype reaches it, and **Next** says so ("Open the Checkout screen to continue").
- **When it shows.** In the app, the first time a person opens a version that has a walkthrough: the SPA keeps a
  per-person, per-version "seen" flag (planned) beside the series' "Don't show again" flag, sets it when the
  walkthrough starts, and starts it by itself only on a version not yet seen. Opened standalone, the prototype has
  no storage (below), so it shows the walkthrough on every load. **Show walkthrough** in the preview's header
  replays it at any time. A version with no walkthrough shows nothing.
- **"Don't show again"** is remembered per viewer and per prototype series (all versions of `Title (vN)`): once
  set, no version of the series starts the walkthrough by itself; **Show walkthrough** still replays it. In the app
  the SPA stores the flag for the signed-in person and tells the walkthrough over the existing frame port whether
  to start. Opened standalone, the prototype has an opaque origin and no storage at all (the sandbox), so "Don't
  show again" lasts for that page load only; the popup says so.
- **Keyboard and screen reader.** The popup is a non-modal `role="dialog"` with an accessible name (the step's
  title) and its body as the description; focus moves to it when it opens and back to where it was when it closes;
  Tab moves through Back, Next, Skip and Don't show again; arrow keys Left and Right are Back and Next; **Esc
  skips**. The step change is announced through a polite live region. The anchored element gets a visible outline
  that does not rely on colour alone. With reduced motion asked for, nothing animates.
- **Phone.** Below 480 px wide, or when the anchor leaves no room beside it, the popup is a sheet at the bottom of
  the prototype's frame, with the anchor scrolled into view above it. No sideways scroll.
- **Writing the steps.** On the prototype's page, editors get **Walkthrough** → an editor beside the preview: add
  a step by clicking an element in the preview (the pin widget's picker, reused), reorder by dragging or with
  Alt+Shift+Up / Down, edit the text, preview from any step. **Draft with the assistant** asks the model for steps
  from the PRD / PR/FAQ the prototype was built from and the prototype's own text and structure; the draft lands in
  the editor, never saved until the editor saves. The draft job writes nothing: no row, no object, no version.

### Data model

- **One copy of the steps: the one that runs.** The steps live only in the version's HTML, as a JSON data block
  (`<script type="application/json">`, never executed, with every `<` written as its JSON Unicode escape, backslash-u-003c, so step text cannot
  close the block or open a tag) next to the walkthrough runtime, both injected by the server between their own two
  HTML comments, exactly as the pin widget is. No row field holds them. The model never writes the block in the
  HTML: every model output (a build, a revision, a draft) has any walkthrough markers, and what lies between them,
  stripped before it is stored (planned), so the only block in a stored object is the one the server injected. On
  read, the server extracts only that block and re-validates it (schema, the caps below, `injection_findings`); a
  block that fails gives no steps. The editor, MCP and the assistant read a version's steps through a planned server
  route that does this (below); the project export carries them inside the HTML objects it already exports.
- **What a model sees of a prototype.** The block is stripped from any HTML a model is given, as the widget is.
  The outline (part 2's outline route) and the walkthrough draft's input (the PRD / PR/FAQ text and the
  prototype's outline) go to the model as `lambda/shared/prompt_safety.py` DATA blocks, never as instructions:
  two tags in `DATA_BLOCK_TAGS` there, `prototype_outline` (the outline, wherever a model gets it; added in
  6.14.00) and `walkthrough_source` (planned: the PRD / PR/FAQ text given to the walkthrough draft), so the existing neutralising
  of those tags inside data applies to them.
- **The existing revision path keeps the steps** (planned change to `build-prototype`'s generator): a Revise
  through `build-prototype` strips the block from the prior HTML before the model sees it, strips any markers from
  the model's output, and re-injects the base version's steps on the new version. So a walkthrough survives a
  Revise, and agents' revisions keep it too.
- **Saving a walkthrough is a new version** of the prototype (D1), written by part 2's *version from HTML* step
  (below): the server takes the current version's HTML, replaces the walkthrough block with the new steps and
  persists the next version of the series with the series' existing provenance fields, as a prose edit records
  them: `edit_kind: edit` (no new value), `edited_by` the saver's `{sub, kind}` and `edited_from_id` the version it
  came from (D4). The previous version keeps its own steps. A version's pins stay on its own pin form (the form id
  derives from the document id), so the new version gets a new form and starts with no pins; part 3's view reads
  them across the series.
- "Don't show again" and "seen" are a viewer's preferences, not part of the prototype: per-person flags, the first
  keyed by the series, the second by the version (planned, in the browser's storage for the signed-in person);
  nothing on the server. "Don't show again" is the only thing the host stores because of a message from the frame
  (see [Security boundary](#security-boundary)); "seen" is set by the host itself when it starts the walkthrough.

### API (planned)

| Route (planned) | Who | What |
|---|---|---|
| `GET /projects/{id}/prototypes/{document_id}/walkthrough` | view | `{steps}` extracted from the version's HTML (empty when it has none) |
| `PUT /projects/{id}/prototypes/{document_id}/walkthrough` | edit | `{steps, edit_id}` → 201 and the new version (`edit_id` as the prose saves send it, `validated_edit_id`, so a retry after a lost response gets the same version, not a 409); the write expects the series at `{document_id}`'s version (`expected_last_version` of `persist_versioned_document`), so it is 409 when the series moved past it |
| `POST /projects/{id}/prototypes/{document_id}/walkthrough/draft` | edit | 202 assist job; its result is `{steps}`, nothing written (the steps come from the PRD / PR/FAQ and the prototype only, which a viewer can read, never from pins) |

Validation: at most 10 steps, the caps above, selectors at most 512 characters (the pins' cap), the text screened
by `injection_findings` (a flagged step is refused with 400 naming it: an editor is writing it, as for company
context).

### Tools (tenet 4)

- MCP (planned): `documents_get_prototype_walkthrough` (read, project: the GET),
  `documents_set_prototype_walkthrough` (write, project: the PUT) and the draft through
  `documents_draft_prototype_walkthrough` (write, project: the job; read with `projects_get_job`).
- The assistant (planned): a client tool `set_prototype_walkthrough` with an approval card that previews the
  steps; drafting is the same tool's "draft" first step through the job.

## Part 2: edit a prototype from a chat bubble

### Behaviour

On the prototype's page an editor uses the assistant: the same launcher bubble and panel as everywhere (this app's
one assistant, not a second chat), opened with **Edit with the assistant** in the preview's header, which puts the
prototype in the panel's context (a chip, "Editing: Checkout prototype (v3)").

1. The editor asks for a change in words ("make the summary a sticky footer on phones").
2. The assistant proposes a **draft revision** through an approval card that shows the exact instruction the
   revision will get (Approve / Decline). Approving starts a job; the panel says it is working and stays usable.
3. When the job finishes, the page shows the **draft** in the preview with a banner: **Applied to a preview, not
   saved**, the model's summary of what changed (by screen and element), **Compare** (side by side or toggle with
   the current version), **Apply as v4** and **Discard**. Another change is another instruction, drafted on the
   newest saved version.
4. **Apply** writes the draft as the next version of the series; earlier versions are kept. Applying the same
   draft twice (a double click, a retry) gives the same version, not two. If the series has moved past the draft's
   base in the meantime, Apply answers 409 and the editor asks again on the newest version. A draft can be applied
   for 7 days after it is ready (its job's lifetime); after that it is gone and the editor asks again.
   **Discard** deletes the draft's job (`DELETE /projects/{id}/prototypes/{document_id}/drafts/{draft_id}`, which
   deletes only a draft job of that series; the page uses the existing `DELETE /projects/{id}/jobs/{job_id}`, which
   deletes the same row), so the draft is gone at once, over every surface.
   The version header gets **Back to v3**, one click, which writes v5 from v3's HTML (a restore is a new version,
   as for prose documents); nothing is deleted.

Only people who may edit the project see **Edit with the assistant**, the drafts and Apply. A viewer sees the
preview, can leave pins (the widget's **Feedback**, as today) and can ask the assistant questions about the
prototype; the assistant offers them no edit (the server refuses one with 403 regardless).

### Data model

- **A draft** is a finished draft job plus one S3 object in the raw-data bucket (`RAW_DATA_BUCKET`, where live
  prototypes are), inside the project's own prototype prefix: the candidate HTML at
  `prototypes/{project_id}/drafts/{job_id}.html` (`prototype_draft_s3_key` in `lambda/shared/prototypes.py`, built
  in 6.12.00), write-once, with no pin-submit metadata. Its detail is the job row's `draft` attribute (`{summary,
  base_document_id, base_version, instruction, llm_metadata}`; the summary is the model's `<change_summary>` block
  as plain text, tags and angle brackets dropped, at most 12 lines of 240 characters and 2,000 in all; for a
  feedback draft, part 3, the per-pin notes too), which no job route returns, as the job's config is not
  (`_project_job_row` in `lambda/api/projects_handler.py`); only the draft GET reads it. The draft id is the job id. A draft's base is always a saved version, never another draft. The
  draft's pin widget is inert: no pin form exists for it until Apply, and the object names none. No row exists
  until Apply, so a draft is in no list, no project read and no Prioritization row.
- **Why under `prototypes/`.** Every rule that guards prototype objects today already covers that key, with no new
  grant: the document generator's read and put on `prototypes/*` (`lib/stacks/api-job-lambdas.ts`), the projects
  Lambda's object access on it, to sign and delete (`grantWorkspaceObjects` in `lib/stacks/api-projects-lambda.ts`),
  the Data Explorer role's explicit DENY of put and delete on `prototypes/*` (`lib/stacks/api-assistant-lambdas.ts`)
  and its handler's own guard (`_reject_read_only_prefix` in `lambda/api/data_explorer_handler.py`), the
  `prototypes/` entry of `RAW_BUCKET_WORKSPACE_PREFIXES` (`lib/stacks/core-buckets.ts`) and the cdk-nag
  acknowledgements of `prototypes/*` (`lib/utils/nag-stack-acknowledgements.ts`), and the project delete, which
  removes everything under `prototype_project_prefix` (`prototypes/{project_id}/`, `lambda/api/projects.py`). The
  agent nodes and the persona panel can read `prototypes/*` (`lib/stacks/agent-runtime.ts`), so they could read a
  draft: accepted, as it is a read of the same project's data, with no write. Two things changed (6.12.00): the
  project export (`scripts/project_bundle/exporter.py`, which copies every object under `prototypes/{project_id}/`)
  skips `drafts/`, so a draft is in no bundle; and drafts have their own CloudFront behaviour (below).
- **Served by its own behaviour.** `/prototypes/*/drafts/*` on the same distribution (`lib/stacks/core-cdn.ts`,
  6.12.00), added before `/prototypes/*` so a draft never gets the live policy, with the same origin, trusted key
  group and cache policy, and the draft policy `PROTOTYPE_DRAFT_CSP` (`lib/utils/prototype-csp.ts`; [Security
  boundary](#security-boundary): no `allow-popups`, no `connect-src`, no pin-CSP function). CDK tests in
  `lib/stacks/core-cdn-drafts.test.ts`: the path pattern and its place before `/prototypes/*`, its origin, key
  group and cache, its policy, and no function; `lib/stacks/core-stack.test.ts` holds it to a signature with every
  other private path.
- **The job result holds only `draft_id`.** The job status route is a GET at VIEW, so the summary and outcomes are
  never in the job's result; they are read through the draft GET, at EDIT. A viewer polling the job of a draft
  sees its status and `draft_id`, nothing else. The job row also keeps what the draft was made from (the base
  version, the instruction, or the `pin_ids` the server accepted and the ones it withheld), which Apply trusts
  instead of the request.
- **A draft lives as long as its job row.** A finished job expires 7 days after it ends (the job's TTL,
  `lambda/shared/jobs.py`), and an editor may delete it sooner (Discard: the draft DELETE below, or
  `DELETE /projects/{id}/jobs/{job_id}`). Once the row
  is gone, the draft GET and Apply answer 404; they never fall back to a key built from the request. DynamoDB
  removes an expired row late (TTL deletion is best effort), so both also treat a row whose `ttl` is past as gone.
  The draft's object is removed with the project (the project delete above); until then no app route reaches it.
- **Bound to its job.** `GET …/drafts/{draft_id}` and Apply accept a draft only when the job row is a finished
  draft job of this project whose base is a version of this series; GET signs only that job's draft key.
- **The drafting job** (6.12.00, `_draft_prototype` in `lambda/jobs/document_generator/handler.py`): the base
  is the head of the series when the drafts POST arrives, re-read by id; one call on the `prototype` surface with the
  build's system prompt and grounding (its output rule replaced: the `<change_summary>` block first, then the whole
  HTML) and the base's HTML (pin widget stripped, capped as a revision's is); the detail is written to the job row
  first, then the object (widget stripped again), so a retried job that finds both completes without a second
  model call. `llm_metadata` is `pass_llm_metadata` (`lambda/shared/document_revision.py`) of the model that
  answered (`answering_model`) and `DRAFT_PROMPT_VERSION` (`lambda/shared/prototype_drafts.py`). No HTML in the
  answer fails the job; a job deleted (discarded) while it runs ends without an object.
- **Apply is idempotent.** Apply persists the version through `persist_versioned_document`
  (`lambda/shared/document_versions.py`) with an allocation id derived from the draft (`apply:{draft_id}`). That function already returns
  the version that landed when the same allocation is replayed, before any new write, and also when a concurrent
  write of the same allocation wins the race; and an Apply refused as stale because the draft's own version
  landed meanwhile answers that version (`apply_draft` in `lambda/shared/prototype_drafts.py` re-reads the
  allocation before it says 409). So a replayed Apply (the version already there when it arrives) answers 200 with
  the same version, and two Applies at the same moment give one version, both possibly answering 201 (each looked
  before the other landed); never a second version. The object write is idempotent
  too: version from HTML treats S3's `PreconditionFailed` (or `ConditionalRequestConflict`) on the new version's
  key as an earlier attempt's write, as the generator's `_put_prototype_html` does today
  (`lambda/jobs/document_generator/handler.py`), so an Apply whose first attempt wrote the object but not the row
  succeeds on retry. The pins' marks and replies (part 3) are idempotent each, so every Apply call, a replay
  included, finishes the set: a mark is conditional on the pin being open, and a reply carries an id derived from
  the draft and the pin and is skipped when the thread already has it. A retry after a failure between the version
  and the marks therefore completes them, and a replay writes no second mark or reply. Apply passes the base's version as `expected_last_version`, so when the series has moved past the
  draft's base it is 409 and the editor asks again (a replay of an Apply that landed is checked first and still
  returns its version).
- **What an applied version records** (D4, the series' existing fields, no new `edit_kind` value): `edit_kind:
  revise`, as a prose revision records; `revised_from_id` the base (the revision footer reads it,
  `resolveRevision`); `revision_feedback`; `edited_by` the applier's `{sub, kind}`; and `llm_metadata: {model,
  prompt_version}` (`pass_llm_metadata` in `lambda/shared/document_revision.py`). It writes no `edited_from_id`:
  nothing reads it on a prototype, and `revised_from_id` already names the base.
- **`revision_feedback` stays a short string**, as today (at most 2,000 characters, shown by the revision
  footer): for a chat draft the editor's instruction; for a feedback draft "Incorporated N pins (k done)". It
  holds no pin text and no model note (the project read returns it to viewers). The per-pin outcomes live in the
  pins themselves (their marks and replies, part 3), not in that string.
- **Version from HTML** (one server step; the walkthrough save, Back to vN and Apply all use it; built in 6.11.00
  except the walkthrough's part, which comes with part 1): from the given HTML, strip the pin widget
  (`strip_pin_widget`) and every walkthrough marker and block; re-inject the walkthrough (when the version has
  steps) and the pin widget with the **new** document's pin form id
  (`inject_pin_widget`); create that form (`ensure_pin_form`); write the object at the new version's key with the
  `pin-submit-url` metadata (`prototype_object_metadata`) using `put_object(IfNoneMatch='*')`, never the duplicate
  route's server-side copy (`_copy_prototype_html` in `lambda/api/projects.py` keeps the source's widget and form
  id). So a restored, applied or walkthrough version's pins land on its own form, never on the version it came
  from. The walkthrough PUT, Apply and the restore are synchronous routes of the projects Lambda, so the step runs
  there: that Lambda has `PIN_SUBMIT_API_BASE` since 6.11.00, the same value as the document generator's
  (`lib/stacks/api-stack.ts`, pinned for both by `lib/stacks/api-stack-jobs.test.ts`), as has its assist twin, a
  separate function whose environment `lib/stacks/api-stack-assist-workers.test.ts` holds equal to the API
  function's. Built as `version_from_html` in `lambda/shared/prototype_versions.py`, whose write-once put the
  generator now uses too. The projects Lambda writes object metadata the CloudFront function trusts, so it is a
  second writer of `pin-submit-url` (see [Security boundary](#security-boundary)). A version made from one of the
  oldest prototypes, whose HTML is inline in the row's `content`, takes that HTML; an early JSON screen spec has no
  HTML and is refused (400), and a version whose object is gone is a 404.
- **Back to vN** (built in 6.11.00) is the existing restore route,
  `POST /projects/{id}/documents/{document_id}/versions/{version_id}/restore`. It used to refuse a prototype;
  `restore_document` (`lambda/api/projects.py`) now sends a prototype to version from HTML
  (`restore_prototype_version`): it reads vN's HTML, runs the step, and persists the next version with the fields
  the prose restore already writes, `edit_kind: restore`, `edited_from_id` (the newest version), `restored_from_id` and
  `restored_from_version`, plus `edited_by`. The prose restore's no-op check compares `content`, which is empty on
  both rows of an S3-backed prototype, so for prototypes it would always say "unchanged": a prototype skips that
  check, and restoring a version whose HTML matches the newest writes one redundant version (D1 keeps it; nothing
  is lost).

### API

All five are built: the four draft routes in 6.12.00 (`{instruction}` only), the outline in 6.14.00.

| Route | Who | What |
|---|---|---|
| `POST /projects/{id}/prototypes/{document_id}/drafts` | edit | `{instruction}` (kind `chat`: stripped, 1 to 2,000 characters; optional `response_language`) or `{pin_ids: [1..50]}` (kind `feedback`, 6.15.00: [Part 3](#built-so-far-part-3s-read-side-and-incorporate)); both or neither is a 400 → `{success, job_id, status: pending, message}`, the job's result `{draft_id}`. 404 unless `document_id` is a prototype of the project; its series' head is the base, and a head whose HTML cannot be read is refused before any job (400 for an early JSON spec, 404 for a lost object) |
| `GET /projects/{id}/prototypes/{document_id}/drafts/{draft_id}` | edit (listed in `_ROUTE_OVERRIDES`) | `{draft_id, kind, base_document_id, base_version, instruction, summary, preview_url, completed_at}`: `kind` `chat` or `feedback`; `preview_url` the draft's signed URL (its own key only; null when signing is unavailable). A feedback draft adds `outcomes`, `withheld` and `ignored` (6.15.00) |
| `POST /projects/{id}/prototypes/{document_id}/drafts/{draft_id}/apply` | edit | No body: the base and its version come from the job row → 201 `{success, document}` (the new version, signed as the project read signs it); 200 and the same version on a replayed Apply; 409 when the series moved past the base; 404 when the job row is gone |
| `DELETE /projects/{id}/prototypes/{document_id}/drafts/{draft_id}` | edit | Discard → `{success: true}`: the draft's job row deleted, as `DELETE /projects/{id}/jobs/{job_id}` deletes it. 404 unless the row is a `draft_prototype` job of this project whose base (from its config) is a version of `document_id`'s series, in any state (a draft still being made can be discarded); so it deletes nothing but drafts. The MCP tool calls it; the page uses the job DELETE |
| `GET /projects/{id}/prototypes/{document_id}/outline` | view | `{document_id, version, title, screens: [{route, headings, text}], truncated}` of the version `document_id` names (`outline_of` in `lambda/shared/prototype_outline.py`): extracted on the server from its HTML (its object, or inline HTML: `version_html`), with the pin widget, `script`, `style`, `svg`, `template`, `noscript` and `head` (but the head's own `<title>`) left out, a head left open closed by `<body>`, and hidden text left out (`hidden`, `aria-hidden="true"`, an inline `display: none`; a screen itself is kept, as an inactive screen is hidden until shown). A screen is an element with `data-screen` / `data-route` / `data-page`, a `<section id>`, or an `id` with a class `screen`, `page` or `view`; text outside every screen is the screen `""`. The first 512 KB of HTML are read, elements nest at most 256 deep; at most 40 screens, 200 lines of 300 characters and 12,000 characters in all, title and routes counted (`truncated`); every line, route and the title have their DATA-block tags defanged. Never pins. 400 for an early JSON spec, 404 for a lost object or a document that is no prototype of the project. Planned (part 1): the walkthrough block stripped too |

The drafts body is validated: exactly one of `instruction` and `pin_ids`; with `pin_ids` there is no free text
for the pins: the server writes the instruction and builds the pins DATA block from the ids (part 3). Back to vN
is the existing restore route (above), not a new one. The outline is a GET at VIEW (the default for a GET; it
holds only what a viewer of the prototype already sees, never pins).

The drafting job runs where builds run today, in the document generator (`build-prototype`'s job, with the
draft mode added), not on the assistant's SSE path: a whole-file revision takes minutes (tenet 7, "How work
moves"). "Draft ready" reaches the browser as the person's AppSync Events notice; polling the job is the fallback.

### Tools (tenet 4)

- The assistant (built in 6.14.00): `draft_prototype_revision` (client tool, project pack,
  `lambda/stream/src/assistant/tools/client/prototype-draft.ts`: `{project_id, document_id, instruction}`, the
  instruction 1 to 2,000 characters, both ids defaulting to the page; its approval card (the SPA's) shows the exact
  instruction and the prototype's title and version; on approval the SPA calls the drafts POST with `{instruction}`
  and reports the job id; card-only, never a plan step: `CARD_ONLY_WRITE_TOOLS`); a server tool
  `get_prototype_outline` on the outline route (`tools/server/prototype-outline.ts`), so the model can read a
  prototype's screens, headings and visible text, given to it inside a `<prototype_outline>` DATA block, every line
  neutralised. The stream Lambda neutralises DATA tags with its own list (`DATA_BLOCK_TAG` in
  `lambda/stream/src/assistant/runtime/page-context.ts`), which holds `prototype_outline`, as Python's
  `DATA_BLOCK_TAGS` does. Applying is the page's banner (Apply beside the preview and Compare): the assistant points
  to it and has no apply tool, so the only in-app Apply is the one shown with the full preview.
- The assistant's page context (built in 6.14.00): a field `documentId` in `pageContextSchema`
  (`lambda/stream/src/assistant/contract.ts`, at most `MAX_ID_LENGTH`) and in the SPA's
  `frontend/src/assistant/page/pageContext.ts`, set to the open prototype's id, so the panel's chip and the tools
  name the version on screen (the system prompt names it as "this prototype", and both tools default to it). It
  is a hint only: every route a tool calls with it checks access itself. Tests: the schema accepts a `documentId`
  within `MAX_ID_LENGTH` and refuses a longer one, and the SPA sets it on a prototype's page and leaves it out
  elsewhere.
- MCP (built in 6.12.00, `lambda/shared/mcp_global_tools_steps.py`, [mcp.md](mcp.md)):
  `documents_draft_prototype_revision`, `documents_apply_prototype_draft`, `documents_discard_prototype_draft`
  (write, project; the last is the draft DELETE, never the bare job DELETE), with the job polled through `projects_get_job` (status and
  `draft_id`) and the draft read through `documents_get_prototype_draft` (the EDIT draft GET): its summary (and,
  since 6.15.00, a feedback draft's `outcomes`, `withheld` and `ignored`) only, the `preview_url` projected out as every signed URL is for a token holder
  (`public()` in `lambda/shared/mcp_global_kit.py` drops keys holding `url`); Apply's answer drops the version's
  signed `prototype_url` the same way. `documents_get_prototype_outline` (read, project: the outline GET, built
  in 6.14.00).
- Back to vN has no tool of its own here: the existing restore route has no MCP or assistant tool for any document
  type today, and a restore tool for every versioned type is a follow-up.
- The existing `build_prototype` tool and `build-prototype` route keep revising straight to a new version, as
  agents and plans use them today.

## Part 3: feedback into the prototype

"The feedback" here is the prototype's own pin form: its pins, and their replies as the comments. Prototypes have
no comment threads. Two other kinds of input are out of scope: the answers of other feedback forms ([Open for the
owner](#open-for-the-owner), question 2), and the findings of agents' reviews of a prototype (the persona panel,
`lambda/agents/persona_panel/`, and `final_review` in `lambda/agents/nodes/final_review.py`), which stay in the
agents' own runs.

### Behaviour

**Feedback** on the prototype's page opens one view of everything said about this prototype series:

- **Sources**: the pins of every version of the series (each with its version) and their replies. Nothing else.
- **Grouped and deduplicated, deterministically, with no model**: by screen (the pin's route), then by element
  (selector; a pin without one by its position). Two pins are folded into one item, "3 testers said this", when
  they are at the same position (the same route and selector, or without a selector bounding-box centres within 5 %
  of the viewport of each other) and their texts are identical or near-identical after normalising (lower case,
  whitespace collapsed, punctuation dropped): equal, or a word-set overlap (Jaccard) of at least 0.8. Groups and
  items are ordered by route, selector, then the earliest pin's time, with ties broken by pin id, so the same pins
  always give the same view.
- **Each item** shows who ("Tester": a pin records no author), where (screen, element, version), when, its status
  and its replies. Flagged items (instruction-shaped text) are listed with a "Not sent to the AI" note and cannot
  be selected.
- **Selecting**: a checkbox per item and **Select all in this group**; a count ("7 selected") and **Incorporate**.
  Nothing is selected by default. At most 50 pins per incorporation: an item that folds several pins counts each
  of them, and the count says so ("7 selected, 12 pins").
- **Incorporate** starts one revision for the selected items: a draft of kind `feedback` (part 2's drafts route
  with the items' pin ids, the same preview, compare, Apply and Discard), with a summary per item: **Done** and what changed, or **Not done** and why (contradicts the
  PRD, needs data the prototype does not have, conflicts with another selected item). The editor applies it or
  not. **Nothing is applied without the editor's selection and their Apply.**
- **After Apply**, the pins of the items the summary marks Done are marked addressed by the new version, shown as
  **Incorporated in v4**; the Not done ones stay open with the reason as a reply. The marks are visible in the app
  to anyone who can see the prototype's feedback (EDIT on the project, today). **Limit:** a pin is anonymous, so
  its author cannot be told; the view says so.

### Data model

No new storage. The existing loop is reused:

- **Reading**: the pins of each version's form, as `GET …/pins` reads them (`list_pins` in
  `lambda/shared/prototype_pins.py`), merged across the series. `list_pins` stops at 200 pins per form
  (`MAX_PINS_LISTED`) and says nothing when it does; the feedback route returns a `partial` flag, and the
  versions it cut, whenever a version's list reached that cap, and the view says "Showing the first 200 pins of
  v2". A version with exactly 200 pins is reported the same way: `list_pins` cannot tell it from more.
- **Scale.** The feedback read is one pin query per version of the series (each version has its own form), so its
  cost grows with the number of versions: the route reads at most the newest versions the versions list returns
  (25, `VERSION_LIST_LIMIT` in `lambda/shared/document_history.py`) and says so in the same `partial` flag beyond
  that. No new hot key: each query is its own form's partition, as `GET …/pins` is today.
- **Which pins Apply touches**: only the accepted `pin_ids` stored on the draft's job row that were sent to the model
  (the withheld ones are stored apart); an accepted pin the model did not answer counts as Not done and gets the fixed
  reply "The AI gave no answer for this pin.", and a pin withheld or gone when the job ran is untouched. Any other id in the model's answer (one it made up, one
  of another series, a withheld one) is dropped and listed in the draft's detail as ignored; nothing in the request
  widens the set.
- **Marking**: Apply sets the Done pins of that set addressed (the same status change `mark_prototype_pins_addressed`
  in `lambda/api/projects_handler.py` makes, per source version's form), with `addressed_by` the new version's
  document id (the revision's id names its version, so there is no separate version field). Resolving stays a
  person's or a later review's step, as today.
- **Not done replies are the model's words, marked so.** The reason is appended as a reply on the pin (as
  `append_reply` does), but not as the applier's own reply: it carries an author kind (`kind: ai`, 6.15.00), the
  draft's `llm_metadata` and whoever applied it as its approver (`approved_by`, the caller's `{sub, kind}`: the
  person in the app, the token over MCP), and the view shows it as "AI reason, approved by an editor". A person's
  reply keeps today's shape.
- **What changed, per item**: the model's note per pin is in the draft's detail (read at EDIT through the draft
  GET); the per-pin outcome is on the pins themselves (Done: the `addressed_by` mark; Not done: the marked reply,
  read at EDIT, as pins are). The applied version's `revision_feedback` is only "Incorporated N pins (k done)"
  (part 2).
- **The pins DATA block** (built in 6.13.00, called since 6.15.00): `pins_block` in `lambda/agents/pins.py` is built
  for agents (15 pins, numbered without ids, 6,000 characters), so it does not fit 50 selected items answered one by
  one. The shared layer has its own, `incorporation_pins_block` in `lambda/shared/prototype_pins.py`, that carries up
  to 50 pins with their pin ids and replies, capped per pin and per block, inside a `prompt_safety`
  `<prototype_pins>` DATA block, and asks the model to answer per pin id (Done / Not done and a reason). The document
  generator's draft job uses it for a `pin_ids` draft; the job never imports from the agents package. Agents'
  `pins_block` may later be built on it.

### Built so far: Part 3's read side and Incorporate

The read side is built (6.13.00), and Incorporate's server side in 6.15.00 (below,
`lambda/shared/prototype_incorporation.py`):

- **The drafts POST with `{pin_ids}`** (exactly one of `instruction` and `pin_ids`; 1 to 50 pin ids, duplicates
  folded): the pins are those the Feedback view lists (`series_pins` in `lambda/shared/prototype_feedback.py`); an
  id that is no pin of the series is a 400 naming how many ("2 of the selected pins are not pins of this
  prototype"), a flagged pin (or one with no mark) is withheld, and a request whose every pin is withheld is a 400.
  The job config keeps `kind: feedback`, the accepted pins (`{pin_id, form_id, document_id, version}`), the withheld
  ids and the server's instruction, "Incorporate the selected tester feedback".
- **The job** reads the accepted pins again by key, gives them to the model only as `incorporation_pins_block`'s
  DATA block (a pin flagged since is withheld again), and asks for a `<pin_outcomes>` block, one line per pin id,
  `pin_id: Done: what changed` or `pin_id: Not done: why`, before the HTML (`DRAFT_PROMPT_VERSION` 1.1.0). The
  draft's detail gains `kind`, `outcomes: [{pin_id, outcome: done | not_done, note}]` for the accepted pins only
  (the first answer per id; an unanswered pin is Not done, "The AI gave no answer for this pin."; notes plain text,
  500 characters), `withheld` and `ignored` (ids the model answered that were not accepted).
- **The draft GET** adds `kind` (`chat` or `feedback`) and, for a feedback draft, `outcomes`, `withheld`, `ignored`.
- **Apply** (of any draft) records `revised_from_draft_id`, the draft's id, on the version (the project read returns
  it), so a client tells an applied draft by id. A feedback draft's version has `revision_feedback` "Incorporated N
  pins (k done)", then, on every call (replays included): each Done pin of the accepted set marked addressed by the
  new version, from open and once per draft (a mark id from the draft and the pin, `mark_ids` on the pin,
  conditional: a replay never marks again a pin an editor reopened since, it reports it `reopened`), then one reply
  per Not done pin, written once (an id from the draft and the pin, `reply_ids` on the pin, conditional),
  `{by: 'ai', name: 'AI', text, at, kind: 'ai', llm_metadata, approved_by: {sub, kind}}`. The answer adds
  `incorporation: {marked: [ids], replied: [ids], not_written: [{pin_id, reason}]}` with reasons `pin_gone`,
  `already_addressed`, `already_resolved`, `reopened`, `thread_full` and `note_withheld` (an instruction-shaped note
  is not posted). The version stands whatever is not written. The feedback read lists an AI reply with `kind`, `llm_metadata` and `approved_by`; a person's keeps its
  four keys.

- `GET /projects/{id}/prototypes/{document_id}/feedback` (below), EDIT through `_ROUTE_OVERRIDES`; grouping and
  dedup in `lambda/shared/prototype_feedback.py` (`group_pins`, `read_feedback`).
- `incorporation_pins_block` in `lambda/shared/prototype_pins.py` (up to 50 pins with their ids and up to 5 replies,
  600 / 300 / 20,000 characters, flagged pins withheld and returned, an unsafe anchor field left out), built in 6.13.00;
  the drafts job calls it for a `pin_ids` draft since 6.15.00.
- MCP `documents_list_prototype_feedback` and the assistant's server tool `get_prototype_feedback`
  (`lambda/stream/src/assistant/tools/server/prototype-feedback.ts`): a flagged item or pin keeps only its ids,
  version, status and the parts of its place (route, selector) not judged unsafe. The element text, selector and route are judged one by one (the route's
  `unsafe_fields` per item, `route_unsafe` per group) and one that reads like an instruction is left out; a pin is
  flagged on its comment alone. Both cap a pin's text at 600 characters and send its newest 5 replies (300 each).
- The page's **Feedback** dialog for editors (`frontend/src/components/PrototypeFeedback/`, opened from the HTML
  prototype's toolbar): groups, items, the "Not sent to the AI" note, checkboxes, Select all in this group and the
  "N selected, M pins" count with the 50-pin cap (Incorporate is off while a refetch has folded the selection past
  it). Its Incorporate button starts a feedback draft with the selected pins' ids (since 6.15.00), and it shows a
  Done pin as **Incorporated in vN** and an AI reply as "AI reason, approved by an editor".

### API

| Route | Who | What |
|---|---|---|
| `GET /projects/{id}/prototypes/{document_id}/feedback` | edit (listed in `_ROUTE_OVERRIDES`) | Every item of the series, grouped, with status and marks (`?status=`, `?version=`), and `partial` (with the versions cut) when a version's pins reached the 200 cap or the series has more versions than are read |

Incorporate is part 2's `POST …/drafts` with `{pin_ids: [≤ 50]}`: **pin ids, never text**, at most 50 pins. The
server reads those pins itself, refuses more than 50 and any that are not pins of this series, withholds the
flagged ones (listed as withheld in the draft's detail), stores the accepted and withheld ids on the job row, and
builds the DATA block with `incorporation_pins_block` above (built in 6.13.00, called by the draft job since 6.15.00).

Apply is part 2's `…/drafts/{draft_id}/apply`; for a feedback draft it writes the version, then marks the Done pins
addressed, then posts the Not done replies, in that order, on every call (each mark and reply is idempotent, so a
replayed or concurrent Apply finishes the set and writes nothing twice, part 2), and reports each mark or
reply it could not write (a thread already at its 50 replies, a pin addressed or resolved meanwhile); the version
stands, as Revise from comments does.

Reading feedback stays **EDIT** on the project, as reading pins is today: an item may quote what a tester typed.
Being a GET, the route is listed in `_ROUTE_OVERRIDES` at EDIT (the default for a GET is VIEW).

### Tools (tenet 4)

- MCP: `documents_list_prototype_feedback` (read, project, built), then part 2's
  `documents_draft_prototype_revision` taking the chosen `pin_ids` (6.15.00) and
  `documents_apply_prototype_draft`.
- The assistant: a server tool `get_prototype_feedback` (built), then part 2's `draft_prototype_revision` (built
  for an instruction, 6.14.00) taking **pin ids only** (6.15.00: `pin_ids`, ≤ 50, exactly one of it and
  `instruction`), never feedback text; its approval card lists the selected items and shows the instruction the
  server will use. Apply is the page's banner (part 2).
- Both feedback tools leave out the text (and replies) of flagged items, giving only their id, place and "flagged",
  so instruction-shaped text never reaches a model through them either; the page's view shows it to the editor.
- Agents keep `collect_prototype_feedback` and `revise_prototype` (Decision 5: they keep writing versions
  directly).

## Part 4: documents in sections

### Behaviour

The project's documents list groups its documents in four sections, always in this order:

1. **PRD** (`prd`)
2. **PR/FAQ** (`prfaq`)
3. **Prototypes** (`prototype`)
4. **Documents**: everything else (`research` reports, `custom` documents, `product_report`s and `decision`
   records), and any type added later

- Each section is a disclosure: a button with the section name and its count ("Prototypes, 3"), `aria-expanded`,
  and its list below. Every section starts open on each page view; folding is not remembered. A section with
  nothing in it shows its heading, a count of 0 and its **New** action, so the step is visible before it is done.
- Within a section, documents are ordered by last edit, newest first (`updated_at`, else `created_at`; ties by
  `document_id`), and each row shows that date. The `#document` mentions, MCP `projects_get` and the assistant's
  `get_project` use the same order.
- **New** per section, for editors: PRD and PR/FAQ open their writing wizards (the person's way of working
  applies, unchanged), Prototypes opens the build dialog (disabled with its reason when the project has no PRD or
  PR/FAQ, the existing 409 rule), Documents opens the existing **New document**. Viewers see no New.
- Keyboard: the section headers and rows are in reading order; a section header's button toggles with Enter or
  Space. Screen readers hear "PR/FAQ, 2 documents, expanded". Below 1280 px, where the list is a strip above the
  page, the sections become a row of section buttons above the strip (the selected document's section open), so
  the strip never scrolls sideways through all four.

### Data model and API

Built. No new storage and no new route. The section is a pure function of `document_type`, the server helper
`document_section(document_type)` (`lambda/shared/document_sections.py`, with `SECTION_ORDER`), used by the project read, the export manifest and the MCP
and assistant listings, so every client and the bundle agree. A legacy managed row with no `document_type` (sort
key `PRD#`, `PRFAQ#` or `PROTOTYPE#`, awaiting the metadata backfill) is in its sort key's section, as the backfill
reads it (`row_section(row)` on the server; the SPA's and the stream's fallbacks do the same):

- `GET /projects/{id}`: each document carries a `section` field, computed on read (`prd`, `prfaq`, `prototypes`,
  `documents`); clients group and count by it, in the helper's fixed order (no second, derived list).
- The project export: the bundle manifest's project summary has `document_sections`, a count per section; the rows
  themselves are unchanged, so an older bundle still imports.

### Tools (tenet 4)

- MCP `projects_get` and the assistant's `get_project` list documents grouped by the same sections, in the same
  order (`document_sections: [{section, documents}]`, every section kept, empty ones too, last edit first within
  each), and `#document` mentions in the assistant ([assistant-mentions.md](assistant-mentions.md)) list them
  grouped the same way.

## Security boundary

- **Every message from the frame is untrusted input.** The prototype's own script shares the frame with the pin
  widget and the walkthrough runtime, so it can drive the widget's side of the bridge
  (`frontend/src/components/PrototypePins/usePinBridge.ts`) and its port as well as they can. What the host does
  with each message (planned change to `usePinBridge.ts`): a pin is forwarded to the public, unauthenticated submit
  route of **the form of the document the host is showing** (its id from the project read), never to the `formId`
  in the message; it is anonymous, redacted and screened there, as every pin is. A standalone pin is bound to its
  form by the `connect-src`; a pin over the bridge is bound by the host's own choice of form. A draft's frame gets no
  pin bridge: pin messages from it are dropped. A walkthrough "don't show again" sets only the viewer's per-series
  flag in the browser. Nothing that arrives over the bridge writes anything as the viewer or with their identity, and
  no planned route takes an author from it. That is why pins stay anonymous.
- **The walkthrough runs inside the prototype's own document, never from outside it.** Its runtime is a static,
  self-contained script in the repository (planned, beside `lambda/shared/static/prototype-pin-widget.js`), injected
  by the server into the HTML it writes, as the widget is. The SPA never injects script into the frame and the
  frame never loads any: the CSP stays exactly as it is for `/prototypes/*` (`PROTOTYPE_BASE_CSP` in
  `lib/utils/prototype-csp.ts`, no new `connect-src`, the sandbox without `allow-same-origin`), and
  `lib/utils/prototype-csp.test.ts` keeps pinning it. The SPA sends the frame only small typed messages over the
  existing private port (start, stop, "don't show again" state), never text to render as HTML. The step data block
  escapes `<`, and the runtime sets step text with `textContent`.
- **What a prototype can still reach.** There is no `connect-src` (beyond the pin form's own submit URL), but the
  sandbox keeps `allow-popups`, so a prototype's script can open a popup, and it can navigate its own frame, to any
  address, carrying data in the URL. That is the exit today for every prototype, and it stays for applied versions
  (prototypes link out by design). The data such a script can see is the prototype itself and what the viewer types
  into it, never the app's (opaque origin, no `allow-same-origin`, no top navigation).
- **Drafts are narrower.** A draft is served from its own `/prototypes/*/drafts/*` behaviour (6.12.00), ahead of
  `/prototypes/*`, signed with the same trusted key group, with a draft variant of the policy: the same CSP without `allow-popups` and with no `connect-src` at
  all. It runs only in the editor's own in-app frame, whose `sandbox` attribute also leaves out `allow-popups`. The
  viewer never renders model HTML any other way (no `srcdoc` of a draft, no `blob:` URL). A draft can still
  navigate its own frame; it reaches no one but editors until one applies it.
- **A second writer of the pin-submit metadata.** The CloudFront function trusts an object's `pin-submit-url`
  metadata to widen `connect-src` to one submit URL. The document generator writes it, and since 6.11.00 the
  projects Lambda too (version from HTML), always through `prototype_object_metadata` for the new version's own
  form and `PIN_SUBMIT_API_BASE`, never from a value in the request. Draft objects carry none (`put_draft_html`
  in `lambda/shared/prototype_drafts.py` writes no metadata).
- **The draft summary and per-item notes are model text**: rendered as plain text, capped, never as Markdown links
  or HTML, and read only at EDIT (the draft GET).
- **Model-written walkthrough blocks.** A model could write walkthrough markers in its HTML to fake steps. Every
  model output has them stripped before it is stored, and on read only the server-injected block is extracted and
  re-validated (schema, caps, `injection_findings`); see Part 1's data model.
- **Prompt injection from feedback.** Feedback text reaches the model only inside DATA blocks
  (`lambda/shared/prompt_safety.py`): pins and their replies in `<prototype_pins>`, built by the server from pin
  ids (`incorporation_pins_block`, part 3, the draft job's since 6.15.00), never from text a client or the assistant
  passes. The prototype outline (a `<prototype_outline>` block, 6.14.00) and the walkthrough draft's input are DATA
  blocks too. Flagged items are withheld and say so. The
  editor's own instruction in part 2 is the instruction, shown verbatim on the approval card; anything quoted from
  feedback is data. A steered model can only produce HTML that runs in the sandbox above, and it reaches no one
  until an editor applies it.
- **Authorization** is the projects API's per-project gate (`required_level` in `lambda/shared/project_access.py`:
  a GET falls back to view, every other method to edit, unless listed in `_ROUTE_OVERRIDES`): EDIT for every write;
  EDIT for the draft GET and the feedback GET, both listed in `_ROUTE_OVERRIDES` (being GETs); VIEW for a version's
  walkthrough steps, for its outline and for the job status, which for a draft job holds only `draft_id`. An autonomous caller (agent, plan step, MCP
  token) is capped at editor, as today. Every new mutating route is classified in
  `lambda/api/test/test_route_admin_gates.py`.

## Cost (tenet 7)

No fixed cost: every model call is pay per use on the existing surfaces (`prototype` for drafts and
incorporation, the documents surface for walkthrough drafts), every long call runs as a job, every notice is an
AppSync Events message, and storage is one object per draft (its HTML), kept until the project is deleted, beside
its detail on the job row, which expires with the job. Grouping and deduplication work without a model.
Part 4 adds no call at all.

## Tests that prove it

- **Routes**: each GET that needs EDIT is listed in `_ROUTE_OVERRIDES` (`lambda/shared/project_access.py`); writes
  fall back to edit. In `lambda/api/test/test_project_permissions.py`, a 403 for a viewer on every new write
  (walkthrough PUT and draft, drafts with an instruction and with pin ids, apply, the restore of a prototype), on
  the draft GET and on the feedback GET; the job status of a draft job, read by a viewer, holds its status and
  `draft_id` and none of the summary or outcomes. Every new mutating route is classified in
  `lambda/api/test/test_route_admin_gates.py`.
- **Part 4**: a server test keyed on every `document_type` value the SPA knows (`KnownProjectDocumentType` in
  `frontend/src/api/types.ts`: `prd`, `prfaq`, `research`, `custom`, `product_report`, `prototype`, `decision`),
  each mapped to its section and order, with an unknown type in Documents, and a check that the two lists stay
  the same (a new type added to one fails the test until it has a section); that the project read, the export
  manifest (per-section counts, rows unchanged) and the MCP and assistant listings group the same way; component
  tests of the list (order, counts, fold, New per section, viewer without New, keyboard) and, below 1280 px, the
  sections as a row of buttons with no sideways scroll.
- **Part 2**: a draft writes no row and is served only by a signed URL of its own key (never `srcdoc`), under
  `prototypes/{project_id}/drafts/`, with the draft policy (no `allow-popups`); a draft is never in the project read,
  and the export skips `drafts/` (a bundle of a project with a draft has none of its objects); the project delete
  removes the draft objects (they are under `prototype_project_prefix`); GET and Apply refuse a job of another
  project or series, an unfinished job and a non-draft job, and answer 404 once the job row is gone (expired or
  deleted, and for a row still present whose `ttl` is past) without reading any key from the request; Discard
  (the draft DELETE or the job DELETE) makes the draft GET and Apply 404, and the draft DELETE refuses a job that
  is not a draft and a draft of another series (404, nothing deleted); no job route returns the draft's detail; a second Apply of
  the same draft answers 200 with the same version as the first (201), and two concurrent Applies give one
  version, with one set of marks and replies; an Apply whose first attempt wrote the object but not the row
  succeeds on retry; an Apply that failed after the version landed, retried, writes the marks and replies exactly
  once; a stale Apply is 409; Apply writes one version with `edit_kind: revise`, `revised_from_id` the base, `edited_by`,
  `llm_metadata` and no `edited_from_id`, and a `revision_feedback` that is the instruction or "Incorporated N pins
  (k done)", within 2,000 characters, with no pin text and no model note; the walkthrough PUT and Apply take no
  `expected_document_id` and are 409 through `expected_last_version`; the drafts body refuses both `instruction`
  and `pin_ids`, neither, and more than 50 pins; Back to vN through the existing restore route is a new version with
  `edit_kind: restore`, `restored_from_id` and `restored_from_version` (the refusal for prototypes gone), and is
  never reported unchanged for a prototype; the walkthrough PUT retried with the same `edit_id` gives the same
  version; version from HTML
  writes with `IfNoneMatch='*'`, creates the new form and writes its `pin-submit-url`; a restored or walkthrough
  version's pins land on its own form (beside `lambda/api/test/test_prototype_pins.py`); the outline GET is
  readable by a viewer, capped, has the widget and walkthrough stripped, and reaches the model inside a
  `<prototype_outline>` DATA block.
- **CDK** (planned, `lib/stacks/*.test.ts`): the `/prototypes/*/drafts/*` behaviour's path pattern, its precedence
  over `/prototypes/*`, its trusted key group and its draft response-headers policy, and no pin-CSP function on it;
  the projects Lambda's `PIN_SUBMIT_API_BASE`, the same as the document generator's; no new grant on the raw bucket
  (the existing `core-buckets.test.ts` check of grants against `RAW_BUCKET_WORKSPACE_PREFIXES` still passes).
- **Prompt safety**: `prototype_outline` and `walkthrough_source` are in `DATA_BLOCK_TAGS`, and a closing tag of
  either inside outline or PRD text is neutralised, as the existing tags are; the stream Lambda's `DATA_BLOCK_TAG`
  holds `prototype_outline`, with a test beside `page-context.ts`'s own; the MCP draft tool's answer has no signed
  URL; the feedback tools' answers carry no text of a flagged item.
- **Part 3**: grouping and dedup are deterministic (the same pins in any order give the same view; identical and
  near-identical texts at one position fold, at two positions do not); the feedback route sets `partial` (naming the
  version) when a version's pins reach the 200 cap, and when the series has more versions than are read, and not
  otherwise; a feedback draft takes ids only, refuses more than 50 pins (an item folding several pins counts each)
  and pins of another series, and flagged pins never reach the prompt; the shared pins block carries up to 50 pins
  with their ids, within its caps, and the model's answer is read per pin id; the document generator does not
  import the agents package; nothing is incorporated without an explicit item list; Apply runs in the order
  version, then marks, then replies; a model answer naming a pin id that is not in the job's stored `pin_ids`, or
  one withheld as flagged, changes no pin; only the Done pins are addressed, with `addressed_by` the new version;
  the Not done ones stay open with the reason as a reply marked model-written (author kind, `llm_metadata`, the
  applier as approver), never shaped as the applier's own reply; a mark or reply it could not write (a thread at 50
  replies, a pin already addressed) is reported while the version stands; nothing is marked before Apply.
- **Part 1**: validation and screening of steps; injection and stripping of the walkthrough block, with a step text
  holding `</script>` staying inside the block; the GET extracting and re-validating only the server-injected block;
  a model-written fake block (in a build, a revision or a draft) is stripped before the object is stored; a
  walkthrough survives a Revise through `build-prototype` (the base version's steps on the new version); the
  walkthrough draft job writes nothing (no row, no object) and its input is DATA blocks; the runtime's own tests
  (keyboard, Esc skips, fallback anchors, reduced motion, step text set with `textContent`), as
  `frontend/src/components/PrototypePins/prototypePinWidget.test.ts` tests the widget; "Don't show again" per
  series (set on v2, v3 does not start by itself; another series does); the "seen" flag per person and version (a
  seen version does not start again by itself, a new version does); standalone, the walkthrough shows on every
  load; a walkthrough save writes a new version with `edit_kind: edit`, `edited_by` and `edited_from_id`, leaves the
  previous object and row untouched, and is 409 when the series moved; the CSP test unchanged for `/prototypes/*`.
- **Pin bridge**: the host forwards a pin to the shown document's form whatever `formId` the message names, and a
  draft's frame drops pin messages (beside `usePinBridge.ts`'s own tests).
- Every new route has its SPA type, Zod schema, dev mock and MCP tool in step (REVIEW.md), and every new string an
  i18n key in every locale.

## Design notes

Part 3 reuses the agents' loop (`mark_prototype_pins_addressed` and `addressed_by`, `GET …/pins`, `pins_block`)
instead of new pin fields or an incorporation row (the only addition is a model-written reply's marking), and groups only by deterministic dedup, with no model theme
grouping. Part 1 keeps one copy of the steps, the HTML block that runs, so a row field cannot drift from what
people see; the "Updated" badge is dropped with it. Part 4 computes sections in one server helper because the brief
asks for the same sections in the export and the tools, and does not remember folding. One alternative was
rejected: replacing part 2's drafts with the existing `build_prototype` approval card. The brief asks for a preview
with a summary of the changes that the editor then applies as a new version, with one click back, and that card writes
straight to a version; the existing route stays for agents and plans. The slice order stays 4 → 2 → 3 → 1 because
part 2's version from HTML (with its re-injection) is what parts 3 and 1 reuse.

## Tenet check

Against [TENETS.md](../TENETS.md).

| Part | Advances | Tension and how it resolves |
|---|---|---|
| 1 Walkthrough | 2 (the prototype explains the flow the PRD describes, so a review starts from the intended path) | None with data: steps are part of a version, saved as a new one (D1), in one copy. |
| 2 Chat edit | 2 (the prototype step gets a fast loop), 4 (the same draft over REST, MCP and the assistant; apply and discard over REST and MCP, and on the page) | Speed versus review: every edit is a preview until an editor applies it. |
| 3 Feedback in | 2 (the review step feeds the prototype, and every change cites the feedback it came from), 1 (feedback is read, never edited) | Telling testers versus their privacy: pins stay anonymous (anything over the frame's bridge is untrusted), so an author cannot be told; the marks show in the app instead. |
| 4 Sections | 2 (each document shown under its methodology step) | Decision 1 keeps the brief's order (PRD, PR/FAQ, Prototypes, Documents); the owner's request listed them as "PRD, Documents, PR/FAQ, Prototypes", and the brief's is the one followed. That order puts PRD before PR/FAQ, the reverse of tenet 2's methodology (PR/FAQ before PRD): the tension is recorded here, and the owner may swap the first two. |

- **D1, versions.** Every change to a prototype (a walkthrough save, an applied draft, an incorporation, a restore)
  is a new document row and a new write-once S3 object; no route overwrites a prototype, and restore is a new
  version. Pins only move through their existing statuses and gain replies.
- **D4, audit.** The new versions record the series' existing provenance fields, with no new `edit_kind` value:
  an applied draft is `revise` (with `revised_from_id`, `edited_by {sub, kind}` and `llm_metadata {model,
  prompt_version}`), a walkthrough save is `edit` (with `edited_by` and `edited_from_id`), and Back to vN is
  `restore` (with `edited_by`, `edited_from_id`, `restored_from_id` and `restored_from_version`). An
  incorporation's outcome is on the pins: `addressed_by` for the Done ones, and for the Not done ones a reply
  marked as the model's, with its `llm_metadata` and the applier who approved it. This closes part of the D4 gap
  TENETS.md lists for project documents, for prototypes only.
- **Tenet 3, AI mode.** Prototypes are not a gated type (`GATED_DOC_TYPES` is `prfaq`, `prd`) and are AI-backed by
  design in every mode, so no step here asks `ai_writing`. How each AI step behaves per way of working:

| AI step | Human-driven | AI-assisted | AI-driven |
|---|---|---|---|
| Walkthrough draft | Offered; a draft the person edits and saves | Same | Same |
| Chat edit (part 2) | Offered; a draft, applied only by the editor | Same | Same: still a draft, never applied by itself |
| Incorporate (part 3) | Offered; a draft, applied only by the editor | Same | Same |

  The owner's rule (nothing applied without the editor) is stricter than Revise from comments, where AI-driven
  applies directly; it holds in every mode. What none of these may do is write a PR/FAQ or PRD: they change
  prototype HTML and walkthrough steps only, and the caps (ten steps of 280 characters) keep a walkthrough from
  carrying a document under another type. Hand-written steps, grouping and part 4 need no model.
- **Tenet 4, parity.** Every action of the page (read, write and draft steps, draft a revision, compare, apply,
  discard, list feedback, incorporate, sections) has its planned route and MCP tool (compare is the page's view of
  two signed URLs), and the assistant's tools call the same routes; the assistant drafts but does not apply, by
  design (the page's banner is where the full preview is). One gap, written down as follow-up: Back to vN uses the existing restore route, which has no MCP or
  assistant tool for any document type today. Authorization, caps, screening and the "apply needs an explicit call" rule are on the server.
- **Tenet 6 and 7.** No new resource with a monthly cost, no new role that can delete customer data, no wider
  CSP (drafts get a narrower one); jobs, not model calls on the request path.
- **What it is not.** Not an HTML editor (people do not edit prototype code by hand), not an auto-apply loop, not a
  way to edit customer feedback, not signed-in or attributed pins, not a reader of other feedback forms' answers,
  not a second chat (the bubble is the one assistant), not a change to how agents revise prototypes today.

## Slices and order

Chosen: **4 → 2 → 3 → 1**, each slice shippable on its own (built partly in parallel: part 4 and part 3's
feedback view need nothing from the others).

1. **Part 4, sections.** No model, no storage, small; it makes the next three findable.
2. **Part 2, drafts, Apply and Back to vN.** It builds the pieces the other two reuse: version from HTML (with the
   widget's re-injection on the new form), a draft preview, and the actor and model on the version.
3. **Part 3, feedback in.** The feedback view first (no AI), then Incorporate on part 2's drafts.
4. **Part 1, walkthrough.** Hand-written steps and the runtime first, the assistant's draft second.

The order 4 → 1 → 2 → 3 would ship the demo sooner but write the version-from-HTML piece twice.

**Built so far.** 6.11.00: part 2's first slice, version from HTML and Back to vN (the button on the
prototype's pane: "Back to v3" on the newest version, "Restore v2" on an older one, editors only), with
`PIN_SUBMIT_API_BASE` on the projects Lambda. 6.12.00: part 2's drafts from an instruction: the drafts route and
job (`doc_type: draft_prototype` in the document generator), the draft GET, Apply and Discard
(`lambda/shared/prototype_drafts.py`, the routes in `lambda/api/projects_handler.py`), the
`/prototypes/*/drafts/*` behaviour with `PROTOTYPE_DRAFT_CSP`, the export's skip of `drafts/`, the four MCP draft
tools, and the draft banner on the prototype pane. 6.13.00: part 3's read side (the feedback GET, its MCP and assistant
tools, the Feedback dialog: [Built so far: Part 3's read side and Incorporate](#built-so-far-part-3s-read-side-and-incorporate)). 6.14.00: the
outline (its GET, `documents_get_prototype_outline`, the assistant's `get_prototype_outline` in a
`<prototype_outline>` DATA block), the assistant's `draft_prototype_revision`, the page context's `documentId` and
**Edit with the assistant** on the prototype's pane. 6.15.00: part 3's Incorporate (`pin_ids` drafts, per-pin
outcomes, Apply's marks and AI-marked replies, the tools' `pin_ids`). 6.16.00: part 4, documents in sections
([Part 4](#part-4-documents-in-sections)). Not yet: part 1.

## Decisions (2026-11-13)

1. **Section order:** PRD, PR/FAQ, Prototypes, Documents (the brief's order; the request listed "PRD, Documents,
   PR/FAQ, Prototypes").
2. **The share-for-review page:** out of scope here. Prototypes get no review link in this feature, so the
   walkthrough shows in the app's prototype view and on the prototype's own signed link.
3. **Standalone "Don't show again":** remembered per viewer in the app (the app stores it, not the sandbox); on a
   standalone link it lasts for that page load.
4. **Limits:** ten steps of 280 characters, 50 pins per incorporation (an item folding several pins counts each);
   an unapplied draft can be opened and applied as long as its job row lives (7 days after it finishes, or until an
   editor deletes the job: Discard), its detail goes with the job row, and its one S3 object (its HTML) is removed
   with the project.
5. **Agents:** `revise_prototype` keeps writing versions directly, as today; drafts are for people.
6. **Anonymous testers:** no note inside the prototype; the "incorporated in vN" marks show in the app, to anyone
   who can see the feedback.

## Open for the owner

1. **"Maybe add it as a new feature request."** File this as a request on the app's own feedback board
   ([feature-requests.md](feature-requests.md)) so people can +1 the parts, with this page linked from it? That is
   data in a deployment, not code, so it is left to the owner.
2. **Form answers.** Should a standard feedback form be allowed to name a prototype's `document_id` (today it is
   documented for a PRD or PR/FAQ), and should those answers then count as customer evidence for the prototype?
   Until decided, part 3 reads only the prototype's own pin form.

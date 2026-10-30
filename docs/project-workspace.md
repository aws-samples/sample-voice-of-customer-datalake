# Project Workspace

The Projects workspace turns customer feedback into research artifacts, lets teams compare concrete artifact combinations, and is reachable by external agents through the app-wide MCP server on **Connect** ([mcp.md](mcp.md)). Projects are private to their owner and invited members by default; see [Sharing and permissions](#sharing-and-permissions).

## Workflow

1. Create a project and select the feedback window and filters that ground it.
2. Generate or import personas and run research.
3. Create PRDs, PR/FAQs, product reports, and prototypes from project context.
4. Review each artifact's provenance and revisions in the Documents tab.
5. Compose project artifacts into Prioritization rows and collect ballots.
6. Hand the project to an external agent: **Connect via MCP** in the project header opens Connect with a token pinned to the project, and a PRD or PR/FAQ's export menu still offers **Copy to Kiro**.

Long-running research, persona, document, merge, and prototype operations run as background jobs. Their status appears in the project. The `list_jobs` MCP tool returns only the newest 50 jobs and has no continuation token or partial-result flag.

## Product tab

The **Product** tab (`/projects/<id>?tab=product`) holds the project's product description, which PRD, PR/FAQ,
product-report and prototype generation read as context. It shows one header (what the tab is for, how many of the
11 fields are filled, when it was last saved), the company context it inherits (read-only, edited in Knowledge →
Company), the description in five sections (the product · customers and problem · offering · goals and boundaries
· notes; every field saves on its own when you leave it), and two side cards: internal documents (images and text,
extracted for the generators) and **Generate report**. A viewer sees the fields and documents read-only, without
the assistant button, uploads or the report.

**Fill with AI assistant** (editors) opens the AI assistant on a new conversation with the request "Interview me to
fill in this project's product description." drafted; nothing is sent until you press send. The assistant then reads
the current description (`get_product_context`) and asks about the fields that are still empty, one question per
message, in this order: product name, one-liner, target users, problem solved, current state (idea, MVP, beta,
generally available, mature), key features, competitors/alternatives and differentiators, goals and success
metrics, constraints and known limitations, non-goals, anything else. After the last answer it proposes ONE
`update_product_context` approval card with every answer; nothing is saved until you approve it, and the form shows
the approved values at once. The questions live in one place, the assistant's guidance
(`lambda/stream/src/assistant/tools/product-interview.ts`), offered only when the caller may edit the project.

The embedded interview chat this tab had before (and its route `POST /projects/{id}/product-context/interview`)
was removed: the assistant bubble does the same job, with its approval cards.

## Which feedback a generation reads

A persona, research or document job can put only a few hundred reviews in front of the model (the limit follows the model's context window), while the chosen window often matches tens of thousands. The job therefore reads EVERY review the window and filters match — sources, categories, sentiments, channel, dimensions, tag, the date basis and your category/source access — and takes an **even sample** across them, so each day (and source, category, …) is represented in proportion to how much of the match it holds. The sample is deterministic: the same filters over the same data pick the same reviews. Previously the read took the newest reviews only, so one big import day could become the whole corpus.

Limits: the window read covers at most 90 days that hold feedback (within 400 calendar days for "All time"), at most 50,000 matching reviews and about 20 seconds of reading. Past either of the last two the sample covers the newest part of the window only, and the job's log line `[FEEDBACK] Sampled N of M matching reviews (at least; the read was capped)` says so. A channel filter reads the channel index (`gsi5-by-channel`), so a small channel inside a big import is found in full.

**The corpus is stored with the result** (issue #236). Every artefact generated from feedback carries `input_feedback_ids`: the ids of the reviews its prompts held, in prompt order, at most 500 (`MAX_INPUT_FEEDBACK_IDS`, `lambda/shared/feedback_sampling.py`). That covers:

| Artefact | Written by | Ids stored |
|---|---|---|
| Persona | persona job (`api/projects.py`) | the reviews the persona-writing step read |
| Research report | research workflow (`research/research_step_handler.py`); the synchronous fallback (`run_research`) | the reviews the research prompt held (the fallback: every review it fetched) |
| PRD, PR/FAQ | document generator, single-shot and Step Functions paths (`jobs/document_generator`), so also "Pursue" on a decision and the agents' write-PRD / write-PR/FAQ nodes | the reviews the chain's feedback block held, after the character budget |
| Merged document | document merger (`jobs/document_merger`), when "use feedback" is on | the 20 reviews the merge prompt quotes |

Not covered, because no review reaches their prompt: prototypes (built from a PRD / PR/FAQ and tester pins), avatar regeneration, persona import, the product report. The suggestion routes (PR/FAQ autofill, suggest-brief, suggest-questions) read feedback but store no artefact. The job result keeps only the counts (`feedback_items_used`, `context_truncated`); the id list lives on the artefact. An edit of a PRD / PR/FAQ is a new version that keeps its predecessor's ids.

**Ids only, never review text** (a design decision): copying customer text into project rows would put it out of reach of source retention and erasure ([source policies](source-policies.md#what-erasure-does-not-reach)). A review erased or deleted since simply shows as unavailable.

**In the UI**, a persona's header and a document's provenance footer show "Written from N reviews" with **Show reviews**, which opens the list ten at a time. Each review is read by id (`GET /feedback/{id}`, so the caller's category and source access applies) and opens in the review modal; one that is gone or outside the caller's access shows as unavailable.

`source_feedback_ids` on a persona (the first 20 reviews fetched) is **display-only** and kept for older readers: it is not the corpus, and nothing in the app reads it. Artefacts generated before the field reached their path have no `input_feedback_ids` and show no corpus line: personas before 5.25.00; PRDs, PR/FAQs, merged documents and fallback research reports before 5.49.00. Imported and hand-made ones never have it.

## Managed Document Versions

PRDs, PR/FAQs, and prototypes are version-managed. Documents with the same type and base title form a persistent series named `Title (v1)`, `Title (v2)`, and so on.

- A retry of the same job returns the already allocated document instead of creating another version.
- Deleting a document does not reuse its version number. Allocation history remains so a delayed retry cannot recreate deleted work under a new version.
- Legacy managed documents are assigned stable identities when read and persisted before a new version is allocated.
- Revision metadata identifies the prototype being revised and the feedback that drove the revision.
- Derivation metadata identifies source documents and whether the generator used all selected inputs.

**Every edit is a new version.** Saving a document — in the page editor or through the assistant's `update_document` — never overwrites it (`PUT /projects/{id}/documents/{doc}`, answers the saved document):

- A PRD or PR/FAQ edit is the next version of its series, allocated exactly like a regeneration (`edit:{source}:{edit_id}`, so a replayed request returns the version it made). The edited version stays as it was; the new one has its own id.
- A research or custom document keeps its id; the content and title it replaces are saved as a revision (`REVISION#{doc}#{n}` in the version partition), in one transaction conditioned on the revision that was read, so a concurrent save gets a 409 instead of being lost. Deleting the document removes its revisions.
- An edit that changes nothing saves nothing. Prototypes are revised through their own workflow.
- **Stale saves across tabs** (`expected_revision`, optional): the document editor sends the revision it loaded — a research / custom document's `revision` (unset = 1), a PRD / PR/FAQ's `version` (it must be the series head). When someone saved in between, the edit is a **409** and nothing is written; the editor offers **Load the latest** (reopen on the newest version) or **Save mine anyway** (resend without the check, so the other save stays in the history). A PRD / PR/FAQ save that loses the race for the next version mid-flight is a 409 too, not a silent v(n+2). Without the field there is no check (the assistant's and MCP's `update_document`).
- **Versions** (below a document) lists the versions newest first — `GET /projects/{id}/documents/{doc}/versions`, view level — to open one or compare it with the current version. **Restore** (`POST …/versions/{version_id}/restore`, edit level) saves a NEW version with that content; history is only added to.

Version counters and allocation-history records are platform-managed. Do not delete rows under the `DOCUMENT_VERSIONS#PROJECT#<id>` partition; see [Data Lake Structure](data-lake-structure.md#projects-table).

## Prioritization Rows

A Prioritization row is a concrete set of scorable documents from one project, not a moving pointer to “the latest” artifacts.

- Any authenticated reviewer can compose another row from a project's scorable documents.
- A row can be recomposed only before its first value-bearing ballot. A stamp-only/all-null save does not freeze it. Once a score lands, the selected document IDs stay fixed so later regeneration cannot change what reviewers scored.
- Admin deletion is available only when the row is not the project's sole default row and has at most 98 ballots. The server deletes an eligible row and those ballots atomically. A room session can accept up to 200 ballots, so a larger row must be retained; the delete endpoint refuses it rather than partially cleaning it up.
- Room voting creates a time-limited session and QR code so participants can score from their own devices.
- Rows follow their project's permissions: creating or recomposing a row and opening a room session need edit access to the row's project, scoring needs view access, and the board hides rows whose project you cannot view (admins see every row).
- Lineage indicators distinguish a coherent document chain, missing lineage, and cross-generation selections.
- A frozen row may be marked stale when a strictly newer, non-contradictory combination of the same document types exists. This is advice, not a gate: the row remains visible and scorable.

When a frozen row is stale, add a new row for the newer combination instead of mutating the row whose ballots describe the older artifacts.

## Sharing and permissions

Every project has a visibility, an owner, and an optional list of invited members. The policy lives in `lambda/shared/project_access.py` and is enforced centrally by the Projects API.

- **Public** — every signed-in user can view and edit the project. This is the pre-permissions behaviour.
- **Private** — only the owner, invited members, and workspace admins (the Cognito `admins` group) can see it. To anyone else the project does not exist: list results omit it and direct requests return `404 Project not found`.

New projects are **private** by default and owned by their creator. Only callers with *manage* access can change a project's sharing.

| Role | View | Edit | Manage |
|------|:----:|:----:|:------:|
| Owner | ✓ | ✓ | ✓ |
| Admin (workspace `admins` group) | ✓ | ✓ | ✓ |
| Editor (invited member) | ✓ | ✓ | — |
| Viewer (invited member) | ✓ | — | — |

*Manage* covers changing visibility, inviting, re-roling and removing members, transferring ownership, and deleting the project. On a public project every signed-in user is effectively an editor; a viewer invitation does not lower that. A caller who can view but not act gets `403` (`You do not have permission to edit this project` / `... to manage this project`). Members may always remove themselves.

**Legacy projects** created before this feature have no owner and no visibility. They read as public, so nobody loses access on upgrade, and only admins can manage them until an admin transfers ownership to a user.

**Editing from the list.** On `/projects`, each card the caller can *edit* has an **Edit** button. It is decided by the `access.can_edit` that `GET /projects` returns for every row, and a row without `access` gets no button. The dialog changes the name and description (`PUT /projects/{id}`, edit level; a blank name is a `400`). Callers who can *manage* the project also get the visibility choice (`PUT /projects/{id}/visibility`). Only the fields that changed are sent, so an editor's rename never makes the manage-level call. The card updates immediately and rolls back if the save fails.

| Method | Path | Level | Purpose |
|--------|------|-------|---------|
| PUT | `/projects/{id}/visibility` | manage | Set `public` or `private` |
| GET | `/projects/{id}/members` | view | Visibility, owner, members, and the caller's access (emails for managers only) |
| GET | `/projects/{id}/members/candidates?q=` | manage | Prefix search of enabled Cognito users (username or email, max 20) |
| POST | `/projects/{id}/members` | manage | Invite a user as `editor` or `viewer` (max 100 members) |
| PUT | `/projects/{id}/members/{sub}` | manage | Change a member's role |
| DELETE | `/projects/{id}/members/{sub}` | manage, or self | Remove a member, or leave |
| POST | `/projects/{id}/owner` | manage | Transfer ownership; the previous owner stays as an editor |

Project objects returned by list, get, and create carry computed `visibility`, `owner`, `access` (`role`, `can_view`, `can_edit`, `can_manage`), and `member_count` fields. Every other `/projects/{id}/...` route requires *view* for `GET` and *edit* for anything else.

**Emails are for managers only.** Project list and get responses and `GET /projects/{id}/members` include the owner's and each member's `email` (and the raw `owner_email` on a project object) only when the caller has `can_manage` — the owner or an admin. Editors and viewers get the same `owner` and `members` entries with the `email` key omitted (not blanked). Usernames, roles, and `sub`s are visible to everyone who can view the project.

**Signed media URLs outlive a removal until they expire.** Persona avatars (`/avatars/*`) and prototypes (`/prototypes/*`) are served through CloudFront signed URLs minted at read time by `lambda/shared/cloudfront_signing.py` (and `lambda/stream/src/lib/cloudfront-signing.ts` for the assistant). Their TTL is `CDN_SIGNED_URL_TTL_SECONDS`, which no stack sets, so the fallback of **3600 s (1 hour)** applies — matched to the 1-hour Cognito ID/access token lifetime. A member who is removed, or a project made private, loses API access immediately, but any signed URL they already hold keeps working until its `Expires`, at most an hour later. Shortening the TTL is possible but of limited value: it only narrows that window for media the user has already been shown, while the frontend never re-signs a URL on expiry and relies on the 30 s query `staleTime` plus refetch-on-focus to pick up fresh ones. Keep it well above 30 s; lower it (for example to 15 minutes) only if prototypes carry content sensitive enough that a one-hour tail after revocation matters.

**Each avatar image has its own key.** An avatar is stored at `avatars/{persona_id}/{sha256-prefix}.{ext}` (older ones at the flat `avatars/{persona_id}.{ext}`), stamped with its project as S3 metadata. Objects are cached `immutable` and the `/avatars/*` cache key ignores the query string, so a regeneration must never reuse a key: **Regenerate avatar** (the refresh button on a persona's detail, `POST /projects/{id}/personas/{persona_id}/regenerate-avatar`, edit level) writes a new key, saves it on the persona, answers the new signed URL, then removes the images it superseded. Persona delete, persona regeneration and project delete sweep both layouts, and only ever objects stamped with their own project (persona ids are not unique across projects).

**A failed avatar says why.** Generation never fails the persona (it is saved without an avatar), but every failure writes ONE ERROR line, `[PERSONA_AVATAR] Avatar generation failed (<reason>, <AWS error code>): <plain words>`, with `persona_id`, `avatar_failure_reason`, `error_code`, `model_id`, `region`, `stage` (`config` / `invoke` / `upload`) and the AWS error text (≤ 500 chars) — never the persona's name, bio or image prompt — so Administration → System → Logs shows the cause without AWS access. Reasons (`lambda/shared/avatar_failure.py`): `no_access` (AccessDenied, or the Marketplace subscription a Stability model needs on first use), `model_not_found` (retired / legacy / invalid model id), `throttled` (throttling or quota), `content_filtered` (the model's filter, also a 200 answer with no image), `validation`, `region_unavailable`, `not_configured` (no `RAW_DATA_BUCKET`), `disabled` (`AVATARS_ENABLED=false`; INFO, not an error) and `error`. An S3 failure while storing the image is reported as the bucket's (`stage: upload`), never as a model access problem. **Regenerate avatar** shows the same reason as its job error, e.g. "Avatar generation failed: the image model stability.stable-image-core-v1:1 is not enabled in us-west-2 for this account, or the role may not invoke it (AccessDeniedException). …".

**The AI assistant acts as the calling user.** Streaming chat forwards the caller's own Cognito claims to the Projects API, so it can never read or change more than the person chatting with it:

- **View-only project on screen** — the run preloads the project and, when it reports `can_edit: false`, drops every project write tool (`CLIENT_TOOLS.project`: document, persona, product-context, research and generation writes) before the first model turn. Reads stay available.
- **Writes to another view-only project** — a project write whose `project_id` belongs to a project a read in this run reported as view-only is refused back to the model *before* any approval card is shown (`lambda/stream/src/assistant/runtime/tool-calls.ts`). A project the run has not read is "unknown", never assumed read-only.
- **REST is the authority** — an approved write is executed by the SPA against the normal Projects API, which re-checks *edit* access; the two checks above only avoid showing a card that would fail.
- **Sharing is never an assistant action** — visibility, invitations, role changes, member removal and ownership transfer are not assistant tools at all; they happen only in the project's sharing UI.

An MCP token acts as the user who minted it — never as an admin, and never above editor — and its read reach still applies on top. Tokens cannot create projects.

## Company personas

The **Company** page (`/company`) has a **Personas** tab (`?tab=personas`) beside Vision and Design system: one shared library of personas for the whole workspace. Every signed-in user reads it; **only admins write it** (generate, import, edit, notes, regenerate the avatar, delete, and promote a project persona into it). Company personas are not filtered by category access.

**Copy, never link.** Moving a persona between the library and a project always makes an independent copy with a new id, its own avatar image, and a `copied_from` record (`{scope: 'project' | 'company', project_id?, project_name?, persona_id, copied_at, copied_by}`, replaced on a copy of a copy). **Research notes are never copied**, in either direction: the copy starts with no notes. Later edits to either side do not reach the other. Deleting a company persona is a hard delete, like a project persona.

- **Promote to company** (Project → Personas, admins only): `POST /projects/{id}/personas/{persona_id}/promote` → `201 {success, persona}`. It needs edit on the project and admin; a non-admin gets `403`.
- **Copy personas in** (Project → Personas, edit on the target project): `GET /projects/{id}/personas/copy-sources` (view) lists the library and the OTHER projects you **own or are a member of** that have personas (at most 100, by name). `POST /projects/{id}/personas/copy` with `{source: {scope: 'company'} | {scope: 'project', project_id}, persona_ids: [1–20 ids]}` → `201 {success, personas}`. A public project you are not a member of is not a source, also for an admin; such a project, a missing one, and the library's own id answer `404 Project not found`. A persona id that is not in the source answers `404 Persona not found`; a bad body or this project as its own source answers `400`.
- **Avatars are copied** to `avatars/{new persona id}/…` and stamped with the target as their owner, so deleting the source project never removes a copy's image. A failed image copy saves the persona without an avatar.

| Method | Path | Who | Answer |
|---|---|---|---|
| GET | `/company-personas` | every signed-in user | `{personas, can_edit}` (newest first; `can_edit` = an admin acting for themselves) |
| POST | `/company-personas/generate` | admin | Same body as project generation; always **adds** to the library (never replaces) → `{success, job_id, status: 'running'}` |
| POST | `/company-personas/import` | admin | Same body as project import → `{success, job_id, status: 'running'}` |
| GET | `/company-personas/jobs` | every signed-in user | `{success, jobs}` like `GET /projects/{id}/jobs` |
| GET | `/company-personas/jobs/{job_id}` | admin | Like `GET /projects/{id}/jobs/{job_id}` (polls generation, import and avatar jobs) |
| PUT / DELETE | `/company-personas/{persona_id}` | admin | Edit (same body as the project route) / hard delete with its avatar |
| POST | `/company-personas/{persona_id}/notes` | admin | Add a research note |
| POST | `/company-personas/{persona_id}/regenerate-avatar` | admin | `202` assist job; poll `GET /company-personas/jobs/{job_id}` |

Generation reads the same feedback and SHARED company knowledge as project generation (never personal memories), with web search off.

**The assistant stays project-scoped.** `@persona` / `@all` mentions, `consult_personas`, persona review and the agents' persona panel only see the current project's personas. To use a company persona there, copy it into the project.

**Storage.** The library is a reserved persona container, `company_personas` (`lambda/shared/company_personas.py`): rows `PROJECT#company_personas` / `PERSONA#{id}`, a META row created on the first write and never listed as a project, and jobs under the same partition in voc-jobs. The id is not a project: every `/projects/company_personas/...` route answers `404 Project not found`, for admins too, and `GET /projects?ids=` leaves it out.

## MCP access

External assistants reach projects through the **global MCP server** (`POST {api}/mcp/global`). Tokens are minted on **Connect** (`/connect`) and act as the minting user — their project access, never admin, at most editor — optionally pinned to one project. See [mcp.md](mcp.md).

The project header's **Connect via MCP** link opens `/connect?project={id}`, which pre-selects that project as the token's pin. An old `?tab=mcp` link opens the Overview tab.

### Removed: the per-project Export / MCP tab

The project page no longer has an **Export / MCP** tab. It used to mint and revoke per-project tokens, show a per-project `mcp.json`, copy a Kiro "autoseed" context bundle, and edit the project's Kiro export prompt. Since 3.00.00 the backend behind it is retired too:

- **Per-project MCP server — removed.** `POST {api}/mcp` and its token routes (`GET`/`POST /projects/{id}/api-tokens`, `DELETE /projects/{id}/api-tokens/{token_id}`) are gone; per-project tokens and the `mcp.json` files that carry them stop working (a per-project token is a 401 at `/mcp/global`). Mint a global token on Connect instead.
- **`GET /projects/{id}/autoseed`** — removed (404).
- **Kiro export prompt.** **Copy to Kiro** in a document's export menu always pastes the backend's instructions (`kiro_default_export_prompt` on `GET /projects/{id}`). A prompt saved on a project before 3.00.00 stays stored but is never read or returned, and `POST /projects` and `PUT /projects/{id}` ignore a `kiro_export_prompt` field.

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

**The AI assistant acts as the calling user.** Streaming chat forwards the caller's own Cognito claims to the Projects API, so it can never read or change more than the person chatting with it:

- **View-only project on screen** — the run preloads the project and, when it reports `can_edit: false`, drops every project write tool (`CLIENT_TOOLS.project`: document, persona, product-context, research and generation writes) before the first model turn. Reads stay available.
- **Writes to another view-only project** — a project write whose `project_id` belongs to a project a read in this run reported as view-only is refused back to the model *before* any approval card is shown (`lambda/stream/src/assistant/runtime/tool-calls.ts`). A project the run has not read is "unknown", never assumed read-only.
- **REST is the authority** — an approved write is executed by the SPA against the normal Projects API, which re-checks *edit* access; the two checks above only avoid showing a card that would fail.
- **Sharing is never an assistant action** — visibility, invitations, role changes, member removal and ownership transfer are not assistant tools at all; they happen only in the project's sharing UI.

An MCP token acts as the user who minted it — never as an admin, and never above editor — and its read reach still applies on top. Tokens cannot create projects.

## MCP access

External assistants reach projects through the **global MCP server** (`POST {api}/mcp/global`). Tokens are minted on **Connect** (`/connect`) and act as the minting user — their project access, never admin, at most editor — optionally pinned to one project. See [mcp.md](mcp.md).

The project header's **Connect via MCP** link opens `/connect?project={id}`, which pre-selects that project as the token's pin. An old `?tab=mcp` link opens the Overview tab.

### Removed: the per-project Export / MCP tab

The project page no longer has an **Export / MCP** tab. It used to mint and revoke per-project tokens, show a per-project `mcp.json`, copy a Kiro "autoseed" context bundle, and edit the project's Kiro export prompt. Since 3.00.00 the backend behind it is retired too:

- **Per-project MCP server — removed.** `POST {api}/mcp` and its token routes (`GET`/`POST /projects/{id}/api-tokens`, `DELETE /projects/{id}/api-tokens/{token_id}`) are gone; per-project tokens and the `mcp.json` files that carry them stop working (a per-project token is a 401 at `/mcp/global`). Mint a global token on Connect instead.
- **`GET /projects/{id}/autoseed`** — removed (404).
- **Kiro export prompt.** **Copy to Kiro** in a document's export menu always pastes the backend's instructions (`kiro_default_export_prompt` on `GET /projects/{id}`). A prompt saved on a project before 3.00.00 stays stored but is never read or returned, and `POST /projects` and `PUT /projects/{id}` ignore a `kiro_export_prompt` field.

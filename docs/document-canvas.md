# The document canvas

In a project, **Documents** opens each document as a page: a clean reading column with the title, an outline
of its headings on one side, and the reviews it was written from (or, for a PR/FAQ or PRD, its comment
threads) on the other. At the top sit its menus (Document · Edit · Format · Insert · View), the save status and
an icon toolbar ([below](#the-toolbar)). Anyone who can edit the project edits the text in place; there is no
separate edit mode. A prototype keeps its own preview; a decision record opens here read-only and is edited in the
Decisions tab. A PR/FAQ or PRD is one document across its versions: the list shows it once, it opens on its latest
version, and the toolbar reads any earlier one ([Versions](#versions)).

Nothing about storage changes: a document is still Markdown in its `content` field, saved through the same
`PUT /projects/{id}/documents/{document_id}` as before, so exports, the review page, the assistant, MCP tools
and the REST API read and write it exactly as they did. Editing adds no route: the canvas saves through that PUT
(with `revise_job_id` when the saved text holds changes accepted from Revise from comments; the server records
the save as a revision only after checking that pass: [document-review.md](document-review.md#saving-a-proposal)). Revise from comments has its own two routes and an MCP step
([document-review.md](document-review.md#revise-from-comments)): what the canvas can do, the API and MCP do (tenet 4).

## Reading

- **Outline** (**Contents**, shown unless you turn it off): the document's headings (levels 1 to 3) as links. The
  heading in view is marked as you scroll; choosing one moves the caret (or, read-only, the focus) to it. Below
  1024 px wide the outline is a **Contents** disclosure above the text.
- **Full width** (on unless you turn it off): the text takes the sheet's width; off, it keeps a comfortable line
  length (about 70 characters).
- **Comments** (a PR/FAQ or PRD): the comment panel is closed unless you open it; its toolbar button counts the open
  threads. Whatever needs the panel opens it for that visit only: commenting on a selection (the format bar's
  **Comment**, Ctrl/⌘+Alt+M), a click in a commented passage (its thread becomes the active one), a link to a thread (a
  recommendation's or a proposed change's), a persona review that filed comments. Your stored choice stays as it was:
  another document or a reload shows it again.
- These three are your preferences, not the page's: kept in this browser (`voc-document-view` in localStorage) and
  the same on every document. Only an explicit switch stores a choice: the toolbar's button, the View menu's entry or
  its shortcut. They are not in the address. Before 7.46.00 they lived only as long as the page, so there was no
  stored choice to migrate: everyone starts with Contents shown, the full width on and the panel closed.
- **Evidence**: the reviews and board requests the document was written from, as cards (source, sentiment,
  rating, a short excerpt, date), with **Show all** opening the full list. For a PR/FAQ or PRD the side rail
  has two tabs, **Comments** and **Evidence**.
- A viewer sees the same page read-only, with stored ids shown as their names and `[FR:<id>]` citations
  linked to their board request, as before. An editor sees the stored text itself, so a save never writes
  display names into the document.

## Editing

Blocks: paragraphs, headings, bulleted, numbered and to-do lists, quotes, callouts (stored as Markdown alerts,
`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), code blocks, tables, dividers and images
(with alt text). Text can be bold, italic, struck through, inline code or a link (http, https, mailto or a
path in the app; other schemes, and addresses starting with `//` or holding a backslash, are refused).

| To | Do |
|---|---|
| Insert a block | Type `/` and pick from the menu (type to filter, arrows, Enter; Esc closes) |
| Use Markdown as you type | `# ` to `### `, `- `, `1. `, `[] `, `> `, a code fence, `---` |
| Format a selection | The floating bar on a selection, or Alt+F10 to move focus to it |
| Add or change a link | Ctrl/⌘+K |
| Move a block | Drag the handle beside it, or Alt+Shift+Up / Down; the handle's menu also moves, turns into, duplicates and deletes |
| Open the block menu from the keyboard | Alt+Shift+M |
| Save | **Save** in the page's top bar, or Ctrl/⌘+S |
| Send a comment or reply | Ctrl/⌘+Enter in its box (Escape closes an empty box and keeps one with text) |

**Saving** writes one new version (D1: nothing is overwritten): a PR/FAQ or PRD gets its next series version,
any other document its next revision, and the server records when (D4). There is no autosave, since every
save is a version. The header says **Unsaved changes** until you save or **Discard**. Leaving the page,
choosing another document or tab, or closing the window with unsaved changes asks first.

If someone saved the document after you opened it (another tab, a teammate, the assistant), the save is
refused and the page offers **Load the latest** or **Save mine anyway**; either way the other save stays in the
history. **History** (the toolbar, or the Document menu) lists the versions and restores one (a restore is a new
version too). **Export** exports the saved version.

Untouched blocks are written back byte for byte, so a small edit is a small change in the version history,
and anything the canvas has no block for (raw HTML, footnotes, reference definitions) is kept as written and
shown as a source block.

## Comments, personas and sharing

On a PR/FAQ or PRD, select text and choose **Comment** in the floating bar (or Ctrl/⌘+Alt+M) to start a thread
anchored to that quote (the comment panel opens for it). Threads, replies, resolve, filters, **AI review** (Ask
personas to review, in the toolbar: what the personas filed is said at the top of the comment panel, which opens
for it) and **Share** (the review link, the toolbar's last button) work as described in
[document-review.md](document-review.md). While you edit, a thread whose quote you change is listed under **Not
found in this version** at once.

## The toolbar

At the end of the top bar, a row of icon buttons (a WAI-ARIA toolbar: one Tab stop, the arrow keys move between
them, Home and End go to the ends; every icon has a name and a tooltip, on hover and on keyboard focus; a switch
says whether it is on):

| Button | Does | Offered to |
|---|---|---|
| **v4 ▾** | The version picker: every version, newest first, the latest marked **Latest** ([Versions](#versions)) | everyone (not on a decision) |
| **History** | The versions list: open, compare, restore | everyone (not on a decision) |
| **AI review** | Ask personas to review (the comments' editors; disabled, with the reason, in a project without personas) | editors, PR/FAQ and PRD |
| **AI rewrite** | Revise from comments ([below](#revise-from-comments); disabled, with the reason, until a thread is answered, or while accepted changes wait for their save) | editors, PR/FAQ and PRD |
| **Comments** (with the open count) | The comment panel, on or off | PR/FAQ and PRD |
| **Contents** | The outline, on or off | everyone |
| **Full width** | The text's width | everyone |
| **Full screen** | The focus view ([below](#full-screen)) | everyone |
| **Share** | The review link ([document-review.md](document-review.md)) | editors, PR/FAQ and PRD |

The toolbar and the View menu are two doors to the same switches: a change in one shows in the other. Below 768 px
wide History, the AI flows, Contents and Full width move into a **⋯** menu (the switches as checkbox items). While an
older version is on screen the AI flows and the Edit, Format and Insert menus step aside. The running AI flow is said
to a screen reader; a failed revision's reason shows above the text.

## Versions

Every save is a version (D1, above). A PR/FAQ or PRD keeps each version as a row of its own (its next series version);
any other document keeps its id and stores what a save replaced as a revision. The page shows both the same way:

- **One entry in the list.** The Documents list shows a PR/FAQ or PRD series once, as its latest version, counted
  once, and selected while any of its versions is open. Choosing it opens the latest. (A prototype keeps one entry per
  version: its pane has Back to vN.) Nothing stored changes: this is how the list reads the rows the project already
  has.
- **The version picker** (the toolbar's first button, "v4") lists the versions, newest first (the History list's 25),
  the latest marked. Choosing an older one shows it read-only under a banner, **Viewing v2 of 4 · read only**, with
  **Back to latest** and, for an editor, **Restore** (asked first): a new version with that version's content, as
  History's restore. Your canvas, with any unsaved changes and the comment you were writing, stays as it was behind it.
- A link to an older version's own row (a link made before it was superseded, or Back after a save) opens the series'
  latest with that older version under the banner, so you always land on the latest. The page checks this once per
  address: a version a teammate saves while you edit never moves your canvas (your save meets it as a conflict).
- The versions come from `GET /projects/{id}/documents/{document_id}/versions` (any member may read; History's list),
  read when the picker opens or an older version is asked for. No route was added.

## Addresses

Every place in the app is a path (7.46.00 for a project page, 7.49.00 for the rest): where you are (a page, its tab
and section, the item open on it, a sub-view, a mode) is the path; only what combines freely stays in the query
(filters, search, a sort, a window, a scope picker). Inside a workspace every address follows its
`/workspace/<slug>` (7.49.00; `/w/<slug>` before). `workspace` is reserved: no top-level page and no agent id is
ever named so (`frontend/src/routes.paramNames.test.ts`). There are no redirects from the forms of before (`/w/…`,
`?tab=`, `&section=`, `?doc=`, `?view=`, `?request=`, `/login?expired=1`): a pre-release change, nobody has them
installed. A path that does not name its place as it should (an unknown tab, a tab without its section) is
replaced in place by the place's own path.

A project page's tab and the document on it:

| Address | Shows |
|---|---|
| `/projects/<id>` or `/projects/<id>/overview` | the Overview |
| `/projects/<id>/personas`, `/product`, `/documents`, `/decisions`, `/participants` | that tab |
| `/projects/<id>/documents/<docId>` | a document |
| `/projects/<id>/documents/<docId>/v/<n>` | its version n, read-only (the version on the page has no `/v/`) |
| `/projects/<id>/documents/<docId>/focus`, `…/v/<n>/focus` | full screen |

Choosing a tab, a document, a version or full screen is a history entry, so the browser's Back and Forward walk
them; a save, a restore or the latest loaded moves to the new version in place (Back never lands on a version the
page has moved past). The query keeps its own parameters (a prefilled decision's, an open review's) across every
move; it names no place, and a query link of an earlier build (`?tab=documents&doc=<docId>&view=focus`) is not
redirected (7.49.00, a pre-release change: nobody has an older build installed). In-app links (a run's
document, the Decisions card's "PR/FAQ ready") use the paths; the server builds none of these links. The
breadcrumb trail ends at the project.

The other pages (each area's `*Paths.ts` in `frontend/src/pages/`, the shared parts in `utils/pathPlace.ts` and
`utils/tabPaths.ts`):

| Address | Shows |
|---|---|
| `/admin/<tab>[/<section>]` (`/admin` is General) | an Administration tab and section ([account-vs-admin.md](account-vs-admin.md)) |
| `/admin/access/boards/<boardId>` | a feedback board's editor |
| `/account/<tab>` | an Account tab |
| `/company/<tab>`, `/memory/<tab>`, `/participants/<tab>` | that page's tab |
| `/data-explorer/raw` (`/data-explorer`), `/data-explorer/processed` | the Data Explorer's tab |
| `/agents/workflows`, `/agents/spend`, `/agents/connections`, `/agents/skills` | a view of the Agents list |
| `/agents/skills/<role>[/v/<n>]` | a skill role's history, one of its versions |
| `/agents/<id>/<tab>` (`/agents/<id>` is Settings) | an agent's tab |
| `/feature-requests/insights` | the boards' Insights |
| `/feature-requests/<slug>/<requestId>`, `/board/<slug>/<requestId>` | a request open on its board |
| `/feature-requests/requests/<requestId>`, `/board/requests/<requestId>` | a request known only by its id, opened on its board |
| `/board/login[/<slug>[/<requestId>]]` | the board sign-in, then that board |
| `/login/expired` | sign-in, saying the session ended |

A tab, a section, a view and an item opened on them are history entries: Back and Forward walk them; the query
stays on a move. The agents' view names are reserved (an agent's id is `ag_<hex>`), and so are the board slugs
`insights` and `requests`. The assistant's page context names the tab from the path.
`frontend/src/locationParams.test.ts` lists every module that reads the query and the keys it reads, and fails when
a location key is read anywhere or an in-app link carries one.

What stays in the query, and why:

| Kind | Keys |
|---|---|
| Filters and search | Categories' `q`, `source`, `sentiment`, `usefulness`, `category`, `subcategory`, `rating`, `rating_dir`, `urgent`, `channel`, `dims`, `tag`, `types`; Problem Analysis' too, and `resolved`, `similarity`; the Dashboard's facets; Radar's `brand` and `days`; a board list's `q`, `status`, `sort`; Insights' `board`, `days`; Agents → Spend's `month`, `by`, `workflow`; Agents → Skills' scope, `connection` |
| The review modal | `review`, `reviewBrand`: one review over whatever page is open (Back closes it), so no one page's path |
| A form's prefill, read once | Connect's `project` (the token's pin); a project's Decisions `newDecision`, `title`, `verdict`, `rationale`, `feedback` |
| External callbacks | GitHub's App returns, `/agents/connections/github/created?code=&state=` and `…/installed?installation_id=&setup_action=&state=`; the MCP OAuth consent's authorize request; the emailed board sign-in link's `email`, `code`; the unsubscribe link's `t`. Each is the other party's by design, and each page takes it once and strips it |

GitHub returns to its two pages at the address it was given: the creation inside the workspace the flow started in
(the manifest names it), an installation at the top-level page, which goes straight back into that workspace
(remembered in the tab when the flow starts, else the workspace last entered), never through the workspace picker.

The SPA's CloudFront distribution serves every one of these paths: an unknown path is S3's 404, which the
distribution answers with `index.html` (`voc-datalake/lib/stacks/core-cdn.ts`); only `/avatars/*` and `/prototypes/*`
are other behaviours, and no app path starts with them.

## Full screen

**Full screen** in the toolbar (or Ctrl/⌘+Shift+F) gives the page the whole window for reading and answering
comments: the canvas and the comment rail side by side from 1280 px wide (one column below), the app's sidebar,
header, project tabs and document list hidden. It opens with the page's header (the title, the save status and the
way out) at the top of the window, however far down the page you were, and puts the cursor in the text without
scrolling it. Esc (when no menu, dialog, format bar or comment box has it; the page's own toolbar owns none), the same
button or the shortcut leaves. The address keeps it as `…/focus`, so a reload stays in it; entering and leaving are
history entries, so Back leaves full screen and Forward comes back (after a save in full screen, the entry before it
opens on the latest version, with the one you started from under the banner). Unsaved changes stay as they are;
entering or leaving never asks.

## The Document menu

**Document** in the top bar holds the document's actions: **Save** (with its state: Saved, Saving…, Unsaved changes;
the Save button stays beside it), **Share for review** (PR/FAQ, PRD), the export formats (Copy, **Download as
Markdown**: the saved version's stored text; **Print or save as PDF**, with **Include open comments** to append each
open thread whose quote is in the printed version (or on the whole document) with its quote and replies; Download as TXT; Copy to Kiro for a PR/FAQ or PRD), **History** and
**Delete**. Exports use the saved version; the menu says so while there are unsaved changes. Arrow keys move through
it, Esc returns to the button.

The same **Rename** and **Delete** are on each document's card in the Documents tab's list, in the card's menu: a
right-click on the card (the menu opens at the pointer, kept inside the window), the ContextMenu key or Shift+F10 on
a focused card, or the card's **⋯** button (shown on hover and focus, on the selected card and always on a touch
screen). It holds **Open** (selects the card, as a click does), **Rename** (only for a document whose title its writers
own: research and custom documents and product reports; a PRD's, PR/FAQ's or prototype's title is its series' own, and
a decision is edited in its tab) and **Delete**. A viewer gets Open only. Rename edits the card's title in place with
the page title's rules (Enter saves, Escape cancels, an empty or unchanged name saves nothing) and the same save, one
new version carrying the title alone; the document open on its page is renamed through the page, so its unsaved text
stays the draft. Delete asks first with the page's confirmation; deleting the open document closes it, deleting
another leaves it open. A PR/FAQ or PRD series has one card ([Versions](#versions)), which acts on the version it
shows, the latest: **Open** opens it, and **Delete** deletes that one version, as the page's own Delete does on the
latest (the version before it is the series' card then; the others stay in History). The menu follows the WAI-ARIA menu pattern: arrows, Home / End, Escape back to the card (or
the ⋯), Tab out; a press outside it or a scroll closes it.

## Revise from comments

On a PR/FAQ or PRD, once threads are answered or resolved, **AI rewrite** (Revise from comments) in the toolbar asks the AI
to work through them, grounded in the threads and the document's evidence
([document-review.md](document-review.md#revise-from-comments)). What comes back depends on your way of working
([ways-of-working.md](ways-of-working.md#revise-from-comments)):

- **Recommendations**: one per thread, each linking to its thread; nothing is written.
- **A proposal**: each change shown on the canvas as the old text struck and the new text added, with the threads it
  answers and **Accept** / **Reject** (and Accept all / Reject all). Accepting puts the change into your draft; a
  change whose passage you have since edited is marked **Out of date**. **Save** writes the new version, and the
  threads of the changes it kept are marked **Addressed in vN** (a change counts as kept only while the saved text
  still holds it where you accepted it). **Discard** or **Load the latest** takes your draft away without a save:
  the accepted changes are pending again.
- **Applied**: the server wrote the revised text as a new version and marked the threads; the banner offers **Undo**
  (restores the version the pass read, as a new version, and takes the **Addressed** marks off its threads) and
  **Review again** (Ask personas to review). If someone saved a version after the revision, Undo says so first and
  offers **Undo anyway** (their change is reverted too) or **Keep it**.

Addressed threads carry their badge and an **Addressed** filter; after any pass **AI review**'s tooltip says it asks
the personas to review again, so a new round of comments can start.

## The assistant's changes

When the assistant proposes a change to the open document, the page shows a banner. **Review** shows the
proposal as a block-by-block diff over the saved text (added and removed blocks marked), with the same
**Approve** and **Decline** as the assistant's approval card: one approval, answered once, through the same
path. A proposal is refused before it is shown when your way of working does not allow it
([ways-of-working.md](ways-of-working.md)); your own edits on the canvas are your text in every way of working.

## Code

The editor is the shared document component's edit engine, in
`voc-datalake/frontend/src/components/Document/edit/`: `markdown/` (the Markdown ↔ editor mapping, on TipTap and
ProseMirror, MIT) and `editor/` (the editor; its menus, format bar and popovers load as a chunk of their own right
after the text, `editor/CanvasChrome.tsx`). Its strings are the `documents` namespace. The Projects page around it
is in `voc-datalake/frontend/src/components/DocumentCanvas/`: `page/` (the page, outline, evidence, the view
preferences, an older version and the full-screen view), `comments/`, `actions/` (save, the menus, the toolbar and
its version picker, the assistant's diff) and `revise/` (Revise from comments). The addresses are
`pages/ProjectDetail/projectPaths.ts` and `useProjectPlace.ts`. It is loaded only when the Documents tab opens a
document.

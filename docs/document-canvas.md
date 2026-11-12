# The document canvas

In a project, **Documents** opens each document as a page: a clean reading column with the title, an outline
of its headings on one side, and the reviews it was written from (or, for a PR/FAQ or PRD, its comment
threads) on the other. Anyone who can edit the project edits the text in place; there is no separate edit
mode. A prototype keeps its own preview; a decision record opens here read-only and is edited in the
Decisions tab.

Nothing about storage changes: a document is still Markdown in its `content` field, saved through the same
`PUT /projects/{id}/documents/{document_id}` as before, so exports, the review page, the assistant, MCP tools
and the REST API read and write it exactly as they did. The canvas adds no route and no tool: what it can do,
the API already does (tenet 4).

## Reading

- **Outline**: the document's headings (levels 1 to 3) as links. The heading in view is marked as you scroll;
  choosing one moves the caret (or, read-only, the focus) to it. Below 1024 px wide the outline is a
  **Contents** disclosure above the text.
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
| Save | **Save** in the page header, or Ctrl/⌘+S |

**Saving** writes one new version (D1: nothing is overwritten): a PR/FAQ or PRD gets its next series version,
any other document its next revision, and the server records when (D4). There is no autosave, since every
save is a version. The header says **Unsaved changes** until you save or **Discard**. Leaving the page,
choosing another document or tab, or closing the window with unsaved changes asks first.

If someone saved the document after you opened it (another tab, a teammate, the assistant), the save is
refused and the page offers **Load the latest** or **Save mine anyway**; either way the other save stays in the
history. **History** lists the versions and restores one (a restore is a new version too). **Export** exports
the saved version.

Untouched blocks are written back byte for byte, so a small edit is a small change in the version history,
and anything the canvas has no block for (raw HTML, footnotes, reference definitions) is kept as written and
shown as a source block.

## Comments, personas and sharing

On a PR/FAQ or PRD, select text and choose **Comment** in the floating bar (or Ctrl/⌘+Alt+M) to start a thread
anchored to that quote. Threads, replies, resolve, filters, **Ask personas to review** and **Share** (the review
link, in the page header) work as described in [document-review.md](document-review.md). While you edit, a
thread whose quote you change is listed under **Not found in this version** at once.

## The assistant's changes

When the assistant proposes a change to the open document, the page shows a banner. **Review** shows the
proposal as a block-by-block diff over the saved text (added and removed blocks marked), with the same
**Approve** and **Decline** as the assistant's approval card: one approval, answered once, through the same
path. A proposal is refused before it is shown when your way of working does not allow it
([ways-of-working.md](ways-of-working.md)); your own edits on the canvas are your text in every way of working.

## Code

The canvas is in `voc-datalake/frontend/src/components/DocumentCanvas/`: `markdown/` (the Markdown ↔ editor
mapping, on TipTap and ProseMirror, MIT), `editor/` (the editor, its menus and format bar), `page/` (the page,
outline and evidence), `comments/` and `actions/` (save, the header, the assistant's diff). It is loaded only
when the Documents tab opens a document.

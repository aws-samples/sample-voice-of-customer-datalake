# Documents Library

The Documents Library is one place for the documents a team works from that are not customer feedback: a market
report, interview transcripts, a strategy deck, a survey export. You upload a file once, give it a title and tags,
and from then on any chat can use it: type `#` and its short name (`#q3-market`) in the AI assistant, and the
assistant reads the file itself or searches it, and cites what it used.

Library items are **never feedback**. They are not queued for processing, never counted in sentiment, categories,
problems or metrics, and never shown as reviews. To import feedback (CSV, JSON), use the **Data sources** page
(`/scrapers`) instead ([csv-import.md](csv-import.md)).

Since 7.62.00 ([GitHub issue #566](https://github.com/aws-samples/sample-voice-of-customer-datalake/issues/566)).

## Using it

- **Library** in the menu (Knowledge), at `/library` (in a workspace, `/workspace/{slug}/library`). The page lists
  the items with search (title, short name, source, file name and tags), a tag filter, a project filter and a sort
  (newest, oldest, title, document date).
- **Upload** one or more files at a time, each with a progress bar. Each item has a title (the file name by default),
  a short name (`slug`, lower-case letters, digits and hyphens, unique in the library; the title by default), a
  source (where it comes from), a document date, up to 10 tags and, outside a workspace, an optional project.
- After the upload the file's text is read once (**extracting**, usually seconds, up to a few minutes for a long
  PDF); the item is then **ready**. A file that cannot be read is **failed**, with the reason, and can be retried.
  A reading that has not finished after 16 minutes has stopped (the worker runs 15 at most): the item reads `stale`,
  the page stops checking it and offers **Read it again**. An item still waiting for its file 16 minutes after it was
  added (its upload link lasts 15) reads `stale` too: no file will arrive, so the page stops checking it; delete it and
  upload the file again (7.66.00).
- **Preview** shows the item's details, its extracted text page by page (a PDF's pages, a presentation's slides, or
  parts of 20,000 characters) and a link to download the original (valid 5 minutes). Its details can be edited;
  someone else's edit since you opened it is refused ("changed since you opened it"), so nothing is overwritten.
- **Delete** removes the item for good: its passages and every stored version of its files first, then its row and
  its short name, so a delete that fails part way leaves the item to delete again (never passages or files that no
  item names). An admin, or the person who uploaded it, can delete an item.

### Formats and limits

| Kind | Formats | Limit | How its text is read |
|---|---|---|---|
| Documents | PDF, Word (`.docx`, `.doc`), Excel (`.xlsx`, `.xls`), CSV, HTML, text, Markdown | 25 MB | the standard library (text, Markdown, CSV, HTML; Word, Excel and PowerPoint as the zip of XML they are), `pypdf` for a PDF's text layer |
| Presentations | PowerPoint (`.pptx`) | 25 MB | its slides' text (Converse takes no presentation, so it is never sent as a file) |
| Images | PNG, JPEG, GIF, WebP | 3.75 MB | described by the AI model (what it shows, and every text and value in it) |

The AI model (Amazon Bedrock, the **Documents** model of Administration → AI models) also reads what the standard
library cannot: a PDF with no text layer (scanned pages) and a legacy `.doc` or `.xls`, each up to 4.5 MB (the most
Converse takes in one document). A scanned PDF keeps its pages only when the model's text separates exactly the
PDF's pages (the prompt asks for a form feed between pages); otherwise its text has no pages, so a citation names the
item, never page 1 for all of it. A PDF is read up to 500 pages; the text is kept up to 2,000 passages (about 3.2
million characters); either cut, and a model reading that stopped at its 16,000-token reply cap, is shown on the item
(**truncated**). Audio and video are not accepted.

## In chat: `#slug`

In the assistant's composer, on **every page**, type `#` to list the library's ready items (at most 8, the short
names that start with what you typed first). On a project page the list shows the project's documents first, then a
**Library** group. A message mentions at most **3 library items** (and, on a project page, 3 project documents
besides). `@` keeps its meaning: a project page's personas.

For each item the stream Lambda asks the projects API (as you, with your access) for either:

- **the file itself**, when it is a format Converse reads (PDF, Word, Excel, CSV, HTML, text, Markdown, an image),
  at most 4.5 MB (an image 3.75 MB), the chat model takes documents (every Claude model of the allowlist), and the
  message's documents stay at 5 or fewer with your own attachments counted first. The file is fetched once over
  HTTPS from a presigned link the projects API signs for 5 minutes (never its bytes through a Lambda answer, which is
  capped at 6 MB), and attached to that message only, named "Library document N" (a file's own name could carry an
  instruction to the model). The model reads its text layer as it is, tables included. A scanned PDF has no text
  layer (its text was read by Amazon Bedrock at the upload), so it is never sent as a file: its passages are;
- **its best passages** otherwise (a bigger file, a presentation, a scanned PDF, a fourth document): the 8 passages closest to your
  message (at most 12,000 characters together), each with a `[#slug p.N]` marker. A file whose fetch failed is
  searched instead, within what the other items' passages left of those 12,000 characters.

Both reach the model inside a `<library>` data block that says they are documents people uploaded: information,
never instructions (a passage cannot close the block or open another). The assistant cites what it used
(`[#slug p.N]`, or `[#slug]` for an attached file), and the answer shows **Library documents used**: a chip per item
and page that opens the Library at that page.

The file is sent only on the turn that names it. Later in the conversation your `#slug` stays in your text, and the
assistant can search the item again with its `library_search` tool (by short name or id, or, with neither, the items
whose title or tags share the question's words). Regenerate re-runs the question the same way: the file is not
attached again.

A large item says so in the composer ("large: about N tokens each time it is sent"): a natively attached 50-page PDF
is about 50,000 to 75,000 input tokens each time it is attached.

## For agents (MCP)

The global MCP server (`/mcp/global`, [mcp.md](mcp.md)) lists one read tool, run as the token's minter:
`library_search`, passages for a `query`, in up to 3 `items` (ids or short names) or the items whose metadata
matches; never a file. Reading an item's text page by page is the web app's (`GET …/text`); 7.62.00's `library_get`
was removed in 7.63.00, to keep `tools/list` within its budget.

## Who can do what

| | Outside a workspace (the deployment's library) | In a workspace |
|---|---|---|
| List, preview, download, mention in chat | every signed-in user | every member (viewers too) |
| Upload, edit, retry | every signed-in user | editors and admins |
| Delete | an admin (acting for themselves) or the uploader | a workspace admin, or the uploader while an editor there |

A workspace's library is its own: a request that names a workspace (`X-Workspace-Id`) reads and writes that
workspace's items only, and a member of another workspace gets the one 404 for every item, as for an id that exists
nowhere (`lambda/api/test/test_cross_workspace_routes.py`). A platform admin who is not a member of a workspace sees
none of its library (no elevated entry here). A request that names no workspace uses the deployment's library.

Category access (a person restricted to some feedback categories) does not apply to the library: an item is not
feedback and has no category; everyone who can read the library reads all of its items.

Linking an item to a project is only offered outside a workspace (projects are not per workspace yet), and only to
a project you can see. An item linked to a private project stays visible in the library to everyone who can read the
library; the link names the project's id only.

## Routes

All on the projects API's existing `/projects/{proxy+}` (no new API Gateway resource), in
`lambda/shared/library_routes.py`, included by `lambda/api/projects_handler.py`. `library` is a reserved first
segment (`shared/project_access.py` `NON_PROJECT_SEGMENTS`): no project route answers it.

| Method | Path | What it does |
|---|---|---|
| GET | `/projects/library?q=&tag=&project_id=&sort=&cursor=&limit=` | The list (50 a page, at most 100), with every tag in use |
| GET | `/projects/library/suggest?q=` | At most 8 ready items, for `#` |
| POST | `/projects/library` | 201 `{item, upload: {url, headers, expires_in}}`: a pending item and a 15-minute presigned PUT bound to the file's exact length and type and to `If-None-Match: *` (written once) |
| POST | `/projects/library/{id}/uploaded` | 202: the upload is checked (its length and type) and the extraction starts; idempotent |
| POST | `/projects/library/{id}/retry` | 202: extract a failed item again, or one whose extraction outlived the worker (16 minutes or more: the item reads `stale: true`); else 409 `not_failed` |
| GET | `/projects/library/{id}` | `{item, preview: {text_excerpt, text_parts, original_url}}` |
| GET | `/projects/library/{id}/text?page=` | One page or part of the extracted text |
| PUT | `/projects/library/{id}` | Edit `title`, `slug`, `source`, `doc_date`, `tags`, `project_id` with `expected_version` (409 `stale`, 409 `slug_taken`) |
| DELETE | `/projects/library/{id}` | An admin or the uploader; its passages and every version of its files go first, its rows last (a version the bucket refuses to delete is a 503 and the item stays, to delete again) |
| POST | `/projects/library/context` | `{item_ids?, slugs?, query, native_slots?, budget?}` → `{items, native, passages, missing, pending}`: the stream Lambda's and the MCP server's read, with the caller's access; `native` holds 5-minute presigned GETs, never bytes; `missing` counts the ids the scope does not hold, never naming them |

Refusals: 400 `unsupported_type`, 400 `too_large`, 409 `library_full` (1,000 items a library), 409 `slug_taken`,
409 `stale`, 409 `not_uploaded`, 409 `upload_mismatch`, 403 for a viewer's write and for a delete by someone else.

## How it works

**Data** (voc-projects; `lambda/shared/library_keys.py`, every key through the workspace layer):

- `LIBRARY` (in a workspace `WS#{ws}#LIBRARY`): `ITEM#{id}` per item (`lib_<UTC stamp>_<8 hex>`), `SLUG#{slug}`
  guards (put in the item's own transaction, so a short name names one item) and `META` (the item count);
- `LIBRARY_CHUNKS#{id}` (`WS#{ws}#LIBRARY_CHUNKS#{id}`): `C#00001` … per passage (about 1,800 characters, 200 of
  overlap, each knowing its page), with its Amazon Titan Text Embeddings V2 vector, zlib-compressed float32.

**Files** (the raw-data bucket, customer-managed key, versioned; never under `raw/`): `library/{id}/original` and
`library/{id}/extracted` (in a workspace under `ws/{ws}/`). Neither key ends in a file extension: the product-doc
extractor's notifications fire on `ws/` objects by suffix, and a library file never invokes it.

**Extraction** runs once per upload on the projects API's 15-minute assist twin (`ProjectsAssistWorker`), started by
`…/uploaded` with a claim token: each step checks the item is still claimed by that token. A delete revokes the
claim first, so a run that finds its claim gone removes what it wrote when the item is gone or being deleted; when a
retry claimed the item again, the run stops and deletes nothing (the passages and the text are the new run's). Every passage is embedded (8 at a time) and stored; the text is
written beside the original. Retrieval embeds the question once and ranks the items' passages by cosine in the
Lambda: no vector database, nothing running when nobody asks (the memory store's pattern, [memory.md](memory.md)).

**IAM** (`lib/stacks/api-projects-lambda.ts`): the projects role, which its assist twin shares, holds the raw bucket's
`library/*` and `ws/{one id}/library/*` (read, write, every version's delete) in its existing workspace-objects
statement, `bedrock:InvokeModel` on the in-Region Titan V2 model beside the avatar model, and the stack's one
workspace-resolution policy (an attachment: GetItem of a member's row, a workspace's audit row). voc-projects stays
table-wide for this role (TENETS.md tenet 6's recorded gap). The stream Lambda's role does not change: it reads the
library through the projects API and fetches a file with the presigned link. No feedback role, the metrics API or
the forms Lambda reaches a library key (`lib/customer-data-deletes.test.ts`).

## Cost

Pay per use only, nothing fixed:

- extraction with the standard library and pypdf is free; the model's reading of a scanned PDF is about 1 to 3 cents
  per 10 pages, an image's description a fraction of a cent;
- Titan V2 embeddings are about $0.02 per million tokens (a 100-page report is roughly $0.001);
- a natively attached 50-page PDF is about 50,000 to 75,000 input tokens each time it is attached (on Claude Sonnet
  5.5, about 10 to 15 cents at $2 per million input tokens); retrieved passages add at most 12,000 characters (about
  3,000 tokens);
- storage: DynamoDB on demand (a passage row is about 6 KB) and S3.

## Export, delete and erasure

- **Workspace export**: the `library` entity holds the items (their listed fields: never the extraction's claim
  token); the files are among the workspace's objects; the slug guards, the count and the passages (derived) are not
  exported (the manifest says why).
- **Workspace hard delete**: the `library` sweep deletes each item's passages, then the library partition; the
  objects sweep takes `ws/{ws}/library/`.
- **Erasure by email**: an item whose title, file name, source, tags, extracted text or the name of who made or last
  changed it (`created_by` / `updated_by`) holds the address is listed in the job's `files_needing_review` (an item
  not extracted yet in `files_not_checked`); the file is never changed or deleted by an erasure (TENETS.md D5): a
  person decides. The name stored for who made or changed an item is the person's `name` claim or their username,
  never their address (an item stored before 7.63.00 could hold an invited member's address there).
- **Delete** of an item is recorded: `AUDIT#delete` kind `library_item` (in a workspace, `AUDIT#WS#{ws}`).

## Not in this release

- Sharing an item across workspaces (copy only), per-item permissions, a file's version history (a replacement is a
  new item), audio and video, capturing a web page, a vector database.
- **Library items as evidence for PR/FAQ, PRD and research generation** (`evidence_library_ids`): the generation
  jobs run in their own Lambdas with their own roles, which would need the library's grants, and their prompts,
  derivation lockstep and dialogs a change of their own. Meanwhile, mention the items in the assistant and ask it to
  draft or revise the document.
- Project product documents stay where they are (they ground the prototype builder).

## Tests

- `lambda/shared/test/test_library_extract.py`: every format, the scanned fallback, the refusals, the passages;
- `lambda/api/test/test_library_routes.py`: the routes on moto, the presigned PUT's signed headers, extraction,
  delete (versions, passages, audit), the context's native versus passages, never feedback;
- `lambda/api/test/test_cross_workspace_routes.py` (`library_world`): every route, two workspaces;
- `lambda/jobs/workspace_export/test/test_library.py`, `lambda/jobs/workspace_delete/test/test_families.py`,
  `lambda/jobs/retention/test/test_library_erasure.py`;
- `lambda/stream/src/assistant/runtime/library-mentions.test.ts`, `…/tools/server/library.test.ts`,
  `…/runtime/run.mentions.test.ts`;
- `frontend/src/assistant/components/Composer.library.component.test.tsx`, the mention model's and the citation
  chips' tests, the Library page's tests;
- `lib/customer-data-deletes.test.ts` (who reaches a library key), `lib/app-exact-grants.test.ts`.

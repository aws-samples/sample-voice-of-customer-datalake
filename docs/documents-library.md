# Documents Library

The Documents Library is one place for the documents a team works from that are not customer feedback: a market
report, interview transcripts, a strategy deck, a survey export. You upload a file once, give it a title and tags,
and from then on any chat can use it: type `#` and its short name (`#q3-market`) in the AI assistant, and the
assistant reads the file itself or searches it, and cites what it used.

Library items are **never feedback**. They are not queued for processing, never counted in sentiment, categories,
problems or metrics, and never shown as reviews. To import feedback (CSV, JSON), use the **Data sources** page
(`/scrapers`) instead ([csv-import.md](csv-import.md)).

Since 7.05.00 ([GitHub issue #566](https://github.com/aws-samples/sample-voice-of-customer-datalake/issues/566)),
ported from the `voc-multiplayer` branch's 7.62.00 without its workspaces: a deployment has one library.

## Using it

- **Library** in the menu, at `/library`. The page lists the items with search (title, short name, source, file
  name and tags), a tag filter, a project filter and a sort (newest, oldest, title, document date).
- **Upload** one or more files at a time, each with a progress bar. Each item has a title (the file name by default),
  a short name (`slug`, lower-case letters, digits and hyphens, unique in the library; the title by default), a
  source (where it comes from), a document date, up to 10 tags and an optional project.
- After the upload the file's text is read once (**extracting**, usually seconds, up to a few minutes for a long
  PDF); the item is then **ready**. A file that cannot be read is **failed**, with the reason, and can be retried.
  A reading that has not finished after 16 minutes has stopped (the worker runs 15 at most): the item reads `stale`,
  the page stops checking it and offers **Read it again**. An item still waiting for its file 16 minutes after it was
  added (its upload link lasts 15) reads `stale` too: no file will arrive, so the page stops checking it; delete it and
  upload the file again.
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

An uploaded file is data, never instructions: the model's prompt says so, and a Markdown file's preview renders as
the assistant's answers do (only safe links, never an image fetched).

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
- **its best passages** otherwise (a bigger file, a presentation, a scanned PDF, a fourth document): the 8 passages
  closest to your message (at most 12,000 characters together), each with a `[#slug p.N]` marker. A file whose fetch
  failed is searched instead, within what the other items' passages left of those 12,000 characters.

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
`search_library`, passages for a `query`, in up to 3 `items` (ids or short names) or the items whose metadata
matches; never a file. Reading an item's text page by page is the web app's (`GET …/text`). The tool's arrival
raised the `tools/list` budget from 4,000 to 10,000 estimated tokens (owner decision, 7.05.00; see mcp.md).

## Who can do what

| Action | Who |
|---|---|
| List, preview, download, mention in chat | every signed-in user |
| Upload, edit, retry | every signed-in user |
| Delete | a member of the `admins` group (acting for themselves) or the uploader; never a delegated credential (an MCP token) |

Category access (a person restricted to some feedback categories) does not apply to the library: an item is not
feedback and has no category; everyone who can read the library reads all of its items.

Linking an item to a project is only offered for a project you can see. An item linked to a private project stays
visible in the library to everyone who can read the library; the link names the project's id only.

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
| POST | `/projects/library/context` | `{item_ids?, slugs?, query, native_slots?, budget?}` → `{items, native, passages, missing, pending}`: the stream Lambda's and the MCP server's read, with the caller's access; `native` holds 5-minute presigned GETs, never bytes; `missing` counts the ids the library does not hold, never naming them |

Refusals: 400 `unsupported_type`, 400 `too_large`, 409 `library_full` (1,000 items a library), 409 `slug_taken`,
409 `stale`, 409 `not_uploaded`, 409 `upload_mismatch`, 403 for a delete by someone else.

## How it works

**Data** (voc-projects; `lambda/shared/library_keys.py`):

- `LIBRARY`: `ITEM#{id}` per item (`lib_<UTC stamp>_<8 hex>`), `SLUG#{slug}` guards (put in the item's own
  transaction, so a short name names one item) and `META` (the item count);
- `LIBRARY_CHUNKS#{id}`: `C#00001` … per passage (about 1,800 characters, 200 of overlap, each knowing its page),
  with its Amazon Titan Text Embeddings V2 vector, zlib-compressed float32.

**Files** (the raw-data bucket, customer-managed key, versioned; never under `raw/`): `library/{id}/original` and
`library/{id}/extracted`. The product-doc extractor's bucket notification filters the `projects/` prefix
(`lib/stacks/core-stack.ts`), so a library file never triggers it.

**Extraction** runs once per upload on the projects API's 15-minute assist twin (`ProjectsAssistWorker`), started by
`…/uploaded` with a claim token: each step checks the item is still claimed by that token. A delete revokes the
claim first, so a run that finds its claim gone removes what it wrote when the item is gone or being deleted; when a
retry claimed the item again, the run stops and deletes nothing (the passages and the text are the new run's). Every
passage is embedded (8 at a time) and stored; the text is written beside the original. Retrieval embeds the question
once and ranks the items' passages by cosine in the Lambda: no vector database, nothing running when nobody asks
(the memory store's pattern, [memory.md](memory.md)).

**IAM** (`lib/stacks/api-projects-lambda.ts`): the projects role, which its assist twin shares, holds the raw
bucket's `library/*` (read, write, every version's delete) in its existing object statement, and
`bedrock:InvokeModel` on the in-Region Titan V2 model beside the avatar model. The stream Lambda's role does not
change: it reads the library through the projects API and fetches a file with the presigned link.

## Cost

Pay per use only, nothing fixed:

- extraction with the standard library and pypdf is free; the model's reading of a scanned PDF is about 1 to 3 cents
  per 10 pages, an image's description a fraction of a cent;
- Titan V2 embeddings are about $0.02 per million tokens (a 100-page report is roughly $0.001);
- a natively attached 50-page PDF is about 50,000 to 75,000 input tokens each time it is attached; retrieved
  passages add at most 12,000 characters (about 3,000 tokens);
- storage: DynamoDB on demand (a passage row is about 6 KB) and S3.

## Delete and erasure

- **Delete** of an item is recorded: `AUDIT#delete` kind `library_item` (the actor and the item's id and short name,
  never its text).
- **Erasure by email** does not read the library in this release, as it does not read a project's product documents:
  a library file is the team's document, not customer feedback. The name stored for who made or changed an item is
  the person's `name` claim or their username, never their address.

## Not in this release

- Per-item permissions, a file's version history (a replacement is a new item), audio and video, capturing a web
  page, a vector database.
- **Library items as evidence for PR/FAQ, PRD and research generation** (`evidence_library_ids`): the generation
  jobs run in their own Lambdas with their own roles, which would need the library's grants. Meanwhile, mention the
  items in the assistant and ask it to draft or revise the document.
- Erasure by email listing the library items that hold an address (`voc-multiplayer` 7.62.00 adds it with its
  project erasure, which main does not have yet).
- Project product documents stay where they are (they ground the prototype builder).

## Tests

- `lambda/shared/test/test_library_extract.py`: every format, the scanned fallback, the refusals, the passages;
- `lambda/api/test/test_library_routes.py`: the routes on moto, the presigned PUT's signed headers, extraction,
  delete (versions, passages, audit), the context's native versus passages, never feedback;
- `lambda/api/test/test_route_admin_gates.py`: the library's write routes are classified;
- `lambda/shared/test/test_mcp_global_tools_mutation.py`, `test_mcp_global_tools_budget.py`: `search_library`;
- `lambda/stream/src/assistant/runtime/library-mentions.test.ts`, `…/tools/server/library.test.ts`,
  `…/runtime/run.mentions.test.ts`;
- `frontend/src/assistant/components/Composer.library.component.test.tsx`, the mention model's and the citation
  chips' tests, the Library page's tests;
- `lib/app-exact-grants.test.ts`, `lib/nag-suppressions.test.ts`, `lib/stacks/core-buckets.test.ts`.

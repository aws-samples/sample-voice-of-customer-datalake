# Project workspace

A project turns customer feedback into research artifacts: personas, research reports, PRDs, PR/FAQs, product
reports and prototypes. Product teams use it to work from evidence, compare concrete combinations of artifacts on
the Prioritization board, and hand the result to an external agent through the app-wide MCP server on **Connect**
([mcp.md](mcp.md)). Projects are private to their owner and invited members by default; see
[Sharing and permissions](#sharing-and-permissions).

Open **Projects** in the sidebar (`/projects`). A project page (`/projects/{id}`) has these tabs, each a path (`/projects/{id}/<tab>`):
**Overview**, **Personas**, **Focus groups** ([persona focus groups](#persona-focus-groups)), **Product**, **Documents**,
**Decisions** ([decision records](decisions-and-release-watch.md)) and **Participants** ([participants](participants.md)). The AI assistant knows which project you are on and can use
its personas and documents ([mentions](assistant-mentions.md)).

## Workflow

1. Create a project and select the feedback window and filters that ground it.
2. Generate or import personas and run research.
3. Create PRDs, PR/FAQs, product reports, and prototypes from project context.
4. Review each artifact's provenance and revisions in the Documents tab.
5. Compose project artifacts into Prioritization rows and collect ballots.
6. Hand the project to an external agent: **Connect via MCP** in the project header opens Connect with a token pinned to the project, and a PRD or PR/FAQ's export menu still offers **Copy to Kiro**.

Long-running research, persona, document, merge, and prototype operations run as background jobs. Their status appears in the project.

## Methodology

The platform teaches one path: customer evidence → personas → PR/FAQ → PRD → prototype → review (TENETS.md, tenet 2),
the last step labelled **Validate** ([Validate](#validate)).
Steps may be done out of order, because a document without its upstream still has value, but no client skips a step
silently. The server says which steps were skipped, in one module, `lambda/shared/methodology.py`, so the web app,
the AI assistant, agents and MCP clients all see the same list.

**The per-step overview.** `GET /projects/{id}` carries `methodology: {order, steps}`. `steps.<step>` is
`{missing: [upstream steps the project has not produced], count}` for `personas`, `research`, `prfaq`, `prd`,
`prototype` and `validation`. `prototype` also has `blocked` (no PRD and no PR/FAQ); `validation` has `skipped`, true when
the project holds a decision and a prototype but no validation report (reported, never refused). `validation`'s count is
its plans and reports: a synthetic run never counts. The upstream of each step:

| Step | Reads |
|---|---|
| personas | (customer feedback) |
| research | personas |
| PR/FAQ | customer feedback, personas |
| PRD | customer feedback, personas, the PR/FAQ |
| prototype | the PRD and/or the PR/FAQ |
| validation | the prototype, and the PRD (its Success Metrics are the criteria) |

The Overview cards render this list: the research card's hint and the PR/FAQ + PRD card's hint name the missing
steps ("Generate personas first", "Write the PR/FAQ before the PRD"), and the prototype card is disabled while
`blocked`. Against an API from before 6.04.00 (no `methodology`) the cards keep their earlier local hints.

**The block a step answers and stores.** `POST /projects/{id}/research`, `POST /projects/{id}/document`
(PR/FAQ, PRD; also "Pursue" on a decision) and `POST /projects/{id}/build-prototype` answer, next to `job_id`,
`methodology: {step, skipped, warnings, evidence}`:

- `skipped`: `[{step, reason: missing | not_selected}]`, an upstream step the project lacks, or one it has that the
  request does not read (research without selected personas, a PR/FAQ / PRD without personas or without the PR/FAQ
  among its documents);
- `warnings`: `[{code, message, …}]`, one per skipped step (`missing_upstream`, `upstream_not_selected`, with
  `step`), `no_evidence` when no customer feedback reached the document, `reference_documents_skipped`
  (`document_ids`, `cap`) when more reference documents were selected than the generator reads (3), and
  `no_source_document` for a prototype with no source. The messages are English for headless clients; the SPA
  renders by `code`;
- `evidence`: the number of feedback items (and board requests) that reached the prompts; `null` in the start answer
  (the job has not read anything yet), `0` for a hand-written document.

The document generator stores the final block on the PR/FAQ, PRD or prototype it writes (and in the job result,
so `GET /projects/{id}/jobs/{job_id}` and MCP `projects_get_job` show it). The Documents tab shows a document's warnings under
it ("Methodology gaps"). Documents made before 6.04.00 have no block and show nothing.

**Feedback by default.** A PR/FAQ or PRD request reads customer feedback unless its `data_sources.feedback` is
`false` (an explicit `false` is honoured and reported as `upstream_not_selected` / `no_evidence`). Before 6.04.00 a
request that named no data sources read no feedback.

**Hand-written documents.** A PR/FAQ or PRD written from a blank template (`POST /projects/{id}/documents` with
`document_type: prfaq | prd`, `origin: human`) is stored with `methodology: {evidence: 0}` and a `no_evidence`
warning; the Documents tab says "Written by hand: cites no customer feedback yet."

**Imported and copied personas.** A persona imported from an image or pasted text (`POST /projects/{id}/personas/import`,
`POST /company-personas/import`, the persona importer job) or copied (`POST /projects/{id}/personas/copy`, promote to
the company library) is not generated from feedback, so it stores an evidence marker
(`lambda/shared/persona_evidence_marker.py`):

- `evidence: {source: import | copy, count, inherited, origin}`: `count` is the number of customer reviews behind
  it (always 0 for an import); a copy keeps its source's reviews (`input_feedback_ids` / `evidence_feedback_ids` are
  copied with it), counts them and sets `inherited: true`; `origin` says where the source's evidence came from
  (`generated`, `import`, `unknown`). Where it was copied from stays in `copied_from`;
- `methodology: {step: personas, skipped: [], warnings, evidence: count}`, with a `no_evidence` warning when
  `count` is 0.

The import START answer carries the same `methodology` block. Evidence is never invented: the marker repeats no
review id (the ids stay in the two existing fields, which an erasure already clears). The persona header shows
"No customer evidence: imported" (or "copied from an imported persona" / "copied from a persona without reviews").
A persona imported before 6.04.00 has no marker; its `imported_from` still shows the imported note.

**The one refusal.** `POST /projects/{id}/build-prototype` on a project with no PRD and no PR/FAQ answers **409**
`No PRD or PR/FAQ found for this project. Generate at least one first.` before any job row. It used to answer 202 and
fail inside the job.

Workflows (agents) get the same advice at design time: see [autonomous-agents.md → Methodology warnings](autonomous-agents.md#methodology-warnings).

## Product tab

The **Product** tab (`/projects/<id>/product`) holds the project's product description, which PRD, PR/FAQ,
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

## Which feedback a generation reads

A persona, research or document job can put only a few hundred reviews in front of the model (the limit follows the model's context window), while the chosen window often matches tens of thousands. The job therefore reads EVERY review the window and filters match — sources, categories, sentiments, channel, dimensions, tag, the date basis and your category/source access — and takes an **even sample** across them, so each day (and source, category, …) is represented in proportion to how much of the match it holds. The sample is deterministic: the same filters over the same data pick the same reviews, and one big import day cannot become the whole corpus.

Limits: the window read covers at most 90 days that hold feedback (within 400 calendar days for "All time"), at most 50,000 matching reviews and about 20 seconds of reading. Past either of the last two the sample covers the newest part of the window only, and the job's log line `[FEEDBACK] Sampled N of M matching reviews (at least; the read was capped)` says so. A channel filter reads the channel index (`gsi5-by-channel`), so a small channel inside a big import is found in full.

**The corpus is stored with the result.** Every artefact generated from feedback carries `input_feedback_ids`: the ids of the reviews its prompts held, in prompt order, at most 500 (`MAX_INPUT_FEEDBACK_IDS`, `lambda/shared/feedback_sampling.py`). That covers:

| Artefact | Written by | Ids stored |
|---|---|---|
| Persona | persona job (`api/projects.py`) | the reviews the persona-writing step read |
| Research report | research workflow (`research/research_step_handler.py`); the synchronous fallback (`run_research`) | the reviews the research prompt held (the fallback: every review it fetched) |
| PRD, PR/FAQ | document generator, single-shot and Step Functions paths (`jobs/document_generator`), so also "Pursue" on a decision and the agents' write-PRD / write-PR/FAQ nodes | the reviews the chain's feedback block held, after the character budget |
| Merged document | document merger (`jobs/document_merger`), when "use feedback" is on | the 20 reviews the merge prompt quotes |

Not covered, because no review reaches their prompt: prototypes (built from a PRD / PR/FAQ and tester pins), avatar regeneration, persona import, the product report. The suggestion routes (PR/FAQ autofill, suggest-brief, suggest-questions) read feedback but store no artefact. The job result keeps only the counts (`feedback_items_used`, `context_truncated`); the id list lives on the artefact. An edit of a PRD / PR/FAQ is a new version that keeps its predecessor's ids.

**Ids only, never review text**: copying customer text into project rows would put it out of reach of source retention and erasure ([source policies](source-policies.md#what-erasure-does-not-reach)). A review erased or deleted since simply shows as unavailable.

**In the UI**, a persona's header and a document's provenance footer show "Written from N reviews" with **Show reviews**, which opens the list ten at a time. Each review is read by id (`GET /feedback/{id}`, so the caller's category and source access applies) and opens in the review modal; one that is gone or outside the caller's access shows as unavailable.

`source_feedback_ids` on a persona (the first 20 reviews fetched) is **display-only** and kept for older readers: it is not the corpus, and nothing in the app reads it. Artefacts generated by older releases have no `input_feedback_ids` and show no corpus line: personas before 5.25.00; PRDs, PR/FAQs, merged documents and fallback research reports before 5.49.00. Imported and hand-made ones never have it.

### Feature requests from the feedback boards

Requests filed on the [feedback boards](feature-requests.md) are a **separate evidence source**: they never enter
voc-feedback or the review metrics, and a generation reads them only when asked. The request field is opt-in
(default off):

| Route | Fields |
|---|---|
| `POST /projects/{id}/personas/generate`, `POST /projects/{id}/research` | `include_feature_requests: true`, `feature_request_board_ids?: [board id, …]` |
| `POST /projects/{id}/document` (PRD, PR/FAQ) | `data_sources.feature_requests: true`, top-level `feature_request_board_ids?` |

`feature_request_board_ids` takes at most 20 board ids (`brd_…`); absent means every non-archived board. A
non-boolean flag or a malformed id list is a 400 before any job row. The job reads the boards' requests in the same
`days` window (on the request's `created_at`, `0` = all time) through `lambda/shared/feature_request_evidence.py`,
most-supported first, at most 200 and about 30,000 characters (`lambda/shared/feature_request_context.py`), and puts
them in their own fenced section, **"Feature requests from the feedback boards"** (`<feature_requests>`), after the
reviews. Each request shows its title, status, supporters, its enrichment (category, sentiment, problem summary) and
its description; never the reporter's or a supporter's email or name, never a board field such as a customer or a
deal. The model cites one as **`[FR:<request_id>]`**, distinct from a review citation.

What reached the prompt is stored as `input_feature_request_ids` (ids only, at most 200):

| Artefact | Where |
|---|---|
| Persona | on the persona, beside `input_feedback_ids` (every persona of the run); the job result's `metadata.feature_requests_used` counts them |
| Research report | `derivation.input_feature_request_ids`; the report header adds "Feature Requests Analyzed: N from the feedback boards" |
| PRD, PR/FAQ | `derivation.input_feature_request_ids` (single-shot and Step Functions paths) |

In personas, the analysis step and every persona-writing call read the section; the plan step reads the analysis only.
Autonomous agents, "Pursue" on a decision and the merged document never send the flag, so they read no board request.
The synchronous research fallback (`run_research`, used only when the research state machine is not configured)
cannot read the boards: it runs in the projects Lambda, whose role holds no grant on `voc-feature-requests` (kept
off for its policy size). When the box is ticked, the report says so under its header ("Feature requests: not
read…") and the saved report carries `feature_requests_skipped: true`, so the skip is never silent.
`POST /projects/{id}/feedback-preview` counts reviews only; a board's request count comes from
`GET /feature-requests/insights` (`totals.requests`, [feature requests](feature-requests.md)).

The readers (the persona and document generator jobs, the research step) hold `dynamodb:Query` on
voc-feature-requests and nothing else on it; the Projects API, which only starts those jobs, holds nothing on it
(`lib/utils/feature-request-evidence-grant.ts`). A board request is
searched by `GET /feature-requests/search` ([feature requests](feature-requests.md)).

### How many reviews match: the wizards' live count

The live count, cited evidence and protected personas below were contributed by @aws-bryan.

The persona and research wizards show a line at the foot of their feedback-filters step: **"About N reviews match"**
within a second, then **"N reviews match"** once the exact count arrives. The persona
wizard adds whether the personas read all of them or an even sample of its item limit. A zero says so before a model
run is spent on nothing.

`POST /projects/{id}/feedback-preview` `{sources, categories, sentiments, days, date_basis, mode, purpose}` answers
`{matched, matched_is_lower_bound, estimated, sample_limit}` (edit access, under the existing projects proxy; code in
`lambda/shared/persona_feedback_preview.py`):

- `mode: exact` is the generation's own read: the same window, filters and caller's category scope, through the same
  pool code (`shared.feedback` `context_request` / `read_context_pool`), so the number and the run cannot disagree. It
  stops after 20 seconds (API Gateway allows 29) and then answers a lower bound, shown as "At least N".
- `mode: estimate` scans four pages of the feedback-id index (rows in hash order, so a random sample), keeps the rows
  the same predicate admits and scales by the index's item count, rounded to two significant figures. A sample with
  fewer than 20 matches answers `matched: null`, and the line waits for the exact count.
- `purpose: personas | research`: only `personas` has a `sample_limit` (the persona item limit for the configured model).
- Answers are reused for five minutes per container, keyed on the project, the selection (click order ignored) and the
  caller's category scope. A cached exact count also answers an estimate. A lower bound is never cached.

The document wizard is not wired: document generation ignores the sentiment filter, so the same count would describe
a different read.

### Which reviews a persona cites

The persona prompt numbers its reviews (`### Review 1`, …) and asks the model to cite its evidence as `Review #N` in
`supporting_evidence`. At generation those numbers are resolved to the ids of that prompt's order and stored as
`evidence_feedback_ids` on the persona (`lambda/shared/persona_evidence.py`): distinct,
in first-cited order, never past the reviews the model read, at most 500. `supporting_evidence` stays as the model
wrote it, so a reference that names no review it read (prose, a number past the truncated prompt) is kept as text.

In the persona header the corpus line adds "cites N of them", and **Show reviews** opens on a **Cited** view, with
**All used** (`input_feedback_ids`) one click away. Personas generated by older releases have no Cited view. Research
reports have no `supporting_evidence`, so they have none either.

### Protected personas

A lock in the persona header (edit access) marks a persona **protected** (`PUT /projects/{id}/personas/{persona_id}/protection`
`{protected: true|false}`, a real boolean or 400, 404 for an unknown persona). The
list shows a lock on it and its header a "Protected" badge. The ordinary persona edit cannot change the flag.

In the wizard's add-or-replace choice ([persona generation](persona-generation.md)), **Add** keeps every persona and
**Replace** deletes only the unprotected ones (`lambda/shared/persona_replace.py`):

- every page of the project's personas is read, and each unprotected one is deleted on its own, conditional on still
  being unprotected, so a persona protected while the run is going is kept;
- a delete that fails for another reason is logged and the rest still go; only the deleted personas' avatar images
  are removed, and the project's persona count is recounted from what remains;
- the model is told about the protected personas the same way an add run describes the kept ones
  (`shared/persona_overlap.py`), and a new persona with a protected one's name is dropped
  (`duplicate_names_dropped` in the job result);
- the wizard's hint and confirmation count only the personas it deletes and say how many protected ones stay.

## Persona focus groups

Since 7.64.00. Put 2 to 6 of the project's personas in one panel and give them a topic. You watch them answer and
react to each other, each citing real feedback, and a synthesis ends it. When new feedback matching a persona
arrives, its card says so, and you can refresh its evidence. Every statement is **synthetic**: a hypothesis to test,
never customer feedback and never evidence (owner decision). Only the reviews the personas cite are real.

### Running one

On the **Focus groups** tab (`/projects/{id}/focus-groups`) choose the personas (at least 2, at most 6), write the
topic (at most 2,000 characters; it is the conversation's first message), pick 1, 2 or 3 rounds, and optionally up to
3 project documents and up to 3 [Documents Library](documents-library.md) items every persona reads. The tab shows the
cost before you start: the model calls on the assistant's chat model and roughly the tokens they read and write (6
personas and 2 rounds: 14 calls, about 45,000 input and 8,000 output tokens). Every persona call also reads the chosen
documents' text (within 30,000 characters together, shared equally) and the chosen Library items' best passages
(within 12,000), and the figure counts them from their sizes at about 4 characters a token: the same group with both
at their most reads about 171,000 input tokens. No dollar figure is shown: the
deployment's Bedrock prices are not held by the app (`lambda/shared/model_prices.py` records none it could not read),
and a guess would read as a quote. **Start focus group** opens the assistant on a new conversation and runs it there.

1. **Round 1 is independent**: each persona answers on its own, as a mention round does, so no answer is anchored on
   another.
2. **From round 2** the moderator (one model call) asks one follow-up question that makes the participants engage with
   where they differ. Each persona then reads an **anonymised digest** of the others' last answers ("Participant 1",
   "Participant 2": no name, theirs or anyone's, and no citation, since another persona's reviews are not its to cite;
   each answer clipped to 600 characters) and agrees, disagrees or builds on them.
3. **The synthesis** (one call) lists agreements, disagreements and open questions, at most five points each, naming
   who holds each view and keeping a citation a participant used.

The answers are persona cards, one per persona and round, each in its own colour (the categorical chart palette,
in the order the group first shows them) with its avatar and its round; each `[fb:<id>]` citation is a numbered chip
that opens the review (FeedbackDetail, with your own access). The synthesis is a card with the **Synthetic** label
and **Save focus group**. **Stop** ends it between batches: every persona call still gets a result and the card says
there is no synthesis. **Regenerate** runs the same group again (its stored configuration).

### What a persona answers from: the evidence pack

`lambda/shared/persona_grounding.py`, one module for every surface that lets a project's personas speak (the
focus groups now; the Validate phase and the voice personas next). Per persona:

- **its cited reviews**: those its `supporting_evidence` cites (`evidence_feedback_ids`, first cited first), at most
  12, always kept whatever the topic;
- **fresh retrieval**: the reviews imported since the persona was generated that match it, other than those it cites
  and those it was written from, at most 8, those that share the most words with the topic first (the similarity
  ranker's words: title, problem summary, text), then the newest. A review a refresh took is such a match, so it
  competes here on the topic. "Match" is the persona's categories (the categories of
  the reviews it cites, else of those it was written from, most frequent first, at most 5) within the project's own
  filters (`filters.sources`, `categories` and `sentiments` on its META; the filters are the floor: a persona whose
  categories are all outside them is matched on the filters' categories). The read walks the day partitions back to
  that day (at most 365 days) within one 8-second budget for the whole pack (a cut read is logged).

Every review is read **as the person asking**: their category scope (its category and source rules,
`shared/category_access.py`) admits it or it is not in the pack, so a pack never holds an id they could not open; a
person who cannot see a persona's categories gets no fresh review, never another category's instead. A review's text
is the **stored text**, which is already the source's PII policy as applied at ingestion: a `redact` source's text is
redacted, a `summary_only` source's is its summary and is marked `verbatim: false` (the persona is told it is not the
customer's words). The author, title, URL and metadata are never read into a pack, each text is clipped to 400
characters, and a text that reads like an instruction to a model is withheld. Nothing about a pack is stored.

The stream Lambda asks for the pack through its read-only invoker (`POST /projects/{id}/personas/evidence-pack`, a
read despite the verb, on the projects API's `/projects/{proxy+}`), with the caller's own claims. Each persona's
system prompt is its profile and the documents, as a mention round's is; its user turn carries its reviews in an
`<evidence>` DATA block, the Library items' passages in a `<library>` DATA block beside them (uploaded documents' words
stay out of the system prompt, 7.66.00) and, from round 2, the others' digest in a `<transcript>` DATA block (data, never instructions, every text neutralised), then the question, with the rule to
cite each review it draws on as `[fb:<id>]`, never an id that is not listed, and to say a point no review supports as
its opinion. **The server strips every cited id outside the speaker's pack** (the synthesis': outside every pack),
repeated until none is left, before an answer is shown, stored or quoted; the cited reviews are the run's feedback
sources. An unreadable pack fails open: the personas speak from their profiles and cite nothing.

### Saving it

**Save focus group** files the turn as a `focus_group` document in the Documents section
(`POST /projects/{id}/documents` with `document_type: 'focus_group'`, `shared/focus_group_documents.py`): the topic, a
synthetic banner, each round with its follow-up and answers, the synthesis and the ids of the reviews cited (never a
review's text: the document is read by everyone on the project, and an erasure never rewrites a document's text). The
row is always `synthetic: true` (whatever the body says) and records `derivation: {kind: focus_group, persona_ids,
document_ids, library_item_ids, rounds, feedback_count}`, with its creator (`created_by_sub`) and time (TENETS.md D4).
The cited reviews are its `input_feedback_ids`, only those the saver may see (the route checks each one with their
category and source access), so an erasure removes an id there as it does a persona's (D5); a `[fb:<id>]` in the text
that names no kept review is removed before the save, and from every later edit's text (`PUT`) and every Revise from
comments pass's changes (7.66.00; a change that only added such a citation is dropped). **A focus group is a reference,
never evidence**: its `DOC#` key
is no methodology step (`shared/methodology.py`), so no PR/FAQ, PRD or prototype counts it, and the document says so
under its text.

### Freshness and Refresh evidence

A project persona's header shows "N new matching reviews since ‹date›"
(`GET /projects/{id}/personas/{pid}/evidence-freshness`, view): the matching reviews since it was generated (by day)
that it neither cites, was written from, nor took in an earlier refresh, of those the person
may see ("At least N" when the 8-second count was cut short). **Refresh evidence** (edit) appends the newest of them
(at most 8) to the persona's `evidence_updates` (`POST /projects/{id}/personas/{pid}/evidence/refresh`): one entry
`{at, by: {sub, kind}, reason: manual_refresh, feedback_ids}`, at most 20 entries kept (the oldest dropped), and sets
`evidence_refreshed_at`; a refresh that took 8 of 20 leaves 12 counted, for the next one. It never rewrites the
persona's text: regenerating stays the generation's ([persona generation](persona-generation.md)). Nothing new writes
nothing (`added: 0`); a refresh that raced another write (another refresh, or a regeneration under the same key) is a
409 and writes nothing. A copied persona keeps its source's evidence, refreshes included. Refreshing is manual only (owner
decision): no schedule refreshes a persona. Both fields are in a workspace's export with the persona, and the retention
worker's lineage pass removes an erased review's id from a refresh entry (the entry, its actor and its time stay).

### Access, limits and cost

- Reads (the pack, the freshness count) need view access to the project; the refresh and the save need edit. A
  stranger gets the project's one 404.
- Limits (stream contract `FOCUS_GROUP_LIMITS`): 2–6 personas, 1–3 rounds, a topic of at most 2,000 characters, at
  most 3 documents and 3 library items. A focus group runs on its project's page only and is refused with mentions.
- Model calls are the chat surface's (the assistant's model), 3 personas at a time: personas × rounds, one moderator
  call before rounds 2 and 3, one synthesis. No fixed cost and no new AWS resource: the routes ride
  `/projects/{proxy+}` and `/chat/stream`.
- Projects are the deployment's until phase 3 (docs/multi-workspace.md), so the pack reads the deployment's feedback,
  as every project route does; a workspace scope is refused in code (`require_deployment`).
- MCP: no focus group tool. The global server's tool list is at its token budget (TENETS.md tenet 4 records the gap);
  an API client runs one through `POST /chat/stream` with a signed-in person's token, as the web app does, and an MCP
  client reads a saved one with `documents_get`.

## Validate

The methodology's last step (TENETS.md tenet 2's "review", labelled **Validate**; 7.68.00, owner decision: no tenet
change). The project's **Validate** tab checks the prototype against the PRD's success criteria, first with the project's
personas (synthetic), then with real testers inside the prototype, and ends in a report and a prefilled decision. The
Overview shows the step as card 6, after the prototype. Every route is an edit, the GET too: its results quote what
testers typed, as a prototype's pins do (`shared/project_access.py`). Projects are the deployment's (docs/multi-workspace.md,
phase 3).

**The state** is the project META's `validation` map (`shared/project_validation.py`): `{prd_document_id,
prototype_document_id, criteria, tasks, plan_document_id, run_document_id, report_document_id, form_id, form_open,
form_language, card_in_prototype, status, revision, updated_at, updated_by: {sub, kind}, reason}`. Every write is
conditional on the `revision` it read (a person's editor sends `expected_revision`: a write in between is 409
`validation_changed`; a job reads again and applies its change once more), records who, when and why (TENETS.md D4), and
is refused on a project being deleted. `status` is `not_started`, `criteria`, `planned`, `testing` (the card is shown) or
`reported`.

**Success criteria** `[{id, text, target?}]` (1 to 10, `c` + 6 hex ids, never reused): statements testers rate from 1 to
5. `target` is the average real testers must reach for the criterion to be **met** (1 to 5; 4 when unset). **Read them
from the PRD** (`POST …/validation/criteria`, one model call on the documents surface) turns the PRD's Success Metrics into
criteria, once: it refuses (409 `criteria_exist`) over saved criteria unless asked again with `replace`. A PRD's own
numbers (a business target a prototype test cannot measure) stay in the criterion's text; no target is invented. They are
edited by hand (`PUT …/validation/criteria`).

**The plan** (`POST …/validation/plan`, a `validation_plan` document in the Documents section): an interview guide of 5
to 8 neutral, open questions per criterion with one probe for each persona, and a task-based test script (1 to 8 tasks,
each with what success looks like) from the newest prototype's outline and walkthrough (`GET …/prototypes/{doc}/outline`'s
screens, never its pins). AI-backed by design, like research (TENETS.md tenet 3), in every way of working; `mode: blank`
writes the hand-written template instead (`origin: human`). The answer and the document carry the step's `methodology`
block: made without a prototype or a PRD is reported, never refused. The plan's test script becomes the step's tasks when
it has none yet.

**The synthetic run** (`POST …/validation/synthetic`, a `validation_run` document, always `synthetic: true`): up to 6 of
the project's personas, 3 at a time, each one model call, try the test script on the prototype's screens as themselves:
per task `completed`, `struggled` or `failed` with a sentence, per criterion a rating from 1 to 5 with a sentence. The run
stores each verdict and the figures (per task the outcomes, per criterion the personas' average). It is labelled
**Synthetic** wherever it shows, its document is never edited (the generic edit refuses it), it is never evidence, no
methodology step counts it, and **it never counts towards a criterion being met**: beside a criterion it reads `likely_met`
or `likely_not_met`, nothing more.

**Real testers: the "Tell us how it went" card** (`PUT …/validation/form` `{tasks, open, language?}`,
`shared/prototype_validation.py`). The prototype's own pin form (`pf_…`) gains validation questions as its next
revision, through the forms' own checks (shared/forms_v2.py; the revision it replaces kept first as its
`FORMREV#{form_id}#{n}` snapshot, a version 1 pin form's own fields with it; conditional on the revision and save count it
read; a question an answered form keeps cannot change its type or range, 409 `answers_locked`): per task "Could you do
this?" (yes or no), one CES (1 to 7), a 1-to-5 rating per criterion and an open "What was missing?", in one of the nine
languages (the card's own words; a task's and a criterion's text stay as written). `open` shows the card or hides it. The
pin widget asks the form for the card with an empty response on the same public submit route and draws it beside
**Feedback**, framed in the app (through the host) or opened on its own. The form id does not change, so the prototype's
CSP keeps its single `connect-src`, its own submit URL: neither the prototype's object nor its metadata is written. The
card targets the newest prototype version when saved; a version made before 7.68.00 carries the earlier widget, which
draws no card (`card_in_prototype: false`, and the tab says to save its walkthrough or build it again). Its answers are
customer feedback in the lake: queued as `feedback_form` items of the form's channel `form_pf_…`, tagged
`prototype_validation` ([feedback-forms.md → Prototype pin forms](feedback-forms.md#prototype-pin-forms-form_type-prototype_pin)).
Pins stay pins, never queued.

**Results** (`GET …/validation`): the real responses of the card's form, read through `gsi5-by-channel`
(`CHANNEL#form_{form_id}`: what the channel holds, newest first, at most 2,000) and admitted by the caller's category and
source access, each scored against the revision it answered (shared/forms_v2_results.py): per task its yes / no and
success rate, the testers' CES, per criterion the real average and its status, **met** or **not met** against its target
once at least 5 testers rated it, **not enough data** before, and "What was missing?" read live (never copied into a
document). The latest synthetic run's figures sit beside them, labelled. `form.stale` says the criteria or tasks changed
since the card was saved.

**The report** (`POST …/validation/report`, a `validation_report` document): the same figures, read with the starter's
category and source access (stored in the job's config), with a short summary (one model call; the computed tables stand
without it). Each criterion's result is `results[i]` (`{id, text, target, target_set, real: {n, average}, outcome:
met | not_met | not_enough_data, synthetic}`, as the GET answers it under `criteria`); the tasks, the ease, the counts and
the synthetic run's id are `report`. Its `input_feedback_ids` are the real responses it counted (lineage: an erasure removes one,
jobs/retention/lineage.py); it quotes no tester. **Create decision** opens the Decisions tab with a new decision prefilled:
the suggested verdict (`pursue` only when every criterion is met by real testers, else `park`; never `reject` by itself),
the criteria and their targets as its success metric, the report among its evidence documents and the real answers (up to
50) as its evidence feedback. Nothing is saved until the person saves it.

| Route | Access | Answer |
|---|---|---|
| `GET /projects/{id}/validation` | edit | the state, the card, the synthetic run, the real results, each criterion judged, the decision prefill and the step's `methodology` |
| `POST /projects/{id}/validation/criteria` | edit | 202 + an assist job whose `result` is `{validation}` |
| `PUT /projects/{id}/validation/criteria` | edit | `{success, validation}` |
| `POST /projects/{id}/validation/plan` | edit | `ai`: 202 + an assist job (`{document_id, validation, methodology}`) and the `methodology` block; `blank`: 201 `{success, document, methodology}` |
| `POST /projects/{id}/validation/synthetic` | edit | 202 + an assist job (`{document_id, synthetic: true, personas, validation}`) |
| `PUT /projects/{id}/validation/form` | edit | `{success, validation, form}` |
| `POST /projects/{id}/validation/report` | edit | 202 + an assist job (`{document_id, validation, decision_prefill}`) and the `methodology` block |

MCP `projects_generate` takes `step: validation_plan` and `validation_report` ([mcp.md](mcp.md)). Cost: pay per use,
one model call for the criteria, the plan and the report's summary, one per persona for a synthetic run; no fixed cost and
no new AWS resource (the routes ride `/projects/{proxy+}`).

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
- **Stale saves across tabs** (`expected_revision`, optional): the document editor sends the revision it loaded — a research / custom document's `revision` (unset = 1), a PRD / PR/FAQ's `version` (it must be the series head). When someone saved in between, the edit is a **409** and nothing is written; the editor offers **Load the latest** (reopen on the newest version) or **Save mine anyway** (resend without the check, so the other save stays in the history). A PRD / PR/FAQ save that loses the race for the next version mid-flight is a 409 too, not a silent v(n+2). Without the field there is no check (the assistant's `update_document` and MCP's `documents_update`).
- **What a save is** is the server's to record, never the client's word. A save of a "Revise from comments" proposal the person accepted on the canvas (a PR/FAQ or PRD only) names that pass: `revise_job_id` (optional), the pass's assist job id. The server records `edit_kind: revise`, `edited_by: {sub, kind}` (the person) and `revise_job_id` on the new version only when the pass checks out ([document-review.md → Saving a proposal](document-review.md#saving-a-proposal)); otherwise the save is a **400** and nothing is written. An unchanged save is the no-op (`unchanged: true`) whatever pass it names: the pass is not checked. Without it the save is an `edit`. An `edit_kind` in the body is ignored, like any other key the route does not read. The assistant's `update_document` and MCP's `documents_update` send neither (an edit).
- **Versions** (below a document) lists the versions newest first — `GET /projects/{id}/documents/{doc}/versions`, view level — to open one or compare it with the current version. **Restore** (`POST …/versions/{version_id}/restore`, edit level) saves a NEW version with that content; history is only added to. A prototype's restore is **Back to vN** on its pane ([prototype-builder.md](prototype-builder.md), part 2): the new version gets the old version's HTML with its own pin form, records `edited_by`, and is never reported unchanged (an S3-backed prototype row holds no `content` to compare). The oldest prototypes' inline HTML is restored too; an early JSON screen spec cannot be (400).

Version counters and allocation-history records are platform-managed. Do not delete rows under the `DOCUMENT_VERSIONS#PROJECT#<id>` partition; see [Data Lake Structure](data-lake-structure.md#projects-table).

## Prioritization rows

A Prioritization row is a concrete set of scorable documents from one project, not a moving pointer to "the latest"
artifacts. Once a score lands, the row's document ids stay fixed; when a newer combination exists, add a new row
instead of changing the one whose ballots describe the older artifacts. Composing, scoring, room votes and lineage
labels are described in [prioritization.md](prioritization.md).

## Sharing and permissions

Every project has a visibility, an owner, and an optional list of invited members. The policy lives in `lambda/shared/project_access.py` and is enforced centrally by the Projects API.

- **Public** — every signed-in user can view and edit the project.
- **Private** — only the owner, invited members, and workspace admins (the Cognito `admins` group) can see it. To anyone else the project does not exist: list results omit it and direct requests return `404 Project not found`.

New projects are **private** by default and owned by their creator. Only callers with *manage* access can change a project's sharing.

| Role | View | Edit | Manage |
|------|:----:|:----:|:------:|
| Owner | ✓ | ✓ | ✓ |
| Admin (workspace `admins` group) | ✓ | ✓ | ✓ |
| Editor (invited member) | ✓ | ✓ | — |
| Viewer (invited member) | ✓ | — | — |

*Manage* covers changing visibility, inviting, re-roling and removing members, transferring ownership, and deleting the project. On a public project every signed-in user is effectively an editor; a viewer invitation does not lower that. A caller who can view but not act gets `403` (`You do not have permission to edit this project` / `... to manage this project`). Members may always remove themselves.

**Legacy projects** created by releases before project permissions have no owner and no visibility. They read as public, so nobody loses access on upgrade, and only admins can manage them until an admin transfers ownership to a user.

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

To copy a project to another deployment (owner and members remapped by email), see
[Moving projects between deployments](project-export.md).

## Deleting

A workspace delete really deletes, and it is recorded (TENETS.md D4, D5; customer data itself is deleted only by `voc-retention`, [source-policies.md](source-policies.md)).

- **Every S3 version goes.** The raw-data bucket is versioned, so a plain delete would only hide an object behind a delete marker. Deleting a persona (its avatars), a prototype document (its HTML), a product doc (its upload and extracted text), a project (every prototype, product doc and its own avatars), a superseded avatar and an archived design reference's logo preview and icon copies removes every version and delete marker (`lambda/shared/s3_versions.py`). The roles that do it hold `s3:ListBucketVersions` and `s3:DeleteObjectVersion` on those prefixes only.
- **Every delete leaves a record.** One row per deleted artifact, `pk AUDIT#delete` / `sk <iso time>#<uuid>`, in the table that held it (`lambda/shared/delete_audit.py`): `kind`, `target` (ids only, never content), `actor` (`{sub, kind}`, kind `user`, `admin`, `agent`, `mcp`, `plan` or `system`; never an email), an optional `reason` and `deleted_at`. The row has no `ttl` and is never overwritten. Kinds in the projects table: `project` (its tombstoned `META` row is kept as well), `persona`, `persona_replaced` (a replace-mode regeneration's deletes, recorded as the person who started it), `company_persona`, `document`, `document_revisions` (a research / custom document's saved revisions), `product_doc`, `document_comment`. Elsewhere: `conversation` (voc-conversations), `design_reference_copies` (voc-aggregates), the feedback-board and participant-list kinds ([feature-requests.md](feature-requests.md#deleting), [participants.md](participants.md#data-model)). Recording never fails the delete: a failed write is logged.
- **A document that cited a deleted source says so.** When a persona, a document or a product doc (a visual) is deleted, each document of the same project that was written from it (its `derivation` `persona_ids`, `sources`, `visual_document_ids`, or the older `source_documents` / `source_prd_id` / `source_prfaq_id`) gains a `deleted_sources` entry `{kind, id, deleted_at}`, plus `name` for a persona (a fictional archetype, not personal data); at most 50 are kept. The ids stay in `derivation` for lineage. The projects API returns the field with the document, and the document view shows "Written from a persona that was later deleted: <name>" (or a document / product document). One Query of the project partition per delete; best effort, a failure is logged.

## Company personas

The **Company** page (`/company`) has a **Personas** tab (`/company/personas`) beside Vision and Design system: one shared library of personas for the whole workspace. Every signed-in user reads it; **only admins write it** (generate, import, edit, notes, regenerate the avatar, delete, and promote a project persona into it). Company personas are not filtered by category access.

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

The project header's **Connect via MCP** link opens `/connect?project={id}`, which pre-selects that project as the token's pin. A retired tab's path (`/projects/{id}/mcp`) opens the Overview tab.

### Upgrading from a release before 3.00.00

The project page no longer has an **Export / MCP** tab, and the per-project MCP server behind it is gone:
`POST {api}/mcp`, the `/projects/{id}/api-tokens` routes and `GET /projects/{id}/autoseed` answer 404, and a
per-project token is a 401 at `/mcp/global`. Mint a global token on Connect instead. **Copy to Kiro** in a document's
export menu always pastes the backend's instructions (`kiro_default_export_prompt` on `GET /projects/{id}`); a Kiro
export prompt saved on a project by an older release is never read, and `POST /projects` and `PUT /projects/{id}`
ignore a `kiro_export_prompt` field.

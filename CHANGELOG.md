# Changelog

All notable changes to the Voice of Customer (VoC) Data Lake are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versions are `0.x` on purpose: this is a sample platform whose interfaces still move between
releases, so a minor bump may carry changes that would be breaking in a `1.x` project. Read the
**Upgrade notes** of each release before deploying over an existing stack.

The version recorded here is the one in the `package.json` files. It is **not** what the dashboard
displays: the UI's build identifier is the short git commit SHA, injected at build time.

## [Unreleased]

### Added

- An expanded prioritization row can enlarge the prototype it is showing to fill the viewport, in
  place, so a pitch session can look at the artifact without leaving the sliders, the team's numbers
  and the room vote behind on the page. Escape, the visible Close control and a click outside all
  return to the row. Offered for every prototype the row renders, including a legacy inline one and a
  JSON spec, neither of which has an address that "Open in new tab" could use.

### Fixed

- Feedback aggregation is now idempotent under DynamoDB Streams redelivery: the aggregate counter
  updates and a per-stream-event claim commit in one DynamoDB transaction, so replaying an event is
  a no-op instead of moving every counter a second time. `AggregateRecordReplayed` reports those
  skips and `AggregateTransactionConflicted` reports bounded in-process retries on hot rows.
- Shared modal dialogs now honour Escape and keep Tab inside themselves while focus is in a nested
  same-origin `<iframe>`. Keys pressed inside a frame are raised in the frame's own document and
  never reached the dialog, so any modal embedding one (the prototype overlay above) could not be
  dismissed from the keyboard once a reader clicked into its content. A frame the page cannot read
  into — cross-origin, or sandboxed without `allow-same-origin` — still cannot be observed, so
  dialogs embedding one must offer a visible dismiss control. One further exception is known and
  tracked as #386: a frame whose content rewrites itself with `document.open()` keeps the same
  document object while a compliant browser erases the listeners on it, so the dialog believes it is
  still listening there.
- Tab can now reach the controls inside a dialog's nested `<iframe>`. Descending into a frame is the
  browser's default action for a Tab pressed while the frame itself has focus, and the focus trap
  cancelled that action whenever the frame was the dialog's last focusable — which is the prototype
  overlay's shape — so focus bounced between the dialog's own controls and every link inside the
  artifact was unreachable by keyboard. A frame the page cannot read into, or one with nothing
  focusable in it, keeps the old behaviour: there would be nothing inside it to bring focus back out.
  This holds at any depth, so a prototype that embeds a frame of its own — a map, a video, a
  documentation pane — is reachable too, and leaving such a frame continues through the prototype's
  own content rather than jumping out of the artifact to the dialog's controls.
- Tabbing through a large prototype inside a dialog no longer slows down with the size of the
  prototype. Each keypress measured the whole embedded document to decide whether the key was leaving
  it — for a 400-control page, 2800 style resolutions per keystroke, nearly all of it to conclude that
  the key was an ordinary one the dialog should ignore. The question is now answered from the first
  control the key can still reach.
- A dialog whose embedded content replaces a frame of its own no longer accumulates one DOM observer
  per replacement. Each nested document is watched so that keyboard handling follows frames the
  content inserts itself, and a watcher for a document that had been swapped away was held until the
  dialog closed, keeping the discarded document alive with it. Watchers are now dropped as soon as
  their document leaves the frame tree.

### Security

- `POST /projects/{project_id}/document` validates `doc_type` against an allowlist of `prd` and
  `prfaq` before creating the job. The field steered the job type, the execution path and the
  generated document's DynamoDB sort key straight from the request body, and each attempt billed a
  model call.
- The public embeddable feedback form page, `GET /feedback-forms/{form_id}/iframe`, no longer
  reflects its form id into the page it returns. The id was interpolated into a `<script>` block
  inside handwritten quotes, so a path the route's own pattern accepts —
  `a');alert(document.domain);x=('` — came back as executable script on the API's own origin, to any
  visitor who could be sent the link (#379). The id is now format-checked before the page is built,
  every value the page inlines is serialized rather than quoted by hand, and the response carries a
  Content-Security-Policy. The page also confirms the form exists first, so an attacker-chosen id no
  longer produces a page at all. Embedding is unaffected: no `frame-ancestors` and no
  `X-Frame-Options` are set, deliberately.
- Every route that takes a form id out of the URL now checks its format before reading or writing,
  so a probe or an unbounded path segment costs no DynamoDB call on the unauthenticated ones.
- `PUT /feedback-forms/{form_id}` no longer creates a record. The write was an unconditional
  `UpdateItem`, which is an upsert, so a request naming an id the table did not hold created a row
  with no `form_id` of its own — one that read back with an empty id and could not afterwards be
  addressed or deleted by id. It is now conditional on the form existing.
- `POST /feedback-forms` can no longer overwrite an existing form. The write was an unconditional
  `PutItem`, which replaces whatever is stored at the same key, so a minted id that collided with a
  form already there would have replaced it — that form's `enabled` flag, theme and document link
  gone, reported as a successful create. Unreachable by a caller, since the id is minted rather than
  taken from the request, so it required a collision between two draws; the write is now conditional
  on the id being free and a collision answers 500 instead of losing the form.

### Upgrade notes

- **`POST /projects/{project_id}/document` now answers 400 for any `doc_type` other than `prd` or
  `prfaq`.** Matched exactly, with no case folding or trimming, so `PRD` and `" prd"` are refused
  too. Previously accepted values that now fail: `build_prototype`, `product_report` and the empty
  string. The web app is unaffected — it only ever sends the two accepted values — but a script or
  integration calling this route directly may need updating. `build_prototype` and `product_report`
  have their own routes (`POST .../build-prototype`, `POST .../product-report`); use those instead.
- **The same route now answers 400 when the request body is present but is not a JSON object** —
  an array, string, number or boolean, including the falsy ones (`[]`, `false`, `0`, `""`). These
  previously started a default `prd` generation. Unparseable JSON is a 400 too, where it was
  previously a 500. A body that is absent altogether, a literal JSON `null`, or zero-length
  (`Content-Length: 0`), still means "generate a PRD with the defaults" and is unchanged.
- **A feedback form id that this service could not have issued now answers 404 on every route that
  takes one out of the URL**, before any read. Ids are at most 64 characters of letters, digits, `_`
  and `-`, so an id containing anything else — a space, for instance — answers 404: ` abc123` is
  refused on its format. Note that no route ever resolved ` abc123` to `abc123`; the space was always
  part of the key, so there is no stored data to migrate. Forms created through this platform are
  unaffected — the ids it mints are 8 hex characters — and a hand-seeded id like `website-form` still
  works.
- **`POST /feedback-forms/{form_id}/submit` reports a malformed id ahead of an invalid body.** A
  request carrying both a bad id and an empty `text` now answers `404 Form not found` where it
  answered `400 Feedback text is required`; the id is wrong regardless of the body, and this route
  had to refuse before enqueueing anything. A well-formed id with an empty `text` still answers 400.
- **`PUT /feedback-forms/{form_id}` answers 404 for a form that does not exist**, instead of creating
  one. Create through `POST /feedback-forms`, which mints the id. Any phantom rows an earlier version
  created are visible in `GET /feedback-forms` as entries with an empty `form_id`; they have to be
  removed directly from the aggregates table, since no route can address them by id.

## [0.2.0] - 2026-08-19

The first release since the platform moved from a single-stack sample to a workspace covering
research, prototyping and team prioritization. Roughly 120 changes, developed between 2026-06 and
2026-08.

### Added

**Project research workspace**
- Research projects that generate personas, PRDs and PR/FAQs from the feedback corpus, run as
  asynchronous jobs with a Background Jobs panel for long-running progress.
- Document provenance: each generated document records and shows how it was built, and which
  specification a prototype was built from.
- Prototype builds that read product context and research, and can be grounded in the mockups they
  were aimed at.
- An MCP endpoint so external agents can read project data, with a two-card Export / MCP layout.

**Team prioritization**
- A prioritization row now represents a project rather than a single document, with ballots keyed to
  the row and PRDs scorable alongside PR/FAQs.
- One ballot per reviewer, replacing a single shared score map, with rows leading on the team score.
- Room voting: a meeting scores a proposal from their phones through a session QR code.
- Linked feedback forms surface their collected ratings on the matching prioritization row.

**Conversational and AI surfaces**
- Streaming chat over Server-Sent Events, served by a TypeScript Lambda through API Gateway.
- A per-surface AI model picker over a curated Claude allowlist, so chat, documents, prototypes,
  enrichment and utilities can each use a different model.
- Opt-in public web search through Amazon Bedrock AgentCore, with agentic multi-query research
  grounding for chat and research. Deployed by default, and switchable off.
- A `create_project` tool callable from chat, plus aggregate search mode and urgency sorting.

**Internationalization**
- A runtime i18n layer with eight locales and a language switcher, replacing hardcoded English.
- Parity guards in CI-style tests so a missing key in one locale fails a check rather than silently
  rendering a raw key path.

**Data sources and ingestion**
- CSV bulk upload with a 50,000-row cap, batched to SQS, with an upload modal.
- A synthetic data review generator plugin, and a persistent Data Sources card for generators.
- Mobile app review ingestion and a rebuilt scrapers UI.
- Ingestion provenance (`ingestion_method`) persisted on each feedback record.
- Feedback forms can be shown as a scannable QR code for a public submission page.

**Interface**
- A flow-ordered sidebar and a Home onboarding page.
- A route-level error boundary, so one failing page no longer blanks the application.
- A shared modal component that owns dialog semantics and keyboard handling.
- Filtering by review date versus imported date across the application, honoured by chat, research
  and MCP.
- Marking problems as resolved in Problem Analysis.
- Category distribution moved to Signals, the Feedback tab consolidated into Categories, and Data
  Explorer tabs slimmed.

**Operations**
- An opt-in deployment prefix, allowing two independent copies in one AWS account.
- Workshop artifacts made deployable, within a five-CloudFormation-template limit.

### Changed

- Claude Opus 4.8 upgraded to Opus 5; AI budgets are configuration-driven rather than hardcoded.
- Persona generation fans out avatar creation and drops a validation step that discarded work.
- Metric windows are read in a single query instead of one lookup per day.
- The two `us-east-1` AI-enablement stacks were merged into one, keeping the stack count at five.
- DynamoDB GSI names now come from a single source of truth.

### Fixed

- Persona generation no longer silently discards most of the feedback corpus.
- Ingestion pages through complete review sets instead of stopping at the first page, and no longer
  loses feedback when an SQS batch send partially fails.
- Feedback form submission counts are honest, with one partition per form.
- Problem Analysis counts over the whole window rather than its first page, and the urgent count
  reports the true total.
- Prioritization reports partial ballots honestly instead of presenting an incomplete average as
  complete.
- Chat conversation and message identifiers are collision-proof, and streamed replies land in the
  conversation they came from.
- Data Explorer queries an index that exists.
- Recurring crash fixes for sparse or legacy records: scrapers without a base URL, categories without
  identifiers, forms without a theme.
- PDF import is refused rather than producing an invented persona.
- Deployment reliability: eternal ingestor asset hash churn, a mismatched bundled botocore, and
  pre-existing stacks blocked by a create-only Cognito property.
- Repo-wide lint and test debt zeroed, with every surface gated.

### Security

- Chat conversations are partitioned by authenticated user, replacing a shared partition that placed
  every user's history together.
- Cognito authentication is required on feedback-form item routes that were reachable unauthenticated.
- The deprecated Cognito implicit OAuth grant is disabled.
- Avatar and prototype objects require signed URLs.
- Raw Lambda events are no longer logged, with a CI guard against reintroduction.
- MCP access uses constant-time token comparison, enforced scope, a narrowed IAM policy, a working
  throttle, an Origin guard and token expiry.
- Free-text fields on the streaming path are bounded and replayed history is clamped.

### Upgrade notes

- **Chat history written before this release becomes unreachable.** Conversations are now keyed by
  authenticated user subject; there is no migration, and the change is deliberate.
- Deploying over a stack created before the Cognito username change may require
  `-c omitUserPoolUsernameConfiguration=true`. See `docs/deployment.md`.
- Web search deploys by default. Opt out with `-c enableWebSearch=false`.
- Lambda layers must be built for ARM64 before deploying: `./scripts/build-layers.sh`.

### Toolchain

- Frontend tests run on Vitest 4. Vite is deliberately held at 7.x: Vite 8 replaces the bundler with
  Rolldown, which requires `manualChunks` to be a function and rejects the object form this project
  uses. That migration is tracked separately.
- After pulling this release, run `npm ci` in `voc-datalake/frontend` — an existing `node_modules`
  from before it will be stale.

## [0.1.0] - 2026-05-25

Initial release of the sample: a fully serverless platform for ingesting, processing and analyzing
customer feedback on AWS.

### Added

- Plugin-based ingestion, where each data source is self-contained and declares its infrastructure,
  UI configuration and credentials in a `manifest.json` consumed by CDK.
- An event-driven processing pipeline: raw payloads archived to S3, queued through SQS, enriched by a
  processor Lambda using Amazon Bedrock and Amazon Comprehend, and aggregated in near real time off
  DynamoDB Streams.
- Multi-language support with automatic language detection and translation.
- A REST API split across domain-specific Lambdas, behind API Gateway with Cognito authentication.
- A React dashboard with metrics, charts, AI chat and project management, served through CloudFront.
- A web scraper plugin, embeddable feedback forms, and an S3 import plugin.
- Encryption at rest with a customer-managed KMS key, and cdk-nag suppressions recorded where AWS
  services do not support resource-level permissions.

<!-- These point at commit ranges rather than release tags, because no version tags exist yet.
     Re-point them at /releases/tag/vX.Y.Z once releases are cut. -->

[0.2.0]: https://github.com/aws-samples/sample-voice-of-customer-datalake/compare/0b785a87...main
[0.1.0]: https://github.com/aws-samples/sample-voice-of-customer-datalake/commit/0b785a87

# Changelog

All notable changes to the Voice of Customer (VoC) Data Lake are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Versioning.** Releases are numbered `MAJOR.MINOR.PATCH` and written here with two-digit minor and
patch parts (`2.09.00`). `package.json` (repo root, `voc-datalake/`, `voc-datalake/frontend/`) carries
the same number in strict SemVer (`2.9.0`), because npm rejects leading zeros; `scripts/check-version.mjs`
(a `validate.sh` step) fails when the two disagree. A **major** bump marks a redesign or a breaking
change to an API, a stack or stored data; a **minor** bump adds or changes behaviour; a **patch** is a
fix, a test, a doc or tooling only. Every change that lands bumps the version and adds its entry here
(see `.kiro/steering/changelog.md`). `2.x` starts with the Kiro redesign; `0.x` releases are kept below.
Read the **Upgrade notes** of each release before deploying over an existing stack.

The frontend build identifier is the short git commit SHA injected at build time; it is separate from
the platform package version.

## [Unreleased]

## [5.52.00] - 2026-10-30

An imported S3 file can be reprocessed through the pipeline from the S3 import explorer (#144).

### Added
- **Reprocess an imported S3 file.** Each file in the S3 import explorer (Administration → Sources → S3 Bulk
  Import) has a Reprocess action that runs it through the import pipeline again and shows the run until it
  finishes. Rows already in the data lake are skipped as duplicates, so only missing rows are imported (for
  example after a partial processing failure or an accidental erasure); stored rows are not re-enriched, which
  stays the job of *Reprocess existing feedback*. A copy archived by hand as `processed/<folder>/<file>` keeps
  its original source `S3 - <folder>`. New admin-only routes `POST /s3-import/reprocess` and
  `GET /s3-import/reprocess/{run_id}`; the run is the ordinary `SOURCE_RUN#s3_import` source-run record
  ([Data lake structure → Reprocessing a file](docs/data-lake-structure.md#reprocessing-a-file)). A failed
  reprocess ends `error` and is not retried by Lambda (press Reprocess again); an upload's S3 event keeps its
  retries. A second
  reprocess of a file answers 409 while its earlier run is still running (younger than the ingestor's 300 s
  timeout).

### Fixed
- `POST /sources/s3_import/run` no longer leaves its run record at `running` forever: the S3 import ingestor
  now closes a run it is given, as completed with 0 rows when no file was named.

### Security
- The S3 import ingestor reads only records that name its own import bucket (new `S3_IMPORT_BUCKET`
  environment variable); a record for any other bucket is skipped with a warning, unread.

### Upgrade notes
- `VocApiStack`: the S3 import API role gains `lambda:InvokeFunction` on the `s3_import` ingestor and
  aggregates-table Put/Get/UpdateItem/Query limited to the `SOURCE_RUN#s3_import` partition (only when the
  `s3_import` plugin is enabled). `VocIngestionStack`: the `s3_import` ingestor gains the `S3_IMPORT_BUCKET`
  environment variable. Deploy both stacks together. No resource is renamed or replaced.

## [5.48.06] - 2026-10-30

The rest of the npm packages move to their newest release within their current major, and the fixes a full
production end-to-end run and log sweep found after the 5.48.04 dependency upgrade.

### Changed
- Every npm package not already moved by 5.48.04 goes to its newest release within its current major. `cdk-nag`
  2.37 → 2.38 and `constructs` 10.6 → 10.8 in the CDK app. The stream Lambda's AWS SDK clients move to 3.1160. Frontend
  runtime: React 19.3, React Router 7.18.5, Recharts 3.10, Tailwind 4.3, Zustand 5.0.16, date-fns 4.4,
  aws-amplify 6.22, i18next 25.10. Tooling: typescript-eslint 8.72, eslint-plugin-sonarjs 4.2, knip 6.44, Stryker
  10.1, pyright 1.1.414, jscpd 5.4, Playwright 1.64 (the e2e suite), and the stream Lambda's TypeScript 5.7 → 5.9.
  The stricter lint and type rules these bring are fixed in the code (tests regrouped as parameterized tests,
  specific matchers, one redundant optional type), with no gate setting changed.
- `cdk-nag` 2.38 replaced its Cognito rule COG3 (advanced security mode) with COG8 (the plus feature plan); the
  suppression on both user pools follows it with the same decision (not enabled, to stay pay-per-use).
- Administration → System → Logs → System errors (`GET /logs/system`) answers in about half the time: a 7-day
  search measured 6.0 s → 3.0 s (median of 6, production). The Insights queries start and are read concurrently, a
  finished query is not read again, the first reads come after 0.5 s instead of 1 s, and the log-group listing is
  kept for 5 minutes in the warm Lambda, so a `query_id` poll no longer lists every log group again. A new
  function's log group therefore joins the search within 5 minutes. The e2e suite gives this screen its own
  latency budget (8 s, measured warm 2.9-4.0 s and with a cold Lambda 4.9-6.4 s), far below the 18 s poll limit.
- Pull requests are rebase-merged and keep every commit (`gh pr merge --rebase`); squashing is no longer
  required ([CONTRIBUTING](CONTRIBUTING.md), `.kiro/steering/changelog.md`). `main` keeps its linear history, so a
  branch catches up with `git rebase origin/main` rather than a merge commit.
- The supported Node.js is 22.12+ (root `package.json` `engines`, [deployment](docs/deployment.md)): Vite 7 and
  Stryker 10 need it, and CI already runs Node 22. The mutation tool's own Babel is 8.x (Stryker 10.1's
  instrumenter); the SPA's build keeps Babel 7 through `@vitejs/plugin-react` 5.2.
- Held back on purpose: `amazon-cognito-identity-js` stays at 6.3.20 (6.3.22 marks the whole library deprecated in
  favour of Amplify v6, a sign-in migration of its own), `@tanstack/react-query` at 5.95 (5.105 deprecates
  `fetchQuery` / `prefetchQuery` in favour of `query()`), `@vitest/eslint-plugin` at 1.6.27 (1.6.28 needs
  TypeScript 6), and `eslint-plugin-react-refresh` at 0.4. Major upgrades (TypeScript 7, ESLint 10 in the CDK app
  and SPA, Vite 8, Vitest 5, i18next 26) are not part of this release.

### Fixed
- Opening a page while offline shows the app's own error state ("Reload page", or the page's "could not be
  loaded") again, instead of the browser's offline page. The 5.47.04 stale-build reload treated a lazy page that
  failed for lack of network as a removed chunk and reloaded the tab; it now reloads only while the browser is
  online, and an offline failure does not use up its one reload per build.
- Two model budgets that thinking used up, seen in the production logs: the PRD chain's `problem_analysis` step
  asks for 16,000 tokens (was 6,000, which came back empty and was retried), and the memory relation judge asks for
  its 800-token answer plus the standard 2,048-token thinking headroom (it came back truncated, so every pair fell
  back to "unrelated").
- The production end-to-end suite follows 5.47.04 and 5.48.02: the Radar picker's "All brands" option, "Edit my
  +1" for a request's reporter (the second +1 comes from the other test user), Delete only on an archived board
  (checked on a scratch board that is recorded in the run ledger, so the cleanup teardown removes it even when the
  worker dies; feedback boards are a new ledger kind), and the SSRF redirect probe tries its redirectors in turn
  (`E2E_SSRF_REDIRECT_URL`, httpbin.dev, httpbin.org) because httpbin.org now refuses internal targets; it skips,
  naming each answer, only when none redirects.
- `test_logs_at_info_with_tenacitys_wording_and_stacklevel_two` reads the qualified name off the undecorated
  function, which pyright 1.1.414 requires.

### Security
- `qs` under `typed-rest-client` (Stryker's dashboard reporter) is forced to ^6.17.1 in the CDK app, the frontend
  and the stream Lambda. `npm audit` still reports 0 vulnerabilities in every package.

## [5.48.05] - 2026-10-30

The Python suite no longer fails when a run crosses midnight UTC.

### Fixed
- Every pytest run moves the clock to 12:00 UTC of its own day, still ticking, from `pytest_configure` on, so dates a
  test module computes at import are covered too (`voc-datalake/conftest.py`, with
  `time-machine` 3.6.0 pinned in `requirements-dev.txt`). Fixtures that write "today" and the handler that reads it
  could land on two different days when a run crossed midnight UTC: four metrics tests failed in CI that way.
  The controlling pytest process picks that noon once
  (`VOC_TEST_MIDDAY`, overwriting a stale shell value; workers refuse a missing value or one that is not 12:00 UTC), so every
  pytest-xdist worker shares it; `lambda/shared/test/test_suite_clock.py` pins the
  rule and fails without the fixture. Test tooling only. One `projects_handler.py` docstring names
  its hypothetical marker in plain prose, so `py_doc_refs` needs no allowlist entry for it (whether that back-ticked
  name resolved depended on which test libraries were installed).
- `scripts/validate.sh` passes its CDK-suite timeout (`VALIDATE_VITEST_TIMEOUT_MS`, 30 s) to hooks too: a
  `beforeAll` synth in `processing-stack-radar.test.ts` hit vitest's 10 s hook default on a loaded CI runner.
- The gate step `audit: every detector has a step` reads `scripts/validate.sh` once instead of piping it into
  `grep -q` per detector, which failed intermittently under `pipefail` (grep: write error: Broken pipe) in CI.

## [5.48.04] - 2026-10-29

Every open Dependabot alert is fixed: 50 alerts (14 high, 24 moderate, 12 low) across the four npm packages.

### Security
- `zod` 4.6.7 everywhere (frontend, stream Lambda, the Kiro ACP bridge; the CDK app already had it): fixes the
  high-severity advisory for versions before 4.6.6.
- `aws-cdk-lib` 2.261.0 → 2.275.0 (exact): the copy of `brace-expansion` bundled inside it (5.0.6, high) cannot be
  overridden, and 2.275.0 bundles 5.0.12. The `aws-cdk` CLI moves to 2.1146.1 with it, pinned exactly like the library.
- `vitest` and every `@vitest/*` package 4.1.12 (the CDK app, frontend and stream Lambda): fixes the
  `@vitest/mocker` advisory for 4.1.11 and earlier. Test tooling only.
- Frontend: `i18next-http-backend` 3 → 4.0.6 (v4 uses the browser's own `fetch`, nothing to configure);
  `fast-xml-parser`, `fast-xml-builder`, `uuid`, `undici`, `fast-uri`, `qs` and `@babel/core` updated in range
  (through `aws-amplify` and the build tooling).
- Dev tooling with a parent that pins the old version gets an npm `overrides` entry: `qs` ^6.16.1 under
  `typed-rest-client` (Stryker) in all three packages, and `esbuild` ^0.28.1 in the frontend (`i18next-parser`
  pinned 0.25).
- `npm audit` reports 0 vulnerabilities in the repo root, the CDK app, the frontend, its e2e suite, the stream
  Lambda and the bridge.

### Upgrade notes
- The CDK library jumps 14 minor versions. Run `npx cdk diff` before the next deploy. On a synth it changes only
  CDK's own output: the three Step Functions roles' trust policies (research, document, agent run) gain the
  `aws:SourceAccount` / `aws:SourceArn` confused-deputy conditions, and CDK's website-upload function
  (`BucketDeployment`) runs on arm64. No resource is renamed or replaced: the name inventory in
  `lib/test-support/baseline.json` is unchanged, only the VocApiStack and VocProcessingStack hashes moved.

### Fixed
- The `quality gates` and `no-event-logging guard` workflows run on pushes to `main` again: their push trigger still
  named the retired `development` branch, so a merged PR was never re-checked on `main` (pull requests were).
- The CDK app uses `addStackDependency` / `addResourceDependency`, which 2.275.0 asks for instead of the deprecated
  `addDependency` on stacks and `CfnResource`s (the ESLint deprecation gate).
- Frontend spec type-check: `tsconfig.test.json` names the `node` types itself; Vitest 4.1.12 no longer brings them,
  and the lockstep specs read files with `node:fs`.
- `test_scanner_enqueues_only_ended_sessions_with_new_messages` pins the scanner's clock to the test's `NOW`: on a
  slow suite run its 5-minute-old "active" session aged past the 30-minute idle cut-off and was enqueued.
- `scripts/validate-affected.sh` falls back to the local `main` when there is no `origin/main` (a shallow checkout,
  a clone without that remote) and says so, except in CI (`CI` set), where it stops instead of risking a smaller
  changed set; a missing default base names `git fetch origin main`. `scripts/validate-affected.test.mjs` (in the
  version gate step) runs the script in a scratch repository: an explicit base, the local fallback, the CI stop, and a bad
  explicit base (`origin/main` included), which never gets the fetch hint.
- A CDK test pins the stack deploy order from the cloud assembly (`lib/app-baseline.test.ts`): templates do not carry
  it, so the baseline hashes alone would not catch a dropped stack dependency.

### Changed
- [Branches and PRs](.kiro/steering/changelog.md) reads in execution order (check what you publish, then push), and
  scopes the admin merge to standing in for the second approval, never for a red or missing CI run. A CHANGELOG
  conflict renumbers only your own unmerged section.

## [5.48.03] - 2026-10-29

Contributing starts from `main`: one branch per release, merged by pull request.

### Changed
- [CONTRIBUTING.md](CONTRIBUTING.md#quality-gates), the steering files and [deployment](docs/deployment.md) describe the
  flow without an integration branch: cut a release (or topic) branch from `origin/main`, bump once, run the full
  `scripts/validate.sh` once, push and open a PR, squash-merge when CI is green. Before the first push, check that the
  branch holds only your new commits.
- `scripts/validate-affected.sh` compares against `origin/main` by default (it named a branch that no longer exists);
  the mutation tooling's default base (`MUT_BASE`) is `origin/main` too.

## [5.48.02] - 2026-10-29

Follow-ups from the 5.48 review: the design-reference archive's list permission is pinned, SVG download links have
their own schema, and the CodeQL script no longer depends on a bash quirk.

### Fixed
- The dev mock's feedback boards hide `created_by` from non-admins, like the API (`board_view`) and
  [feedback boards](docs/feature-requests.md) say; only `paused_by` was hidden.
- `npm run validate:codeql` calls the summary with or without `--strict` directly instead of expanding an optional
  flag array, so the 5.48.01 macOS bash failure cannot come back by dropping a guard.

### Changed
- The SVG copies of a design reference's logo and icons (download links) are read through their own `downloadHref`
  schema, which takes the same safe shapes as an image source (https, the dev server, a same-origin path) and never
  `data:`, `javascript:` or a protocol-relative link; a test pins both sinks.
- [Company context](docs/company-context.md) states that archiving a reference lists its icon folder through the
  `s3:List*` on the bucket ARN that the `company-context/*` read grant includes; a CDK test pins that grant.

## [5.48.01] - 2026-10-29

A transient DNS failure no longer refuses a public URL.

### Fixed
- The outbound URL check (design references, scrapers, analyze-url, the web scraper and every SSRF-guarded fetch)
  retries a DNS lookup that failed for a transient reason (`EAI_AGAIN`, or a resolver error such as
  "Device or resource busy" on a cold start) twice, after a short wait, before it refuses the URL with
  "URL validation failed". A name that does not exist is still refused at once, and every address of the lookup that
  succeeds is still checked.
- `npm run validate:codeql` no longer stops with "strict[@]: unbound variable" under the macOS bash when strict
  mode is off.

## [5.48.00] - 2026-10-29

Feedback boards can be paused, design references keep local copies of their logo SVG and icons, and the website
capture's model call reads three screenshots.

### Added
- **Pause a feedback board** (the board card, and Administration → Privacy & access → Boards). A paused board stays
  visible to its audience, who can still sign in and read it, but nobody can post a request, add or change a +1 or
  edit until an admin resumes it; such writes answer 409 `board_paused`. Admins can still change statuses, delete
  requests or +1s, and promote. The board shows "Paused: new requests and votes are closed for now".
  `PUT /feature-requests/boards/{board}` accepts `paused`, and every board answer carries it.
  See [feedback boards](docs/feature-requests.md).
- **Design references keep local copies of their icons**: a website reference copies the page's favicons, touch icons,
  manifest icons and `og:image` (when it is the logo) into the private bucket: at most 12 files, type checked by their
  bytes, duplicates kept once. They show as thumbnails in the reference preview. See
  [company context](docs/company-context.md).
- **A logo drawn from an SVG keeps its sanitised SVG** (website header, inline `<svg>`, GitHub repository), offered as
  **Download SVG**. It is served as a download only and never shown inside the page.

### Changed
- **Archiving a board is the step before deleting it**: Delete is offered only on an archived board, and the archive
  confirm says the board leaves its audience's view. Restore stays available. The API is unchanged
  (`DELETE …?with_requests=true` still archives first).
- **The website capture reads three screenshots in its one model call**: above the fold, the header and the footer,
  each sized so the model does not shrink it (PNG, or JPEG when large). About 2,700 image tokens per capture instead
  of about 1,600.
- The SVG sanitiser applies the file's own simple `<style>` rules before dropping the sheet, so logos exported from
  drawing tools keep their colours.
- A reference's extracted guidelines no longer embed remote images (links stay); fonts are kept as family names only,
  never as files.
- The e2e suite deletes its saved sessions when its cleanup ends (`E2E_KEEP_AUTH=1` keeps them), and the working-tree
  secret scan skips `.auth/` like the other git-ignored folders.

### Fixed
- `PUT /feature-requests/{id}` refuses a body that names `board` or `board_id` (400) instead of ignoring it: a request
  never moves to another board.
- `board_archived` and `board_paused` refusals show a translated sentence instead of the code.
- Archiving a design reference also deletes its SVG copy and its copied icons.

### Upgrade notes
- IAM: the design capture role may write `company-context/design/icons_*`, and the settings role's archive delete
  also covers `company-context/design/icons_*`. Deploy VocIngestionStack and VocApiStack.
- Existing design references get their icons and SVG copy on their next **Fetch again**. Boards stored before this
  release read as not paused; nothing to migrate.

## [5.47.04] - 2026-10-29

AWS Lambda Powertools is pinned, so every deploy and CI run uses the same version.

### Changed
- `aws-lambda-powertools` is pinned to `3.38.0` in the ingestion and processing layers and in
  `requirements-dev.txt` (it was an open range). 3.38.0 adds `Vary: Origin` to API answers that echo an allowed
  origin, CORS preflights included, so browsers and caches keep answers for different origins apart. Two tests now
  expect that header.

### Upgrade notes
- Rebuild the Lambda layers (`./scripts/build-layers.sh`) before the next deploy so they carry the pinned version.

## [5.47.03] - 2026-10-29

The code-audit gate gives the same answer locally and in CI.

### Fixed
- `audit: py_doc_refs` failed in CI with a stale allowlist entry for `PYTHONOPTIMIZE`: whether that name counts as a
  known token depends on the Python installation, so one comment in `lambda/api/projects_handler.py` now names the
  environment variable in plain prose and the allowlist entry is gone. See [code audit](docs/code-audit.md).

## [5.47.02] - 2026-10-29

Docs and test data use fictional names only.

### Fixed
- [docs/mobile-app-reviews.md](docs/mobile-app-reviews.md): the Android collection and output examples use the
  fictional `com.example.air` / `example_air` app instead of a real brand; the 5.11.00 Changed entry about
  source labels names "Example Air (iOS)".
- The bug report template's example URL uses the documentation placeholder `d111111abcdef8.cloudfront.net`
  instead of a deployment's CloudFront domain.

## [5.47.01] - 2026-10-29

Dependency patch releases, matching the bumps already merged into `main`.

### Changed
- CDK app (`voc-datalake/`): zod 4.6.5 → 4.6.7 and fast-uri 3.1.8 → 3.1.9.
- Frontend (`voc-datalake/frontend/`): vite 7.3.6 → 7.3.7, source-map-js 1.2.1 → 1.2.2 and brace-expansion
  1.1.18 / 2.1.4 / 5.0.9 → 1.1.21 / 2.1.7 / 5.0.12 (build and dev tooling only).

## [5.47.00] - 2026-10-29

Pages open on the last 14 days by import date, Radar brands take search and exclude terms, and large imports
no longer stall counts or the aggregator.

### Added
- **Radar search terms and exclude terms**: each Radar brand can list up to 8 search terms (a legal name, product
  names) added to its general news queries, and up to 8 exclude terms that drop a result about something else
  before any model call. Edit them in the Radar brand editor or with the assistant. See
  [Search terms](docs/radar.md#search-terms).
- `GET /scrapers/connectors` lists app connectors and Web Reviews pages with the Radar brand each one feeds, and the
  assistant's `list_scrapers` now includes them. See [scrapers](docs/scrapers.md).
- The header period selector has a **Last 14 days** choice.

### Changed
- **The default period is the last 14 days by imported date** (was 7 days). A browser still on the old default
  (7 days, imported date) moves to the new one once; any other saved choice is kept.
  See [account vs admin](docs/account-vs-admin.md).
- A many-app App Store or Google Play run continues in parts: each part stops with time to spare and starts the
  next, so "Run all" no longer stops at the 15-minute Lambda limit. See [mobile app reviews](docs/mobile-app-reviews.md).
- Expected refusals are logged as information instead of warnings: a permission refusal (403) and an assist job
  that ended with a user-facing refusal. Administration → System → Logs no longer lists 409 and 410 answers from
  the API access log (401, 403 and 404 were already hidden).
- API Gateway: related routes are folded into proxy resources (`/feedback`, `/scrapers/manual`, `/data-explorer`,
  `/integrations`, `/sources`, `/connect`, `/chat`), and a CORS preflight exists only where a browser method
  does. Every path keeps its method, Lambda and authorizer. The unused `/metrics/release-watch` resource is gone.

### Fixed
- Radar: a news listing page (a home page, a section, a category or date archive, or a page cited by two or more
  records) no longer merges two different stories. See [radar](docs/radar.md).
- Radar → All brands: the release total is exact; it stopped at 100.
- Dashboard and Categories counts read up to 100,000 rows per request (was 5,000) with the review-date basis or a
  source, channel, dimension or tag filter. When the cap still cuts a day, the answer says so
  (`partial_reason: 'row_cap'`) and the UI names the last day read. See [categories](docs/categories.md).
- Bulk imports: the aggregator writes a run of new reviews in a few joint transactions instead of one per review,
  so a large import no longer retries on the contended daily counters.
- Deleting a design reference also deletes its logo preview image.
- Design references: a website's inline `<svg>` logo and a GitHub repository's SVG logo are sanitised and drawn as
  the logo preview. See [company context](docs/company-context.md).

### Upgrade notes
- IAM changes: the App Store and Google Play ingestor roles may invoke their own function (to start the next part),
  and the settings role may delete `company-context/design/logo_preview_*` objects in the raw bucket.
- VocApiStack replaces many API resources (424 → 353). Deploy with `npm run deploy:infra` (or follow a bare
  `cdk deploy` with `scripts/refresh-api-stage.sh`) so the stage stops serving the removed methods.

## [5.46.01] - 2026-10-29

System errors stops listing two designed outcomes as errors, and failure queues show a message's real age.

### Fixed
- Administration → System → Logs → System errors:
  - a workflow run that a person cancelled (`ExecutionAborted`, e.g. "Cancelled by an admin") is a warning,
    listed under "Errors and warnings" only;
  - a refused board sign-up (`SignUpRefusedError: domain_not_allowed`, the sign-up trigger refusing an address it
    must refuse) is a warning; any other error of that function stays an error.
- Failure queues: a message's age is now the larger of CloudWatch's age and its own send time. Once a message has
  been read three times, CloudWatch's age points at the second-oldest message, so a three-day-old dead letter read
  "1 hour". The peek also waits up to 1 s, so a queue holding a single message shows it reliably.

## [5.46.00] - 2026-10-29

Problems follows the header like every other page, and the project assistant takes @persona, @all and #document.

### Added
- **@persona, @all and #document in the project assistant**: on a project page, type `@` to ask one of the
  project's personas (or `@all`) and `#` to tag a document (title and version, newest first), e.g.
  "@all please review #PR/FAQ (v2)". Each persona answers as its own card, grounded on the tagged documents and
  its profile, review only; then the assistant adds a short synthesis. Up to 6 personas and 3 documents per
  message; keyboard and screen-reader friendly, with `@` and `#` buttons on phones. Works in every way of
  working. See [mentions](docs/assistant-mentions.md).
- `consult_personas` (the assistant's persona tool) can read up to 3 documents.

### Changed
- **Problem Analysis follows the header's period and date basis**, like every other page. The "Latest 2,000
  reviews" window of 5.45.00 is gone (an old link opens on the header's period). The review-type chips stay,
  defaulting to Problems only.

### Removed
- `latest=N` on `GET /feedback/problems` (ignored if still sent).

### Fixed
- Persona answers in the assistant no longer disappear after a reload: a long answer used to be cut into invalid
  JSON when the conversation was saved.
- Problem Analysis reads a 30,000-review import day in full (measured, see
  [capacity](docs/problem-analysis.md#capacity)); the docs now state the real cap of 1,000 listed problems
  (counts are never capped).

### Upgrade notes
- Nothing to deploy differently; no infrastructure change.

## [5.45.01] - 2026-10-29

The 5.45.00 API stack deploys: the review links' rate limit is set per HTTP method.

### Fixed
- Deploying 5.45.00 failed on the API stage (`'~1review~1{proxy+}/*' is not a valid method path`) and VocApiStack
  rolled back: API Gateway takes no "all methods" throttle for one path. The `/review` routes are now throttled per
  method they serve (GET and POST), with the same limits.

### Upgrade notes
- Deploy 5.45.01 instead of 5.45.00. A stack that tried 5.45.00 rolled back cleanly; VocCoreStack's 5.45.00 changes
  (the image-model agreement) are already in place and stay.

## [5.45.00] - 2026-10-29

Ways of working with AI per person, PR/FAQ and PRD review with margin comments and share links, review types and a
"latest 2,000 reviews" Problems view, and the image model's access and quota in Administration → AI models.

### Added
- **Ways of working with AI** (Administration → Privacy & access → Users): each person is **Human-driven** (the AI
  answers questions, explains the method and reviews, but never writes their PR/FAQ or PRD), **AI-assisted** (the
  AI drafts, suggests and rewrites with them) or **AI-driven** (also autonomous agents and approved plans write
  for them). Everyone starts AI-driven; an administrator moves people. Inside Human-driven, "PR/FAQ with AI" and
  "PRD with AI" can be unlocked per person once they have learned. Enforced by the server on every AI write path
  (editor buttons, assistant, plans, agents, MCP); a Human-driven person's assistant coaches instead of writing, and
  the editor offers **Coach me** and **Review my draft**. See [ways of working](docs/ways-of-working.md).
- **Write a PR/FAQ or PRD by hand**: **Start writing** opens a blank template, in every mode.
- **Comments on PR/FAQs and PRDs**: select text and comment; threads sit in the margin (a list on phones) with
  replies, resolve and reopen, kept across versions (shown as "not found in this version" when the text is gone).
- **Ask personas to review**: up to 6 of the project's personas read the document and leave a verdict and comments
  on the exact passages they quote; it never edits the document and works in every mode.
- **Share for review**: a link per document with a Copy button, open to anyone with a verified email or to listed
  domains and addresses, expiring after 7, 30 (default) or 90 days and revocable. Reviewers sign in with an emailed
  code on `/review/<link>`, read the newest version and comment; they see only their own threads. See
  [document review](docs/document-review.md).
- **Review types**: every review gets one type — bug, service failure, feature request, usability, performance,
  pricing and billing, support experience, praise, question or other — in the same model call that already
  categorises it (the built-in `feedback_type` dimension, [dimensions](docs/dimensions.md)). Stored reviews are typed
  by **Classify review types for existing reviews** in Administration → Taxonomy → Dimensions (one model call per
  review; it never starts by itself).
- **Problems**: opens on **Latest 2,000 reviews (by review date)**, the newest reviews customers wrote whatever
  their import date, with the time range still one click away; review-type chips default to **Problems only**
  (praise, questions, feature requests and other are hidden until turned on; untyped reviews stay in view). See
  [problem analysis](docs/problem-analysis.md).
- **Administration → AI models → Image generation (persona avatars)**: the image model, its region, whether this
  account has access (with how to fix it), its requests-per-minute quota and a **Test** button (one small image,
  a few cents; not part of "Test all").

### Changed
- Every deployment now requests access to the persona-avatar image model (the Stability agreement and Marketplace
  subscription, in us-west-2), like the Claude models, with no flag. A refusal never fails the deploy; the AI models
  row shows the state.
- Feedback boards and review links share one sign-in pool, now on every deployment: with `-c emailFrom` codes come
  from your address as before; without it Cognito sends them from `no-reply@verificationemail.com`.

### Fixed
- Problems, Dashboard and every review-date view no longer show 0 reviews when reviews were written before the
  first import: the review-date cutoff is the period you chose (none for All time), not the days since the first
  import.

### Security
- A new board or review sign-up must enter the emailed confirmation code before the account exists. Before, the
  sign-up trigger confirmed any admitted address, so someone could register an address they did not own.

### Upgrade notes
- **VocCoreStack** gains the image-model agreement (custom resource + provider) and, on deployments without
  `-c emailFrom`, the board user pool, its client and its two triggers. With `-c emailFrom` the existing pool is
  updated in place (same logical ids), never replaced.
- **VocApiStack** goes to 424 resources with every plugin (gate 425): the board authorizer is on every deployment
  and `/review` routes are added (rate-limited like the other public routes, see `api-gateway.ts`).
- Without `-c emailFrom`, Cognito's own sender allows 50 emails a day per account; set `-c emailFrom` to lift it.
- Nothing to migrate. Everyone stays AI-driven until an administrator changes them. Reviews stored before this
  release are untyped until an administrator runs the classification.

## [5.44.01] - 2026-10-28

System errors shows the HTTP status of failed API calls and leaves out the test suite's own errors.

### Fixed
- Administration → System → Logs → System errors: a failed API call row shows its status code
  (`POST /scrapers/{proxy+} → 403 …`) instead of `→ <n>`, and a 403 and a 500 on the same route are separate rows.
- Lines written while an end-to-end test run was being served (`test_run` set) are no longer listed, as test
  traffic was already left out of the API rows.

## [5.44.00] - 2026-10-28

Administration → System → Logs now carries what a developer needs to diagnose a failure without AWS access:
every failing API call and workflow, the whole log of a failing request, the failure queues and the deployment's
setup — and source runs and persona avatars say why they failed.

### Added
- **System errors** also lists failed API calls (the API Gateway access log: 5xx as `HTTP`, other 4xx as warnings,
  test traffic left out), failed, timed-out and aborted workflow runs (Step Functions: agent runs, research,
  document workflows) and the Core stack's own functions (product-doc extractor, Cognito triggers, admin
  bootstrap, CDN signing keys). Each row says where it came from; samples keep up to 6,000 characters, so full
  stack traces fit.
- **Show the whole request** (an expanded row): every log line of that one invocation, any level, oldest first —
  usually what the function was doing before it failed (`GET /logs/system/request`).
- **Failure queues** card: every dead-letter / failure queue holding work that failed every retry, with its
  count, the age of its oldest message and up to three masked message bodies. Reading a sample removes nothing
  (`GET /logs/system/queues`).
- **Environment** block: version and commit, region, the account's last four digits, enabled sources, web search,
  inference scope, the image model and its region, the model per AI surface, alarms and their state, sources
  paused by their circuit breaker, and which logs the search covers (`GET /logs/system/environment`).
- **Download** now carries all of it — the groups, every request opened, the queues, the environment, the
  period's validation failures and processing errors — with a short guide to reading the file. See
  [deployment](docs/deployment.md#system-errors-administration--system--logs--system-errors).

### Changed
- App Store / Google Play connectors: each app now runs on its own **Run frequency** and **sort order** (a
  "Manual only" app is no longer scraped hourly by the schedule); a connector without its own value keeps the
  plugin's. A storefront that answers an error now logs a warning naming the cause (for example `HTTP 403 x2
  (gb, kr)`), an app that suddenly gets no reviews from any storefront logs a warning, and a manual run lists
  these in its run's errors instead of completing silently with 0 reviews
  ([mobile app reviews](docs/mobile-app-reviews.md)).
- Persona avatars: a failure now says why — not enabled for this account (Marketplace/model access), model not
  found, throttled, filtered, invalid request, region unreachable — with the image model id, its region and the
  AWS error code, both in one System errors line and in the Regenerate avatar job's error
  ([project workspace](docs/project-workspace.md)).

### Upgrade notes
- The logs API (`voc-logs-api`) gains read-only access to the deployment's Step Functions logs, the API access
  log and the Core stack's function logs (Logs Insights), and may **peek** at the failure queues
  (`sqs:ReceiveMessage` with a zero visibility timeout plus `kms:Decrypt` through SQS only — nothing is deleted;
  each peek raises a message's receive count, which these queues never act on) and read
  `ApproximateAgeOfOldestMessage`. Logs Insights bills each search per GB scanned (USD 0.005/GB), only when an
  admin opens or refreshes the tab.
- App Store / Google Play: apps whose connector says "Manual only" stop being scraped on the schedule after this
  release. Set a frequency on the connector to keep them scheduled. A new per-app watermark
  (`<app>_last_count`) starts empty, so the first run after the upgrade never warns about a drop.

## [5.43.01] - 2026-10-28

System errors also lists the AI assistant's warnings, and groups repeats of one failure into one row.

### Fixed
- Administration → System → Logs → System errors, "Errors and warnings": warnings and fatal errors from the AI
  assistant's streaming function (`level` `WARN` / `FATAL`) are now listed too; only the Python functions'
  `WARNING` / `CRITICAL` were before.
- A failure that names an id joined with `_` (for example `job=job_80cbfb058cf7408f`) now counts into one row
  instead of one row per job.

## [5.43.00] - 2026-10-28

Administration → System → Logs shows every error this deployment's functions log, so a failure can be
diagnosed from the app without AWS account access.

### Added
- **System errors tab** (Administration → System → Logs, now the first tab): every ERROR / CRITICAL log line and
  every platform crash (timeouts, runtime errors) of the deployment's Lambdas over the last 24 hours, 7 or 30 days,
  optionally with warnings, grouped by function and message with a count, first and last seen, and the newest
  occurrence's full text and request id. A persona avatar that fails, a source run that cannot reach a store, an
  assist job that dies all show up here with the real exception. Personal data is masked before anything leaves
  the server. **Download** saves the shown list as a JSON file to hand to whoever analyses it. Admin-only
  (`GET /logs/system`, never cached) — see [deployment](docs/deployment.md#system-errors-administration--system--logs--system-errors).

### Upgrade notes
- The logs API (`voc-logs-api`) gains read-only CloudWatch Logs Insights permissions on the deployment's own
  Lambda log groups (`logs:DescribeLogGroups`, `logs:StartQuery`, `logs:GetQueryResults`, `logs:StopQuery`). Each
  search is billed by CloudWatch Logs Insights per GB scanned (USD 0.005/GB; a 7-day search of a busy test
  deployment scans about 0.5 GB) — only when an admin opens or refreshes the tab. Nothing to migrate.
## [5.42.01] - 2026-10-27

Radar finds a brand's older news again, and stops filing the same story twice.

### Fixed

- A Radar brand scanned earlier the same day (or recently) searched only for news published since that scan, so its
  feed items and older news were dropped and every item it filed was dated the scan day. Each search (query type and
  language, the own-domain search, Exa) now looks back to the day THAT search last ran, never more than 90 days, and
  feeds are always read over the last 90 days.
- The same story from two sources (for example the brand's feed and Exa) worded differently was filed twice. A news
  item citing a page another item already cites is now merged into it.

### Upgrade notes

- The next scan of each brand looks back the full 90 days once (items it finds again are merged, not duplicated).

## [5.42.00] - 2026-10-27

Radar tracks every competitor's news, not only its releases.

### Added

- **News for every Radar brand**: launches, new features, promotions, partnerships, announcements and company news,
  also when they are published outside the brand's own site. The scan searches in each brand's own language and in
  English, rotating through the kinds of query across scans within the same query cap.
- **Search language per brand** (Administration → Sources → Radar → Edit): Auto takes it from the brand's first
  domain (`.pl` → Polish, `.cz` → Czech, …), or pick one of 16 languages.
- **News feeds per brand** (up to 3 RSS or Atom feeds): read at each scan through the outbound URL guard; their dated
  items are filed with the item's own article as the citation.
- **Exa as a second search index** (Administration → Sources → Radar → "Exa"): an admin stores an Exa API key; when
  Radar's web search finds no dated news for a brand, Exa searches the brand's domains and the web too. The key is
  kept in SSM Parameter Store (no monthly cost) and never shown again; only brand names, search terms and domains are
  sent to Exa (about $5 per 1,000 searches, billed by Exa). API: `PUT` / `DELETE /radar/settings/exa-key`.
- **News and releases** on the Radar page: each item shows its kind (Release, Announcement, Promotion, Partnership,
  Company news), a filter by kind, and "via Exa" / "via feed" when only those found it. The All brands table shows
  the latest news with its kind.
- The AI assistant reads the news kinds, and `save_radar_brands` can set a brand's language and feeds.

### Changed

- The own-domain search no longer filters by publish date (the brand's undated pages are dated from the page, and
  anything older than the window is not filed). The scan no longer runs the "<brand> vs <our brand>" query.
- News items carry `kind` and `found_via` in every Radar API view; items found before this release read as
  `release` / `web`. See [docs/radar.md](docs/radar.md).

### Upgrade notes

- No migration. The scan makes up to 5 model calls per brand (one per step that finds something). Exa stays off until
  an admin stores a key.

## [5.41.00] - 2026-10-27

Radar can show every brand at once.

### Added

- **All brands** on the Radar page (`/radar`, brand selector, shown once two or more brands are tracked; shareable as
  `?brand=all`): a table of every brand over the chosen window (reviews, sentiment in words with the positive / negative
  share, releases in the window, the latest release) and one "Latest news across brands" feed, newest first, each item
  naming its brand. A brand's name in the table, or its chip in the feed, opens that brand. The feed shows the newest
  100 and says how many there were. API: `GET /radar/all?days=` (see [docs/radar.md](docs/radar.md)).

### Changed

- A Radar brand can no longer be named "All" (its key would clash with the All brands view): saving such a brand list
  answers 400 with the reason.

### Upgrade notes

- No migration. A deployment that already tracks a brand whose key is `all` keeps it, but cannot save the list again
  until that brand is renamed.

## [5.40.00] - 2026-10-27

Scan for a brand's news from the Radar page, and ask the assistant to do it.

### Added

- **Scan now on the Radar page** (admins, once a brand is tracked): under the page header, with the last scan's
  result and a line saying what it does: it searches the web and each brand's own domains for its releases and news
  now, without waiting for the schedule (a few minutes; it uses web searches). The same control stays in
  Administration → Sources → Radar.

### Changed

- The AI assistant now starts the scan when asked to "scan now", "look for news", "refresh Radar" or "what did
  <brand> ship" (one approval card, `run_radar_scan`), instead of saying it cannot. On pages other than Radar and Data
  sources it offers to open the Radar page, where the scan is available. See [docs/radar.md](docs/radar.md).

## [5.39.03] - 2026-10-27

The assistant can confirm which Radar brand a scraper feeds.

### Fixed

- Asked whether Radar sources are linked, the AI assistant no longer reads the empty source list of the tracked brands
  (Radar without a brand) as "not linked": that list gets the same `profile_sources` name and note as the brand list
  (5.39.02 covered only the brand list).
- The assistant's scraper list now includes each scraper's `radar_brand`, so it can confirm which Radar brand a scraper
  feeds instead of guessing.

## [5.39.02] - 2026-10-27

The assistant checks a Radar import correctly.

### Fixed

- After setting up Radar sources, the AI assistant no longer tells you the new connectors are "not linked yet" because
  a brand's sources list is empty. That list (`GET /radar/brands` → `sources`) only ever holds older source profiles;
  scrapers, review pages and app connectors set to a Radar brand never appear in it. The assistant now reads it as
  `profile_sources` with a note saying so, and checks an import through the run's status and each brand's review total
  on Radar. See [docs/radar.md](docs/radar.md).

## [5.39.01] - 2026-10-27

The website capture picks the site's own logo, not a cookie banner's.

### Fixed

- A website reference whose cookie-consent banner sits before the header in the page's markup (common with consent
  plugins) no longer gets the banner's vendor image as its logo. Logo images inside a cookie / consent banner and
  hidden images are skipped, and an image inside the page's header or navigation is preferred over one further down.
  Refresh the reference to read its logo again.

## [5.39.00] - 2026-10-27

SVG logos work: a website whose logo is an SVG gets its logo, and an SVG file can be uploaded as the company logo.

### Added

- Company → Design system → logo upload accepts an `.svg` file. The browser converts it to a PNG (longest side
  1,024 px, transparent background) and only the PNG is uploaded. An SVG the browser cannot convert (for example
  one with embedded HTML) says so and asks for a PNG export instead.
- A website reference whose logo is an SVG (`<img src="….svg">` in the header) now gets that logo: the secure browser
  that reads the site draws it in a separate blank tab and keeps only a PNG screenshot of it. Its preview says
  "Rendered from the site's SVG logo", and "Use this logo" copies that PNG. A header PNG, JPEG or WebP is still
  preferred when the site has one. See [docs/company-context.md](docs/company-context.md).

### Fixed

- A website whose header logo is an SVG no longer gets its favicon or touch icon proposed as its logo.

### Security

- SVG bytes are still never downloaded, stored or served by the API (an SVG is a document that can carry script):
  both paths turn the SVG into a PNG in a browser, and the logo routes keep accepting only PNG, JPEG and WebP.

### Upgrade notes

- Refresh an existing website reference to read its SVG logo. Inline `<svg>` logos (drawn in the page's markup, not
  an image file) and GitHub references' SVG logos are not read yet.

## [5.38.01] - 2026-10-26

Agent guidance for the test traffic tag.

### Changed

- The project's agent steering (`.kiro/steering/testing.md` → "Production E2E Traffic and Log Sweeps", and the
  deployment checklist in `coding-standards.md`) now explains the `voc-e2e/<run tag>` tag: how the suite sends it,
  the Logs Insights filters that leave test traffic out of an error sweep, tagging hand-made probes, and that a new
  API Lambda entry point must apply the tag.

## [5.38.00] - 2026-10-26

Test traffic is tagged, so log checks can leave it out.

### Added

- Every request the end-to-end suite sends carries the User-Agent token `voc-e2e/<run tag>` (one tag per run;
  `run-sharded.sh` shares it across shards, override with `E2E_TAG_RUN_ID`). API Lambda log lines of such a
  request carry `test_run`, so a Logs Insights query drops them with `filter ispresent(test_run) = 0`. See
  `frontend/e2e/README.md` → "Test traffic tag".

### Changed

- The API stage access log keeps every field it had and adds `path` (the real path, ids included), `userAgent`,
  `integrationStatus` and `errorMessage`, so a 4xx or 5xx can be traced to the exact request and told apart from
  test traffic.

### Fixed

- The end-to-end job follower no longer keeps polling a job whose project is gone (404 / 410): it stops at the first
  such answer instead of logging a 404 every 5 seconds until its timeout.

### Upgrade notes

- Log lines written before this release have no `userAgent` / `test_run`, so they cannot be told apart from real
  traffic; access and Lambda logs keep 14 days. Queries that parse the access log by key keep working.

## [5.37.00] - 2026-10-26

A feedback board can be deleted together with its requests.

### Added

- Delete a board that still has requests, from its card on Feedback boards or from Administration → Privacy &
  access → Boards → the board editor. The confirm says the board, its requests and every +1 on them are deleted
  for good, and Delete works only once the board's name is typed. Large boards are deleted in steps: the dialog
  shows how many requests are gone, and if it stops, pressing Delete again continues. The board is archived as
  soon as deletion starts, so nobody but admins can post to it meanwhile. Projects already created from its
  requests are kept. API: `DELETE /feature-requests/boards/{id}?with_requests=true`, repeated until it answers
  `done: true` (see [docs/feature-requests.md](docs/feature-requests.md)). An empty board is still deleted with
  one plain confirm.

### Fixed

- Deleting the last remaining board no longer brings "Sales feature requests" straight back: that board is now
  created only once, on a deployment's first use of boards.
- A board whose requests are older than the newest 1,000 requests across all boards no longer looks empty: its
  request list, the delete check and the status-in-use check now read that board's own requests.

### Upgrade notes

- No migration. With no board left, the board pages show their empty state and board-pool sign-up is closed
  until an admin creates a board.

## [5.36.04] - 2026-10-26

The app loads again on the 5.36.x builds.

### Fixed

- The 5.36.01, 5.36.02 and 5.36.03 frontends showed a blank page for everyone ("Cannot access … before
  initialization" in the console): two board modules imported each other, and the production bundle evaluated one
  of them before the other was ready. The shared email check now lives in its own module. While the fix was
  prepared, the live frontend ran the 5.36.00 build; the backend stayed on 5.36.03.
- A frontend test now fails when production source under `frontend/src/` has a runtime import cycle (type-only
  imports are ignored), so a bundle that cannot start is caught before it ships.

### Upgrade notes

- Frontend only; no backend change since 5.36.03. A deployment running 5.36.01–5.36.03 should deploy this release.

## [5.36.03] - 2026-10-26

A tab opened before a deploy recovers by itself.

### Fixed

- A browser tab still running the previous build no longer breaks when it opens a lazily loaded part of the app
  after a deploy (for example Administration → System → Version showed no changelog, with "Failed to load module
  script … MIME type text/html" in the console): each deploy replaces the hashed files in `/assets/`, and the
  missing chunk was answered with the app's `index.html`. The app now reloads once when a chunk fails to load, which
  fetches the current build; a second failure of the same build is left to the page's own error state, so a real
  outage cannot loop.

## [5.36.02] - 2026-10-26

The website upload of a CDK deploy no longer runs out of memory.

### Fixed

- VocApiStack's SPA upload (`DeployWebsite`, CDK's BucketDeployment provider) now runs with 1024 MB instead of the
  128 MB default. At 128 MB `aws s3 sync` of the ~7 MB SPA used all of its memory, crawled at ~35 KiB/s and timed out
  after 15 minutes; CloudFormation's retry then finished it, so a deploy took about 35 minutes longer than it should.

### Upgrade notes

- The BucketDeployment provider function is replaced by one with 1024 MB (CDK names the singleton by its memory);
  CloudFormation creates the new one and deletes the old in the same deploy. Pay-per-use only.

## [5.36.01] - 2026-10-26

Feedback boards fixes from the live check: sign-in returns to the shared board, one +1 per person, a description per template, and fresher admin lists.

### Fixed

- Feedback boards: a board share link (`/board/<slug>`) opened signed out now returns to that board when the
  person signs in with the EMAILED link, not only with the typed code (the slug is remembered in the same browser
  with the pending sign-in) — [docs/feature-requests.md](docs/feature-requests.md#sign-in-a-separate-user-pool).
- Administration → Privacy & access → Boards: deleting a board from its editor goes back to the list without
  asking for the deleted board again (it answered 404 and logged a console error).
- Administration → Privacy & access → Boards: after a board is saved (its audience, name, template fields…), the
  board list and the Feedback boards page show the saved board at once instead of the old one until the list
  had refetched; a deleted board leaves the list at once too.
- Feedback boards: one +1 per person per request. The reporter (whose +1 is filed with the request) and anyone
  who already supports a request see "Edit my +1" instead of "+1", and `POST /feature-requests/{id}/supports`
  answers 409 `already_supported` to a second +1 by the same email (it used to count twice as a support while
  supporters stayed 1). Requests that already carry such a duplicate keep it until someone removes it.
- Feedback boards: the request description follows the board's template. Its hint names what that board asks for
  (a service board no longer says "Describe what the customer needs."), and it is required on Sales feature
  requests and Customer service issues boards only; on Beta feedback and Blank boards it is optional ("Description
  (optional)"). The API enforces the same rule on `POST`/`PUT /feature-requests…` (it used to accept an empty
  description everywhere while the form required one everywhere) — [docs/feature-requests.md](docs/feature-requests.md).

### Upgrade notes

- API callers of the feedback boards: `POST /feature-requests` (and a `PUT` that sends `description`) on a
  `sales` or `service` board now answers 400 `description is required` for an empty description.

## [5.36.00] - 2026-10-26

Feedback boards: several shareable boards (Sales feature requests, Customer service issues, Beta feedback, Blank), each with its own audience, fields, statuses and link, configured in Administration → Privacy & access → Boards.

### Added

- **Feedback boards**: several boards instead of one company-wide feature-request board, each for a team or an
  audience. `/feature-requests` lists them as cards (template, audience, request count, Copy link to the share link,
  Open; admins also Edit and Delete, and a gear to the admin section); `/feature-requests/{slug}` is one board, with
  its own fields, statuses and totals (`?request=` deep links as before). The standalone `/board` lists the boards a
  board-pool user may use (one board opens directly) and `/board/{slug}` is one board; an old `/board?request=<id>`
  opens the request's board. See [docs/feature-requests.md](docs/feature-requests.md).
- **Templates**: Sales feature requests (customer, deal, revenue impact and amount; totals customers, committed and
  at-risk USD), Customer service issues (kind, severity, reference, steps, people affected; +1 = "also affected"),
  Beta feedback (area, outcome, rating, https link; average rating) and Blank. Fields come from a fixed catalogue and
  can be switched on, off or required per board; statuses (up to 8, the first is the initial one) can be renamed,
  reordered, added and removed. Everything a template sets stays editable.
- **Audiences** per board: `company` (the company domains), `list` (allowed domains and/or email addresses) or
  `anyone` (any address that verifies itself). A board someone may not use answers 404 on every board and request
  route. `anyone` boards are rate-limited: per poster per board 20 new requests and 100 +1s a UTC day, 500 new
  requests per board a day (429 `rate_limited`). No moderation: a signed-in post shows at once.
- **Administration → Privacy & access → Boards** (`/admin?tab=access&section=boards`, admin-only): the company
  domains, the list of boards with New board (pick a template), and a board editor (`&board=<id>`) for name, link
  name with share-link preview, description, audience, fields, statuses, Archive and Delete (only an empty board;
  archive one with requests).
- API: admin-only `POST/PUT/DELETE /feature-requests/boards[/{id}]`, `GET /feature-requests/boards[/{slug_or_id}]`
  for every user of a board, `GET /feature-requests?board=` and `POST /feature-requests {board, fields}` (both
  default to the seeded board, so older clients keep working); 409s `slug_taken`, `status_in_use`,
  `board_not_empty`, `board_archived`, `board_limit`.

### Changed

- The nav item "Feature requests" is now **Feedback boards** (LISTEN), in all 9 languages, with the same route
  `/feature-requests`; old links keep working.
- The company domains moved from the participant email card to Administration → Privacy & access → Boards (same
  setting). The participant email card keeps external people, the daily cap, the sender name and the
  email-configured line.
- Request status, fields and totals follow the request's board (a status is one of the board's keys). Promote moves
  a request to `planned` only on a board with that status.
- Board-pool users see only the boards whose audience admits their email, and the board pool's sign-up admits an
  email that ANY non-archived board would admit (read from a derived row `SETTINGS` / `board_audience` in the
  participants table that every board save rewrites).

### Upgrade notes

- The first board listing after the upgrade creates the board **Sales feature requests** (`brd_sales`, slug
  `sales-feature-requests`, audience `company`). Every existing request has no board and reads as this board's,
  with its statuses unchanged; no migration script runs.
- An `anyone` board lets ANY email address sign up to the board pool and post on that board (rate-limited, no
  moderation). Such an account still reaches only the board routes, and only the boards that admit it.
- VocCoreStack enables TTL (`ttl`) on the `voc-feature-requests` table, so the `anyone` boards' daily rate-limit rows
  expire. It is an in-place update of the same table (no replacement, no data change); the other items carry no
  `ttl` and never expire.

## [5.35.04] - 2026-10-26

e2e suite only.

### Fixed

- e2e `network.spec.ts`: the "connection cut mid-answer" check also accepts a tab that has already recovered the
  server's finished answer (a short answer replaces the "connection closed" alert before the check looked). Found in
  the 5.35.03 sharded production run (1,040 passed, this 1 failed).
- Frontend tests: the feature-request "closes a deleted request" case waits for the closed dialog instead of reading
  it once, so it no longer fails under a loaded test run.

## [5.35.03] - 2026-10-25

Fixes from the 5.35.02 live verification: agent PR/FAQs use the review evidence, clearer run results, assistant page context and Stop, votes, translated plugin names, accessibility, model capacity without waiting, and more faithful design-system extraction.

### Fixed

- Autonomous agents, PR/FAQ and PRD writing: the press release, both FAQs and the PRD document now read the run's
  evidence (the scope's review count and window, the problems with their counts, quotes from the cited reviews) and
  a revision's brief. They used to reach only the first, analysis, step, so an Internal FAQ built on 108 reviews
  said "I have no customer feedback from the last 30 days". The PR/FAQ templates ask for a neutral document voice
  and evidence-backed numbers, which also applies to PR/FAQs written from the project page
  ([docs/autonomous-agents.md](docs/autonomous-agents.md#what-the-steps-read-and-send)).
- Autonomous agents: a research report's title is cut on a whole word with "…" ("…baggage and unpaid… — 2026-10-25
  19:51 UTC"), not mid-word. The default research title from a question does the same.
- Agent Runs tab, "What it produced": each document is listed by its title and version (v1, v2, v3) and linked to it,
  and its project is named while the run is paused, even when the run created the project after the project list
  was loaded.
- Agent Runs tab: a run closed after it needed a human no longer shows "Needs a human: the workflow asks for a
  human." as an error. Closing removes the run's `error`, and `GET /agents/{id}/runs/{run_id}` answers `error: null`
  for runs closed before this release. The pause stays in the run's journal.
- e2e (`s2-agents`, `s3-personas-documents`): the run-follow and run-history steps open "Show technical log" before
  reading the event log and close a run that ends at needs_human through its decision card; the persona edit step
  finds the Personas-tab card by the persona's name.
- AI assistant: every message's page context now names the page it was sent from, so a conversation that moves from a filtered Categories page to Problem Analysis no longer reads the new page as contradicting, and retracting, an earlier answer.
- AI assistant: after **Stop** the tab no longer sends a save the server refuses (409); it waits for the server's `stopped` copy and saves its own only when the server has none.
- AI assistant: **Regenerate** shows on the last answer also when its turn ends on a tool call (an answer closing with a navigation suggestion had Copy but no Regenerate).
- Room votes: `POST /voting-sessions/{id}/submit` on a closed or expired vote whose row or project was deleted answers **410** `gone`, as `/config` does, instead of 409 `closed` ([prioritization](docs/prioritization.md)).
- Administration → Sources and Data sources: plugin names and descriptions are translated in all nine languages instead of the English manifest text ([plugin architecture](docs/plugin-architecture.md)).
- Accessibility: a memory's **+1** / **Still true** button is announced with the memory it confirms (every card's button had the same name), and each pasted review's date field names its review ("Date of review 2 (required)").
- Data Explorer: an avatar folder of an imported persona (or an older persona id) reads "Persona · <date>" instead of its raw `persona_…` id ([data lake structure](docs/data-lake-structure.md#data-explorer)).
- API: the shared DynamoDB client pools 32 connections, enough for one request's whole read fan-out; `voc-metrics-api` logged "Connection pool is full, discarding connection" under load at botocore's default of 10.
- Administration → AI models: `GET /settings/model/capacity` answers at once from the stored quotas (marked `stale` when older than an hour) and the `voc-settings-assist` worker re-reads Service Quotas in the background; a cold load took 5.2 s. Only a deployment's very first reading is read while the screen waits ([deployment](docs/deployment.md)).
- Design references (GitHub and live websites): the components read from a repository's CSS or measured in the
  page now win over the model's version of the same component (by name), so the stored design keeps what the
  model dropped or guessed. A GitHub repository's Badge keeps every tone (`info`, `aim` …, up to 8 variants per
  component), Input / Select keep their whole focus ring (outline, ring border colour, glow), a Switch keeps its
  width and its knob, and `shadow-sm` / `shadow-2xl` resolve to the repository's own `--shadow-*` tokens (Tailwind's
  default only when it defines none); `color-mix()` values are computed. Components gain an optional `width`
  and `focus.border_color` / `focus.shadow` ([docs/company-context.md](docs/company-context.md)).
- Design references from live websites: a page's filled buttons are kept one per background (a coloured
  call-to-action and a white nav button are two Button variants, not one), and a hover or focus colour comes only
  from a stylesheet rule whose selector matches that element; a model-guessed hover is dropped.
- Company → Design system: the save row's **Discard changes** now drops a logo drafted with "Use this logo" and
  the "Use as design system" banner too, like the banner's **Discard**; the saved logo shows again.
- Company → Design system → Components: the editor now keeps a component's width and its whole focus ring
  (border colour and glow, editable under "Hover and focus") and allows 8 variants like the server. Before, saving
  after "Use as design system" silently dropped them, and a Badge with 7 tones could not be saved at all.

## [5.35.02] - 2026-10-25

Fixes from the sharded production e2e run and the logs: persona saves when a project is deleted mid-generation, fast and throttle-safe model capacity, design references read component classes and theme variants, assistant-added participants keep their origin, and the e2e suite runs safely in parallel.

### Fixed

- Persona generation (`voc-job-persona-generator`): a project deleted while its personas are being generated now
  ends the job as "The project was deleted while its personas were being generated" (a terminal 404: no retry, no
  async-failure DLQ message, no ERROR) instead of a generic "Please try again" after every avatar was billed. The
  project is re-checked before the avatar batch, so no avatar is made for a deleted project, and avatars made just
  before the delete are removed. Each refused persona write logs its DynamoDB `cancellation_reasons`; a persona row
  that already exists (a redelivered job) is kept and the rest of the set is saved; a transient transaction conflict
  is retried. The project's `persona_count` is recounted from its personas, so it is right when an agent appends.
- Background jobs: a progress or status update for a job whose row no longer exists (its project was deleted, or
  it expired) is logged at INFO with the reason, not as an ERROR with a traceback.
- Administration → AI models: `GET /settings/model/capacity` answered in 14.5-15.9 s on first load (Service Quotas
  pages ~1,050 Bedrock quotas). The Anthropic token quotas and their codes are now stored in the aggregates table
  (`SETTINGS#model_quotas`), used for an hour, then re-read by quota code in parallel; the full listing (100 per
  page) runs only on first use or when a model joins the allowlist. Same response shape
  ([docs/deployment.md](docs/deployment.md)).
- Administration → AI models: under load Service Quotas answered `TooManyRequestsException` and every quota showed
  "Quota unknown". The Service Quotas client now retries adaptively, the by-code refresh runs at most three reads at
  a time, and a throttled refresh or listing answers with the stored reading marked `"stale": true` (shown as "Last
  stored reading"), retried after a minute.
- Design references: an `ftp://` (or any other non-https) link said "plain http:// pages are refused". The add form
  and the API's 400 now name the scheme that was typed ("ftp:// addresses are refused"), in all nine languages.
- Design references from GitHub: plain CSS component classes are now read (`.btn-secondary` / `-ghost` / `-danger`,
  `.input`, `.badge-*`, `.tab` / `.tab-active`, `.select`, `.switch`; `@apply` and plain declarations), the other
  themes (`[data-theme=light]`, `:root[data-mode=light]`, `.dark`, `prefers-color-scheme`) are kept as a "Theme
  variants" table in the reference's guidelines, Tailwind v4 `@theme inline` self-aliases no longer hide radii, and a
  stylesheet is parsed whole instead of its first 20,000 characters. An SVG-only logo is named in the guidelines
  with a request for a PNG / JPEG / WebP export; SVG stays refused
  ([docs/company-context.md](docs/company-context.md)).
- Participants added through the AI assistant (`add_participants` card) were stored with origin `manual`.
  `POST /participants/lists/{list_id}/members` now takes an optional `origin: 'assistant'` (only `manual` or
  `assistant`; anything else, `feature_request` included, is a 400) and the card sends it
  ([docs/participants.md](docs/participants.md)).
- e2e suite (sharded runs): a spec's own cleanup deletes only what that spec recorded. `s2-99` deleted the project
  `s3` was generating personas for (same shard ledger), which failed s3 steps 02-11; `s2-04` now confirms the
  "Start a run now?" dialog that Run now opens since 5.35.00.

### Upgrade notes

- The settings Lambda role gains the read-only `servicequotas:GetServiceQuota` on this account and region's
  `bedrock/*` quotas. Deploy `VocApiStack` (with the API stage refresh, `npm run deploy:api`).

## [5.35.01] - 2026-10-25

Design-system references (404s, duplicates, URL messages, logo into the draft, no centring-margin tokens), the MCP Bearer challenge, and the e2e suite updated to the current app with a 30-minute sharded run.

### Fixed

- Company → Design system: a website reference whose page answers 404 / 410 now fails with "The page was not found
  (HTTP 404); check the address", a 5xx with "The site answered with an error … try Fetch again later", and only a
  bot challenge or HTTP 401 / 403 / 429 with "The site blocked the secure browser" (before, every HTTP error read
  as a block). The `voc-design-capture` log now names the browser session id, the page host and a failure reason
  code with the HTTP status ([docs/company-context.md](docs/company-context.md)).
- Company → Design system: reading a live website no longer turns the page's centring margin into a spacing token
  (example.com gave "page-padding 203.25px" at the 1440 px viewport). Equal auto side margins and fractional px
  values the page never used are dropped from the extracted spacing.
- Company → Design system: adding a reference whose address is already a (non-archived) reference is refused
  with 409 naming it (`POST /settings/design-system/references`; case, default port, trailing slash and fragment
  are ignored; websites, GitHub and Figma alike) instead of starting a second paid browser session and model call.
  The add form says so while typing and offers **Fetch again** on the existing reference.
- Company → Design system: an address that cannot be added now says why beside the field (not https, not a web
  address, no site name, a user name or password, localhost) instead of only greying out **Add reference**.
- Company → Design system: **Use this logo** puts the logo into the unsaved draft, like **Use as design system**;
  it becomes the company logo only on **Save design system** (Discard keeps the old one). The route
  `POST /settings/design-system/references/{id}/logo` now answers `{logo_id, logo_url}` without saving, and
  `PUT /settings/design-system` takes `logo_id`. The "Replace the current logo?" dialog is gone.
- Company → Design system: archiving a link reference no longer says "The file is kept"; it says the link and what
  was read from it are kept.
- Global MCP (`POST /mcp/global`): a revoked, expired, unknown or forged token, or one whose minter is disabled, now
  gets `401` with `WWW-Authenticate: Bearer realm="voc-mcp-global", error="invalid_token"` and the JSON-RPC error
  (code `-32001`), so MCP clients see the Bearer challenge. Before, API Gateway renamed the handler's header to
  `x-amzn-Remapped-WWW-Authenticate`. The endpoint's token authorizer is now the global MCP function itself (the full
  credential check, never cached), and an `ACCESS_DENIED` gateway response turns its Deny into that 401; the inline
  Node shape-check authorizer `voc-mcp-token-authorizer` (function and log group) is removed, so VocApiStack has
  2 fewer resources ([docs/mcp.md](docs/mcp.md)).
- e2e suite: each run keeps its saved sessions under its own `$E2E_OUT/.auth` (`E2E_AUTH_DIR` overrides), so parallel
  shards no longer overwrite each other's login and land on `/login`. New `npm run e2e:prod:sharded -- <n>`
  (`e2e/scripts/run-sharded.sh`) runs the production suite in n parallel shards, each with its own output, run id,
  ledger and cleanup, and merges the reports; 6 shards take about 30 minutes ([e2e/README.md](voc-datalake/frontend/e2e/README.md)).
- e2e suite: specs follow the current screens again (project Edit / Delete in the card's actions menu, admin-only
  source tiles for e2e-user, the non-admin empty dashboard and two-step checklist, the six project tabs, connector
  runs in Admin logs, the "Generate personas now?" confirm, PR/FAQ wording, "Enable now" on a disabled form, the
  workflow name field, sharing by display name or email, analyze-url as an assist job, a typed objective title).
  The s3 avatar sweep reads the raw-data bucket from the VocCoreStack output when `E2E_RAW_BUCKET` is unset.

### Upgrade notes

- VocApiStack replaces the `/mcp/global` authorizer's function: CloudFormation deletes the
  `voc-mcp-token-authorizer-<account>-<region>` Lambda and its `/aws/lambda/voc-mcp-authorizer-…` log group, and
  adds an `ACCESS_DENIED` gateway response. Each `/mcp/global` request now invokes `voc-mcp-global-api` twice
  (authorizer, then handler). Run the API stage refresh after the deploy as usual (`scripts/refresh-api-stage.sh`).

## [5.35.00] - 2026-10-25

Fixes from a full live end-to-end test: autonomous agents (prompt leaking into PR/FAQs, review scope, project reuse, persona portraits), the assistant (Stop really stops, Regenerate, page filters), prioritization scores, decisions, and many smaller issues; the e2e suite now covers every screen and the 5.x features.

### Added

- Projects → Decisions: decisions can be deleted from the tab (Delete, after a confirm dialog; owners and editors
  only), through the existing `DELETE /projects/{id}/documents/{document_id}`
  ([docs/decisions-and-release-watch.md](docs/decisions-and-release-watch.md)).
- Workflow editor: a "Create a portrait for each persona" switch on Generate personas steps, and a "Length budget
  (words)" on Write PR/FAQ, Write PRD and Revise steps (`max_words`, 200–8,000)
  ([docs/autonomous-agents.md](docs/autonomous-agents.md#what-the-steps-read-and-send)).
- `POST /projects/{id}/document` takes `writer_context` (prompt-only context), `writer_instructions` (reach every
  writing step) and `length_budget_words`; `POST /projects/{id}/personas/generate` takes `keep_existing_personas`
  (add beside the existing personas instead of replacing them).
- AI assistant **Stop** now stops the answer on the server too (new route `POST /chat/conversations/{id}/cancel`,
  stored run status `stopped`): the run stops generating (no further Bedrock calls) within about 2 seconds, keeps
  the text so far, also the thinking when no text had appeared yet, and shows a **Stopped** marker, also after a
  reload. Before, the run went on in the background and a reload showed the full answer.
- e2e suite (`voc-datalake/frontend/e2e`): specs for the 5.00–5.34 features that had none — Participants (lists,
  people, project link, ask composer; an ask is sent only on the dev mock), the public unsubscribe page, the
  feature-request board and `/board` sign-in (a refused domain only; no code is ever requested), the Product tab's
  "Fill with AI assistant", workflow revision History, Radar (Scan now never pressed), project Decisions (create,
  edit, delete), every persona's avatar loading (project page and agent runs), and the Account / Administration /
  Company tabs, Home brief, review window and German Participants / Feature requests. `e2e/COVERAGE.md` maps every
  page, tab and flow to the spec that covers it, and names what is still missing and why. The existing specs follow
  the 5.x screens again, and the app has stable selector hooks for them (accessible names first, a few
  `data-testid`s; listed in `e2e/README.md`).

### Changed

- Autonomous agents reuse only projects they created themselves; any other project, however similar its name, gets
  a new project instead. Agent runs never remove a project's personas.
- Agent-generated personas get portraits by default, like the rest of the product (off with the step's switch, or
  for the whole deployment with `AVATARS_ENABLED=false`).
- The agents list polls while an agent's run is queued or running, so its status moves without a reload.
- Prioritization: an axis your saved ballot leaves unscored now starts on its own **Not scored** stop
  (shown as text and announced as "Not scored") instead of resting on 3, so choosing any value, 3
  included, counts as a score; **Clear** takes an unsaved choice back to Not scored
  ([docs/prioritization.md](docs/prioritization.md)).
- Prioritization: a row's team composite is now the scoring formula over the team's per-metric means,
  so every vote counts. Before, a partial ballot (for example the owner's, with one metric unscored)
  was left out of the headline as soon as any fully scored ballot existed, and the row read
  "2 reviewers" over the room ballot's number alone. Rows where every ballot is fully scored are
  unchanged.
- Room votes: `GET /voting-sessions/{id}/config` and `POST /voting-sessions/{id}/submit` answer
  **410** `reason: gone` for a session whose row or project was deleted (the ballot page says the
  proposal was deleted), and the facilitator `GET /voting-sessions/{id}` answers 404.
- AI assistant: `search_feedback` takes the period you name ("last 90 days", "all time") instead of always using the
  page's time range.
- Conversation titles are stored up to 120 characters (was 60); the list still shows two lines.
- Feature-request board: the list's search, status filter and sort are in the URL (`?q=`, `?status=`,
  `?sort=`), so a filtered board is a shareable link; changes replace the history entry
  ([docs/feature-requests.md](docs/feature-requests.md)).
- Radar releases: a release with no published date is labelled "Date not published, first found <day>" (the
  assistant says "first found <day>") instead of an approximate release day.
- Radar reads a brand with one request, `GET /radar/brands/{brand}/page?days=` (`{detail, releases, compare}`,
  [docs/radar.md](docs/radar.md#api-voc-radar-api)), instead of three parallel ones that made a cold
  `voc-radar-api` start a second environment. A `?brand=` link and the label settings start loading beside
  `GET /radar`. The detail, releases and compare routes stay for the AI assistant.
- Faster first loads ([docs/caching.md → First load](docs/caching.md#first-load)). The app shell no longer
  fetches the charts library (it rode in for a class-name helper) or the floating assistant panel and its
  markdown renderer (now loaded when the panel first opens): 1,699 KB → 937 KB of JS before any page renders
  (516 → 291 KB gzipped).
- Persona and document export menus: the PDF item is now "Print or save as PDF". It always opened the browser's print
  dialog (where "Save as PDF" writes the file, in every language's script and at vector quality), but was labelled
  "Download as PDF".
- Accessibility: the sidebar's navigation is a landmark named "Main" (in every language); a Personas-tab card is
  named by its persona and described by its tagline (the initial and the tagline no longer repeat in its name);
  Home's "<agent> needs your decision" cards and the empty assistant ("How can I help?") are named regions.

### Fixed

- Agent PR/FAQs no longer start with the writer's own prompt (reviews, memories, the conductor's message with run
  and project ids): the heading is the document title, and the document generator never stores a prompt DATA block.
- The agent's review analysis reads the last 30 days and every page of reviews (it read 7 days and one page, so a
  category with 108 reviews was reported as "1 reviews").
- Agent instructions such as "Keep documents short" reach every PR/FAQ / PRD writing step, with a length budget.
- The built-in workflow's "Maximum new personas" (`max_new`) now sets how many personas a run generates.
- The agents list shows Running (not Queued) for a run that has started; Runs → "What it produced" lists each
  document once.
- Agent pages show category labels, not ids (scope picker, "Watches: …", Run now); agent settings and workflow
  editor validation are plain sentences in every language.
- Pages stopped refreshing after their first change until a reload: on a project, the header's Public / Private
  badge (the Share dialog's Public → Private left "Public") and the Decisions cards (an edited decision kept its old
  values, and a second edit was refused as stale); on an agent, "This agent doesn't exist" after Run now or a
  decision. The breadcrumbs and the AI assistant's page context observed the page's cache entry with a fetch-less
  query, which replaced the page's own fetch; they now read the cache without observing it. A decision's save or
  delete shows on its card at once.
- Prioritization: the team score next to a room vote now updates when a ballot arrives and when the
  vote ends, without a page reload; the stats cards show a loading state (`aria-busy`) while the documents are
  read, instead of four zeros.
- Deleting a prioritization row or a project now closes the row's open room vote; the session used
  to stay open and readable.
- Projects: PRDs and PR/FAQs no longer read the company design system (Knowledge → Design system). Its tokens and
  reference summaries are prototype input only; in a written document the model took them for requirements (a PRD
  described an unrelated dashboard from a design reference). Research and personas never read it; prototypes still
  do ([docs/company-context.md](docs/company-context.md)).
- Prototype Enlarge overlay: Escape pressed inside the prototype closes the overlay again (#386, broken since
  prototypes were sandboxed to an opaque origin). The prototype's pin widget forwards an Escape it does not use
  itself to the app, which accepts it only from a frame inside that dialog, and the widget keeps doing so after the
  prototype rewrites its own page.
- Share dialog and project cards: a person whose Cognito username is a machine id (a UUID, as email sign-in pools
  assign) is named by their name, else their email, instead of the UUID.
- Project page at phone width: the tab bar wraps onto a second row instead of scrolling sideways with a hidden
  scrollbar, so Documents, Decisions and Participants are reachable with a mouse at 390 px.
- AI assistant: the panel header's **More actions** items (Notify me, Export, Reset button position) take a mouse
  click again; the conversation below used to catch it, so only the keyboard reached them.
- AI assistant: an all-time or long question answered from the newest 90 days of feedback no longer comes back as
  "nothing older is in the data"; the tool says the rest was not searched and points to exact counts.
- Renaming a conversation opens the field on its full name, not on the list's cut title with "…".
- The assistant launcher no longer floats over the open mobile navigation drawer, and every page keeps room at the
  bottom so its last control (e.g. the Categories CSV export) can scroll clear of the launcher.
- The floating assistant panel is named by its heading through a per-instance id.
- Feature-request board: clearing the search and then picking a status, or picking a filter right after closing a
  request, no longer brings back the old search or re-opens the request.
- Dashboard: when the counts cover only part of the window (e.g. Review date + All time), a visible note under the
  tiles says which range they cover and why, instead of only a hover title on "~297".
- Web Reviews: new reviews are stored as plain text (no `\.` escapes or `**` markers; glued sentences split).
  Older stored reviews display cleanly in the feed, review detail, Data Explorer, CSV/PDF exports and the
  assistant's feedback tools; stored data is not rewritten. See [docs/web-reviews.md](docs/web-reviews.md).
- Categories: the header and "Show all N categories" count the same rows; a review whose journey stage is
  `unknown` no longer shows an "Unknown" chip; the category editor shows a stored subcategory the configuration
  no longer lists instead of "None".
- Chart tooltips name every series ("Reviews", not "value") and format numbers in the reader's language.
- Accessibility: paste-review rows name their controls after the review ("Delete review 3"); the Administration
  source rows have no unnamed icon button; the data source wizard's filter chips expose `aria-pressed`; each Connect
  Revoke button names the token it revokes.
- Raw ids: the `add_participants` card names the list while the lists load; feedback-form channels read as the
  form's name; Data Explorer avatar folders read "Persona N · <date>"; built-in source names are translated in
  every language; the wizard summary names sources and categories by label; a space separates a supporter's
  email from the "Reporter" badge.
- Radar release scan: an undated release now takes the date written in its cited URL path
  (`/changelog/2026-07-30-…`) before falling back, the article-page date is read whichever order the meta
  tag's attributes come in, and an undated mention of a feature merges into its dated record instead of filing
  a copy under the scan day — the cause of every new release reading as the same "approximate" day
  ([docs/radar.md](docs/radar.md)).
- My objectives & KPIs: a KPI with a name but no target (or any other refused field) is marked next to the
  field before anything is sent, and a field error the server returns is shown on that field, instead of
  "Could not save. Try again.".
- Feedback forms: the widget's (and iframe's) rating buttons have accessible names ("Good (4 of 5)",
  "3 stars of 5: Good"), sit in a group named by the question and expose the chosen one as pressed; the cards
  say "1 Submission" (plural forms in all nine languages); counts being read show busy placeholders, never a
  stale or provisional 0.
- Data sources: the S3 Bulk Import dialog no longer tells you to "paste the token" (it has none); it asks for
  its settings in Administration.
- Personal-data redaction: a card number must now pass Luhn AND start with an issuer prefix that issues that
  length, so a Luhn-valid 13-digit timestamp or order id is no longer replaced with `[CARD]`
  ([docs/source-policies.md](docs/source-policies.md)). Memories no longer redact a bare digit run (an id or a
  timestamp) as a phone number; card numbers are still redacted, and the "Add memory" preview says the same.

### Upgrade notes

- Deploy every stack and the frontend (`npm run deploy:all`): the fixes span the API Lambdas (chat Stop, Radar
  page read, projects, the document generator's pin widget), the agent runtime (VocProcessingStack) and the Web
  Reviews plugin (VocIngestionStack). No IAM change: the stream Lambda reads the Stop marker with the `GetItem` it
  already holds. Stop markers expire through the conversations table's `ttl`.
- The Escape fix lives in the pin widget that a prototype carries from its build: prototypes built before this
  release keep the old widget, so Escape inside them still does nothing (the overlay's Close button works).
  Rebuild a prototype to give it the new widget.

## [5.34.00] - 2026-10-25

Dead and duplicated code removed, and fourteen new code-audit detectors that keep it out; a Bedrock-throttling retry that never fired is fixed.

### Added

- Code audit (`npm run audit:code`, [docs/code-audit.md](docs/code-audit.md)): fourteen new detectors, each its
  own `scripts/validate.sh` step that fails on a finding.
  - Python: `py_sfn_errors` (a Step Functions `Retry` / `Catch` error name no Lambda of the task can report),
    `py_shared_constants` (one constant value kept in several modules that ship together), `py_dead_params`
    (defaulted parameters no call passes, arguments every call spells the same, dead fallbacks for keys the
    bundled JSON config always has), `py_doc_refs` (comments and docstrings naming code, paths or routes that do
    not exist) and `clones_struct.py --kind function` (small whole-function copies that could share one home).
  - TypeScript: `ts_prop_usage` (optional component props no production call site passes; props every call site
    passes are listed as advice), `ts_css_tokens` (CSS custom properties, keyframes and classes nothing uses,
    following Tailwind v4 `@theme` utilities), `ts_mock_routes` (dev-mock routes no SPA call reaches, mock
    exports nothing imports), `ts_stale_refs` (comments naming a missing file, a test that does not exist, a
    false "pinned by" claim, or a vanished identifier), `ts_name_twins` (one small helper declared under the
    same name in two modules) and `ts_query_keys` (TanStack Query keys spelled inline in two files).
  - Repository contracts: `stack_outputs` (a CloudFormation output a script or doc reads that no stack
    declares), `repo_contracts` (undocumented or unread CDK context keys, `cdk.json` flags for modules the app
    never imports, npm scripts nothing runs or that name a missing file, orphan script files) and
    `doc_contract` (docs and steering files linking to missing files or anchors, citing paths or routes the code
    no longer has, or listing the API handlers out of step with `lambda/api/`).
- Code audit: new kinds on existing detectors. `py_route_callers` reports `called-no-route`, a request the SPA
  (every call site in `frontend/mock-coverage.json`) or the assistant's internal-API calls make that no route
  serves (a `{proxy+}` passes it to a Lambda that answers 404). `ts_reachability` reports `never-written`, an
  optional option member the CDK app or a script reads but nothing ever sets, so it always takes its default.
- Code audit: six new `patterns.py` rules, each pointing at the one shared helper: `utc-now-iso`,
  `ts-inline-is-record`, `ts-local-request-init`, `locale-manual-plural`, `ts-manual-plural`, `ts-json-equality`.
- CDK tests: every cdk-nag suppression (and every `appliesTo` item) must still suppress a finding in the default
  or the all-features synth, and every suppression regex must be anchored and escaped so it matches only the
  finding its reason names.
- `npm run check:mock` now also gates the SPA's raw `fetch` calls to the API base (the public unsubscribe and
  ballot config / submit routes), so they need a `mock-coverage.json` entry like every `fetchApi` call.
- Lockstep tests pinning the agent form's and the workflow editor's limits to the backend constants that
  enforce them.

### Changed

- Backend clean-up with no behaviour change. Timestamps, SHA-256 hashes, key prefixes shared by a writer and its
  readers (daily metrics, prioritization ballots, erasure jobs, memory imports, the failure messages the Logs page
  matches) and small helper copies now each have one home in `lambda/shared`. The data explorer, manual import and
  S3 import APIs share one admin-only middleware. The avatar prompt is read only from its JSON template.
- Docs: the steering files' route tables (logs, ballots), API handler lists and counts (20 handlers), page and
  component counts and test-setup instructions match the code again; `docs/plugin-architecture.md` drops its
  finished migration plan, and `docs/code-audit.md` no longer cites audit notes that were never in the repo.
- `voc-datalake/scripts/test-api.sh` no longer looks up the `ChatStreamUrl` output, which no stack has
  emitted since the assistant moved behind API Gateway; it streams from the API endpoint (the optional second
  argument still overrides it).
- One shared home for duplicated SPA and assistant helpers (plain-object guard, request options, list leniency,
  debounced value, JSON equality, language names, query keys, QR symbol settings, user references); the
  assistant's memory and company approval executors now go through the memory, company-context and design-system
  API modules. No user-visible change.

### Removed

- Parameters no caller ever passed, Python fallback copies of the avatar prompt config, forwarding functions that
  existed only for tests to patch, and the `BedrockThrottlingException` alias in the research step handler.
- npm scripts that duplicated gate steps or skipped the API stage refresh: root `dead-code`, `dead-code:prod`,
  `duplication`, `duplication:pairs`, `typecheck:python`, `test:acp-bridge` (the gate runs its own copies:
  `npm run validate`), and `voc-datalake`'s bare `deploy:core`, `deploy:ingestion`, `deploy:processing` (use
  `npm run deploy:infra`, or `cdk deploy <Stack>` followed by `bash scripts/refresh-api-stage.sh`).
- Six cdk-nag suppressions that matched no finding (stale grants, a queue cdk-nag already knows is a DLQ, an entry
  another always shadowed). Only template metadata changes; `cdk-nag` reports nothing new.
- `voc-datalake/cdk.json`: six CDK feature flags for modules the app never uses (ECS, EC2 launch templates,
  CodePipeline, SNS subscriptions). The synthesized templates are unchanged.
- Administration → Sources: the credentials section's **Test** button. It called
  `POST /integrations/{source}/test`, a route removed in #115, so it has answered 404 ever since and never
  worked; the source card's "Connected" badge still shows whether credentials are saved.
- Unused component options with their dead branches (a small tile size, a labelled ghost mark, an admin-route
  redirect target, the card without actions, disabled tag and dimension fields, and similar), and the unused
  "Delete" fallback label of the confirm dialog in all 9 languages.
- Unused design tokens: `card-fg`, `muted-fg`, `info-fg`, `aim-fg`, `panel-strong` and the utility mappings of
  `accent-glow`, `border-hover`, `chrome`, `chart-grid` and the sentiment aliases (the `--*` variables stay),
  five unused animations with their keyframes, and the `scrollbar-hide` class. The design-system guide lists
  only what exists ([docs/kiro-design-system.md](docs/kiro-design-system.md)).
- Dev mock routes no screen calls (batch prototype-pin updates, persona metrics, the legacy chat route, a `PUT`
  on prioritization, reading Radar settings, creating a participant directly).
- 31 shadowed plural base strings and the unused `categories:issues` strings from all nine locales.

### Fixed

- Research and document-generation workflows: a step throttled by Bedrock is now retried. The state machines
  retried on `BedrockThrottlingException`, but the Lambda reports `BedrockThrottlingError`, so the retry never
  fired and a throttled step failed at once.
- Stale comments and docstrings that pointed at moved files, renamed functions and tests that no longer exist.
- `npm run deploy:frontend` (`frontend/scripts/deploy.sh`) writes the same `config.json` as a CDK deploy:
  it now carries `features.email` and, on a deployment with `-c emailFrom`, the feature-request board's user
  pool (`board`), so a frontend-only deploy no longer hides the board sign-in and the email capability. It no
  longer writes `streamEndpoint` / `avatarsCdnUrl`, which the app never read. VocApiStack gains an
  `EmailAvailable` output (only with `-c emailFrom`) for it; a lockstep test pins the script, the stack and
  the app's config schema to one key set.
- JSON upload: the "Import N items" button and the preview heading no longer append an English "s" in every
  language (German showed "3 Elements importieren", Japanese "アイテムs"); the S3 upload status, and several French,
  Spanish and German "more items / more errors" counters, now use real singular and plural forms.
- Agents: the form accepts a cron expression up to 120 characters, the limit the API enforces (it stopped at 100).

### Security

- cdk-nag: the `AwsSolutions-IAM5` suppressions for DynamoDB index ARNs, bucket object ARNs, Lambda version
  wildcards and the CDK assets bucket are now anchored regexes that match only the finding their reason
  names. They had lost their backslashes, so the whole-bucket `/*` entry for the raw data bucket also silenced
  every prefix-scoped grant on it. Those prefix grants now carry their own reviewed suppression, one item per
  prefix, so a grant on a new prefix is reported. IAM policies are unchanged; only template `Metadata` changes.

## [5.33.01] - 2026-10-25

Fixes from the live check of the participants and feature-request board release.

### Fixed

- Feature-request board (`/board`): the emailed sign-in link no longer leaves its one-time code in the
  address bar or browser history after sign-in, and signing out of a board opened from that link no longer
  shows the false "opened in a different browser" warning. A shared `?request=` is kept.
- Administration → Privacy & access → Users → "Company domains and participant email": "Saved." now appears
  after a successful save (the form reloaded with the stored values and dropped the notice).
- Board sign-up refusals: the `voc-board-pre-sign-up` function's one ERROR log line per refused domain is now
  documented as expected (docs/feature-requests.md), carries only the code `domain_not_allowed`, and is pinned
  out of every ops alarm.
- Board sign-in email: the sign-in link is now also written out as text, so a mail client that shows only
  plain text still offers an address to open.
- Deleting a feature request or erasing a person (admin) no longer re-requests the deleted item right after
  (a 404 and a console error); the dialog closes and the lists refresh.
- AI assistant: the `add_participants` approval card's summary now names the participant list instead of
  showing its raw id.

## [5.33.00] - 2026-10-25

Participants (lists of people to ask for feedback, emailed asks) and an internal feature-request board with
revenue impact and its own email sign-in.

### Added

- **Participants** (VALIDATE → Participants, `/participants`): participant lists (employees, paid participants,
  beta customers, sales, customers, feature requesters, custom) with member counts; people with company, title,
  notes and tags; a person view with their lists and the asks they received; administrators can erase a person.
  Tabs Lists / People / Asks deep-link with `?tab=`. Routes under `/participants/*`. See
  [docs/participants.md](docs/participants.md).
- **Asks**: email chosen lists and/or people a subject, a message and one link — one of your feedback forms (the
  answer is then attributed to the person and the ask: `metadata.participant`) or any https page. Sent through
  Amazon SES in the background (at most 10 per second, a configurable daily cap, 500 recipients per ask), with
  Reply-To the asker and one-click unsubscribe (`List-Unsubscribe`). The Asks tab shows sent / failed / skipped /
  responded per ask and each recipient's status.
- **Project → Participants tab**: link lists and people to a project or invite new ones, see how many active people
  that reaches, "Ask for feedback" prefilled with the project and everyone linked, and the project's asks.
- **Unsubscribe page** (`/unsubscribe?t=…`, public) and the public `POST /unsubscribe` (always 200, with its own
  stage throttle in `lib/stacks/api-gateway.ts`). Nothing happens on page load, so mail link scanners cannot unsubscribe anyone.
- **Feature-request board** (LISTEN → Feature requests, `/feature-requests`): sales and field teams post a request
  with a description, customer, deal and revenue impact in whole US dollars (committed to pay, deal at risk, or
  none); others +1 it with their own customer. Totals per request (supporters, customers, committed and at-risk
  USD), sort, filter and search, a detail dialog deep-linked as `?request=<id>` with "Copy link". Admins set the
  status, delete, and **promote to project**: supporters and customer contacts become the request's participant
  list, linked to the project. Routes under `/feature-requests/*`. See
  [docs/feature-requests.md](docs/feature-requests.md).
- **Standalone board at `/board`** for people who are not app users: `/board/login` emails a sign-in link and a
  one-time code from the board's OWN Cognito user pool, and only addresses on the configured company domains can
  join. A board session is accepted by the board routes alone; the app's own user pool is unchanged.
- **Administration → Privacy & access → Users → "Company domains and participant email"**: the company domains
  (who may join the board), whether people outside them may be added as participants, the daily send limit and the
  sender name, plus whether email sending is configured and the board link to share.
- **AI assistant on Participants**: `list_participant_lists`, `create_participant_list` and `add_participants`
  (up to 200 people per approval card, every row shown, duplicates collapsed, invalid emails refused before the
  card) — bulk entry goes through the assistant. `voc-chat-stream` may now invoke `voc-engagement-api`.

### Upgrade notes

- **Two new tables in VocCoreStack**, `voc-participants-<suffix>` (people's emails and names) and
  `voc-feature-requests-<suffix>`, created empty; covered by `-c protectData` and by the teardown backup steps like
  every customer-data table. VocApiStack gains one Lambda, `voc-engagement-api`, the routes `/participants/*`,
  `/feature-requests/*` and `POST /unsubscribe`. Deploy VocCoreStack before VocApiStack (`cdk deploy --all` does)
  and end with the API stage refresh as always. Nothing to migrate.
- **Email is opt-in: `-c emailFrom=noreply@<your-domain>`.** Before setting it, verify the SES identity of that
  domain in the deployment region, leave the SES sandbox, and turn on the SES account-level suppression list for
  bounces and complaints. With it, VocCoreStack adds the board's Cognito user pool (`voc-board-user-pool`, Essentials
  feature plan, billed per monthly active user) and `config.json` gains `board` and `features.email: true`. Without
  it, asks answer `409 email_not_configured` and only app users can use the board. See
  [docs/deployment.md](docs/deployment.md#participant-email-and-the-feature-request-board--c-emailfrom).
- **Nobody can join the board until an admin lists the company domains** (Administration → Privacy & access →
  Users); the list starts empty.

## [5.32.00] - 2026-10-24

The Product tab is redesigned and its embedded chat replaced by a guided interview in the AI assistant.

### Changed

- **Project → Product tab redesigned.** One header (what the tab is for, how many of the 11 fields are filled, when
  the description was last saved), the company context strip, the description in five section cards (the product ·
  customers and problem · offering · goals and boundaries · notes; long text wraps, every field still saves on its
  own when you leave it), and internal documents and **Generate report** as side cards. The Chat / Upload / Both
  switch is gone: everything is always shown. See [docs/project-workspace.md → Product tab](docs/project-workspace.md#product-tab).
- **Fill with AI assistant** (Product tab header, editors only) opens the AI assistant on a new conversation with an
  interview request drafted (nothing is sent until you press send). The assistant asks about the empty fields one
  question at a time — product name, one-liner, target users, problem, current state, key features,
  competitors/differentiators, goals and metrics, constraints, non-goals, anything else — and then proposes ONE
  `update_product_context` approval card; the form shows the approved values at once.

### Removed

- The Product tab's embedded AI interview chat, and its route `POST /projects/{id}/product-context/interview` (the
  `assist_interview_turn` assist job). The AI assistant's guided interview replaces it.

### Upgrade notes

- `POST /projects/{id}/product-context/interview` now answers **404**. Nothing in the app calls it any more; an
  external script that did should use the AI assistant (or `PUT /projects/{id}/product-context`) instead. Deploy
  with `npm run deploy:infra` (or follow a bare `cdk deploy` with `scripts/refresh-api-stage.sh`) — the projects
  API sits behind `{proxy+}`, so no API Gateway method is removed, but the stage refresh is the standard step.

## [5.31.01] - 2026-10-24

A regression test for the Python test setup's layer-path filter.

### Fixed

- The test setup's layer-path filter is a small function with its own test, so a checkout whose path contains
  `layers` can never again lose the virtualenv's packages.

## [5.31.00] - 2026-10-24

Slimmer Lambda layers: crypto and lxml only where they are used, no copies of the runtime's SDK libraries, and a layer audit in the gate.

### Changed

- The Python dependency layers ship only what their functions use
  ([lambda-sizing.md → Dependency layers](docs/lambda-sizing.md#dependency-layers)). Unzipped size per cold start:
  - `ApiDepsLayer` and `ProcessingDepsLayer`: 39.4 MB → 20.5 MB (zipped 13.7 → 7.3 MB);
  - `IngestionDepsLayer`: 37.2 MB → 22.2 MB (zipped 14.1 → 7.9 MB).
- The CloudFront URL-signing crypto (cryptography, cffi, pycparser) is in a new `SigningDepsLayer`
  (VocApiStack, 16.8 MB). It is attached only to the five functions that sign avatar and prototype URLs: the
  projects API, its assist worker, the persona generator, the persona importer and the document generator.
- lxml is in a new `EmailIntakeDepsLayer` (VocIngestionStack, 12.4 MB). It exists only when the inbound-email
  intake is enabled, and only that function carries it. The webscraper parses with `html.parser` as before.
- Layers no longer carry their own urllib3, jmespath, python-dateutil, six or s3transfer, so the runtime's botocore
  runs on the runtime's own copies. They also drop console scripts, type stubs and packaged test suites.
  `scripts/build-layers.sh` now builds every layer directory, with the same recipe as the CDK bundling.
- New gate detector `scripts/audit/py_layers.py`, in the `audit: … + py_layers` step. It reports:
  - a layer library no attached function reaches, or one only a few reach;
  - a package the runtime already ships;
  - a function that imports a library none of its layers provides;
  - a layer a function never uses;
  - a venv that does not match the layer requirements.

  See [code-audit.md](docs/code-audit.md).

### Fixed

- The Python test setup no longer drops the virtualenv's packages when the checkout path contains
  `layers/` (it filtered `sys.path` by substring); only the repo's own `lambda/layers` build output is removed.

### Upgrade notes

- The next deploy publishes new versions of `ApiDepsLayer`, `ProcessingDepsLayer` and `IngestionDepsLayer`,
  creates `SigningDepsLayer` (VocApiStack), and updates every function that uses those layers. It also creates
  `EmailIntakeDepsLayer` if you deploy with `-c inboundEmailDomain`. Docker (or `CDK_DOCKER=finch`) must be able
  to build two more layer assets. There are no data or route changes.
- Local and CI Python environments install two more requirement files:
  `lambda/layers/signing-deps/requirements.txt` and `lambda/layers/email-intake-deps/requirements.txt` (see
  `voc-datalake/requirements-dev.txt`; the CI workflows already do). The `py_layers` gate step reports
  `version-mismatch` until `voc-datalake/.venv` matches the layer requirement files. Today that means
  `pydantic==2.14.1` and `websocket-client==1.9.2` for ingestion-deps.

## [5.30.01] - 2026-10-24

The CDK-contract audit step no longer judges CDK's own Lambda handlers.

### Fixed

- The release gate's `audit: py_reachability + py_env_contract + py_iam_contract` step failed on a fresh checkout
  (CI): it judged the Lambda CDK itself adds for the website deployment (staged from `voc-datalake/node_modules`)
  as repo code and reported its environment variables. Handlers staged from `node_modules` are now external, and
  the detectors' cached synth also refreshes when `package-lock.json` changes (a CDK upgrade can add functions).

## [5.30.00] - 2026-10-24

Workflow revision History, top categories on Release Watch, the code-audit detectors in the release gate, and the last owner-decided dead fields removed.

### Added

- **Workflow revision History.** The workflow editor (the workflow page and an agent's Workflow tab) has a
  **History** button: a dialog listing the saved revisions newest first (who saved each one, when, which one is
  current), each revision's step and arrow counts, and what restoring it would change. Admins can **Restore into
  editor**, which loads that revision into the unsaved draft; saving it then creates a new revision as usual.
  Anyone who can open the workflow can browse its history. See docs/autonomous-agents.md → "History".
- **`GET /workflows/{id}/revisions/{revision}`** (`voc-agents-api`, under the existing `/workflows/{proxy+}`
  route): one saved revision with its definition, `{workflow_id, revision, name, definition, saved_at,
  saved_by_username}`. Same read rule as `GET /workflows/{id}`; 404 for a revision the workflow does not have,
  400 for a revision number that is not 1–999999. No IAM or gateway change.
- Release watch (Dashboard → GitHub, and a launched decision on Project → Decisions) now shows each
  release's top categories before → after, by their configured names with grouped counts, each opening
  Categories filtered by it; a category new to the top three or one that grew says so in words
  ([docs/decisions-and-release-watch.md](docs/decisions-and-release-watch.md)).

### Changed

- **The code-audit detectors are now part of the release gate.** `scripts/validate.sh` runs every detector in
  `scripts/audit/` as its own `audit: …` step (the three synth-based Python ones together, after the vite build),
  plus the detectors' own tests and lint, and fails on any finding or a detector that cannot run; a further step
  fails when a detector exists with no step. `scripts/validate-affected.sh` runs only the detectors whose inputs a
  branch changed. A finding is fixed, or allowlisted in `scripts/audit/allowlists/<tool>.json` with a reason. See
  [Code audit → In the gate](docs/code-audit.md#in-the-gate).
- Internal clean-up, nothing visible changes: the SPA stops decoding saved-session fields the restore
  path never read (`title`, `kind`, `page` on `GET /chat/conversations/{id}`; the sessions list still
  reads them), stops mirroring the AG-UI run id and the `assistant.context` announcement in assistant
  thread state, and no longer decodes the setup returned by `PUT /projects/prioritization/config`
  (the page re-reads it). The assistant's `search_feedback` tool drops an internal truncation flag;
  its answer still carries the same truncation notice. API routes, payloads and the `/chat/stream`
  request are unchanged.

## [5.29.00] - 2026-10-24

Code-audit detectors you can re-run (dead and similar code), what they found removed, and the memory import fix.

### Changed

- The memory embedding model is fixed to Titan Text Embeddings V2: the `MEMORY_EMBED_MODEL_ID` override no
  stack ever set is gone (the IAM grant only ever allowed that model). The resolved-problems expiry
  (180 days) and the plugin circuit breaker (5 failures in 15 minutes) are constants; their never-set
  `RESOLVED_PROBLEMS_TTL_DAYS` / `CIRCUIT_BREAKER_THRESHOLD` / `CIRCUIT_BREAKER_WINDOW` reads are removed.
- **Code-audit detectors** (`npm run audit:code`, report-only, not a gate; tests `npm run test:audit`, lint
  `npm run lint:audit`): `scripts/audit/run-all.sh` runs every detector in `scripts/audit/`. Dead code: Python
  unreachable from real Lambda entry points, CDK env vars vs what each function's code reads, IAM grants no code
  path uses, API routes with no product caller, DynamoDB attributes written but never read (judged on an offline
  synth with each bundling command replayed); TypeScript members nothing reads or only writes, string-union values
  nothing produces, unreachable locale keys, SPA API functions only tests call. Similar code: structural clone
  finders for Python and TypeScript (renamed and near copies jscpd misses) and a rule engine for re-implemented
  helpers (DynamoDB paging, Decimal conversion, per-call AWS clients, init warming, inline admin checks, raw Bedrock
  calls, locale-less numbers and dates, clipboard, raw `{{count}}`). Every detector takes `--help` and
  `--json [PATH]`, exits 0 / 1 / 2, and allowlists with a mandatory reason; reports go to `.cache/audit/`. See
  [Code audit](docs/code-audit.md).
- Internal consolidation, no behaviour change: eight more DynamoDB query loops use the shared pager, the document
  generator reuses one S3 client per environment instead of building one per scratch read or write, category
  settings share the dimensions' field validator, and the i18n scripts share one source-file walker and flattener.
- The global MCP API (`voc-mcp-global-api`) builds its DynamoDB, Cognito and Lambda clients while starting up,
  not on its first request.
- Docs, tests and the AI assistant's Radar tool description use fictional companies and people only ("Example
  Air", "Acme"): the remaining real brand, airline and person names in examples are replaced (see
  [Radar](docs/radar.md) for the new example feed URL). No behaviour change.

### Removed

- `GET /memory/imports` (the import list) and `GET /radar/scan` (the last scan): nothing in the app called
  them. The Memory page keeps polling `GET /memory/imports/{id}`; the last scan is `last_scan` on `GET /radar`.
- `AVATARS_CDN_URL` on the persona generator and importer job Lambdas (neither builds a CDN URL), and the
  unread `manual_trigger` key in the payload of `POST /sources/{source}/run`.
- 48 unused UI strings from all 9 locales (old project-chat, data-explorer and filter copy, among others),
  and unread SPA state: the auth store's loading/error fields, the manual-import `isProcessing` flag, the
  theme store's unused setter, the decision's `decidedBy`, the ballot's `corrected`, the dimension
  metrics' `key`/`periodDays`, the agent run page's `nextCursor`, the scoring templates' `builtin` flag,
  and two unread fields of the CDK capacity report. No visible change.

### Fixed

- A memory page import longer than one chunk stopped after its first chunk: the memory extractor
  (`voc-memory-extractor`) now has the extract queue's URL and may send to it (that queue only), so it queues
  the next chunk.

### Upgrade notes

- Both removed routes sit behind the `/memory/{proxy+}` and `/radar/{proxy+}` resources, so they answer 404
  as soon as the API Lambdas are updated; no API stage change. Scripts calling them must stop.

## [5.28.00] - 2026-10-24

Clean-up: no tests in Lambda bundles, unused permissions and routes removed, dead code deleted, shared helpers instead of copies, and every number in the app language.

### Changed

- **Python Lambda bundles no longer ship tests or caches.** Docker bundling copied whole trees, so every
  Python function's zip carried `shared/test/**`, `__pycache__/` and `*.pyc` (the staging excludes only
  shaped the asset hash). Every bundle is now built by one helper that ends by removing test files, test
  directories, caches and `.env*` files; `voc-metrics-api` goes from 15 MB to 2.1 MB on a developer
  checkout (4.9 MB on a fresh clone). See docs/deployment.md → "What a Python Lambda bundle contains".
- **Agent run views no longer carry `review_window`.** `GET /agents/{id}/runs` and `GET /agents/{id}/runs/{run_id}`
  (and the 202 of `POST /agents/{id}/run`) drop the field; nothing in the app, the assistant or `/mcp/global` read it.
  New runs no longer store it, nor the agent's `last_run_finished_at`, nor a plan step's `approved_at` (none was
  read; existing rows keep them, harmlessly).
- **Unused Python helpers removed** (no behaviour change): the never-called `fetch_with_retry` HTTP helper and
  other dead shared functions, and the `plugins/_shared` package no longer imports every plugin module when one is
  imported. A new test fails when a module's `__all__` exports a name no other production module uses, so a dead
  helper can no longer hide behind an export.
- Internal Python consolidation, no behaviour change: one DynamoDB query pager, one Decimal-to-JSON
  conversion, table-driven API error answers, shared admin checks, and one helper for the image,
  attachment and tool-use Bedrock calls (same requests on the wire).
- **Numbers and decimals follow the app language everywhere.** Counts are grouped ("26,622", de "26.622",
  pl "26 622") and decimals use the language's mark ("4.5", pl "4,5") on the Feedback Forms cards and the
  submissions dialog, the Prioritization evidence panel and team scores, Release Watch, the Dashboard's
  "By dimension" and GitHub Issues cards, Settings → Logs, Memory's review tab and the file sizes of uploads,
  CSV imports and the S3 browsers (large files now show MB instead of thousands of KB). The English PDF reports
  group their counts too ("2,083 problems"); the translated Categories report writes them in the reader's
  language.
- **Counts inside sentences follow the app language's grouping too.** Every translated sentence that carries
  a count ("Your workspace has 16,799 feedback items", "1,200 shown of 16,799", badges, limits such as
  "Enter 1–9,999 days") now groups it like the figures around it (de "16.799", pl "16 799"), in all nine
  languages; plural forms are still chosen from the number itself. Positions and versions ("Review 3", "v12")
  stay as they were. The AI model test's "tokens/min" figure no longer picks its plural from a formatted
  string. A test fails when a new string spells a count without the number format.
- **The metric tiles' trend is translated.** The screen-reader text ("Increased by 15%") is now in all nine
  languages, with the locale's percent spelling, and a fractional change keeps its decimal.
- **Dates use one formatter.** The submissions dialog, the S3 import list, Plans, Account and the morning brief
  show the medium date and short time of the app language; the Dashboard's "nothing in this window" note writes
  the newest day as "Jun 15, 2026". A date-only value (`YYYY-MM-DD`) is now shown as that calendar day in every
  time zone instead of the day before west of UTC.
- **Export menus close on Escape** and return focus to their button (document and persona export).

### Removed

- Environment variables and IAM grants no function read: `voc-chat-api` loses `FEEDBACK_TABLE`,
  `AGGREGATES_TABLE`, its feedback read, aggregates read-write and `bedrock:InvokeModel` grants (it only
  stores conversations); the processor/aggregator role loses its projects-table read and `PROJECTS_TABLE`;
  every ingestor loses `DEPLOY_ACCOUNT_ID`, `DEPLOY_REGION`, `PRIMARY_LANGUAGE` and `PLUGIN_ID`; webhook
  functions lose `FEEDBACK_TABLE`, `PLUGIN_ID` and their feedback-table read-write grant; `voc-retention`
  loses `RETENTION_FUNCTION` (it re-invokes itself by its own name).
- **`GET /data-explorer/stats`**: no screen called it. Use `GET /data-explorer/buckets` and `GET /data-explorer/s3`
  to browse the data lake ([Data lake structure](docs/data-lake-structure.md)).
- **`GET /memory/stats`** (admin memory counts): no screen called it ([Memory](docs/memory.md)).
- **`PUT` and `DELETE /projects/{id}/personas/{persona_id}/notes/{note_id}`** (edit / delete a persona research note):
  no screen, assistant tool or MCP tool called them. Adding a note (`POST …/notes`) is unchanged.
- **Five API routes nothing in the app called any more** (no screen, assistant tool, plan step, `/mcp/global` tool or
  agent runtime): `POST /projects/{id}/personas` (create a blank persona; generate and import are unchanged),
  `GET /scrapers/{id}/runs` (run history; `GET /scrapers/{id}/status` and `GET /logs/scraper/{id}` remain),
  `POST /workflows/import` (the editor's Import still loads a file into the draft, which Save / Save as stores),
  `GET /settings/categories/reprocess/{job_id}` (the latest job and cancel remain) and `GET /feedback-forms/{id}`
  (the form list carries every field; update and delete are unchanged).
- Dead code in the dashboard and the assistant Lambda, with no user-visible change: SPA API wrappers nothing called (the `api.*` project shortcuts, `getPersonas`, `getFeedbackForm`, `getScraperRuns`, the workflow import, single reprocess-job and memory-update calls), unused props and hook results, a never-shown "Remix" next-step hint, and the translation keys the UI never used (about fifty, in all nine locales). The backend routes are unchanged.

### Fixed

- The "Copied" state of the Feedback Forms and Settings → Sources copy buttons and of the export menus no longer
  leaves a timer running after the card or menu closes.
- The feedback form stats and submissions reads are validated at the API boundary: a malformed answer shows an
  em dash or drops the one bad row instead of breaking the card.

### Security

- The feedback-forms API no longer falls back to allowing every CORS origin when `ALLOWED_ORIGIN` is unset;
  it fails closed like every other API Lambda. Deployed stacks are unaffected (CDK sets `'*'` for this
  function explicitly, for the embeddable widget).
- The webhook role can no longer read, write or delete feedback items; the processing and retention roles
  are now the only roles that can delete them.

### Upgrade notes

- Every Python Lambda's code changes (smaller bundle), so the next deploy updates all of them in place.
  No resource is replaced: logical ids are unchanged; only code, environment variables and IAM policies
  differ (and the order of VocCoreStack's cross-stack outputs).
- The memory, persona-note, persona-create, scraper-runs, workflow-import and reprocess-job routes answer 404 once
  the API Lambdas are updated. `GET /data-explorer/stats` and `GET /feedback-forms/{id}` are explicit gateway
  methods, so they disappear only with the API stage refresh that `npm run deploy:infra` (or
  `deploy:api`) ends with; after a bare `cdk deploy`, run `bash voc-datalake/scripts/refresh-api-stage.sh`. Scripts
  calling any of the removed routes must stop.

## [5.27.00] - 2026-10-24

Lambdas back at one vCPU with cheaper code: init-time clients, one-pass DynamoDB decoding, lighter metric, log and aggregation work.

### Changed

- **No Python Lambda runs above one vCPU any more.** Python handlers use one core, so the eight functions doubled
  on 2026-10-20 got no faster above 1,769 MB; they are back at 1,769 MB with the CPU behind their breaches made
  cheaper: `voc-agent-heartbeat`, `voc-briefing`, `voc-logs-api` 3,538 → 1,769 MB; `voc-metrics-api`,
  `voc-projects-api`, `voc-integrations-api`, `voc-memory-scanner` 3,072 → 1,769 MB; `voc-radar-api` 2,048 →
  1,769 MB. `voc-aggregation-processor` goes 1,024 → 1,536 MB (68.8 % CPU p95 on bulk-delete batches). A synth test
  now refuses any Python function above 1,769 MB ([Lambda sizing → Back to one vCPU](docs/lambda-sizing.md)).
- **Lambdas build their AWS clients while starting up, not on their first request.** The agents, radar, logs,
  projects and ballots APIs, the heartbeat, conductor, briefing, memory scanner, memory retention, retention and Radar
  scan workers (and the `$LATEST` copies of the SnapStart APIs) used to spend most of a cold request building the
  DynamoDB client; that now happens during Lambda's init. In a simulation the first request uses 75–85 % less CPU.
- **Every Lambda's DynamoDB reads decode their items in one fast pass** (the shared DynamoDB resource), with the same
  values as before. This is what makes the metrics API's long walks cheaper, and it helps every list read.

- **The aggregation processor (`voc-aggregation-processor`) uses far less CPU on bulk deletes.** A run of
  consecutive `REMOVE` stream records in a batch is now reversed with one conditional write per distinct counter
  (and one per day for the sentiment average) instead of one write per record per counter — 852 requests became
  183 on a 100-record batch copied from production. The aggregate rows end exactly where one-at-a-time reversal
  left them: when a counter cannot take the whole run (it sits below it), that counter falls back to one decrement
  per record. Inserts and edits are unchanged. Log lines of a run are grouped per phase rather than per record
  ([Processing pipeline](docs/processing-pipeline.md)).

- **The metrics API (`voc-metrics-api`) uses far less CPU per request.** Its DynamoDB reads decode the returned
  reviews in one fast pass instead of the SDK's per-attribute parse, the day-by-day walks behind `/metrics/*`,
  `/feedback/entities` and the `/feedback` list read only the fields they count or filter on, and `/feedback`
  then fetches just the page it returns in full (one `BatchGetItem` of at most 100 reviews). Problem Analysis
  skips similarity comparisons that cannot match. Every answer is the same as before; the heaviest list and
  filtered-metric calls take about a quarter to a half of their former CPU and answer sooner. Nothing to do on
  upgrade.

- `GET /logs/summary` (Administration → System → Logs) now asks DynamoDB for each source's row count instead of reading
  and redacting up to 1,000 rows per source and type only to count them. Same numbers; during an incident with
  hundreds of failures per source the route uses about a ninth of the CPU and answers several times faster.
- `GET /radar/brands/{brand}/compare` reads the Radar brand list and the source profiles once per request instead of
  twice, and the Radar API reuses its table object: about 15 % less CPU on that route, same response.

### Upgrade notes

- Nine Lambda memory sizes change (eight down to 1,769 MB, the aggregation processor up to 1,536 MB); nothing else to
  do. Re-run `scripts/capacity/capacity-query.sh --hours 168` about a week after deploying.

## [5.26.00] - 2026-10-23

A default autonomous agent, grouped counts on every metric tile, and no more canned review replies.

### Added

- Every deployment now starts with a default autonomous agent, **Autonomous Product**. It is created the first
  time an admin opens Agents, gets its own copy of the built-in workflow and a threshold trigger (10 reviews per
  category in 7 days), and starts **disabled**, so it runs and costs nothing until an admin enables it. A
  deployment that already has agents (archived ones count) gets nothing new, and archiving the default agent never
  brings it back ([Autonomous agents → Default agent](docs/autonomous-agents.md#default-agent)).

### Changed

- Home's tiles group their counts the way the Dashboard does ("26,622 reviews", not "26622"), in the app
  language. Every metric tile now formats numbers itself, and Problem Analysis's header stats use the same
  tile instead of a copy of it. The Dashboard and Categories PDF headers group their counts too.

### Removed

- The review modal and the review page no longer show "Suggested Responses" (fixed canned replies with
  copy buttons).

## [5.25.04] - 2026-10-23

Every Lambda's logs expire.

### Fixed

- The Lambdas CDK creates itself (S3 auto-delete and bucket-notification providers in `VocCoreStack` /
  `VocIngestionStack`, the website deployment in `VocApiStack`) now log to stack-owned log groups with a 14-day
  retention, like every other function. Lambda used to create their groups with no retention, so those logs never
  expired. A synth test fails on any function without a retained log group.

### Upgrade notes

- The cross-region export providers cannot be reached this way; set their retention once, and give the provider
  groups left from earlier deployments a retention or delete them. See
  [docs/deployment.md](docs/deployment.md#log-retention-of-cdks-own-provider-lambdas).

## [5.25.03] - 2026-10-23

Problem Analysis PDF totals and a chart warning.

### Fixed

- Problem Analysis → Export PDF counts every problem of the period (the header and each subcategory), like the page's
  tiles, instead of only the problems listed; a subcategory whose list was cut to the largest says so
  ("2083 problems (largest 471 listed)").
- Categories: the sentiment gauge no longer logs "The width(-1) and height(-0.5) of chart should be greater than 0"
  when it mounts; every chart container now has a first-paint size (checked by a test).

## [5.25.02] - 2026-10-23

Dead API routes removed.

### Removed

- `GET /feedback/problems/resolved`, `PUT` / `DELETE /feedback/problems/{problemId}/resolve` and `POST /radar` from
  `VocApiStack`. They were wired to Lambdas with no such route and answered 404; resolving a problem is
  `GET` / `PUT /settings/resolved-problems`, and Radar's writes are under `/radar/{proxy+}`. A new CDK test
  (`api-route-liveness.test.ts`) fails on any API method whose Lambda registers no matching route.

### Upgrade notes

- Deploy with `npm run deploy:infra` (it refreshes the API stage), or the removed methods stay live on the stage.

## [5.25.01] - 2026-10-23

Feedback samples are nested.

### Fixed

- The even feedback sample behind personas, research and documents is now one fixed ordering of the whole window:
  a smaller sample is always the start of a larger one, so pages read with `offset`/`limit` never repeat or skip a
  review, and a sample trimmed to fit the model's context still covers every day of the window.

## [5.25.00] - 2026-10-23

Personas and research read the whole window, Problem Analysis counts every review, and category routing uses names.

### Added

- Generated personas and research reports store `input_feedback_ids`: the reviews the model read, in prompt order
  (at most 500), so the corpus behind each one is kept (#236; ported from #429 by @aws-bryan).

- `GET /feedback/problems` (metrics Lambda, Cognito, read-only): the Problem Analysis tree aggregated on
  the server over the whole window — counts, urgent counts, sentiment, root cause and sample review ids per
  problem, through the caller's category/source scope, the page's filters and the 20 s walk budget
  (`is_partial` / `scanned_through` when it stops early). See [docs/problem-analysis.md](docs/problem-analysis.md).
  (ported from #429 by @aws-bryan)

### Changed

- Persona, research and document generation now read every review the chosen window and filters match and take an
  even, deterministic sample across the whole window, instead of the newest reviews only — one big import day no
  longer becomes the whole corpus. Filters, the date basis and the caller's category/source access apply as before; a
  channel filter reads `gsi5-by-channel`. See [docs/project-workspace.md](docs/project-workspace.md#which-feedback-a-generation-reads)
  (ported from #429 by @aws-bryan).

### Fixed

- **Problem Analysis** (`/problems`) counts every review of the period instead of the newest 2,000: the page
  reads the server-aggregated tree instead of paging `/feedback` in the browser. The "Showing the newest …
  reviews" line is gone; a caveat shows only when the server could not read the whole period, or lists only
  the largest 2,000 problems (every count still covers them all). An expanded problem shows up to ten example
  reviews with its total. (ported from #429 by @aws-bryan)

- Projects: the persona, research and document wizards now filter feedback by the category NAME reviews store.
  Before this, a category added on the Categories page sent its internal id (`cat_…`), which matched no review, so
  the job ran on no feedback (ported from #429 by @aws-bryan).
- Feedback forms: the form editor's category routing stores the category and subcategory NAME, so submissions
  from a form routed to a category added on the Categories page are tagged with that category instead of its
  internal id (`cat_…`). A form saved earlier with an id still shows the right category, and the next save
  stores the name.
- Feedback forms saved before this release with a category routing stored as an id (`cat_<uuid>`) now file
  their submissions under the category's name: `POST /feedback-forms/{id}/submit` maps the stored id to the
  configured name, so nothing has to be re-saved.
- Deploy: a connection failure or timeout reaching Bedrock while accepting a model agreement
  (`VocWebSearchStack`, model-access half) no longer fails the custom resource and rolls the stack back. The
  model is reported `UNAVAILABLE` with the exception class as `errorCode`, and the deploy goes on; deploy again
  to retry. Other Bedrock errors still fail the deploy (ported from #429 by @aws-bryan).

### Upgrade notes

- `GET /feedback/problems` lists at most the 1,000 largest problems (every total still counts all of them,
  `problems_truncated`), each with at most 3 similar wordings, and merges at most the 5,000 largest distinct problem
  texts per subcategory by similarity (`similarity_partial`), so the answer stays well under Lambda's 6 MB and the
  29 s API limit on very large windows.
- A generation's feedback read now covers the whole window (at most 50,000 matching reviews or about 20 seconds of
  reading), so it costs more DynamoDB read capacity than the old newest-first read on large windows. The pre-checks of
  `POST /projects/{id}/personas/generate` and `/research` still stop at the first matching review.

## [5.24.01] - 2026-10-23

Tests only.

### Fixed

- A restricted viewer's channel-filtered list, categories, summary and entities are tested to give the same answer
  through `gsi5-by-channel` as through the day walk, and to show only the categories they may see.

## [5.24.00] - 2026-10-23

A channel filter reads only that channel's reviews, so every channel answers exactly, however big its import.

### Added

- A `gsi5-by-channel` index on the feedback table (`VocCoreStack`), keyed on the review's channel and processing time,
  with a slim projection. See [docs/dimensions.md](docs/dimensions.md).

### Changed

- `?channel=` on Categories, Dashboard, the feedback list and every `/metrics/*` view reads that
  channel through the new index instead of walking every review of every day. A channel of 70 reviews inside a
  25,000-review import day is read in about 0.1 s (it was missing before), and a channel of 25,000 in about 2 s;
  counts are exact up to 100,000 reviews in the window (before: 5,000). The feedback list fetches only its page of
  full reviews. Search and release watch with keywords still use the day walk.

### Upgrade notes

- Deploying adds one index to `voc-feedback`. DynamoDB builds it from the existing reviews by itself (no migration
  script); CloudFormation waits for it, a few minutes for tens of thousands of reviews. `VocCoreStack` deploys before
  `VocApiStack`, so the API uses it only once it exists; a table without it falls back to the old walk.
- Cost: each review write also writes a small index row (a few hundred bytes); still pay-per-request.

## [5.23.06] - 2026-10-23

Tests only.

### Fixed

- A 5.23.05 item-filter test failed the type check; it now asserts the condition exists before reading it.

## [5.23.05] - 2026-10-23

Tests only.

### Fixed

- The AI assistant's feedback lookup is tested to send the channel filter to DynamoDB on both the date and the
  category walk, and only the exact channel filter (not tags or dimensions) is sent there.

## [5.23.04] - 2026-10-23

A channel filter finds its reviews in a big import.

### Fixed

- Categories, Dashboard, the feedback list, search and the AI assistant now find every review of a small channel
  (`?channel=`) in a large import. Before, the item walks stopped at their candidate cap (5,000 rows) and matched the
  channel only afterwards, so a channel whose rows sat past the cap showed nothing even though the channel list
  counted them (a 26,000-row CSV: `google_play` counted 70, listed 0). The channel is now part of the DynamoDB
  filter on the date and category indexes.

## [5.23.03] - 2026-10-22

Tests only.

### Fixed

- The inline logo preview's limits are pinned by tests: an empty body, an image over 5 MB and an answer without a
  `Content-Type` are refused, and an image of exactly 5 MB is shown.

## [5.23.02] - 2026-10-22

Logo previews encode their bytes directly.

### Fixed

- Company logos and reference logo previews (Knowledge → Company → Design system) are turned into `data:` URLs
  from the image bytes instead of through `FileReader`, which refused the fetched image on Node 22 and failed the
  quality-gates CI. What the page shows is unchanged.

## [5.23.01] - 2026-10-22

Tests only.

### Fixed

- The closed-card fields on `PUT /settings/my-onboarding` are now exercised against a DynamoDB table (repeat
  closes, the other fields kept, per-user scope, a bad value stores nothing).

## [5.23.00] - 2026-10-22

Home cards can be closed, and Home no longer carries dashboard shortcuts.

### Added

- Home → the "<agent> needs your decision" card has an **X** that closes it for that waiting run, for this user on
  every browser (`PUT /settings/my-onboarding {dismiss_decision_run}`; the GET lists the 50 newest closed runs as
  `dismissed_decision_runs`). Closing decides nothing: the run still waits on the agent's Runs tab and the sidebar
  badge still counts it, and a later run that stops for a person shows a new card. See
  [docs/briefing.md](docs/briefing.md).
- Home → the "Subscribe to the morning brief" card has an **X** that closes it for this user
  (`subscribe_prompt: dismissed`); Account → Morning brief still subscribes.

### Removed

- Home's **Open dashboard** button and **Open the dashboard when I sign in** switch. The dashboard stays in the
  sidebar, and the start-page switch stays on Account → Preferences.

### Upgrade notes

- Frontend and `VocApiStack` (the settings Lambda) deploy together; no new resources, no data migration.

## [5.22.00] - 2026-10-22

The design system now holds component styles, read from a website or a GitHub repository.

### Added

- Knowledge → Company → Design system → **Components**: buttons, inputs, cards, badges, tabs… each with up to 6
  variants (primary, outline, ghost…), their colours (or a colour token), border, radius, padding, size, font and
  shadow, hover and focus states, and a live preview; saved with the rest of the design system (`components` on
  `GET`/`PUT /settings/design-system`, up to 30).
- Live-website and GitHub references extract components with their styles: measured from the rendered page (and its
  hover/focus rules), or read from the repository's component sources (`cva`/Tailwind variant maps resolved to the
  repository's tokens). Each reference preview shows its components; **Use as design system** merges them by name and
  the banner counts them.
- The prototype, PRD and PR/FAQ prompts get a Components section and are told to use these styles; the Build prototype
  dialog lists component styles among what the design system provides.
- An example HTML snippet per component (advanced), rebuilt from an allowlist on the server and shown only in a
  sandboxed frame.

### Changed

- Applying a reference no longer appends a component list to the guidelines (components are their own section).
- After adding a reference the type goes back to Live website; a preview's font line shows each family's first name.
- A GitHub reference read uses up to 21 GitHub requests (was 13).

### Fixed

- The company logo and a reference's logo preview were blocked by the site's image policy; they are now loaded and
  shown inline without widening that policy.
- A reference's "fetched" time is stamped when its read finishes.

### Upgrade notes

- Deploys VocIngestionStack (the capture role may now store the logo preview under `company-context/design/`)
  and VocApiStack.

## [5.21.00] - 2026-10-22

Set up the design system from a live website or a GitHub repository with one click.

### Added

- Knowledge → Company → Design system → references: **Live website** (the new default). The page is opened in the
  AWS-managed secure browser (the one Web Reviews uses) and its colours, fonts, corner radii, spacing, logo and look
  are read from the rendered page and one screenshot.
- Every reference now shows what it yielded (colour swatches, fonts, counts, the logo) and a **Use as design system**
  button: it loads the reference into the editor as a draft with a change summary ("6 new, 2 updated", "Guidelines
  added"); nothing is saved until you press Save. **Use this logo** sets the reference's logo.
- `POST /settings/design-system/references/{id}/apply` (returns the unsaved draft) and
  `POST /settings/design-system/references/{id}/logo` (administrators). References carry `extracted_design`.
- A new Lambda, `voc-design-capture`, in VocIngestionStack (its own least-privilege role: the managed browser,
  Bedrock, the design-system rows only).

### Changed

- GitHub references read the whole repository tree and pick its design files (CSS variables, Tailwind `@theme`, theme
  and palette files, font faces, token JSON, logos, `components/ui`, theme docs) instead of only the top folder, so
  repositories that keep their design in sub-folders are read properly. Public repositories work without a token.
- Colour tokens also accept `oklch()`, `oklab()`, `lab()` and `lch()`.
- A reference being read shows "Reading…" and the page refreshes it until it is ready.

### Security

- Website and logo URLs are checked against the outbound URL policy (https, public addresses only) when added, after
  the page has loaded, and on every redirect of a logo download; logos must be PNG, JPEG or WebP and at most 2 MB.

### Upgrade notes

- Deploys VocIngestionStack before VocApiStack (`npm run deploy:infra` does this, then refreshes the API stage).
  Needs Amazon Bedrock AgentCore Browser in the region. Anonymous GitHub reads are limited to 60 requests an hour;
  one repository read uses up to 13.

## [5.20.00] - 2026-10-21

Prioritization scores rows on the metrics your team chooses; the document wizard's AI drafts start from what you
typed; prototypes can follow the company design system by choice.

### Added

- Prioritization → **Scoring setup** (administrators): name your own metrics (1–8 in use), give each a weight, say
  whether higher or lower is better, and what 1 and 5 mean. Templates: Current default, RICE, ICE and Value vs Effort.
  Metrics are archived, never deleted, so stored scores are kept. Everyone else sees **How scoring works** with the
  metrics, their share of the score and their direction. See [docs/prioritization.md](docs/prioritization.md).
- `GET /projects/prioritization/config` (signed-in) and `PUT /projects/prioritization/config` (administrators;
  `{axes, base_version}`, 409 when someone else saved first).
- Project → Build prototype → Also read: **Design system** (colours, type, spacing, guidelines and reference designs),
  ticked by default when the company has one, disabled with a link to set one up otherwise
  (`use_design_system` on `POST /projects/{id}/build-prototype`; absent = on, as before). The "Built from" footer
  says when it was used.

### Changed

- The board's sliders, team score, sorting, row summary, explainer and the phone ballot follow the configured
  metrics. The score is `Σ weight × value / Σ weight` over the metrics a person scored (a lower-is-better metric counts
  as 6 − value); the server now computes it too (`composite` on each row).
- `GET /projects/prioritization` and the public `GET /voting-sessions/{id}/config` include the metrics (`axes`); a
  score for an archived or unknown metric is refused with 400. The AI assistant describes the configured metrics.
- Project → Generate PRD / PR/FAQ, step 3: the AI drafts start from what you typed. A title, description or answer you
  wrote is improved and expanded, never replaced; empty fields are drafted from feedback
  (`POST /projects/{id}/documents/suggest-brief` takes `title` ≤ 200 and `feature_idea` ≤ 4,000 characters;
  `POST /projects/{id}/prfaq-autofill` also takes `answers`, up to 5 × 4,000; over a limit = 400). Drafting the five
  answers waits until the title and description are filled, and says so. Both AI buttons look and behave the same
  ("Draft with AI" / "Improve with AI").
- Design-system text that names a category a user cannot see is hidden from them, in Knowledge → Design system and in
  the prototype, PRD and PR/FAQ prompts they start.

### Fixed

- A typed customer answer could come back empty from the AI draft.
- "Built from" footers now show company context and memories for documents without web searches.

### Upgrade notes

- No migration: with no setup saved, the board uses the four original metrics and weights (impact 40, time to market
  30, strategic fit 20, confidence 10), and existing scores keep counting.

## [5.19.01] - 2026-10-21

"Other" can be granted to a restricted user.

### Fixed

- Administration → Privacy & access → Users → access: **Other** (reviews without a category) is offered as a category
  to grant, and `PUT /users/{username}/category-access` and the AI assistant's `set_user_access` accept `other` even
  though it is not a configured category. Before, the grant was refused as "not configured", so a restricted user could
  never be shown the Other row.

## [5.19.00] - 2026-10-21

Every review shows up in the category breakdown, every memory is tagged with its categories, and "Give full access"
no longer grants restricted sources.

### Added

- An **Other** row on Categories and the Dashboard category chart: reviews no configured category claims (no category,
  the fallback, or a category since removed from the configuration). The breakdown now adds up to the total; clicking
  the row lists those reviews (`category=other`). A restricted user sees it only when Other is granted.
- `voc-datalake/scripts/memory/backfill_categories.py`: tags existing memories with the categories they are about
  (dry run by default, `--apply` writes only the tags). See [docs/memory.md](docs/memory.md) → "Category tags".

### Changed

- Administration → Privacy & access → Users → access: **Give full access** now selects every category and every
  source that is not restricted, what a never-limited user sees. A restricted source is still granted separately.
- Every memory write is tagged with the categories it is about: hand-added, edited, merged and duplicate memories are
  classified from the configured list, not only extracted ones.

### Fixed

- The all-time category breakdown summed to less than the total (16,295 vs 17,066).
- A restricted user could read company memories about another category written in other words.

### Upgrade notes

- After deploying, run the memory backfill once as a dry run, then with `--apply`
  (`.venv/bin/python scripts/memory/backfill_categories.py --region <region> [--apply]` from `voc-datalake/`). It makes
  one Haiku call per untagged memory.
- Optional: run Administration → Taxonomy → Reprocess (processed reviews) to move reviews filed under removed categories
  into today's categories; until then they count under Other.

## [5.18.00] - 2026-10-21

A user with limited category access sees only their categories: their reviews, their counts and their category names.

### Added

- Dashboard, Categories and the Home tiles show restricted users a short note naming the categories they can see.
- Administration → Privacy & access → Users → access shows the user's current category and source rule, with a
  **Give full access** action (all categories and every source, restricted ones included; Save applies it).

### Changed

- Category names stay hidden too: a restricted user never sees another category's name through memory, company
  context (vision and objectives), resolved problems, research/document/persona grounding, the morning brief or the AI
  assistant, which no longer states how many categories the workspace has. The memory extractor tags the categories
  a memory names. See [docs/categories.md](docs/categories.md) and [docs/memory.md](docs/memory.md).
- People who cannot set up the workspace no longer see the "workspace is empty" welcome or the setup steps of the
  Home checklist; a restricted user with nothing visible is told which categories they can see, or to ask an
  administrator.

### Fixed

- A restricted user's totals now match their category totals for every window, all time included; a read that stops
  early says so (`partial_reason: 'time_budget'`, `scanned_through`).
- The project wizard could list built-in category names to a restricted user.
- Radar's comparison counted a review stored twice as two.

### Upgrade notes

- No data migration. Memories created before this release carry no category tags; for restricted users they are
  filtered by the category names their text mentions.

## [5.17.01] - 2026-10-21

Three Polish leftovers found on the live check.

### Fixed

- The morning brief's "Ask the assistant" button on a personal note is written in the brief language.
- Administration → System → Alerts shows the monthly cost with the language's decimal mark (Polish "1,70 USD").
- The Radar trend chart's sentiment axis uses the language's decimal mark ("-0,5").

## [5.17.00] - 2026-10-20

The morning brief follows the language you use the app in, and dates and numbers follow it everywhere.

### Changed

- The morning brief is written in the language you use the app in, unless you pick one under Account → Morning
  brief → **Brief language** ("Same as the app" by default, now shown before you subscribe too). Refresh on Home
  sends the app language (`POST /settings/my-briefing/refresh` takes an optional `{language}`; GET/PUT
  `/settings/my-briefing` carry `language_source: ui | chosen`). The scheduled brief and its email use the stored
  language, which follows the app while the source is `ui`. See [docs/briefing.md](docs/briefing.md).
- Dates, times and numbers follow the app language everywhere (Projects, Dashboard feed, Home tiles, Administration →
  System → Alerts, Agents, Data Explorer, Data sources, logs, the assistant's saved-document title); scores use the
  language's decimal mark ("+0,08"). PDF reports keep English dates.

### Fixed

- A reader who never subscribed got the morning brief in English on Refresh while using the app in another language.
- One name for the morning brief in Polish, Spanish and Korean.
- The Dashboard feed shows the translated sentiment, not "negative".
- Radar review counts use the language's plural forms (Polish "4 opinie").
- Data sources run frequencies ("Manual only", "Every 15 minutes") are translated.
- Polish AI-model labels in Administration → AI models.
- AI assistant: a conversation deleted in another tab or browser is no longer requested on every page load (a 404
  and a console error); the app forgets it after one try and opens a new empty conversation.

### Upgrade notes

- Stored brief preferences without `language_source` follow the app's language; a PUT naming only `language` counts
  as an explicit choice. No migration.

## [5.16.01] - 2026-10-20

Tests for the translation tool.

### Changed

- The pure parts of `voc-datalake/frontend/scripts/fix-i18n.mjs` (answer parsing, plural forms, list values,
  `--lang`) moved to `fix-i18n-helpers.mjs` with their own tests, run by `scripts/validate.sh`. No change to what
  the tool does.

## [5.16.00] - 2026-10-20

The app is now available in Polish.

### Added

- **Polish** as a ninth interface language (Account → Preferences → Language: "Polski"), with Polish plural
  forms. The morning brief can be written and emailed in Polish too.

### Changed

- The translation tool (`voc-datalake/frontend/scripts/fix-i18n.mjs`) uses Claude Haiku 5.5 and still sends each
  string with the page it belongs to and the UI code that shows it. It now takes `--lang <code>` to translate one
  language, adds the plural forms a language needs beyond English (Polish "few" / "many"), translates list values
  such as suggested responses, and leaves a failed string missing instead of filling it with English, so a
  re-run retries it.

## [5.15.00] - 2026-10-20

Radar set up in one place, one review window everywhere, a cache that only refreshes when reviews change, and
a full pass for clearer, readable screens.

### Added

- **Radar brand list** in Administration → Sources → Radar (up to 25 brands, each with its domains) drives the
  news and release scan (`GET`/`PUT /radar/brands`). Reviews reach Radar only from a source marked **Radar
  source** with a brand: a scraper, a Web Reviews page, an app connector or a CSV/JSON upload. A review with an
  unknown brand is refused, never filed with your own feedback. See [docs/radar.md](docs/radar.md).
- The AI assistant can read Radar and create Radar scraper sources (writes still need your approval); Home shows
  Radar cards.
- **One review window everywhere**: clicking a review on Dashboard, Categories, Problems, Radar, Home or in an
  assistant answer opens it in a window above the page (`?review=<id>`), with Copy link, sentiment in words
  ("Negative · 90 %"), the language name and similar reviews in the same language first. Back and Escape close it.
- **Account menu** at the top right: your initials open name, email, role, My profile and Sign out. The
  sidebar no longer shows your name or a Sign out button.
- **Caching**: API reads are answered from a warm-container memo and with ETags (`304 Not Modified`), and the app
  keeps feedback data for 5 minutes, so nothing is re-read until reviews, categories or settings change. See
  [docs/caching.md](docs/caching.md).
- `GET /metrics/sentiment` takes an optional `category`. With one category selected, the Categories sentiment
  card shows that category ("Sentiment · Technical Support").
- `POST /projects/prioritization/rows` also accepts `{project_ids: [...]}` (up to 25), so Prioritization loads
  with one request instead of one per project. `{project_id}` still works.

### Changed

- The /chat page has a collapsible conversation rail. Each conversation's Rename, Delete and Close live in one
  "More actions" menu, and export and notifications are labelled menu items.
- Assistant answers are plainer. They follow length requests, give Radar sources as short titled links, flag
  small samples, fold several tool steps into one "Looked at N things" row, and keep each conversation's draft
  to itself. Full screen stays full screen after a link.
- Text wraps instead of being cut off across the app (cards, tiles, menus, headings, tables) in every language
  and at 200 % text size. Numbers, percents, chart axes and dates follow the app language. The Radar comparison
  becomes stacked cards on narrow screens.
- Header controls share one height, one centre line and one neutral border, and the theme button is round like
  the account avatar.
- Costly or outside actions ask first: Data sources "Run now", persona generation and other AI generation. A new
  scraper defaults to Manual only.
- Naming: "Data sources" and "Source settings" are used everywhere. Radar sources read "Radar · <Brand>". Data
  Explorer says "100 shown, more available". Memory gets an "All statuses" filter.
- Eight Lambdas doubled under the 60 % CPU rule: Radar API to 2,048 MB; integrations, projects and metrics APIs
  and the memory scanner to 3,072 MB; logs API, briefing and agent heartbeat to 3,538 MB. See
  [docs/lambda-sizing.md](docs/lambda-sizing.md).

### Fixed

- Prioritization: saving one slider no longer resets the other three scores to 0.
- Radar: totals, trend and theme counts match the review list (duplicate imports counted twice), and a day's
  reviews show only that day, including the newest day. The review window shows the rating.
- Categories: the Overall Sentiment gauge is readable (number in the centre, words below in high-contrast text,
  a screen-reader description). The subcategory chip shows its label. The header total is formatted ("17,066
  reviews").
- Problems: the partial-period notice and the progress wording ("800 reviews read so far").
- The phone time-range menu no longer opens off the left edge of the screen.
- Feedback form delete, Data Explorer "Load more", Memory list refresh, the stale paste-draft notice, the "App"
  wording when deleting a review page, and agent failures reported as "not valid JSON".
- Conversations continue after a reload or a route change. Escape closes only the top-most layer.

### Security

- Per-user live routes (for example `/memory/imports/{id}`, `/chat/conversations/_list`) answer
  `Cache-Control: private, no-store`. Cached reads use `private, no-cache` with `Vary: Authorization`, never
  `max-age`, and each cache entry is keyed by the caller's access scope.

### Upgrade notes

- Deploys every stack; no data is migrated or deleted. Three version counter rows are created the first time
  data changes: `METRIC#meta/data_version` and `config_version` in `voc-aggregates`, and
  `SETTINGS#radar/version` in `voc-radar`.
- Radar brands now come from the brand list. Brands set on older source profiles are still merged in, and the
  old Source policies checkbox shows as a read-only note.
- The eight resized Lambdas cost about twice as much per call (pay-per-use). The integrations SnapStart cache
  goes from about $5.85 to $11.70 a month. Re-measure with `scripts/capacity/capacity-query.sh --hours 168`
  after a few days.

## [5.14.00] - 2026-10-18

Every Lambda sized to stay under 60 % of its memory and CPU.

### Changed

- The Lambda sizing ceiling is now **60 %** for both peak memory and CPU, for every function (it was 70 %, and
  60 % only for variable-payload memory). See [docs/lambda-sizing.md](docs/lambda-sizing.md).
- 25 functions get more memory, which on Lambda also means more CPU, measured in production over 14 days:
  - to 1,769 MB (one vCPU): agent heartbeat, briefing, feedback processor, logs API, agents API, ballots API
    and research step;
  - to 1,536 MB: agent conductor, memory scanner, integrations, metrics, projects, memory and scrapers APIs;
  - to 1,024 MB: aggregation processor, email intake, data explorer, Radar, settings, manual import and
    S3 import APIs;
  - to 512 MB: global MCP API, users API and the GitHub Issues webhook; to 256 MB: the MCP token authorizer.
- The 2026-10-06 Power Tuning pins (metrics, projects, agents, ballots, memory, settings) are kept as history
  and no longer exempt those APIs from the CPU rule.

### Upgrade notes

- Deploys VocApiStack, VocProcessingStack and (with the email inbox on) VocIngestionStack; no data change.
- Cost: a function's duration charge grows with its memory (worst case +50 % for 1,024 → 1,536 MB, +73 % for
  1,024 → 1,769 MB, +100 % for a doubling), usually less because the calls get faster. At current volumes that is
  cents to a few dollars a month. The SnapStart cache for the integrations and memory APIs rises from about
  $3.90 to $5.85 a month each.

## [5.13.01] - 2026-10-18

### Fixed

- Administration → Sources → Radar showed "Loading..." forever when the Radar overview could not be read;
  it now says so with **Try again**, and never claims that no brand is tracked.

## [5.13.00] - 2026-10-18

Radar setup in one place, and one scrollbar per page.

### Added

- Administration → Sources → Radar now starts with **Brands tracked**: each brand with its 90-day review
  count, its website domains and the source profiles feeding it, an **Add a brand** link to Privacy &
  access → Source policies, and a three-step **How Radar works** (add a brand, bring its reviews in,
  releases from the scheduled or on-demand web search). See [docs/radar.md](docs/radar.md).
- `GET /radar` brands carry `sources`, the ids of the source profiles that name the brand.
- The Radar page (`/radar`) has a **Configure** link for admins, and its empty state opens the Radar setup.

### Fixed

- A second, page-level scrollbar on Radar (and on any page with screen-reader-only text far down): the
  page's content scroller is now the containing block of its positioned children.

## [5.12.00] - 2026-10-18

Account uses the same top tab bar as every other page.

### Changed

- Account (`/account`) replaces its ten-item left rail with five tabs on the shared tab bar (the design
  system's segmented tabs, as on Company, Memory and the project pages): Profile (details, change
  password, sign out), Preferences (language and theme, Home setup and "How it works", assistant
  notifications and bubble position, this browser), Morning brief, Objectives, and Access & tokens (my
  access, MCP tokens). Each tab is a deep link, `/account?tab=<id>`; see
  [docs/account-vs-admin.md](docs/account-vs-admin.md).
- Links into Account now use `?tab=`: Home's brief Settings link and "Customise in Account" open
  `?tab=briefing`, Company's objectives link opens `?tab=objectives`, and "Go to settings" (shown when no API
  endpoint is set) opens `?tab=preferences`.

### Upgrade notes

- Bookmarks of the 5.09–5.11 form `/account?section=<id>` keep working: each opens the tab that now holds
  that card and is replaced by its `?tab=` URL.

## [5.11.01] - 2026-10-18

Polish found by the 5.11 live check.

### Fixed

- Feedback detail showed journey stage and impact area as stored ids ("post_purchase"); they now read
  as labels ("Post purchase").
- Agents → Run now could show the workflow id while its name was loading; it shows a placeholder, and
  the id only when the workflow cannot be read.
- Dashboard bar-chart source names were cut short on wide screens; the label axis has more room from
  the `sm` breakpoint up (phones keep the narrower axis).

## [5.11.00] - 2026-10-18

Second pass from the live verification: readable charts on phones, linkable Administration places.

### Changed

- Administration tab and section switches update the URL (`?tab=&section=`), so Back and copied links
  keep your place; switching tabs keeps an unsaved brand draft.
- Home's morning-brief card is a one-click Subscribe with a "Customise in Account" link; every brief
  setting lives on Account → Morning brief ([docs/account-vs-admin.md](docs/account-vs-admin.md)).
- Dashboard "Feedback by Source" is horizontal bars (top 8 plus "Other sources"); chart number axes use
  compact ticks (10K) sized to fit.
- Project documents can be linked directly (`/projects/{id}?tab=documents&doc=<id>`); Decisions →
  "PR/FAQ ready" opens that PR/FAQ.
- Source labels read web-review hostnames as domains ("trustpilot.com") and app names that already end in
  their platform the same way as the rest ("Example Air (iOS)").

### Fixed

- Dashboard axis labels and 5-digit ticks were cut off on phones.
- Data Explorer processed records showed raw category ids; Categories keywords did not use the configured
  category names; feedback dimension values without a label showed lowercase ids.
- Copy, error messages and docs that still pointed at "Settings → …" or pre-5.09 Administration tabs now
  name the current places (e.g. Administration → Taxonomy → Categories).
- A closed, expired or full vote page no longer shows instructions about fields that are gone; a refused
  ballot keeps its form so it can be sent again.
- After a plan is approved the assistant says it is running and that the plan card shows each step's
  result, instead of "I haven't seen any results yet".

## [5.10.00] - 2026-10-18

Fixes from a full production click-through: plan results, honest list counts, readable labels.

### Added

- Rename an AI-assistant conversation from the /chat sidebar or the conversations drawer; the name
  survives later replies (`PUT /chat/conversations/{id}/title`).
- `GET /voting-sessions?row_id=` returns a Prioritization row's open room vote.
- `GET /feedback/urgent` and `GET /feedback/search` page with `next_token` and report `total`/`has_more`;
  the feedback read routes take `rating_min`/`rating_max`.
- The assistant plan card and Agents → Plans show each analysis step's result (markdown, collapsed when long).
- /agents has a Workflows tab for admins; `/agents/workflows` opens it.

### Changed

- Opening a room vote asks for confirmation (it creates a public link); a row has at most one open vote,
  and a reloaded row shows its link, ballot count and Close the vote.
- Agents → New workflow and New agent ask for a name first; Run now asks for confirmation and names the
  agent, workflow, scope and call limit.
- An analysis step that finishes without a result is marked failed with a reason, and the plan ends
  completed with errors.
- Similar feedback is ranked by text similarity (same sentiment and source preferred, no unrelated padding).
- Data Explorer → Processed feedback search and the Categories rating filter run on the server.
- The assistant panel's open/closed state is per browser tab; its preferences stay shared.
- A prototype built without a title is named "<PRD title> prototype"; Connect tokens default to read-only;
  Memory tabs are in the URL (`?tab=`); the Company subtitle links to Account → My objectives.
- JSON upload imports the valid items and lists the skipped ones ("Item 2: text is required").

### Fixed

- Assistant plans: analysis steps without declared outputs stored no result although the plan reported
  success; results are now stored (redacted, up to 8,000 characters) and quoted in the plan summary.
- Categories "Urgent only" stopped at 100 with a wrong total; the rating filter only filtered rows already
  loaded; Data Explorer search undercounted.
- A failed agent run's summary names the failing step's reason; the project decision's "PR/FAQ requested"
  note goes away when the job ends and links the PR/FAQ.
- The assistant context chip showed raw keys ("pages.agents") on Agents, Memory and other pages.
- Category, subcategory, source and persona ids show as readable labels across the app and PDF exports;
  app-review sources no longer repeat their platform ("Acme Android android").
- Scraper auto-detect with zero reviews no longer reports success; manual import checks the URL; Company
  Save no longer fires for an empty objective; delete confirmations name the form or project; Web Reviews
  dialog wording; chart labels no longer clip at narrow widths.
- Accessible labels on the Prioritization and vote-page sliders and the Similarity select; vote-page copy
  says what is done with the optional name.

## [5.09.00] - 2026-10-18

Administration fits on one row; personal preferences all live on Account.

### Added

- Account (`/account`) has a section rail with deep links (`?section=`): Profile, Preferences, Morning brief,
  Assistant, Objectives, My access (read-only category scope), MCP, This browser, Password and Sign out.
  See [docs/account-vs-admin.md](docs/account-vs-admin.md), which records what belongs on Account (your own
  preferences) and what belongs in Administration (software settings, admin-protected).

### Changed

- Administration (`/admin`) has six tabs instead of eleven, so the tab bar no longer scrolls: General,
  Sources (Data sources, Integrations, Email inbox, Radar), Taxonomy (Categories, Dimensions), Privacy &
  access (Source policies, Users), AI models and System (Logs, Version). Each grouped tab has a section
  switch; URLs are `?tab=&section=` and every old `?tab=` link redirects to its new place.
- Save Changes appears on General only, the one tab whose fields it saves.
- The morning-brief settings moved from Home to Account → Morning brief; Home keeps the brief, Refresh and
  the subscribe prompt, and its Settings link opens Account.
- The Danger zone (reset local settings) moved from Administration → General to Account → This browser.
- "Go to settings" on Dashboard, Feedback Forms and Scrapers (shown when no API endpoint is set) opens
  Account → This browser instead of Administration, which non-admins cannot open.

## [5.08.01] - 2026-10-18

Tests only.

### Fixed

- The persona-panel mutation tests scripted the model's verdicts as an ordered list, but the panel consults
  personas on parallel threads, so a different thread interleaving on CI handed a verdict to the wrong
  persona (`test_a_blocked_review_is_not_agreed_and_counts_the_blockers`). The fake now answers per
  persona, named in the system prompt.

## [5.08.00] - 2026-10-18

Radar: read the reviews behind every number.

### Added

- **Radar → reviews dialog.** Click a love or hate theme, a quote, a day of the sentiment trend (bar or the
  keyboard day list), "Read all reviews", or a category's "Them" cell in "Compared with us" to read the
  reviews behind it: filter chips (category, subcategory, sentiment, day) that can be cleared, a sentiment
  select, full texts with "Show more", source links and "Load more" ([docs/radar.md](docs/radar.md)).
- `GET /radar/brands/{brand}/reviews?days=&category=&subcategory=&sentiment=&day=&cursor=&limit=` (signed
  in; the brand's visibility and the caller's category scope apply; 25 per page, at most 50).

### Security

- Review texts are PII-redacted on the way out; author and email are never returned; only http(s)
  source links are returned.

## [5.07.00] - 2026-10-18

Home: pending agent decisions as cards, brief settings always within reach, and collapsible sections.

### Added

- **Home → agent decisions:** a card for each autonomous agent whose last run waits for a person, with
  the reason, the step and when it stopped. Admins get "Make the decision", everyone else "Review the
  run" (both open the agent's Runs tab). While these cards show, "Things to do" drops its agent-runs row.
- **Home → Brief settings** is always on the page, also before subscribing (language and instructions
  can be set first), and a **Settings** button next to Refresh jumps to it.

### Changed

- **Home:** the setup checklist, Brief settings and How it works are collapsible (chevron) and start
  expanded. **Skip** collapses a section and is remembered per user: a skipped checklist now stays on
  Home collapsed instead of disappearing, and How it works has its own Skip. Expanding a skipped section
  un-skips it.
- `GET/PUT /settings/my-onboarding` carries a new field `guide` (`open` | `skipped`). The 400 for a body
  naming no field now reads "Give at least one of: state, start_page, guide".

## [5.06.02] - 2026-10-18

### Fixed

- **Radar → love / hate:** the same review text imported twice (a repost, a second import) is quoted
  once per theme instead of twice.

## [5.06.01] - 2026-10-18

Found by the live Radar review-ingest test.

### Fixed

- **Radar:** a Radar source's reviews are bucketed by the day they were written (`source_created_at`,
  else the import day), not the import day, so a backfill of another brand's history keeps its real
  sentiment trend ([docs/radar.md](docs/radar.md)). Reviews already stored keep their import day.
- **CSV upload** to a Radar source: the source picker and the "rows queued" note now say the rows go to
  the Radar page under that brand, not the Feedback page.

## [5.06.00] - 2026-10-18

Every Lambda warning and error found in the last 7 days of production logs, fixed at the cause.

### Changed

- **Scrapers → Auto-detect** (`POST /scrapers/analyze-url`): a target page that answers 404, 410, 5xx
  and similar now ends the job with the caller's 400 "The site refused the request (HTTP n)…" instead
  of a service error logged at ERROR. 403 and 429 keep the bot-wall message that points to Web Reviews.
  The scraper editor now shows that reason instead of a generic failure.
- **Aggregation processor:** a transient transaction cancellation that is retried logs at INFO; the
  single WARNING now fires only when the attempts run out and the stream redelivers the record.

### Fixed

- **Feedback enrichment** and every strict-JSON model answer (agents, reclassification) now decode an
  object wrapped in a code fence, followed by extra text, or carrying raw line breaks or tabs inside a
  string. Such answers used to fall back to default enrichment ("Failed to parse Bedrock response").
  An answer that is really cut off is still stored with default insights and its error, never dropped.
- **Autonomous agents:** the `aggregate_reviews` step's answer budget is sized for every review id it
  may cite, so it no longer stops with "still truncated after 0 continuation(s)".

## [5.05.02] - 2026-10-18

Tests only.

### Fixed

- Morning brief: a test pins that a built brief records the settings fingerprint the 5.05.01 Refresh check
  compares against.

## [5.05.01] - 2026-10-18

### Fixed

- **Morning brief:** Refresh right after changing the brief's language or custom instructions answered
  "Your brief is up to date" with the brief written for the old settings. A built brief now records a
  fingerprint of those settings, and a changed fingerprint rebuilds it (docs/briefing.md).

## [5.05.00] - 2026-10-18

Fixes from the end-to-end test of the 5.04 features in the browser and the Lambda logs.

### Changed

- **Alerting** (Settings → Logs → Alerts) now also watches the morning-brief DLQ (`briefing-dlq`) and,
  when the email inbox is on, the inbox DLQ (`email-intake-dlq`). See the alarm table in
  [docs/deployment.md](docs/deployment.md).
- **Email inbox:** under `-c protectData=true` the inbound bucket is now retained on stack deletion
  like the raw data lake (it holds the only copy of each received original). Its 90-day expiry is
  unchanged.

### Fixed

- **Home → Brief settings:** the time and language selects use the app's dropdown style and a
  label that names the field exactly.
- **Morning brief:** turning email off while the AWS confirmation is still pending no longer logs a
  warning; the expected case logs at info with its SNS error code, other failures still warn.

### Upgrade notes

- Turning alerting off and on again in Settings → Logs → Alerts creates the new DLQ alarms
  (each costs about $0.10 a month while it exists).

## [5.04.03] - 2026-10-18

Tests only.

### Fixed

- Morning brief: tests pin that the urgent-review read retries DynamoDB `UnprocessedKeys` and keeps the
  reviews in index order.

## [5.04.02] - 2026-10-18

Found in the live brief test: the first brief build failed on the urgent-review read.

### Fixed

- **Morning brief:** the urgent-review signal asked the urgency index (`gsi3-by-urgency`, an INCLUDE
  projection) for attributes it does not carry, so every brief build failed with a DynamoDB
  `ValidationException`. It now reads the keys from the index and the fields by key (BatchGetItem);
  a test pins the request against the index definition in `core-stack.ts`.

### Upgrade notes

- The `voc-briefing` role gains `dynamodb:BatchGetItem` on `voc-feedback`.

## [5.04.01] - 2026-10-18

Found in the live inbox test: a re-sent email under a new Message-ID became a second item.

### Fixed

- **Email inbox dedupe:** the same sender's same text re-sent under a new `Message-ID` within 14 days
  now joins its first thread and is counted as `seen_in_thread` instead of becoming a second item
  ([docs/email-intake.md](docs/email-intake.md)).

## [5.04.00] - 2026-10-18

Company knowledge reaches every shared output, Home becomes a per-user morning brief, projects record decisions, releases are watched, other brands get a Radar, and feedback can arrive by email.

### Added

- **Company knowledge in shared outputs.** Research, PR/FAQ, PRD, prototypes, personas and agent outputs are
  grounded in the company context (vision and company objectives) and in COMPANY memories, never in anyone's
  personal memories or objectives. Personas use only `product` and `customer` memories; the persona panel,
  enrichment, category reprocess and the memory extractor get none. See [docs/memory.md](docs/memory.md).
- **"Built from" shows the knowledge used**: company memories, web searches and company context, next to the
  reviews, on every generated document (`derivation.memory_ids`, `web_search_count`,
  `company_context_included`, written only when used).
- **The assistant knows the company**: a short company context plus the caller's own objectives is added to
  every assistant turn ([docs/company-context.md](docs/company-context.md)).
- **Agent steps search the web** (`deep_research`, `custom_llm`), on by default with a cap of 10 searches per
  run and a per-step switch in the workflow editor.
- **Morning brief on Home**, per user: greeting, metric tiles, evidence-linked cards (what's new, trending,
  sentiment shift, spike and urgent alerts, release watch), "Things to do" (agent runs waiting for a decision,
  memories to review, MCP tokens expiring), Refresh (anyone, free debounce), subscribe at an hour and time
  zone, language, custom instructions, optional plain-text email to the user's own verified address. Card
  buttons open a new assistant conversation with the prompt prefilled, never sent. Routes
  `GET/PUT /settings/my-briefing`, `GET /settings/my-briefing/brief`, `POST /settings/my-briefing/refresh`,
  `PUT /settings/my-briefing/cards`. See [docs/briefing.md](docs/briefing.md).
- **Decision records** on projects (Decisions tab): Pursue / Park / Reject with rationale, success metric, kill
  criterion and evidence; Pursue can seed a PR/FAQ. Routes `POST/PUT /projects/{id}/decisions`,
  `POST /projects/{id}/decisions/{doc}/pursue`.
- **Release watch**: before/after volume and sentiment per GitHub release or dated launch, with a regression
  flag (`GET /metrics/release-watch`, Dashboard → GitHub, launched decisions, and a brief card). See
  [docs/decisions-and-release-watch.md](docs/decisions-and-release-watch.md).
- **Radar** (`/radar`): another brand's love / hate themes, sentiment trend, releases found by our web search
  (with citations) and a per-category comparison with us. A source becomes a Radar source with the
  "Radar source: tracks another brand" checkbox in Administration → Sources; its reviews go to the new
  `voc-radar` table and never into our own numbers. Administration → Radar sets the scan cadence, brands and
  query cap; the assistant gets a read-only `get_radar` tool. Routes `/radar/*`. See [docs/radar.md](docs/radar.md).
- **Email inbox** (off by default): `-c inboundEmailDomain=<host>` (+ optional `inboundEmailHostedZoneId`,
  `inboundEmailRuleSet`, `inboundEmailCreateIdentity`) receives feedback by email through SES, with spam/virus
  checks, daily caps, auto-reply and bulk filtering, thread and quote-aware dedupe, forwarded originals,
  attachment summaries and PII redaction by default. Settings → Sources → Email inbox shows the addresses,
  today's counters and the caps (`GET/PUT /settings/email-inbox`). See [docs/email-intake.md](docs/email-intake.md).

### Changed

- **Research searches the web by default** (the start-research box is pre-ticked; the API and the assistant's
  `start_research` treat an omitted value as on; an explicit `false` still opts out). PR/FAQ and PRD reuse the
  research findings; personas never search.
- Generic document edit and restore answer 400 for a decision record (edit it in the Decisions tab).
- The processor waits for (and fails closed on) the source profiles before storing any review, so a Radar
  review can never land in `voc-feedback`; SQS retries meanwhile.
- `voc-watermarks` gets a TTL attribute (`ttl`) for the inbox's thread state.
- The web-search gateway target is pinned to connector version 1.2.0 (domain and date filters).

### Security

- Web queries are planned only from the question and feedback statistics, never from memory or company
  context text.
- Brief emails go only to the account's own verified Cognito email; brief cards, quotes and prompts are
  limited to the categories the reader can see.
- Inbound email is never answered; email text, attachments and web results reach the model only as DATA
  blocks; the SES rule may write only `inbound/*`.
- Email inbox hardening ([docs/email-intake.md](docs/email-intake.md)): past the overall daily cap mail is
  deferred and retried after 00:00 UTC (counted `deferred`, `EmailDailyCapHit` metric), never dropped; the
  per-sender cap counts an unauthenticated sender (no SPF or DKIM `PASS`) per domain; emails over 25 MB are
  dropped from their size before download (`too_large`, replacing `oversize`); attachments are sized
  before decoding and only decoded when read; recursion/memory failures and `message/rfc822` nested over 3
  deep are `unparseable`. The inbox's KMS key-policy statements now also require `aws:SourceAccount` and
  `aws:SourceArn` (the receipt rule; the inbound bucket). Radar article-page fetches stop reading at 300 KB.

### Upgrade notes

- New resources: `voc-radar` table (VocCoreStack); `voc-briefing` worker, queue, DLQ, topic and 15-minute
  dispatch rule, and `voc-radar-scan` worker with a daily tick (VocProcessingStack); `voc-radar-api`
  (VocApiStack). Everything stays idle until someone subscribes, presses Refresh or marks a Radar source.
- The research, document and persona generator roles gain read on the memory table and Titan Embed V2
  invoke; the agent nodes Lambda gains InvokeGateway when web search is deployed. Web search costs about
  $7 per 1,000 queries.
- The connector pin is applied by a custom resource in VocWebSearchStack (`UpdateGatewayTarget`, in place;
  the tool name does not change). If it fails, VocWebSearchStack rolls back and the rest is unaffected.
- Email inbox: only one SES receipt rule set is active per region. Pass `-c inboundEmailRuleSet=<active set>`
  to add the rule to it; otherwise a new set is created and must be activated by hand. Originals are kept
  90 days under `inbound-raw/` and are not reached by erasure. Radar items are not covered by retention or
  erasure either.

## [5.03.00] - 2026-10-17

The global MCP server speaks the 2026-07-28 protocol alongside the older versions, and refuses GET/DELETE the way the spec asks.

### Added

- **MCP 2026-07-28 support** on `POST /mcp/global`, next to the legacy versions (2025-11-25, 2025-06-18,
  2024-11-05). Clients on the new protocol need no handshake: `server/discover` lists the versions,
  capabilities and instructions, results carry `resultType` and the server identity, and `tools/list` adds cache
  hints. The mirrored `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers must match the request body, or
  the request is refused (`HeaderMismatch`, -32020). Existing clients (Kiro, Claude Code, Copilot) see no change.
  See [docs/mcp.md](docs/mcp.md).

### Changed

- An unknown MCP protocol version is now answered with the spec's `UnsupportedProtocolVersionError` (-32022,
  HTTP 400, `data.supported` + `data.requested`) instead of a generic -32600, so a newer client knows to retry
  with a supported version.

### Fixed

- `GET` and `DELETE` on `/mcp/global` answer **405 Method Not Allowed** with an `Allow` header, as Streamable HTTP
  requires, instead of an API Gateway 403 that a strict client could mistake for an authentication failure.
  They are API Gateway mock methods behind the same token authorizer as `POST`: no Lambda runs.

### Upgrade notes

- `VocApiStack` gains two API Gateway methods (`GET`, `DELETE` on `/mcp/global`) and their stage throttles; deploy
  with `npm run deploy:infra` (it ends with the API stage refresh). No data or token changes.

## [5.02.00] - 2026-10-17

Research reports read as much feedback as the model's context allows, no longer capped by the workflow state size.

### Changed

- **Research reads far more feedback.** The research workflow used to carry the feedback block through its Step
  Functions state, which capped it at 50,000 characters (for example 33 of 50 items). The block now goes to the raw
  data bucket under `scratch/research_jobs/<job_id>/` and the analysis step reads it from there, so the sample is
  sized by the selected model like persona and document generation: with the default 200 K-token models,
  320,000 characters and up to 145 items. The "based on N of M items" notice on the job still reports what reached
  the model. The scratch object is deleted when the job completes or fails.

### Fixed

- Tests: the backend test run no longer ends with a `ResourceWarning` about an unclosed socket.

### Upgrade notes

- `VocProcessingStack` only: the research Lambda gains `RAW_DATA_BUCKET` and read/write on the raw bucket's
  `scratch/research_jobs/*` prefix. The raw bucket is versioned, so a deleted scratch object stays as a noncurrent
  version until the bucket's 90-day noncurrent-version rule removes it.
- A research job that is between its first and second step while the stack updates still completes: the analysis
  step accepts the inline block an older execution carries.

## [5.01.01] - 2026-10-17

Fixes from a live end-to-end sweep of 5.01.00 (browser, assistant, jobs and every log group).

### Fixed

- **Settings → Logs → Alerts failed to load (HTTP 502)**: CloudWatch authorizes `DescribeAlarms` (a list call)
  against `alarm:*` even when it is filtered by name prefix, so the alerts API was refused. The logs API now holds
  `cloudwatch:DescribeAlarms` on `alarm:*` (read-only); creating and deleting alarms stays limited to the
  deployment's `voc-alerts-…` prefix.
- **Client errors no longer log as warnings.** A 400, 404, 409 or 413 from any API, and a rejected assistant run,
  log at INFO (403 stays WARNING, server faults stay ERROR), so a WARNING in the logs means something an operator
  should look at.
- The "this generation read only part of the matching feedback" notices for personas, documents and research, and
  the Bedrock "hit maxTokens, auto-continuing" notice, log at INFO: both are the designed path and are already
  reported on the job (the warning that output is still truncated after every continuation stays).
- Tests: shared table-cache fixtures restore the cached tables afterwards, so a module that bound a table at
  import keeps matching the accessor (an order-dependent failure).

### Upgrade notes

- Deploy VocApiStack (and every stack that ships the shared Lambda code): `npm run deploy:infra`, with
  `-c protectData=true` on a production deployment.

## [5.01.00] - 2026-10-17

Production deployments can keep their data whatever happens to the stacks.

### Added

- **`-c protectData=true` (or `"protectData": true` in `cdk.context.json`) for production deployments**: the data
  tables, the raw-data bucket, the KMS key, the design-integrations secret and the Cognito user pool are kept when
  the stacks are deleted or a resource is replaced (CloudFormation `RetainExceptOnCreate`), DynamoDB tables and the
  user pool get deletion protection, and the raw bucket has no auto-delete provider. Off by default, so demo and
  temporary deployments still clean up fully. A value other than true/false fails the synth. See "Production:
  protectData" in [docs/deployment.md](docs/deployment.md).

### Upgrade notes

- **Deploying for production? Set `protectData`.** Turning it on for an existing deployment changes only deletion
  policies and protection; nothing is replaced. To tear a protected deployment down on purpose, deploy once with
  `-c protectData=false`, then delete the stacks.

## [5.00.00] - 2026-10-17

The AI assistant takes over bulk admin work (review import, plugin toggles, many users at once, Word/Excel/CSV
attachments), alerting becomes an opt-in setting with no cost while off, personas are written one model call each,
and deleting the stacks now cleans up all data. Major: a deploy context key is removed and teardown semantics change.

### Added

- **Settings → Logs → Alerts** (admin): turn the operational CloudWatch alarms on or off and manage notification
  emails (SNS email subscriptions, shown as pending until the recipient confirms AWS's email). Turning alerting on
  creates the alarms at runtime: the five dead-letter-queue depth alarms, processor and aggregator errors, aggregator
  stream lag and ingestor errors (8 + one per enabled ingestor, billed per alarm metric only while on). Routes
  `GET|PUT /logs/alerts`, `POST /logs/alerts/recipients`, `POST /logs/alerts/recipients/remove`. See
  [docs/deployment.md](docs/deployment.md) (#247).
- **AI assistant: `import_reviews`** (admin, approval card): imports reviews the assistant extracted from pasted text
  or an attached file through `POST /scrapers/manual/json-upload`, up to 500 per card, de-duplicated on re-import.
- **AI assistant: `set_source_enabled`** (admin): turns a plugin's schedule on or off; it can be a step of an
  approved plan.
- **AI assistant: `create_users`** (admin, approval card): creates up to 25 users in one approval, with the same
  checks as `create_user`; it stops at the first failure and reports who was created.
- **AI assistant attachments** accept Word (doc, docx), Excel (xls, xlsx), CSV, HTML, text and Markdown files, read
  natively by Bedrock, as well as images and PDFs (up to 5 documents; about 2 MB of attachments per message).
  See [docs/assistant-plan-mode.md](docs/assistant-plan-mode.md).

### Changed

- **Persona generation plans the personas first, then writes each one in its own model call** (up to 4 at once).
  One bad answer now costs one persona (retried once, then dropped and counted) instead of the whole set. New metric
  `PersonaCallFailed`; job metadata gains `parse_tiers` and `personas_planned` (#235).
- **Saved research report titles end with their UTC creation date and time** (`— 2026-10-17 14:05 UTC`), so two
  runs on the same question are told apart.
- **Deleting the stacks deletes all customer data**: the feedback, aggregates, projects, memory and agents tables,
  the raw-data bucket (every object version), the design-integrations secret and the KMS key (after a 30-day pending
  window). While the platform runs nothing changes: no TTL on customer data and no delete routes. Back up first:
  see "Teardown deletes everything" in [docs/deployment.md](docs/deployment.md) (#248).
- `docs/deployment.md` explains that `anthropicUseCase` values are embedded in the synthesized template, when the
  use-case submission is unnecessary, and why model agreements are still created (#272).
- Dev dependencies: vitest 4.1.11 (pinned exactly, with `@vitest/coverage-v8`) in the CDK app and the stream Lambda,
  `@humanfs/node` 0.16.8, browserslist 4.28.9, baseline-browser-mapping 2.11.21.

### Removed

- **The always-on dead-letter-queue alarms and the `-c alarmEmail` context key.** Alerting is configured in
  Settings → Logs → Alerts instead.

### Fixed

- Research reads every page of the project's personas and documents, not only the first 1 MB.
- A prioritization row that stores the same document twice is no longer labelled "Crosses generations" (#399).
- `GET /sources/status` answers "not scheduled" for a known plugin without a schedule rule now that the role may
  only describe the enabled plugins' rules.
- The audit and steering-sync prompts in `.kiro/prompts/` match the current stack layout; test fixtures use generic
  names; the post-deploy e2e check accepts a deployment with alerting off.

### Security

- **The integrations API may describe, enable and disable only the exact schedule rules of the enabled plugins**,
  not a name wildcard; the matching cdk-nag suppression is gone.
- The alerts API may manage only alarms under the deployment's `voc-alerts-` prefix and subscriptions of the one
  ops topic; every write is admin-only, emails are validated, capped at 10 and never logged.
- `GET /scrapers` stays open to signed-in users by recorded decision: no scraper config holds a credential (#398).
- **A CloudFormation replacement never deletes data**: the data tables, the raw bucket, the KMS key and the Cognito
  user pool are deleted with the stack but carry `UpdateReplacePolicy: Retain`, so a change that forces a
  replacement keeps the old resource.
- Assistant approval cards: `import_reviews` lists every row (scrollable, with title and link), not a sample, and
  `create_users` flags each administrator with a warning badge and a count, so an injected row in a pasted or
  attached list stands out. The stream Lambda enforces the attachments' total size, not only each one's.

### Upgrade notes

- **The next deploy deletes the five `…-messages-visible` alarms and any `alarmEmail` email subscription.** Remove
  `alarmEmail` from `cdk.context.json` (an unknown key is ignored), then turn alerting on in Settings → Logs → Alerts
  and add the addresses there; each recipient confirms AWS's email.
- **Deletion policies switch to DESTROY on the next deploy; nothing is deleted until the stacks are deleted.** Before
  any `cdk destroy`, back up the raw bucket and export the tables (docs/deployment.md). Resources left behind by an
  earlier stack deletion (RETAINed) must still be removed by hand. Never change `deploymentPrefix` on a live
  deployment: the raw bucket's auto-delete provider empties the old bucket when its name changes.
- Persona generation uses more Bedrock input tokens: roughly 2× at 3 personas and 4.5× at 8 (each persona call
  carries the analysis and the feedback sample), up to 4 calls at once against the documents model's quota.
- Deploy all stacks together (`npm run deploy:all`): the frontend and the stream Lambda carry the new assistant tools.

## [4.01.00] - 2026-10-17

Follow-ups from the open GitHub issues and pull requests: research reports say how much feedback they read,
tighter Lambda invoke permissions, safer logs and ingest links, and the i18n audit in `npm run check`.

### Changed

- **Research reports size their feedback sample from the selected model** (the `documents` surface) instead of a
  fixed 50 reviews / 50,000 characters, trim at whole reviews, and record how much they read: the job result
  (`metadata.feedback_usage`, shown by the job list's truncation notice), the saved document
  (`feedback_items_used`, `context_truncated`) and the report header ("N of M items read"). The sample stays
  bounded by Step Functions' 256 KB state limit (#231).
- **The processing queue refuses a `url` / `source_url` containing a control character** (CR, LF, tab, NUL, DEL,
  C1), an invisible format character (zero-width, bidi override) or a Unicode line separator, or made only of
  whitespace, and trims whitespace around a link. Plugin authors must emit clean links; see
  `plugins/_template/README.md` (ported from PR #421, thanks to its author; #412).
- **On Scrapers, a non-admin sees why they cannot create a web scraper** ("Only admins can add web scrapers.")
  instead of a create button that would fail (#398).
- `npm run check` now runs the i18n audit (new `npm run check:i18n`: the i18n script tests and the locale audit;
  it never rewrites locale files). See [docs/deployment.md](docs/deployment.md) (#257).

### Fixed

- **The aggregator's DynamoDB stream source bisects a batch on a function error**, so one bad record no longer
  holds back up to 100 valid records' metric updates (#253).
- **Deleting a persona no longer fails with a 500 when the project's persona count is already zero or missing**:
  the persona is deleted and the count floored at zero (#267).
- `POST /sources/{source}/run` for a known plugin without an ingestor in this deployment still answers
  "Ingestor Lambda not found" now that the role may not invoke it.
- The webhook base class's docstring no longer implies it verifies signatures; each plugin handler does (#267).
- The security-review prompt (`.kiro/prompts/aws-security-review.md`) no longer claims a WAF is deployed and
  lists the current stacks and API Lambdas (#246).
- Correction to an earlier release note: CDK seeds a plugin's secret keys only when the secret is first created,
  so a deployment whose secret predates a plugin has no `<plugin>_*` keys and that plugin fails closed. Save its
  credentials in Settings, then re-enable its schedule if the circuit breaker tripped (#398).
- Tests: plugin tests force placeholder AWS credentials, so credentials exported in a developer's or CI shell can
  never sign a request (#398); the plugin-identity guard in the secret loader is pinned by outcome (PR #400);
  `setNested` in the i18n fixer moved to `frontend/scripts/set-nested.mjs` with tests that fail if its
  prototype-pollution protection is removed (#347, PR #370); stronger Settings and Prioritization lineage
  copy tests (#398, #399); the API test suite clears the integrations handler's cached plugin list after each test,
  so a test that parsed its own list can no longer fail a later one on the same worker.

### Security

- **The integrations, scrapers and manual-import API roles may invoke only the exact Lambda functions they use**
  (each enabled plugin's ingestor, the webscraper ingestor, the manual-import processor) instead of a name
  wildcard (#234).
- **Persona-generation and research logs no longer record filter values or user-written custom instructions**,
  only a bounded summary (counts, days, date basis) (ported from PR #330, thanks to its author).

### Upgrade notes

- Deploy VocApiStack and VocProcessingStack (`npm run deploy:infra`): the IAM grants, the stream bisect setting and
  the research state machine change. No layer rebuild is needed.

## [4.00.10] - 2026-10-17

Tests only: pin the `knip-production` config check against every non-object `knip.jsonc`.

### Fixed

- `voc-datalake/scripts/knip-production.test.ts` now covers `null`, a number and a string at the root of
  `knip.jsonc` (not only `[]`), and an empty file reading as an empty config.

## [4.00.09] - 2026-10-17

Tooling: follow-ups from the earlier quality-gates review (PR #425).

### Changed

- `npm run lint` and `scripts/validate.sh` now lint the shared gate rules in `eslint-rules/` themselves
  (new `npm run lint:gates`, config in `eslint-rules/eslint.config.mjs`), under the same source and
  suppression rules as the packages.
- `npm run check` builds the SPA before `test:cdk`, whose synth needs `frontend/dist`
  (it failed with `CannotFindAsset` on a fresh clone). See [docs/deployment.md](docs/deployment.md).

### Fixed

- `@types/estree`, used by the gate rules' type annotations, is now a declared devDependency of
  `voc-datalake/` instead of a transitive one.
- `scripts/knip-production.mjs` rejects any `knip.jsonc` that TypeScript reports as invalid (a JSON
  array, `null`, a number or a string) with TypeScript's diagnostic; the old `typeof` check could never fire.
- The `.knip-production-*/` scratch directory is gitignored.
- Removed the frontend ESLint config's dead pending-spec switch (specs have been linted for a while).
- `test_without_the_filter_powertools_does_warn` no longer fails intermittently under parallel pytest: the
  logging-warning tests clear Powertools' process-wide metric store before flushing.

## [4.00.08] - 2026-10-17

CodeQL is now a validate.sh gate, and every finding it reported is fixed.

### Added
- **`scripts/validate.sh` runs CodeQL** (security-and-quality, JS/TS and Python) in its own lane and fails on any error or warning. Install the CLI with `brew install codeql`; the step takes about 5 minutes on half the cores. On GitHub Actions it skips itself, because the repository's code scanning runs the same analysis on every PR; `VALIDATE_SKIP_CODEQL=1` skips it locally. Accepted findings stay listed, each with its reason, in `scripts/codeql-summary.mjs`.

### Fixed
- **CI type check:** the Lambda layers pinned `tenacity>=8.2.0`, so CI installed 9.2.1 while local runs had 9.1.4, and pyright rejected the retry logger shim against the newer protocol. Both layers now pin `tenacity==9.2.1` exactly, and the shim accepts either signature.
- **CodeQL findings:**
  - A regex escape in a theme test now escapes backslashes too.
  - The mutation planner writes its plans under `.cache/mutation/` instead of the shared `/tmp`.
  - The i18n fixer checks for prototype-polluting keys on each path segment as it walks.
  - The test `ResizeObserver` stubs accept the observer callback.
  - The web-reviews page hook is a dataclass default factory, not a class attribute.
  - Seven tests whose assertions CodeQL couldn't follow, or whose shape it misread, are reshaped; what they assert is unchanged.

### Upgrade notes
- The ingestion and processing layers pick up `tenacity` 9.2.1 on the next `npm run build:layers`, and it's deployed with the layers. It is the latest release; retry behaviour is unchanged.

## [4.00.07] - 2026-10-17

Repository hygiene. Docs and comments only; nothing deployed changes.

### Removed
- **Planning notes are no longer tracked.** Git now ignores the todo list, the feature backlog and the 4.00.06 index in `docs/history/`, and the `.kiro/specs/` working spec; the files stay on disk as local files. `.gitignore` keeps todo, backlog, spec, pending, audit, request, handover and roadmap notes out of the repo from now on. This replaces the 4.00.06 move to `docs/history/`.

### Changed
- Code comments that cited those notes ("todofeatures §6.x", the long-running-llm spec, the mutation handover) now cite the maintained docs (`docs/mcp.md`, `docs/feedback-forms.md`, `lambda/shared/assist_jobs.py`), or drop the citation where the sentence stands on its own.

## [4.00.06] - 2026-10-17

Repository cleanup. Docs and tooling only; nothing deployed changes.

### Changed
- **Root planning notes moved to `docs/history/`.** `todo.md` (agent handover notes) and `todofeatures.md` (the finished feature backlog) moved there, with a short index (`docs/history/README.md`). Code comments still cite them as `todofeatures §6.x`; the three that named `todo.md` by path now point to the new location.
- **The pre-push AI review hook moved to `scripts/git-hooks/pre-push`.** Git never ran it from `.kiro/hooks/`. CONTRIBUTING.md now explains how to install it.
- **Steering `structure.md`** lists the current root layout (scripts, tools, eslint-rules, docs/images, docs/history) instead of dead-code scripts that no longer exist. `tech.md` gives the real Lambda runtime (Python 3.14; the assistant stream runs on Node.js 22).

### Removed
- `docs/SYSTEM_DOCUMENTATION.md`: a stale ten-entry index, superseded by the README's documentation table. The embed-snippet route check keeps covering `docs/feedback-forms.md`.
- `.kiro/prompts/consolidate-markdown.md`: an obsolete prompt that pointed at a non-existent file and would have deleted docs.
- `voc-datalake/scripts/test-plugin-loader.ts`: a framework-less test script nothing ran. `lib/plugin-loader.test.ts` (vitest, 29 cases) covers the plugin loader.
- `voc-datalake/schemas/feedback-event.schema.json`: nothing loaded it. Queue messages are validated by the Pydantic schemas in `lambda/shared/ingest_schemas.py`.

## [4.00.05] - 2026-10-17

Docs only.

### Changed
- **README rewritten around current screenshots and an AWS architecture diagram.** The outdated demo GIF (`static/VoC Demo.gif`) is gone. Five screenshots from the local mock with fictional sample data replace it: dashboard, AI assistant, categories, a project and autonomous agents. A draw.io diagram with AWS icons shows the three flows (ingest and enrich, explore and act, long-running work), and each flow is explained underneath. The editable diagram is `docs/images/architecture.drawio`. The feature list, built-in data sources (Web Reviews, GitHub Issues), tech stack and documentation index are brought up to date.

## [4.00.04] - 2026-10-17

Tests only.

### Fixed
- **A guard test now fails if a backend test module sets "today" (or "yesterday") once at import again**, the pattern behind the midnight-UTC failures fixed in 4.00.03 (`lambda/shared/test/test_clock.py`).

## [4.00.03] - 2026-10-17

Tests only.

### Fixed
- **The backend test suite no longer fails when a run crosses midnight UTC.** Ten test modules worked out "today" once, when they were imported. A run that started before 00:00 UTC then seeded yesterday's date partition while the code under test queried today's, so every count read 0. They now read the clock when each test runs, through a shared helper (`lambda/shared/test/clock.py`). One unused date constant was removed.

## [4.00.02] - 2026-10-16

Two fixes from an end-to-end log and browser sweep.

### Fixed
- **`/agents/workflows` opens the workflow library** (on `/agents`) instead of trying to load an agent named "workflows" and showing a 404 in the console. The address bar leads there when a workflow's own URL is trimmed, and the Workflows breadcrumb already pointed at `/agents`.
- **Every model call is named in the logs.** Category generation, scraper URL analysis, document remixing, feedback enrichment and category reprocessing logged as `step 'unknown'`, so their latency, token and truncation lines could not be told apart. They now log as `generate_categories`, `analyze_scraper_url`, `document_merge`, `feedback_enrichment` and `category_reclassify`.

## [4.00.01] - 2026-10-16

Tests only.

### Fixed
- **Unit coverage for the shared assist-job helpers** that the settings and scrapers routes now use to start a job and answer 202, including the refusal when no worker Lambda is configured.

## [4.00.00] - 2026-10-16

Model calls no longer race API Gateway's 29-second limit: seven AI routes now start a background job and answer at once, and the AI assistant can stream for up to 15 minutes.

### Changed
- **Seven AI routes answer `202 {success, job_id, status: 'pending'}` instead of the result** (breaking for API callers). Poll until `status` is `completed` (the old response body is in `result`) or `failed` (`error`):
  - `POST /settings/categories/generate` → `GET /settings/jobs/{job_id}`
  - `POST /scrapers/analyze-url` → `GET /scrapers/jobs/{job_id}`
  - `POST /projects/{id}/prfaq-autofill`, `/documents/suggest-brief`, `/research/suggest-questions`, `/product-context/interview` and `/personas/{pid}/regenerate-avatar` → `GET /projects/{id}/jobs/{job_id}`

  Input checks (400/403/404) still answer at once. The settings and scrapers jobs are visible only to the user who started them; project jobs follow the project's view access. These jobs don't appear under Background jobs, and their rows expire after a day. The web app polls for you, so the pages work as before, but a long answer no longer fails with a 504.
- **The work runs on three new 15-minute worker Lambdas**, `voc-projects-assist`, `voc-settings-assist` and `voc-scrapers-assist`. Each runs the same code and permissions as its API Lambda. A design-reference refresh also runs on `voc-settings-assist`, and the settings API no longer invokes itself.
- **The AI assistant (`POST /chat/stream`) can run for up to 15 minutes** (was 5). The integration timeout, the Lambda timeout and the Bedrock request timeout are all 900 s. A saved run counts as stalled only after 960 s without progress. The assistant's `analyze_scraper_url` tool starts the job and waits for it.

### Upgrade notes
- Deploy with `npm run deploy:infra`: it ends with the API stage refresh, which the changed routes need. The deploy adds three Lambdas and their log groups to `VocApiStack`.
- Scripts and integrations that call the seven routes directly must now poll the job route. `/mcp/global` doesn't expose them.
- `POST /settings/model/test` stays synchronous.

## [3.26.03] - 2026-10-16

### Fixed
- **The "per-field caps clipped" report reaches CloudWatch again.** 3.26.01 lowered it to INFO, but this module logged through Python's own logger, which the Lambda runtime sets to warnings only, so the line disappeared. It now goes through the shared structured logger, as JSON with each clipped field's count.

## [3.26.02] - 2026-10-16

### Fixed
- **Persona analysis gets the same 16,000-token output budget as the research steps** (up from 12,000 in 3.26.01). A live run after 3.26.01 wrote about 24,000 characters and still needed one continuation call; research ran in one call each.

## [3.26.01] - 2026-10-16

Fixes from an end-to-end sweep of the browser console, API Gateway and every VoC log group.

### Fixed
- **Persona generation and research no longer run out of output room mid-answer.** The models think inside the same budget as their answer. The persona analysis step had 4,000 tokens and was cut off (one run stopped at 6,055 characters after three continuations, with its last continuation empty). The research steps had 9,000 and needed one to four continuation calls per run. The budgets are now 12,000 for persona analysis and 16,000 for each research step (data analysis, synthesis, validation), so a full answer arrives in one call. Jobs are not slower: the same text arrives with fewer calls, well inside the 15-minute limit.
- **The "per-field caps clipped" log line is now informative and no longer a warning**: it fired on every persona, research and document job as a WARNING with no numbers, because the counts were dropped on the way to CloudWatch. It is now an INFO line that names each clipped field and its count. Clipping long reviews to fit the model's context is by design, not a fault.

## [3.26.00] - 2026-10-16

### Added
- **Rename and Delete on the agent list** (Autonomous agents, admins): each agent row has a pencil to rename it and a bin to delete it. Delete asks first, then the agent stops running and leaves the list. Its past runs, and the projects and documents it made, are kept, and a run in progress finishes first. It is the same as Archive on the agent's page.

### Changed
- The name dialog is now shared by the workflow editor's "Save as…" and Rename in the workflow library and the agent list.

### Fixed
- docs/autonomous-agents.md now documents the workflow Rename added in 3.25.00.

## [3.25.01] - 2026-10-16

### Fixed
- Tests only: the workflow rename tests share the library page's test setup (the duplication gate), and the action-bar audit records where the editor's Save sits now that its name dialog is shared.

## [3.25.00] - 2026-10-16

### Added
- **Rename a workflow from the library** (Autonomous agents → Workflow library, admins): each workflow except the built-in template has a Rename button that opens a dialog with its current name. Saving a new name adds a revision with only the name changed, so agents that run it keep running it. A workflow saved before newer rules can still be renamed. API: `POST /workflows/{workflow_id}/rename` `{name}`. See [docs/autonomous-agents.md](docs/autonomous-agents.md).

## [3.24.04] - 2026-10-16

### Fixed
- **Dropdown lists opened empty** (Chrome 135+, Safari 27+, since 3.22.01): the open list was set to fade in, but the browser never applied the "now open" state, so the list stayed invisible. You could see the dropdown open but not its options. The fade is removed, so the list now shows at once in every dropdown, including the workflow picker on an agent's Workflow tab.

## [3.24.03] - 2026-10-16

### Fixed
- Tests only: the run decision form is pinned to drop "fix the objections I pick" when the personas raised none, keeping "something else".

## [3.24.02] - 2026-10-16

### Changed
- In the run decision form the objections to fix are grouped under one heading per persona (with its Blocking badge), instead of repeating the persona's name on every objection.

## [3.24.01] - 2026-10-16

### Fixed
- Tests and the local dev mock only: the action-bar audit now tracks the decision form's button, and the mock accepts decision notes of up to 6,000 characters like the API.

## [3.24.00] - 2026-10-16

### Changed
- **A clearer decision on a run that needs you** (Autonomous agents → agent → Runs): the card now asks "What should happen next?" and lists the choices the run allows, each with what it does. Revise once more, fixing the objections you tick (a blocking persona's are ticked for you), plus your own instructions. Accept it as it is and continue. Something else, where you tell the agent what to do. Or close the run. Nothing happens until you press "Make the decision"; closing still asks you to confirm.
- **Persona objections are no longer cut short**: a stop for a human now keeps up to five objections of up to 400 characters per persona (it was three of 200), as the persona panel writes them. The note sent with a decision can be up to 6,000 characters, to carry the ticked objections.

### Upgrade notes
- A run that stopped before this release keeps the shorter objections it stored.

## [3.23.01] - 2026-10-16

### Fixed
- **Deleting a plan twice keeps the first record of who deleted it and when**: a second delete (say, an admin after the plan's owner) no longer overwrites it.

## [3.23.00] - 2026-10-16

### Added
- **Delete a finished plan** (Autonomous agents page → Plans): each finished plan (completed, failed, cancelled or expired) has a Delete button that asks for confirmation and then removes it from your list. Nothing is erased: the plan and its steps are kept and still open by id, and anything the plan created stays in your projects. A plan that is still running cannot be deleted; cancel it first. API: `DELETE /agents/plans/{plan_id}` (the plan's approver or an admin; 409 while active). See [docs/assistant-plan-mode.md](docs/assistant-plan-mode.md).

### Fixed
- The workflow editor header from 3.22.02 broke two quality gates (function complexity and the long-name tooltip audit); the title is now its own small component, with no visible change.

## [3.22.03] - 2026-10-16

### Fixed
- Tests only: the server's and the editor's loop rules are pinned to report the same issues in the same order (loop steps in their listed order; a loop without its review reports only that; an end step listed in a loop is not counted inside it).

## [3.22.02] - 2026-10-16

### Fixed
- **Dropdown lists now actually use the app's look** in Chrome 135+ and Safari 27+: in 3.22.01 the field's own styling switched the themed list back off, so the operating system's popup still showed.
- **Leaner workflow editor header**: the editor no longer shows a "Revision N" line under the workflow's name, and on an agent's Workflow tab the library icon beside the picker is gone, so the picker alone titles the editor. The workflow library list still shows each workflow's revision.

## [3.22.01] - 2026-10-16

### Fixed
- **Dropdowns match the app everywhere**: in Chrome 135+ and Safari 27+ the open list of every dropdown now uses the app's font, colours and menu look (theme-aware, with a check mark on the current choice) instead of the operating system's popup. Other browsers keep their native list.
- **Agent Workflow tab header**: the workflow picker is now a compact title-sized dropdown in place of the workflow's name (no repeated name beside it), with an icon link to the library page, so the toolbar fits on one row.

## [3.22.00] - 2026-10-16

When an autonomous agent stops for a human, the admin now sees why and decides how it goes on. Loops in the workflow editor must be wired so they can actually end, and an agent's Workflow tab can switch to another workflow.

### Added
- **A decision on runs that need a human** (Autonomous agents → agent → Runs): the run shows why it stopped (a loop that ran out of rounds with each persona's verdict and objections, a failed review with no way back, the budget, an end step, or a failed verification) and the decisions it allows. These are "Accept and continue", "Run one more round" and "Close the run", each with an optional note that the next revision step reads. The run resumes where it stopped, with a fresh step and model-call budget. API: `POST /agents/{agent_id}/runs/{run_id}/decision` (admins). See [docs/autonomous-agents.md](docs/autonomous-agents.md#when-a-run-needs-a-human).
- **Needs-decision notifications**: a count on the "Autonomous agents" sidebar item, a badge on each agent waiting in the list, and a banner on the agent's page that opens the run.
- **Workflow switcher on an agent's Workflow tab** (admins): point the agent at another library workflow (asks first when the editor has unsaved changes), plus a link to the workflow's library page.

### Changed
- **Loop rules on save**: creating, saving, importing or validating a workflow now refuses a loop that cannot end properly. A loop needs its review (a persona review or a final review). That review needs a passing arrow that leaves the loop and a failing arrow that stays inside it, and every one of its arrows must be labelled. No other loop step may lead out of the loop. Each problem is pinned to its step in the editor, and arrows drawn from a loop's review are labelled automatically.

### Upgrade notes
- Workflows stored before this release keep running unchanged (rules are checked only on save, import and validate); one that breaks a rule must be fixed the next time it is saved or duplicated.
- Runs that stopped for a human before this release carry no reason, so they can only be closed.

## [3.21.01] - 2026-10-16

### Fixed
- **Agent runs still failed at "Aggregate reviews in scope"** after 3.21.00: with up to 30,000 characters of reviews, the model thought for about 40 seconds and stopped at its output limit with almost nothing written. Agent steps now get 8,192 tokens of thinking room, up from 2,048.

## [3.21.00] - 2026-10-16

Fixes from a live browser test of autonomous agents and the workflow editor: agent runs no longer fail at the first step, and workflows can be started, opened and read.

### Added
- **Workflow library: "New workflow" and "Open"** on the Autonomous agents page (admins). "New workflow" creates a minimal Start → End workflow and opens it. Every library row opens in the editor at `/agents/workflows/{id}`, without going through an agent.

### Changed
- **Readable workflow canvases**: the editor and the run graph no longer shrink a large workflow until its text cannot be read. Zoom stays at 60% or more, the editor centres on Start, and the run graph centres on the step that is running (or the last one).
- **"Save as…" confirms the switch**: on an agent's Workflow tab it now says the agent runs the new copy. Before, it switched the agent silently.
- In a step's settings, "Add arrow" now comes before "Delete step", so connecting steps without dragging is easier to find.

### Fixed
- **Agent runs failed at "Aggregate reviews in scope"** ("the review analysis was not valid JSON"): the agent's model spent its whole output budget thinking and returned nothing. Every agent model call now has room for the model's thinking.
- **The editor showed the old workflow after "Save as…"**: it kept the previous name and an "Unsaved changes" badge, so Save would have overwritten the original. It now shows the copy, saved.

## [3.20.00] - 2026-10-15

Each Web Reviews connector has its own source, so two brands read from the same review site no longer share one.

### Changed
- **Web Reviews source per connector**: reviews used to import under one source per website (`web_www_trustpilot_com` for every Trustpilot page). Each connector now gets `web_<site>_<app_name>`, for example `web_trustpilot_example_air`. Filters, source profiles (PII, retention) and the AI assistant's personas or PR/FAQs pinned to a source now apply to one brand. The label is set when the connector is created, stored on it (`source_id`) and kept when the connector is renamed. A client cannot set it. See [docs/web-reviews.md](docs/web-reviews.md).

### Upgrade notes
- A connector saved before this release has no stored `source_id`. Its next import uses `web_<site>_<app_name>` from its current URL and name, and the next save stores it.
- Reviews already imported keep their old `web_<host>` source until they are relabelled. Changing a stored review's `source_platform` moves its counters to the new source (the aggregator handles the edit).

## [3.19.03] - 2026-10-15

Docs, examples and test fixtures use a fictional company.

### Changed
- The plan-mode docs, the AI assistant's planning hints, and the plan test fixtures now use a fictional airline ("Example Air", App Store id 1234567890, `com.example.air`) instead of a real company. The fixtures are renamed `plan-step-example.json`, `plans/valid-example.json` and `plan-step/example-run-fixtures.ts`.

## [3.19.02] - 2026-10-15

### Fixed
- **Web Reviews reported the end of a review list as a block**: a list with fewer pages than asked for ended with "`<target>`: blocked by HTTP 404", because the page-number fallback guessed `?page=N+1` past the last page. A 404 or 410 on a next page now ends the target normally. A first page that answers 404 is still reported.

## [3.19.01] - 2026-10-15

Fixes from a live end-to-end test of the full cycle: the AI assistant learns why a site cannot be analyzed, persona avatars get their image prompt, and the logs lose a warning that hid real ones.

### Fixed
- **`POST /scrapers/analyze-url` on a site that blocks plain HTTP** (Trustpilot answers 403) returned a 500 "Failed to analyze URL", which the assistant reported as an outage. A 403 or 429 is now a 400 that says the site refuses plain fetches and that the Web Reviews connector (managed browser) can read it. Any other fetch error is still a 500.
- **Persona avatars fell back to the generic image prompt**: the 200-token prompt call ran out of budget on an adaptive-thinking model and came back empty. It now has the same thinking headroom as enrichment (`shared/converse.with_thinking_headroom`).
- **"No application metrics to publish" warning on every API call**: silenced by its exact message, as Powertools documents. Every other warning still shows.

## [3.19.00] - 2026-10-15

Web Reviews can read the latest N pages, the latest N reviews, or everything, and resume a long crawl on the next run. Plugin ingestors start again, and review enrichment no longer breaks its JSON.

### Added
- **Web Reviews reading modes**: each target has `max_pages` (default **10**; `0` = all pages, up to 100) and a new `max_reviews` (default `0` = no limit, up to 5,000). For example, the latest 10 pages is `10`/`0`, the latest 200 reviews is `0`/`200`, and everything is `0`/`0`. Set them in the Scrapers page connector form, the AI assistant's `create_app_connector`, or `POST /integrations/web_reviews/apps`. See [docs/web-reviews.md](docs/web-reviews.md).
- **Web Reviews backfill**: a crawl that runs out of time, or reaches the run's 5,000-review cap, saves where it stopped. The next run continues from that page instead of starting over.
- **Web Reviews page cache**: a page whose content has not changed since the last run is not sent to the model again.

### Changed
- **More reviews captured per page**: a navigated page is scrolled to load lazy reviews. Up to 160,000 characters of page text are read, in chunks of 40,000, one model call each. Up to 400 reviews are kept per page (was 100), and a run sends up to 5,000 reviews (was 1,000).

### Fixed
- **Plugin ingestors failed at start-up** with `No module named 'pydantic'`: the ingestion layer now ships pydantic, which the ingest schemas need. A new test fails the build when a plugin Lambda imports a package its layer does not ship.
- **Review enrichment broke its JSON**: the enrichment model ran out of output tokens, was auto-continued, and the reply failed to parse. Enrichment, category and dimension re-classification now answer in one call with room for the model's thinking.
- **Idempotency warning on every processed review**: the feedback processor now gives its idempotency settings the invocation's remaining time.

### Upgrade notes
- Rebuild the Lambda layers (`./scripts/build-layers.sh`) before deploying: the ingestion layer gains `pydantic==2.14.1`.
- Existing Web Reviews targets keep their stored `max_pages`. Targets saved before this release have no `max_reviews`, which reads as `0` (no limit).

## [3.18.05] - 2026-10-15

Tests only: the trailing-newline fix of 3.18.04 is also checked on real validators.

### Changed
- `lambda/shared/test/test_regex_end_anchor.py` now also checks four shared validators (reprocess job ids, prototype form ids, company-context dates, raw-archive stems): each accepts its valid value and refuses it with a trailing `\n` or `\r\n`.

## [3.18.04] - 2026-10-15

Python validators and patterns now match the whole input: a trailing newline no longer passes as a valid id.

### Security
- **Exact end anchors in every backend regex**: Python's `$` also matches just before a trailing newline, so a validator such as `^[A-Za-z0-9_-]{1,64}$` accepted `"abc\n"`. All 51 such patterns in `lambda/` and `plugins/` now end with `\Z`. They cover conversation, project, scraper, job, ballot, pin and token ids, dates, design-system values, GitHub repo names and hosts. A value with a trailing newline is now refused (400) or, for a raw-archive name, hashed. A new test fails the build if a production `re.*` pattern uses `$` outside MULTILINE mode.

### Fixed
- **Raw archive keys never contain a newline**: an item id ending in a newline (possible from a JSON upload or a third-party API) used to name its S3 archive `raw/…/abc\n.json`. It now gets the hashed `h.<sha256>.json` name like any other unsafe id, and the retention worker matches that name.

### Upgrade notes
- No migration. An archive written before this release under a name ending in a newline is not matched by retention; this deployment has none.

## [3.18.03] - 2026-10-15

Plan mode no longer finishes a plan around a step that has not started yet.

### Fixed
- **Plan mode: a lost race no longer ends a plan early.** If a `wait` step failed to start because a concurrent update got there first, or a step behind a failed one failed to be marked skipped, the plan finished as `completed_with_errors` with that step still pending. A plan now keeps running while any step is pending, and the next decide (30 s later) starts or skips it. See [docs/assistant-plan-mode.md](docs/assistant-plan-mode.md), "Failure, cancel, expiry".

## [3.18.02] - 2026-10-15

Python backend mutation hardening: every Python module added or changed since 3.06 now has 0 surviving mutants. Tests and refactors only; nothing a user, an API caller or an operator can notice changes.

### Changed
- **Mutation-tested backend**: 37 Python modules and slices were mutation-tested with mutmut, and every mutant is now killed. They cover the dimension/tag config, source profiles and policies, PII redaction, retention and erasure, ingest archiving, model capacity and test, plugin circuit breaker, null-origin CORS, the plan-mode conductor (state, execution, decisions, waits, identity, canonical fingerprints), the aggregator's dimension counters and the whole Web Reviews plugin (browser, CDP client, page reader, extraction, block detection, handler). The new `*_mutation.py` suites pin exact values, boundaries, refusal messages and log lines. A few weaker duplicate tests were removed, as were some lines of dead code that no input can reach; no behaviour changes.

## [3.18.01] - 2026-10-15

Web Reviews hardening from the security review: page text can no longer close the model's data block, page reads are size-capped, and a target cannot be imported from another site.

### Fixed
- `POST /integrations/{source}/apps` answers **400** ("app must be an object") instead of 500 when `app` is a string, list or number.

### Security
- **Web Reviews prompt isolation**: the page-text delimiters are removed from the page case-insensitively and repeatedly, so a nested (`</page_</page_text>text>`) or re-cased (`</PAGE_TEXT>`) tag can no longer end the data block the extraction model reads.
- **Web Reviews memory bound**: JSON-LD is capped at ~1 MB per page in the browser and again in the plugin, and a browser reply over 8 MB is refused with a clear error (the browser session is still stopped), so a page cannot exhaust the ingestor's memory.
- **Web Reviews stays on the target's site**: a page the browser was redirected to on another host ends that target with `"<target>: redirected off-host"` (nothing from it is imported under the target's `web_<host>` source), and next pages must keep the target's scheme, host and port.

## [3.18.00] - 2026-10-15

Generic web reviews: a new plugin reads customer reviews from public review pages with a managed browser, one source per site ([docs/web-reviews.md](docs/web-reviews.md)).

### Added
- **Web Reviews plugin** (`web_reviews`): add public review pages (Trustpilot, TripAdvisor, forums, …) on **Scrapers → Data sources → Web Reviews** with a name, an https URL, pages per run (1-20, default 5) and a frequency (manual only by default); Run now, Edit, Delete and the last run per page. Each run uses one Amazon Bedrock AgentCore Browser session (`aws.browser.v1`, honest User-Agent, always stopped), reads page 1 and follows the next pages, and takes reviews from the page's JSON-LD or, without it, from its text with the `enrichment` model. Reviews are imported as `web_<host>` sources (`web_www_trustpilot_com`), so source profiles (PII, retention, restricted) apply per site.
- **Blocked sites are reported**: a page behind DataDome, HUMAN (PerimeterX), Cloudflare, AWS WAF, a CAPTCHA or an HTTP error ends the run with `"<page>: blocked by <vendor>"` on its card instead of an empty import. Measured from AWS: Trustpilot, TripAdvisor and airlines-inform.com are readable; Yelp, ConsumerAffairs and Reddit are blocked.
- `POST /integrations/web_reviews/apps` validates a page before saving it: https only, a public host (the shared SSRF guard), page and frequency bounds; unknown fields are dropped.
- **AI assistant**: `create_app_connector` takes `source: "web_reviews"` with `url` and `max_pages` (approval card shows the page, pages per run and schedule); `run_source` runs `web_reviews`. In plan mode the assistant finds review pages with web search, puts each chosen URL on the plan card, runs the import and can scope personas / PR-FAQs to the new `web_<host>` sources ([docs/assistant-plan-mode.md](docs/assistant-plan-mode.md)).

### Changed
- A plugin manifest may set `infrastructure.ingestor.browser: true` to get AgentCore browser permissions on its dedicated role ([docs/getting-started-plugins.md](docs/getting-started-plugins.md)).
- App-connector cards show up to two run errors and how many more.

### Upgrade notes
- **New IAM permissions** on the new `voc-ingestor-web_reviews` role: `bedrock-agentcore:StartBrowserSession` and `StopBrowserSession` on `arn:aws:bedrock-agentcore:<region>:aws:browser/aws.browser.v1`, and `bedrock-agentcore:ConnectBrowserAutomationStream` on `*` (that action has no resource type in IAM).
- **The plugin is on by default** (`pluginStatus.web_reviews: true`); it creates a Lambda, a log group and a disabled 15-minute schedule rule, and does nothing until a page is added. Set it to `false` in `voc-datalake/cdk.context.json` to leave it out.
- **Rebuild the ingestion layer** for its new dependency (`websocket-client==1.9.2`): `./scripts/build-layers.sh` (CDK synth rebuilds it too).
- AgentCore Browser runs in the deployment's region; it is available in the US, EU (incl. eu-central-1) and Asia Pacific regions on the AgentCore regions page. Browser time and model calls are billed ([AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/)). Review each site's terms of use before adding it.
## [3.17.00] - 2026-10-14

AI assistant plan mode: a multi-step request becomes one plan the user approves once, and it runs in the agent runtime ([docs/assistant-plan-mode.md](docs/assistant-plan-mode.md)).

### Added
- **Plans in the assistant**: on any page the assistant can read a catalogue of every page's tools (`plan_catalogue`), run any page's read tools to ground a plan (`plan_lookup`), and propose a multi-step `voc-plan/1` plan (`propose_plan`); an invalid plan goes back to the model as an error list. The bubble shows a **plan card**: the goal, every step in order with its page and kind, each write as a fixed field table built from its arguments (outputs of earlier steps read "← output of step N", model-written text "written when it runs"), "will ask again" on the tools that always ask at run time, and the plan limits. **Approve and run** starts the plan through `POST /agents/plans`; **Change** asks the assistant to revise it; **Decline**.
- **Plan progress** in the bubble under an approved plan: each step's status, refreshed every 5 s while the panel is open; a step that needs approval shows exactly what it would write with Approve / Decline; Cancel; the summary and a link to the created project when it ends. Opt-in desktop notifications when a plan finishes or a step waits for approval. A **Plans** list on the Agents page opens the same view. `get_plan` / `cancel_plan` let the assistant follow and stop a plan.
- **Plan routes** under the existing `/agents/{proxy+}`: `POST /agents/plans` (any signed-in user approves their own plan; 400 lists each invalid step and field; at most 3 active plans per user), `GET /agents/plans`, `GET /agents/plans/{plan_id}`, `POST /agents/plans/{plan_id}/cancel` and `POST /agents/plans/{plan_id}/steps/{step_id}/approve|decline` (approve takes `{fingerprint}` of the paused write the card showed) ([docs/autonomous-agents.md](docs/autonomous-agents.md) → "Plans").
- `voc-agent-run` gains a plan branch: up to 3 ready steps at once, waits on source imports, scraper runs and project jobs, a paused step waits 30 minutes for its approver, a failed step skips its dependents, and the plan ends `completed` or `completed_with_errors` with a summary.
- New Lambda **`voc-plan-step`** (VocProcessingStack, Node.js 22, ARM64, built from `lambda/stream`) runs one plan write or think step as the approver through the domain APIs, writing exactly the approved arguments; any deviation, a never-pre-approvable tool or a changed approval returns the step for approval.
- `generate_personas` and `generate_document` take an optional `sources` list (source_platform values; an app connector's reviews are `<app_name>_iOS` / `<app_name>_Android`) that limits the feedback the job reads, on chat cards and in plans.
- New assistant tools: `run_source` (admins: start an app-review, GitHub Issues, S3 import or synthetic source now; `POST /sources/{source}/run`), `get_source_run` (admins: that run's status, errors redacted), `find_app_store_app` (App Store ids via Apple's public iTunes Search API; Google Play package names via web search when it is on), `build_prototype` (`POST /projects/{id}/build-prototype` with the route's own fields), each with its approval card where it writes.
- Dev mock: stateful `/agents/plans*` routes (a plan advances one step per poll; its second write stops for approval).

### Changed
- The assistant continues with the step it just proposed when the user answers with a short "go" / "yes" / "ok".
- The assistant now proposes a plan for a request with several steps across pages; one-step requests run as before. In a plan, the persona instructions, a PRD/PR-FAQ's feature idea and merge instructions are literals the user approves on the plan card (never model-written at run time), and the planner is told to name the plan's subject in them and pin `sources` to the new connector's reviews.
- `run_agent` and `cancel_agent_run` are offered to administrators only, in chat and in plans (their routes were already admin-only; non-admins used to get a card that then failed).

### Security
- Before each plan step the approver is re-checked in Cognito (exists, enabled, same account; still an administrator for admin-only tools); a disabled or demoted approver stops the plan at its next step. `admins` is forwarded only for an admin-only step whose re-check confirmed it. A delegated credential (MCP token, agent) can never approve a plan.
- Plans can never name `save_brand_settings` or the user-administration tools (approval card only); `delete_document`, `forget_memory` and `merge_memories` always ask again when a plan reaches them. A paused write's fingerprint is re-computed before it is offered for approval, and a write of either kind reported done without its approval fails its step.
- Approving a paused plan step binds to what the approver saw: `POST …/steps/{step_id}/approve` requires `{fingerprint}` (400 without it) and is conditional on the stored paused write's fingerprint, so a stale card answers 409 "This step changed; review it again" and never approves a write that replaced it. A resolved step must report exactly the approved write's fingerprint, or it fails and is never recorded as done.
- The 3-active-plans cap is atomic: a per-user counter (`PLANCAP#{sub}` in `voc-agents`) is taken in the same transaction that stores the plan and given back in the same transaction as its terminal status, so concurrent approvals cannot pass it.
- Delegated credentials (MCP tokens, agents) get 403 on every plan read, list, cancel and step resolve, not only on approve.
- A plan's think steps never get the user directory (`list_users`, `get_user_access`), and `voc-plan-step` has no Users API environment or invoke grant. Think steps in the scrapers and settings packs read as an administrator only while the approver still is one (re-checked in Cognito).
- `find_app_store_app` reads Apple's answer as a stream under a hard byte cap (cancelled past it, never buffered whole), follows no redirect, and keeps only results whose link is an `https://apps.apple.com/` page.

### Upgrade notes
- Deploy all stacks and the frontend together (`npm run deploy:all`): the plan UI needs the Agents API's plan routes, the stream Lambda's new tools and `voc-plan-step` from the same release. Plans are not visible until it is deployed.
- New Lambda `voc-plan-step` in VocProcessingStack. It invokes the projects, metrics, feedback-form, settings, scrapers, memory, agents, integrations and feedback-edit API Lambdas by name (not the users API) (they deploy with VocApiStack after it, as the agent runtime's delegates already do), reads the aggregates (GetItem/Query) and feedback tables, and calls the allowlisted Bedrock models.
- VocProcessingStack now imports the Cognito user pool from VocCoreStack (new cross-stack export) and grants the agent conductor `cognito-idp:AdminGetUser` / `AdminListGroupsForUser` on it plus `dynamodb:GetItem` on `voc-jobs`. Deploy order is unchanged (Processing before Api).

## [3.16.01] - 2026-10-14

Docs only: design for the AI assistant's plan mode.

### Added
- [docs/assistant-plan-mode.md](docs/assistant-plan-mode.md): how the assistant will turn a multi-step request into
  a plan the user approves once (with every write defined in it), run each step with one page's tools in the agent
  runtime, wait on imports and jobs, and fall back to an approval card for anything the plan did not define. Not
  built yet.

## [3.16.00] - 2026-10-10

Administrators can ask the AI assistant on the Settings page to create users, change them and set what they may see.

### Added
- AI assistant, Settings page (`settings` pack, administrators only): `create_user` (a new account; Cognito emails the
  temporary password), `update_user` (name, role or enabled state as a before → after diff) and `set_user_access` (which
  categories and sources a user may see), each proposed by the assistant and saved only after you approve the card,
  through the existing admin-only `/users/*` routes with your own session. Two reads back them: `list_users` (no `sub`,
  no flags) and `get_user_access`. Refused before any card: a duplicate email, an unknown username, your own role or
  enabled state, an access rule for an administrator, an unconfigured category or source; refused on approve when the
  user or grant changed since the card was shown. Deleting users, password resets and user flags stay in Settings →
  Users ([docs/categories.md](docs/categories.md) → "With the AI assistant").

### Changed
- `voc-chat-stream` may now invoke `voc-users-api` (env `USERS_FUNCTION`; the one new entry in its exact-ARN
  `lambda:InvokeFunction` statement) for the two admin-only reads above. Not on `/mcp/global`.

### Upgrade notes
- Deploy `VocApiStack` and the frontend together (the stream Lambda and the SPA share the assistant contract).

## [3.15.00] - 2026-10-10

The embeddable feedback widget tells a visitor inline when a submission fails, instead of a browser dialog.

### Changed
- Feedback widget (`/feedback-forms/{id}/iframe` embeds): a failed submission now shows an inline notice beside the
  arrows — "Failed to submit. Please try again.", or the API's own reason when it refused the submission (for example a
  text past the length bound) — announced as an alert region, with the typed feedback kept in the form. Pressing Next
  submits again and clears the notice. The previous browser `alert()` blocked the page and was lost on close
  ([docs/feedback-forms.md](docs/feedback-forms.md)).

### Fixed
- `npm run validate:codeql` exits 0 for Python again: three tests no longer assert on expressions with side effects or
  build an exception only to discard it, and the two remaining `error`-level results — both CodeQL 2.27 extractor false
  positives (a PEP 695 `**ParamSpec` read as an unassigned local; a variable assigned on the previous line) — are listed
  as accepted with their reasons in `scripts/codeql-summary.mjs`.

## [3.14.04] - 2026-10-10

Code hygiene from CodeQL's `code-quality-extended` suite; no behaviour changes.

### Added
- The public feedback widget's jsdom tests pin the three rating kinds: stars 1..`rating_max` with their hover labels
  (an empty label past the five named ones), numeric 1..10 with no label attribute, and the five labelled faces.

### Fixed
- The public feedback widget declares its question heading once per slide and builds the three rating-button kinds
  (emoji, numeric, stars) through one helper instead of three near-identical blocks; the rendered DOM is unchanged.
- `scripts/convert-template.mjs` returns `null` explicitly when a template or asset file cannot be read (the caller
  already treated the absence as a failed stack), drops an always-true guard and an unused loop variable.
- Removed an unused import from the CDK ESLint config, an unused constant from the dev mock, and an unused parameter
  from `frontend/scripts/fix-i18n.mjs`; four statements in `api-routes.ts` / `api-stack.ts` get the explicit semicolon
  the rest of those files use.

## [3.14.03] - 2026-10-10

Tooling and fixes: a local CodeQL scan (`npm run validate:codeql`), and the findings it raised in our own code.

### Added
- `npm run validate:codeql` runs CodeQL's `security-and-quality` suite over the whole repository (JavaScript/TypeScript
  and Python; `scripts/codeql.sh`, filters in `scripts/codeql-config.yml`, summary in `scripts/codeql-summary.mjs`). It is
  not a `validate.sh` step (a full run takes 10–20 minutes); the exit code is 1 on any `error`-level result. Findings that
  are by design (the e2e suite saving responses as evidence files, a test *about* `document.write`, the no-op tracer's
  `del`s) are listed as accepted, each with its reason, never counted. Needs `brew install codeql`.
- `lib/plugin-loader.integrity.test.ts` pins `generateIntegrityHashes`: a missing manifest is the same error, a component
  a plugin does not ship gets no integrity entry, and the hash moves only when a `.py` file changes.
- The public feedback widget's tests now enforce that `innerHTML` is only ever assigned constant markup and that dynamic
  text goes through `textContent`.

### Fixed
- `plugin-loader.ts` and `vite.config.ts` read files once instead of checking for them first (CodeQL file-system race);
  `prototype_pins.py` tests NaN with `math.isnan`.
- `scripts/convert-template.mjs` copies assets with `copyFileSync` instead of a shell `cp` built from template paths;
  `frontend/scripts/fix-i18n.mjs` builds nested locale containers with null prototypes.
- The public feedback widget drops an unused HTML-escape helper and an unused variable (every dynamic string it renders
  already goes through `textContent`, verified by the new test).
- e2e suite: markdown cells and CSS attribute selectors escape backslashes before their delimiter; the saved-session reset
  reads the file once; a dead assignment and a predicate named like `String.match` are gone; bridge harness log lines
  JSON-quote the values they print.
- Tests: inlined JSON in the widget harness escapes `</` and U+2028/9; two placeholder matchers use the literal text
  instead of a URL-shaped regex; a hand-rolled regex escape uses the shared `escapeRegExp`.

## [3.14.02] - 2026-10-10

The labels-vs-status rule now holds across the whole app, not only the feedback card: document types, source tiles, persona attributes and the project wizards are no longer coloured by what kind of thing they are. Colour is left to state.

### Changed
- **Document types** (the Documents rail on a project, its lineage footers, the wizard's document picker, Prioritization
  rows): every type is the same neutral pill with a lucide icon per type — PRD (file), PR/FAQ (newspaper), research
  (search), custom (pen), product report (bar chart), prototype (hammer) — instead of a tone per type (PRD blue, PR/FAQ
  green, research amber, custom purple, prototype amber). One shared `DocumentTypeBadge` replaces three separate maps.
- **Scrapers page**: every source tile — app sources, web scraper templates, paste / JSON / CSV import, synthetic data,
  and each source dialog's header — is the accent tile with its own icon; the kind of source was painted as six
  different tones before. A paused scraper keeps its grey tile; "Auto-discovered" on a plugin tile is now the blue
  provenance marker (like "built-in") rather than a second accent.
- **Personas** on a project: the detail sections are neutral cards and their attribute chips (demographics, tech
  savviness, activity, decision style, devices, tools), the primary goal panel and a scenario's trigger / outcome are
  grey with muted sub-headings, where each section had its own colour. **Pain points** keeps its red tone because that
  section is negative sentiment, a state.
- **Project wizards** (Generate Personas, Run Research, Generate Documents, Remix Documents): one accent icon tile, an
  accent progress bar and the standard primary Next / Submit button in every wizard, instead of amber, blue or green per
  wizard; a chosen output type, PR-FAQ / PRD option or filter uses the selected style (accent tint + accent border);
  research suggestions hover neutral; "Working Backwards" is a neutral label; the question numbers are grey.
- Smaller sweeps: a plugin's setup-instructions panel is one neutral panel for every plugin (its manifest colour no
  longer paints it, on the Settings source card and the Scrapers plugin dialog); Data Explorer folder / file icons,
  the Problem Analysis subcategory icon, the Prioritization submissions icon and the project owner's crown are the
  idle icon grey; the Prioritization team-score numbers are the text colour rather than a hue per axis; the personas,
  documents and research-notes empty states use the accent tile like the other empty states; research-note numbers
  are grey.
- [docs/kiro-design-system.md](docs/kiro-design-system.md) › Labels vs status: a table of these surfaces (before →
  after) and the list of tones deliberately kept as states; `theme/badgeTones.test.ts` pins each surface.

## [3.14.01] - 2026-10-10

Feedback cards no longer look like a Christmas tree: descriptive labels are neutral grey, the category is the one emphasised label, and colour is left to state (sentiment, urgency, privacy). The design system now says so as a rule.

### Changed
- Feedback cards on **Categories** (Feedback Results), the feedback detail page (Classification, Tags & filters) and the
  similar-feedback list use neutral labels: subcategory, journey stage, persona, dimension values and tags are all grey
  (`badge-muted`); the category is the single accent label; sentiment, Urgent and Redacted / Summary only keep their
  status tones exactly as before. A hand-set dimension value is told apart by its pencil icon and "Set by hand" title,
  not by a colour; "Changed by …" (a hand-set category) stays a small blue provenance marker with icon and text.
- The same rule on neighbouring lists: the Problem Analysis "+N" similar-problems count, a feedback form's type pill
  ("Prototype pins"), a scraper template's extraction method ("JSON-LD") and a company objective's horizon are now
  neutral labels rather than status-coloured chips. True status badges everywhere are unchanged.
- [docs/kiro-design-system.md](docs/kiro-design-system.md): new rule 15 and a **Labels vs status** section — a badge
  or chip is toned by meaning, never to tell labels apart: descriptive labels `badge-muted`, at most one `badge-accent`
  per row for the primary classification, `ok` / `warn` / `danger` / `info` / `aim` for state only (`info` = an
  informational state such as provenance, `aim` = AI / generated). Quotes KiroCrew's status-only `Badge` and its
  `SourceBadge` neutral-among-peers reasoning, with the feedback card as the worked example, the Badges recipe updated
  and a residue grep under Verifying a change. `theme/badgeTones.test.ts` fails when the feedback surfaces tint a
  descriptive label `info` / `aim` or show a second accent label.

## [3.14.00] - 2026-10-09

On the Scrapers page, the AI assistant can set up connectors for administrators: it proposes one, an approval card shows exactly what will be saved, and nothing happens until you approve.

### Added
- AI assistant on **Scrapers** (`/scrapers`), administrators only: `create_scraper` (a new web scraper via
  `POST /scrapers`), `update_scraper` (a before → after diff against the stored scraper; refused if the scraper changed
  since the card was shown) and `create_app_connector` (an iOS or Android app-review connector via
  `POST /integrations/{source}/apps`). A create never overwrites: an id that exists is refused before the card and
  again right before saving. New scrapers are saved disabled with no schedule unless you asked for one, and running
  one stays a separate, separately approved `run_scraper` step. See [docs/scrapers.md](docs/scrapers.md)
  ("With the AI assistant").
- The approval cards are deterministic. Each shows a fixed table of every saved field (URLs one per line with the host
  emphasised, method, selectors, pagination, schedule as "Off" / "Every N minutes", enabled, dimension defaults, tags)
  and the note "Nothing is saved until you approve". Once saved, the card links to the scraper
  (`/scrapers#scraper-<id>`), and the Scrapers list refreshes.
- `analyze_scraper_url`, an admin-only assistant read that suggests CSS selectors for a public https page through
  `POST /scrapers/analyze-url`. It saves nothing.
- For administrators, `list_scrapers` now also returns selectors, pagination and labels, so the assistant can propose
  updates.

### Changed
- On a project's Overview, every workflow step icon uses the accent purple.

### Upgrade notes
- Deploy the stream Lambda (`VocApiStack`, `voc-chat-stream`) and the frontend together. The new tools are in the
  contract on both sides, and an older SPA cannot render or execute the new approval cards. No IAM, route or data
  change is needed: the stream already holds an invoke grant on the scrapers API, and the writes go through the
  existing admin-only REST routes with the user's own token.
- These tools are not added to the global MCP server (`/mcp/global`). Writes there need their own decision.

## [3.13.00] - 2026-10-09

Administration gains a Version tab: what is deployed, and what changed in each release.

### Added
- Administration → **Version** (`/admin?tab=version`, admins only): the platform version (in this changelog's
  `3.13.00` form), the git commit and the build time (UTC), stamped into the frontend at build time. A build
  without git (for example from a tarball) shows the commit as `unknown`.
- The same tab shows these release notes, newest first. They load only when the tab is opened (a separate,
  same-origin script file, so the rest of the app does not get heavier), ten releases at a time with **Show older
  releases**. Links to `docs/` pages open the page on GitHub in a new tab.

### Upgrade notes
- The release notes are bundled into the frontend's public static files, like the rest of the app's code: anyone
  who can load the site can download them, even though the tab is admin-only. They carry no account data.

## [3.12.00] - 2026-10-09

Importing data — paste, CSV, JSON and S3 bulk import — is admin-only, on every route (owner decision 2026-10-08,
#242 follow-up).

### Changed
- Every `/scrapers/manual/*` route (`parse`, `parse/{job_id}`, `confirm`, `csv-upload`, `json-upload`) and every
  `/s3-import/*` route (`sources` list/create, `files`, `upload-url`, `file/{key}` delete) now answers `403` to a
  non-admin, before any S3, DynamoDB, SQS or model call. Each handler gates through one middleware, so a route added
  later is admin-only by default. See [docs/scrapers.md](docs/scrapers.md) and
  [docs/data-lake-structure.md](docs/data-lake-structure.md).
- Data Sources → New Source: for a non-admin the Manual Import, JSON Upload, CSV Upload and S3 Bulk Import tiles are
  disabled with the admin-only tooltip and a note; the import dialogs are never mounted. The S3 source's File Explorer
  shows an admin-only notice instead. App-review sources, synthetic data and feedback forms are unchanged.
- `POST /s3-import/upload-url` is create-only: it answers `409` when the file already exists, and the presigned URL is
  signed with `If-None-Match: *`, so S3 refuses (412) an overwrite that races the check. The response carries
  `upload_headers` the PUT must send. To replace a file, delete it first. The File Explorer now reports a refused
  upload instead of showing it as uploaded.
- `DELETE /s3-import/file/{key}` deletes only `<source>/<file.csv|.json|.jsonl>`; any other key (leading `/`, `..`, a
  root-level or nested key, `processed/`) is a `400`.
- `GET /settings/model` stays open: the agent detail page's Models tab (read-only for non-admins) reads the model
  list through it. No assistant or MCP tool reaches the import routes.

### Security
- A `users`-group caller could inject feedback into the enrichment pipeline (CSV/JSON/paste import, S3 upload), list
  the S3 import bucket and every staged file, and delete any object in that bucket, including `processed/`.
- The route-gate inventory (`lambda/api/test/test_route_admin_gates.py`) now lists the import writes as ADMIN_ONLY and
  pins the gated reads (`GET /s3-import/sources`, `GET /s3-import/files`, `GET /scrapers/manual/parse/{job_id}`) so
  they cannot silently reopen.

### Upgrade notes
- Non-admins can no longer import data via CSV, JSON, paste or S3, or see the S3 import bucket. Give anyone who
  imports data the `admins` group. Feedback already imported is unaffected.
- A script that re-uploads a file under the same name through `upload-url` now gets `409`; delete the file first, or
  use a new name.

## [3.11.00] - 2026-10-08

Brand settings and AI category generation are admin-only, and every mutating API route is now classified as
admin-only or open by decision in one test (owner decision 2026-10-08, #242).

### Changed
- `PUT /settings/brand` and `POST /settings/categories/generate` now answer `403` for non-admins, before the body is
  parsed, anything is written or Bedrock is called. `GET /settings/brand` stays open to every signed-in user. See
  [docs/categories.md](docs/categories.md).
- Administration → General & brand: for a non-admin the brand fields are read-only with a notice, and Save Changes
  is disabled with the admin-only tooltip. Categories: the AI Category Suggestions panel is shown to admins only.
  (The Administration page itself is already admin-only; this covers the in-page state too.)
- The AI assistant's `save_brand_settings` tool was already offered only to admins (settings pack + admin-only
  client tool), so it is unchanged; no MCP tool calls either route.

### Security
- Closes the remaining #242 gap: a `users`-group caller could overwrite the shared brand profile every AI surface
  reads and spend Bedrock on category generation.
- New route-gate inventory test (`lambda/api/test/test_route_admin_gates.py`): it parses every API handler, lists
  each POST/PUT/PATCH/DELETE route, and fails when a route is in neither the ADMIN_ONLY nor the OPEN_BY_DECISION
  table, when an ADMIN_ONLY route loses its structural `require_admin` gate, or when a table entry goes stale.

### Upgrade notes
- Non-admin users can no longer save brand settings or generate categories with AI. Add users who must do so to the
  `admins` group. No data migration or deploy-order change.

## [3.10.00] - 2026-10-08

Web scrapers are admin-only again: only admins can create, edit or analyze a scraper (owner decision, reversing
2026-10-04).

### Changed
- `POST /scrapers` (create and edit) and `POST /scrapers/analyze-url` (Auto-detect) now answer `403` for non-admins,
  before any secret read, URL fetch or Bedrock call — like `DELETE /scrapers/{id}` and `POST /scrapers/{id}/run`
  already did. MCP tokens and agents are never admin. An admin's schedule (`enabled`, `frequency_minutes`) is stored
  as sent; the save limits (shape, sizes, URL policy, scraper count, byte budget) still apply. Reads (list,
  templates, run status, run history) stay open to every signed-in user. See [docs/scrapers.md](docs/scrapers.md).
- Data Sources page: a non-admin sees scrapers read-only. The editor opens with every field disabled and a notice;
  Save, Auto-detect, Run Now and Delete are disabled with the admin-only tooltip; the web scraper templates under
  New Source are disabled. Manual import, JSON/CSV upload and the other source tiles are unchanged.

### Upgrade notes
- Non-admin users can no longer create or edit scrapers or analyze URLs. Scrapers they created earlier stay as they
  are and keep running on their schedule; an admin can edit or delete them. Add users who must manage scrapers to
  the `admins` group.

## [3.09.01] - 2026-10-08

Prototype isolation and pin hardening: prototype documents run in an opaque-origin sandbox, pin comments are
redacted, and only GitHub issues are refreshed in place.

### Fixed
- Pins from a standalone prototype keep working under the sandbox: `POST /feedback-forms/{form_id}/submit` answers
  a request with `Origin: null` with `Access-Control-Allow-Origin: null` and `Vary: Origin` (no credentials) — for
  `prototype_pin` forms only; every other form and route keeps its CORS unchanged. Inside the app the viewer accepts
  the frame's messages by window identity and answers on a private `MessageChannel` port. A prototype built before
  this release still stores pins from the app, but shows no "saved" notice or markers there until regenerated
  ([docs/feedback-forms.md](docs/feedback-forms.md)).
- The processor refreshes a stored item in place only for `github_issues` records; a record from any other source
  that carries `issue_attributes` is stored as a new item or skipped as a duplicate
  ([docs/github-issues.md](docs/github-issues.md)).

### Security
- Prototypes (`/prototypes/*`) are served with `sandbox allow-scripts allow-popups` and `form-action 'none'` in
  their CSP (CloudFront function and the response-headers fallback alike), and the in-app frame carries the same
  `sandbox` attribute. A prototype's script, opened standalone or framed, now runs on an opaque origin and can no
  longer read the app's Cognito tokens in `localStorage`. Prototypes relying on `localStorage`, cookies or `<form>`
  submits lose that.
- A tester's pin comment is redacted (emails, tokens, key=value secrets, digit runs) on the server before it is
  stored, like the pin's other free-text fields.

### Upgrade notes
- Deploy `VocCoreStack` (prototype CSP), `VocApiStack` (feedback-form Lambda) and `VocProcessingStack` (processor),
  then the frontend. No data migration. Regenerate a prototype to get the new pin widget's in-app notices and markers.

## [3.09.00] - 2026-10-08

Plugin recovery and GitHub issue updates: a tripped circuit breaker can be reset, issues already ingested follow
their changes, standalone prototypes accept pins, and VocApiStack leaves the resource ceiling behind.

### Added
- Settings → Data Sources: a source paused by its circuit breaker shows "Paused after repeated failures" (when, how
  many failed runs, a short reason) with a **Reset** button (admins). Reset clears the pause without turning the
  schedule back on. See [docs/plugin-architecture.md](docs/plugin-architecture.md) (Circuit Breaker).
- `POST /sources/{source}/reset` (admin): closes a source's circuit breaker without enabling its schedule.
  `GET /sources/status` reports per source `circuit: {tripped, tripped_at, failure_count, last_error}`; `last_error`
  goes to admins only.
- Prototype pins from a standalone prototype URL: opened in its own tab, a prototype's Feedback widget posts pins
  directly to its own form's public `POST /feedback-forms/{form_id}/submit` route (no credentials, Authorization
  header or referrer; the route's rate limit applies). Inside the app the viewer still relays pins with `postMessage`.
  Prototypes built before this release, and copies, still show the "open it from the VoC app" notice
  ([docs/feedback-forms.md](docs/feedback-forms.md)).

### Changed
- `PUT /sources/{source}/enable` also closes the source's circuit breaker, so turning a source back on fully restores
  it. Its response includes `circuit`.
- VocApiStack: every Lambda behind an API Gateway method has ONE invoke permission scoped to this RestApi instead of
  two per method. The all-plugins template drops from 479 to 388 resources (limit 500); each function is still
  invocable only by API Gateway from this RestApi ([docs/deployment.md](docs/deployment.md)).
- `scripts/check-version.mjs` also fails when the newest CHANGELOG release is not numbered above every existing
  section (historical out-of-order sections below it stay valid).

### Fixed
- **The plugin circuit breaker never worked in a deployed stack.** It addressed the watermarks table (key `source`)
  with `pk`/`sk` keys, so every read and write was refused and no failure was ever counted. Its state now lives in the
  aggregates table. A trip writes its record first and always; a failure to disable the schedule or write the record
  is logged and metered (`CircuitBreakerScheduleDisableFailed`, `CircuitBreakerTripRecordFailed`) and no longer skips
  the other step.
- **GitHub Issues: changes to an issue already ingested now reach the stored feedback.** Labels, close/reopen (and
  reason), milestone, +1 and other reactions, linked PRs, comment count, version or component are refreshed in place
  when a newer copy arrives from the webhook or the next poll. An edited title or body is re-enriched, and the
  Dashboard counters move with it. Older or identical copies change nothing. A person's category correction,
  hand-set dimensions and tags are never overwritten ([docs/github-issues.md](docs/github-issues.md)).
- GitHub Issues comments follow their issue: the poller re-sends every comment of a changed issue, so closing or
  relabelling an issue also updates its stored comments and the per-label and open counts.
- Processor: new items are written with `attribute_not_exists(pk)`, so a replayed or concurrent first copy can no
  longer overwrite an in-place refresh or a manual correction (all sources).
- Synthetic reviews: a `NaN` or `Infinity` rating no longer fails the whole run; it is stored without a rating.
- The plugin template's `sys.path` comment says what the line does (it adds the plugin's own folder).

### Security
- The prototype CSP (`/prototypes/*`) is set by a viewer-response CloudFront Function (`PrototypeCspFunction`,
  VocCoreStack). It adds exactly ONE `connect-src` source, the full submit URL of that prototype's own pin form, and
  only when the S3 object carries the generator-written `x-amz-meta-pin-submit-url` and its form id matches the
  document in the request path. Everything else keeps the strict base policy.

### Upgrade notes
- **The circuit breaker is live for the first time after this deploy.** A plugin that fails 5 times within 15 minutes
  (`CIRCUIT_BREAKER_THRESHOLD` / `CIRCUIT_BREAKER_WINDOW`) has its schedule turned off and its runs skipped until an
  admin turns it back on or presses Reset. Scheduled runs every 30 minutes cannot reach that alone; manual "Run now"
  retries and faster schedules can. Watch the `plugin.disabled` audit log line after deploying.
- Deploy VocCoreStack (new CloudFront Function on `/prototypes/*`) and VocApiStack (document generator gains
  `PIN_SUBMIT_API_BASE`; per-method Lambda permissions are replaced), then `scripts/refresh-api-stage.sh` as usual
  (`npm run deploy:infra` does it). CloudFormation creates the new permissions before deleting the old ones.
- After deploying, open one NEW prototype's signed URL standalone: the response must carry a single
  `Content-Security-Policy` ending in `connect-src https://<api>/v1/feedback-forms/pf_…/submit;`, and a pin must save.
- GitHub Issues: no backfill; stored issues refresh the next time GitHub reports a change. The idempotency key for
  github_issues now carries a content fingerprint. The poller lists all comments of each changed issue (usually one
  request; each comment counts against the 1,500-items-per-run cap).
- No new IAM: ingestors and the integrations API already read and write the aggregates table.

## [3.05.06] - 2026-10-08

Tooling only: more ruff rule families gate the Python code.

### Changed
- `voc-datalake/ruff.toml` now also selects LOG, PLE, RSE, A, PGH, ISC, T10, TID, ASYNC, DTZ001, PLW2901, EXE,
  ICN001, PYI034 and FURB167, so new findings of these kinds fail `scripts/validate.sh`. The few existing findings
  were fixed with no behaviour change: loop variables are no longer reassigned in their own loop, test datetimes carry
  a timezone, `xml.etree.ElementTree` is imported as `ET`, and the three operator scripts with a shebang
  (`scripts/mcp_tokens/backfill_creator_index.py`, `scripts/retention/rebuild_aggregates.py`,
  `scripts/retention/remove_ttl.py`) are now executable. The families measured and deliberately not selected are
  listed, with reasons, in `ruff.toml`.

## [3.08.04] - 2026-10-08

Docs only: the Kiro ACP bridge guide names credentials generically.

### Fixed
- `docs/kiro-acp-browser-bridge.md` lists "single sign-on credentials" instead of a company-internal tool name.

## [3.08.03] - 2026-10-08

Tests only: no account-specific data or local paths in the repository's tests.

### Fixed
- The e2e suite no longer defaults to one deployment's raw-data bucket: the S3 avatar proof in
  `e2e/tests/s3-personas-documents.spec.ts` needs `E2E_RAW_BUCKET` and says so when it is missing. The ops visual check
  writes its screenshots under the e2e output folder (`E2E_OUT`) unless `E2E_EVIDENCE_DIR` is set, and the budget notes
  no longer name a local path. A layout unit test uses a placeholder name.

## [3.08.02] - 2026-10-08

Tooling only: the agent write-guard on the quality gates is removed; the read-only notice stays.

### Removed
- The Kiro PreToolUse hook `.kiro/hooks/protect-quality-gates.json` (and its script). It also blocked writes to
  files that only mentioned the gate file. The read-only notice at the top of `eslint-rules/quality-gates.mjs`, the
  coding-standards steering rule and the test pinning `max-lines` at 400 / 750 remain.

## [3.08.01] - 2026-10-08

Tooling only: the remaining commits of PR #425 (quality gates) are merged. This release also puts the version back
above 3.08.00 — the 3.05.04 and 3.05.05 housekeeping releases were numbered below it.

### Changed
- CI prints the pending-gate counts (`scripts/quality-baseline.sh`) to the job summary after Validate, as an
  informational step that never fails the job.
- The shared ESLint quality-gate rules (`eslint-rules/`) and `scripts/knip-production.mjs` are now covered by their own
  tests (`voc-datalake/scripts/*.test.ts`, run in the CDK vitest suite), and `scripts/knip-production.mjs` fails
  clearly on a malformed or non-object `knip.jsonc`.
- `typecheck:cdk` type-checks the tools project without emitting files; the frontend is built before the CDK suite in CI.
- The competing-allocation moto test serializes its transactions (it flaked on CI).
- **Quality gates are human-owned.** `eslint-rules/quality-gates.mjs` now opens with a read-only notice for agents;
  the `max-lines` ceilings are fixed at 400 lines for production files and 750 for specs (was 730), pinned by
  `voc-datalake/scripts/quality-gate-rules.test.ts`. A new Kiro PreToolUse hook (`.kiro/hooks/protect-quality-gates.json`)
  blocks agent writes to that file, and the coding-standards steering says to fix the code instead of relaxing a gate.

## [3.05.05] - 2026-10-08

Housekeeping only: the generated plugin manifest catches up with `cdk.context.json`, and the repo's review agents use
Kiro's current configuration format.

### Fixed
- `voc-datalake/frontend/src/plugins/manifests.json` (generated by `npm run generate:manifests`) now shows
  `github_issues` as enabled, matching `pluginStatus` in `voc-datalake/cdk.context.json` since 2.16.00. The committed
  copy was stale; builds regenerate it, so a deployed frontend was not affected.

### Changed
- The repo's Kiro review agents (`.kiro/agents/quality-reviewer.json`, `security-reviewer.json`,
  `test-generator.json`) use Kiro's current tool names and a `permissions` block. Their access is the same as before.

## [3.05.04] - 2026-10-08

Tests only: mutation hardening of 47 stream Lambda files; the CDK test temp-dir cleanup gets a longer hook timeout.

### Changed

- Mutation-hardened specs for 47 files of the streaming chat Lambda (assistant contract and runtime, session record and recorder, Bedrock streaming and model fallback/override, attachments, tool specs, client and server tools, feedback search, CloudFront signing, persona context, handler); every one is at 0 surviving mutants. Equivalent-mutant code was simplified with no behaviour change.

## [3.08.00] - 2026-10-08

Settings → AI models can test a model's access and capacity before it is saved.

### Added
- **Test a model before saving it** (Settings → AI models): changing a surface's model is now a draft with
  **Save** / **Discard**; each row's **Test** sends one minimal request to exactly the model the draft resolves
  to (Automatic included; no fallback, no retry) and shows the result as a status: Available (latency and
  tokens per minute), No access, No capacity, Throttled, Not in this region, Not ready, Unavailable or Error.
  Saving a model whose last test did not pass asks for confirmation. **Test all models** tests every allowlisted
  model one at a time in a small table. See [docs/deployment.md](docs/deployment.md#testing-a-model-before-saving-it-settings--ai-models).
- **`POST /settings/model/test`** `{model_id}` and **`GET /settings/model/capacity`** (both admin-only): the test
  result `{model_id, invoked_id, status, ok, latency_ms, message, quota, checked_at}`, and each allowlisted
  model's tokens-per-minute quota from Service Quotas (no model call).

### Upgrade notes
- The settings Lambda role (`SettingsLambdaRole`, VocApiStack) gains the read-only
  **`servicequotas:ListServiceQuotas`** on `*` (the API has no resource-level permission; documented cdk-nag
  suppression). Nothing else changes; deploy as usual and refresh the API stage.
- **No capacity** means the model is subscribed but its tokens-per-minute quota is 0 in this account: the only
  action is to wait. The UI offers no quota-increase request for it.

## [3.07.00] - 2026-10-08

The AI surfaces move to the Claude 5.5 generation: Opus 5.5 and Haiku 5.5 join the model picker, and the
built-in defaults now use Sonnet 5.5, Opus 5.5 and Haiku 5.5.

### Added
- **Claude Opus 5.5** (`global.anthropic.claude-opus-5-5`) and **Claude Haiku 5.5**
  (`global.anthropic.claude-haiku-5-5`) in Settings → AI models, on every surface. Both reject `temperature` and an
  explicit thinking budget and do not support the Flex tier; requests to them omit all three automatically.
  Both have an `eu.` profile, so EU deployments can use them too ([docs/eu-deployment.md](docs/eu-deployment.md)).

### Changed
- **Built-in ("Automatic") surface defaults**: documents, utilities and the internal default bucket → Sonnet 5.5
  (was Sonnet 5); prototypes, agent conductor and agent final reviewer → Opus 5.5 (was Opus 5); feedback
  enrichment and memory → Haiku 5.5 (was Haiku 4.5). The AI assistant, agent workers and the persona panel stay on
  Sonnet 5.5. Every older model stays selectable; the picker describes them as previous generation.
- **Capacity fallback order** (REST/jobs and the streaming assistant): Sonnet 5.5 → Sonnet 5 → Sonnet 4.6 →
  Haiku 5.5 → Haiku 4.5 ([docs/deployment.md](docs/deployment.md#model-capacity-fallback)). Opus is still never a
  stand-in. Bedrock's own Opus safety fallback now runs Opus 5.5 → Opus 5 → Opus 4.8, and every hop is granted.
- The memory surface still asks for Flex; Haiku 5.5 does not support it, so memory calls go out on the default tier
  in one round trip ([docs/memory.md](docs/memory.md)).
- Persona generation on the documents surface now sizes its feedback corpus for Sonnet 5.5's 1M-token context
  (about 5× the previous budget), so more feedback reaches each persona run.
- `VocApiStack`: the Projects API role's Bedrock invoke grant moved from its default inline policy to its own
  customer-managed policy (same actions and resources) to stay clear of the role's inline-policy size quota.

### Upgrade notes
- **Bedrock model access**: grant Claude Opus 5.5 and Claude Haiku 5.5 in each account (and, for EU deployments,
  their `eu.` profiles) before relying on the new defaults. A deploy with `anthropicUseCase` set creates the
  agreements automatically, because the agreement list is derived from the allowlist. Without access, those surfaces
  fall back along the capacity chain to Sonnet 5.5 (prototypes and the agent conductor/reviewer get Sonnet, never an
  older Opus) — or pin them in Settings → AI models or with `-c defaultModelId`.
- **Pinned surfaces keep their pinned model**: only surfaces left on Automatic change. A `-c defaultModelId` pin
  written earlier is also kept.
- **Cost**: the new defaults bill at Opus 5.5 and Haiku 5.5 rates, and the documents surface sends larger persona
  prompts on Sonnet 5.5. Check the [Amazon Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/) before
  deploying.
- The context windows of Opus 5.5 and Haiku 5.5 are recorded as 200K tokens (conservative, not yet confirmed on the
  model cards); prompts sized for those surfaces never assume more.

## [3.05.03] - 2026-10-08

Tooling only: the CDK test suite no longer fills the disk, and whole-package Stryker sweeps can start.

### Fixed
- The CDK vitest suite left one cloud assembly (about 340 MB, with `frontend/dist` and the Lambda bundles) in the
  system temp dir for every synth and never removed it. A Stryker sweep, which re-runs the synth tests once per
  mutant, left 21,579 of them and filled the disk. Each test file now synthesizes into its own directory under
  `<tmp>/voc-cdk-tests/`, removed when the file ends; directories of killed workers are swept by the next file
  (`lib/test-support/cdk-tmpdir.setup.ts`).
- Stryker's initial test run may take up to 30 minutes (was Stryker's default 5), so a whole-package frontend sweep no
  longer times out before it starts (`STRYKER_DRY_RUN_TIMEOUT_MINUTES`).

### Upgrade notes
- Contributors: old `cdk.out*` directories from earlier test runs stay in your temp dir (`$TMPDIR`, on macOS under
  `/var/folders/…/T/`). Delete them once, when no test or `cdk` command is running.

## [3.05.02] - 2026-10-08

Tooling: TypeScript mutation testing (Stryker per package, planner TS mode, brief).

### Changed

- Mutation tooling for the TypeScript packages: voc-datalake/scripts/mutate-ts.sh runs Stryker (vitest runner, per-test coverage, incremental cache) per file and lists every surviving mutant; node scripts/mutation-plan.mjs plan --ts batches files into agent jobs; the brief has a TypeScript section. The Settings → Users flags panel spec now pins its copy and rules (0 surviving mutants).

## [3.06.00] - 2026-10-08

Tag and filter feedback by your own dimensions (product, module, user type …) and tags, per-source data
protection (PII redaction, restricted sources, retention and erasure), CSV column mapping, and EU-only inference.

### Added
- **Dimensions** (Settings → Dimensions, `GET/PUT /settings/dimensions`): up to 10 admin-defined dimensions with
  allowed values and an optional one-level parent (product → module). Values come from the import, then the source
  profile, then the category's `product`, then the model (dimensions with `infer: true`). Feedback items gain
  `dimensions`, `dimension_sources` and `tags`; they are edited in place on a review (`PUT /feedback/{id}/dimensions`).
  See [docs/dimensions.md](docs/dimensions.md).
- **Filters** `channel`, `dims=key:value,…` and `tag` on `/feedback`, `/feedback/urgent`, `/feedback/search`,
  `/feedback/entities` and every `/metrics/*` view (summary, sentiment, categories, sources, personas, dimensions,
  github); `/metrics/summary`, `/sources` and `/personas` now also take `source`. Categories page filters for each.
  `GET /metrics/dimensions?key=` counts a dimension's values with a sentiment split (Dashboard "By dimension" card);
  `/feedback/entities` adds `channels`, `tags` and `dimensions`.
- **Source profiles** (Settings → Sources, `GET/PUT /settings/sources`): per source id, a PII policy (`allow`,
  `redact`, `summary_only`), `retention_days`, `restricted`, dimension defaults and tags. Redaction replaces
  emails, phone numbers, IBANs, cards and IPs (plus names and addresses through Comprehend for English and
  Spanish) before anything is archived or queued. See [docs/source-policies.md](docs/source-policies.md).
- **Access by source**: a user's access (Settings → Users → Category access) gains a Sources rule — default
  (every source that is not restricted), all, or selected. `PUT /users/{u}/category-access` takes
  `sources: ['*'] | [ids] | null` (null = back to the default); `GET /feedback/access` adds `sources_all`, `sources`,
  `source_rule` (`all` / `allow` / `deny`) and `sources_denied`.
- **Erasure** (Settings → Sources, `POST/GET /settings/erasure`): delete every review matching an author, source
  id, CSV row id or email (case-insensitive). A source id or CSV row id erasure must name its `source` (400 without).
  Only a SHA-256 hash of the value is stored. What erasure does not reach (copies in documents, conversations,
  memory, whole-file uploads) and what to do: [docs/source-policies.md](docs/source-policies.md).
- **CSV upload**: pick a source profile (`source_id`) and map columns (`column_map`: text, author, title, channel,
  tags, `dimension:<key>`, …); unmapped columns are kept in `metadata` instead of being dropped. Author and title
  are now stored. JSON upload, feedback forms (also the widget's `dimensions` embed option) and scrapers accept
  dimension defaults and tags.
- **AI assistant and MCP**: `channel` / `dims` / `tag` on the search, list, urgent, entities and metrics tools (and
  `source` on every metric view), a `list_dimensions` tool, a `dimensions` view in `get_metrics`, and form dimension defaults/tags in
  `update_feedback_form` ([docs/mcp.md](docs/mcp.md)).
- **EU deployment**: `-c inferenceScope=eu` sends every Bedrock call through `eu.` inference profiles and grants
  only those ([docs/eu-deployment.md](docs/eu-deployment.md)).

### Changed
- A message's `metadata` (and `metadata.custom_fields`) entry whose key is a configured dimension key is a dimension
  value (origin `source`) when no explicit `dimensions` value is given — an unmapped CSV column named `product`
  fills the `product` dimension.
- Feedback forms: the form's own `dimension_defaults` win over the widget's `dimensions` embed option, which may
  only fill keys the form leaves unset ([docs/feedback-forms.md](docs/feedback-forms.md)).
- `metadata.email` / `metadata.submitter_email` are stored lower-cased at ingestion.
- `POST /settings/categories/reprocess` accepts `mode: 'dimensions'`: re-infers model dimensions only, never
  overwriting a value set by the import, a profile or a person.
- New aggregate counters `METRIC#daily_dim…` and `METRIC#daily_tag#…` feed the dimension and tag views.

### Fixed
- A form submission the source policy rejects answers 400 instead of being queued unredacted.
- Admin-controlled text interpolated into enrichment prompts (channel, source, dimension and category descriptions)
  is one bounded line without newlines or braces.
- The processor resolves the model's category against the configured categories (unknown → `other`) on every
  enrichment path, so a made-up category can no longer reach the category index.

### Security
- A `restricted` source is invisible to users without an explicit grant on every list, item, search, metrics and
  entities route, in the AI assistant and over MCP; callers whose source rule hides anything are served from the
  items, never from the pre-computed counters.
- `redact` / `summary_only` sources keep no raw copy and never queue the author or unredacted text. Redaction also
  covers `url` / `source_url` (query strings) and metadata at any depth (nested maps such as `custom_fields`, lists).
- The AI assistant, which reads feedback straight from the table, applies the source rule as well as the category
  rule to every search, count and by-id lookup, and admits nothing when the rule cannot be read.
  `/metrics/categories` serves a source-restricted caller from the items, not the counters.
- Ingestion fails closed when the source profiles cannot be read: plugin runs fail and retry, webhooks and the form,
  upload and data-explorer routes answer 503, and the processor retries a message that carries no applied policy —
  nothing is archived or queued under the `allow` default.
- Feedback-form statistics read `source_platform`, so a source restriction applies to them.
- A research / persona job started by a source-restricted user reads that user's visible feedback instead of none.
- `voc-retention` holds an explicit IAM Deny on deleting `raw/csv_upload/*` and `raw/json_upload/*`.
- Per-item raw archives are named collision-free (`h.<sha256>` for ids that are not filename-safe or longer than 64
  characters), so two items no longer share one archive object and an erasure removes only the item's own copy.

### Upgrade notes
- **New IAM permission:** every ingestion-side Lambda (plugin ingestors and webhooks, manual import, feedback
  forms, data explorer) is granted `comprehend:DetectPiiEntities` and runs with `PII_COMPREHEND=1`. Nothing calls
  it until a source profile sets `pii: redact` or `summary_only`.
- **New `voc-retention` worker** (VocProcessingStack, daily schedule): the ONLY role in the app with a delete
  permission on customer data (feedback items and their `raw/*` objects, all versions). It deletes nothing unless a
  source profile sets `retention_days` or an admin requests an erasure. Whole-file CSV archives
  (`raw/csv_upload/*`) are never deleted; sources with retention or a non-`allow` policy archive per item instead.
- **`-c inferenceScope=eu`** is opt-in (default `global`, templates unchanged). With `eu`, web search is never
  deployed (an explicit `-c enableWebSearch=true` fails the synth) and persona avatars are disabled.
- **CSV `source_id`:** a CSV upload with a `source_id` stores its reviews under that id as `source_platform`
  instead of `manual_import`; earlier imports keep their source. The legacy `source` / `source_channel` CSV column
  still maps to the channel.
- **Existing reviews have no dimensions** until you define them and then run Settings → Categories → Reprocess in
  the dimensions mode (`mode: 'dimensions'`).
- **Archive names:** per-item raw archives written before this release for an id that was not filename-safe or was
  longer than 64 characters are no longer recognised by the retention worker; remove such leftovers by hand
  ([docs/source-policies.md](docs/source-policies.md)). GitHub Issues ids (`owner/repo#n`) are such ids: a
  re-ingested issue is archived under a new `h.<sha256>` name and its old object stays.
- **503 on ingestion routes:** the form submit, CSV/JSON upload and data-explorer routes (and plugin webhooks) can now
  answer `503` while the source settings are unreadable; callers should retry.
- **Web scrapers:** a scraper's reviews carry the scraper's name as their source, so a profile must use that name
  (in the id format); a `webscraper` profile never matches.

## [3.05.01] - 2026-10-08

Tests only: mutation hardening of the last 16 Python modules/slices; every Python module is now at 0 surviving mutants.

### Changed

- Mutation-hardened test suites for the integrations and memory APIs, the document and persona generator jobs, the aggregator's last slice, the memory policy, tracing, model fallback, agent artifacts/state machine/nodes, the normalized feedback item, and the synthetic-reviews and template ingestors (no behaviour change; equivalent-mutant constructs simplified).

## [3.05.00] - 2026-10-07

The plugin circuit breaker really stops a failing schedule, KiroCrew's data palette, a higher MCP rate limit, four
Lambdas upsized for CPU, and a validate gate that runs in about 4 minutes instead of 16.

### Added
- A gitleaks secret scan of the working tree is now a `scripts/validate.sh` step (`scripts/gitleaks-tree.sh`,
  using `.gitleaks.toml` and `.gitleaksignore`, with redacted output). CI installs gitleaks 8.30.1.
- `scripts/validate-affected.sh [<base>]` runs only the gates a track, agent or mutation branch needs, based on the
  paths it changed, including suites that read those files from other packages. `--explain` prints the mapping. See
  CONTRIBUTING.md → Quality gates.

### Changed
- **MCP:** each global MCP token (`POST /mcp/global`) can make up to 120 requests per UTC minute (was 60). Past
  that it still gets `429` with `Retry-After`, and tokens still live at most 90 days ([docs/mcp.md](docs/mcp.md)).
- **Charts and category colours** use KiroCrew's categorical data palette: accent purple, blue, teal, orange,
  violet, grey, green, amber. It replaces the purple→pink ramp on the Dashboard, the GitHub insights chart, the
  Categories bars and legend, the social-feed source edges and the Categories PDF. Sentiment keeps the status
  colours (positive = ok, negative = danger, mixed = warn, neutral = muted), as KiroCrew does for good/bad values
  ([docs/kiro-design-system.md](docs/kiro-design-system.md)).
- **Kiro Dark:** the success/positive green is `#1bb36b` (KiroCrew's Kiro green, lightened for contrast; was
  `#22c55e`), and the sidebar rail uses the card colour `#211d25`.
- **Lambda memory raised for CPU, upsize only:** `voc-agent-heartbeat`, `voc-logs-api`, `voc-memory-scanner` and
  `voc-mcp-tokens-api` go from 512 to 1,024 MB. All four were over the 70 % CPU ceiling in the 3.00.00 production
  check. Nothing was lowered, and Ballots stays at 1,024 MB ([docs/lambda-sizing.md](docs/lambda-sizing.md)).
- **VocIngestionStack:** each scheduled ingestor (`webscraper`, `app_reviews_ios`, `app_reviews_android`,
  `github_issues`) runs as its own IAM role, `IngestorRole<Plugin>`. It has the same base grants plus
  `events:DisableRule` on exactly its own schedule rule. Unscheduled ingestors keep the shared role.
- **`scripts/validate.sh`** runs its steps in four parallel lanes and stops at the first failure, printing that
  step's log tail. It keeps one log per step under `.cache/validate/logs/` and ends with a timing table (`--serial`,
  `--keep-going`, `--only`, `--list`). pytest runs on pytest-xdist and the CDK vitest suite on four workers. Wall time
  dropped from about 16 to about 4 minutes. The full gate now runs once per release, on the integration branch
  before the release commit; branches run the affected gates only.

### Removed
- The unused audit-to-EventBridge path (`AUDIT_EVENT_BUS` in `plugins/_shared/audit.py`). No stack ever set it.
  Plugin audit events remain one `AUDIT` CloudWatch log line each.

### Fixed
- The plugin circuit breaker now disables the plugin's EventBridge schedule when it trips. Before, the client it
  needed did not exist, so it only wrote the `CIRCUIT#<plugin>` / `TRIPPED` row, and the schedule kept invoking the
  ingestor every tick ([docs/plugin-architecture.md](docs/plugin-architecture.md), "Circuit Breaker").
- GitHub design-system imports (Company context → design references) pick up plain token files such as
  `tokens.json`, `design-tokens.json` and `tokens.css`. Before, they were skipped or ranked as ordinary CSS.
- Projects → Product context no longer fails with a 500 when the interview proposes a non-text lifecycle state;
  the bad value is dropped. A product-doc upload whose `filename` or `content_type` is not text now gets a 400
  instead of a 500.
- Ids and keys with a trailing newline (for example `rp_0123456789ab\n`) are refused everywhere they are validated:
  job, token, document edit/version, pin, conversation, scraper and company-context ids, GitHub repository names,
  and the field names and error codes shown on the Logs page.
- Kiro Light: the error/negative red is `#bd1c3a` (was `#c11d3b`), so a negative badge on a hovered row meets
  WCAG AA (4.64:1, was 4.48:1). PDF exports use the same red.
- The processor's batch-concurrency test no longer compares wall-clock times, which made it fail under load.

### Upgrade notes
- **VocIngestionStack** creates one IAM role per enabled scheduled plugin and moves those ingestors onto it, as an
  in-place Lambda update. Each scheduled ingestor gets `INGEST_SCHEDULE_RULE_NAME` in its environment.
- **Recovering a tripped plugin is now two steps.** Its schedule shows as disabled in Settings. Delete the
  `CIRCUIT#<plugin>` / `TRIPPED` item from the watermarks table, then re-enable the source in Settings.
  Re-enabling alone turns the schedule back on, but every run is skipped while that item exists.
- If you read plugin audit events from your own `AUDIT_EVENT_BUS`, use a CloudWatch Logs subscription or metric
  filter on the `AUDIT` log lines instead.
- **Cost of the upsizes:** all four functions are pay-per-use, so the per-call charge at most doubles, which is
  cents a month at current volume. The exception is `voc-mcp-tokens-api`'s SnapStart cache, which is billed while
  its version is active: about $1.95 → $3.90 a month.
- **Deploy** with `npm run deploy:infra`, so the API stage refresh runs. Re-run
  `scripts/capacity/capacity-query.sh --hours 168` once traffic exists. `voc-logs-api` is CPU-bound and may still
  read over 70 %; Power Tune it rather than raising it again.
- **Contributors:** install gitleaks 8.30+ (`brew install gitleaks`), and re-install `voc-datalake/requirements-dev.txt`
  (it adds `pytest-xdist`).

## [3.04.00] - 2026-10-07

Home offers the dashboard from the first visit, and each user can choose to open the app on the dashboard.

### Added

- Home: an **Open dashboard** button in the hero at all times (it used to appear only after the setup
  checklist was hidden or skipped), and a switch **Open the dashboard when I sign in**. With it on, opening
  the app — a fresh load of `/` or the redirect after sign-in — goes straight to `/dashboard`; the sidebar's
  Home link still shows Home. The same switch is on the Account page under Setup checklist.
- `PUT /settings/my-onboarding` accepts `start_page` (`home` | `dashboard`), alone or with `state`, and
  `GET` returns it (default `home`). It is stored per user next to the checklist state, so it follows the
  user across browsers.

### Changed

- `PUT /settings/my-onboarding` changes only the fields it names (one `UpdateItem`), so choosing a start
  page never resets the checklist, nor the reverse. An empty body now answers 400
  `Give state, start_page or both`.

## [3.00.05] - 2026-10-07

Docs only: mutation programme status and worktree cleanup recorded.

### Changed

- The mutation-hardening status (161 modules done, 16 slices left) and the worktree cleanup are recorded in todo.md for the next session. No code change.

## [3.00.04] - 2026-10-07

Tests only: mutation round 15 (8 modules/slices).

### Changed

- Eight more modules or slices are mutation-hardened to zero survivors — the aggregator's lines 1051–1565, the agents store's second half (so the whole store is done), the GitHub issues ingestor, agentic web search, the conductor's planning, document versioning's stale-save guard, batched DynamoDB reads and scraper run-error redaction. About 15 weaker tests removed; the unreachable branches those runs exposed are deleted. No behaviour change.

## [3.03.00] - 2026-10-07

Cancel keeps unsaved drafts; the assistant never covers a save row; the API stage is refreshed after every deploy so removed routes stop being served; the integrations and feedback-form APIs get 1,024 MB and SnapStart priming; e2e ledger and run-target fixes.

### Fixed

- Unsaved-changes guard: on `/admin` (General & brand), pressing **Cancel** in the "Unsaved changes"
  dialog no longer throws the brand edits away. The brand settings could load (or refetch) after you
  started typing — the fields are editable while they load — and replaced your edits, so the form went
  clean and the next navigation left without asking. A fresh server copy now only updates the fields
  you have not edited. The agent page (`/agents/{id}`) had the same flaw when the agent refetched (for
  example after a run updated its stats) and is fixed the same way. Every editor that uses the guard
  (Administration, Company, Account objectives, agents, workflows, Prioritization and the persona,
  document, user, scraper and feedback-form dialogs) now passes one shared test: edit, leave, Cancel,
  the draft is still there, and leaving again asks again.
- Accessibility: the First Name / Last Name labels in the user dialogs now name their inputs.
- Assistant launcher: at 390 px it no longer covers the full-width **Save Changes** on `/company`.
  Every form's primary save / submit row is now a registered sticky action bar the launcher keeps
  clear of: Company (vision & objectives, design system, design tokens), Account (Change Password,
  objectives), Connect (Create token), Memory (Remember, Import), Administration (data-source
  credentials, Start reprocessing), the feedback category picker, Prioritization row composition,
  project research notes and the product interview. A guard test fails when a new page renders a
  primary button without saying whether its row is registered or why it is exempt.
- Production e2e suite (`voc-datalake/frontend/e2e`, tests only), the spec bugs found by the 3.00.00
  verification:
  - `s2-agents` fills the custom step's "Instructions (required)" field by its label. It used to fill
    the workflow Description, so the save never landed and the agent ran the built-in workflow.
    Before every Run now, it checks that the agent runs this run's e2e workflow and that the workflow
    has no project step.
  - Any project an agent run creates is read from the run's journal and recorded in the ledger, so
    cleanup deletes it. Entities a browser create call makes are recorded too (projects, forms, agents
    with their workflow copy, workflows), including the ones the assistant creates through an
    approval card.
  - `s3-personas-documents` waits for the restored version after a Restore instead of racing the
    re-mounted Versions list.
  - s3 cleanup deletes every conversation the run started.
  - s3's avatar proof checks the content-addressed `avatars/{persona_id}/{hash}.{ext}` keys (plus the
    legacy flat ones) and must see every avatar a persona points at before the delete.
  - `assistant-bubble` judges a keyboard move where the launcher ends up, after its 150 ms
    transition. F5-a / F5-b (every audited page, both viewports) likewise judge the launcher once it
    has stopped moving, instead of one read after a fixed 300 ms sleep.
  - `unsaved-guard` reaches the agent through in-app links, so Back opens the in-app dialog. A new
    test checks that a full reload raises the browser's own leave prompt.
  - `unit/helpers.spec.ts` adds structural guards: every spec uses the suite `test`, every context a
    spec opens is prepared, every agent-run spec checks its target and deletes the projects its runs
    created, and no spec selects conversations by label.

### Changed

- Assistant launcher: it now moves only when it would actually sit on an action bar, instead of
  jumping above any bar visible anywhere in its column (a page with two forms, such as Account, no
  longer sends it to mid-screen).
- Deploy: `npm run deploy:infra` (and `npm run deploy` / `deploy:api` in `voc-datalake/`) now
  ends by re-deploying the API Gateway stage (`voc-datalake/scripts/refresh-api-stage.sh`, through
  the new `scripts/cdk-deploy.sh`; extra arguments still reach `cdk deploy`). This closes the
  3.00.00 gap where routes removed from the API (`POST /mcp`, `ANY /mcp/{proxy+}`) stayed live on
  the stage and answered 500 until it was redeployed by hand: CloudFormation snapshots the new
  deployment before it deletes removed methods. See
  [docs/deployment.md](docs/deployment.md#refresh-the-api-stage-after-every-deploy-removed-routes).
  The post-deploy ops check (`tests/ops-postdeploy.spec.ts`) now fails when the stage serves a
  method the API definition no longer has, or when a retired route answers 2xx or 5xx.
- Capacity: `voc-integrations-api` and `voc-feedback-form-api` go from 512 MB to 1,024 MB. Since the
  3.00.00 deploy both broke the 70 % CPU rule: integrations at 71.4 % weighted and 88.5 % p95 over 29
  long calls (warm calls too), and feedback forms at 79.9 % p95 over 60. Both are SnapStart functions,
  so the deploy publishes a new snapshotted version and moves the `live` alias. The SnapStart cache cost
  of each doubles, to about $3.90 a month
  ([docs/lambda-sizing.md](docs/lambda-sizing.md#snapstart-on-for-the-four-slow-apis)).
- SnapStart priming: the four SnapStart APIs now build every route's request-validation model before
  the snapshot. The integrations API also pre-parses the DynamoDB and Lambda SDK models that its run
  routes loaded lazily after every restore (locally, 83 ms → 23 ms CPU on the first
  `GET /sources/status?run_status=…`). The priming creates no client, makes no AWS call and holds no
  credential.

### Upgrade notes

- Deploy with `npm run deploy:infra` (or `voc-datalake/scripts/cdk-deploy.sh`): it runs `cdk deploy`
  and then refreshes the API stage, so routes removed from the API stop being served.
- If you deploy with a bare `cdk deploy` or with the synthesized CloudFormation templates, run
  `bash voc-datalake/scripts/refresh-api-stage.sh` after the stack update completes
  (`API_STACK=<prefix>-VocApiStack` for a prefixed deployment). It makes one write: a new
  deployment of stage `v1`.

## [3.02.00] - 2026-10-07

MCP token hardening: 90-day maximum lifetime, a per-token rate limit and a secret-scanning rule.

### Added

- Global MCP (`POST /mcp/global`): each token may make at most 60 authenticated requests per
  minute. The next one is answered **429** (JSON-RPC error `-32002`) with `Retry-After`, and
  counted in the `RateLimited` metric. One runaway assistant can no longer use up the stage
  throttle every other token shares. See [docs/mcp.md](docs/mcp.md#token-api-connect-page).
- `/.gitleaks.toml`: the default gitleaks rules plus `voc-mcp-token`, which reports a
  `voc_tok_…` token committed to the repository.

### Changed

- Connect → MCP & skills: a token now lives at most **90 days** (was 365); the form offers
  7, 30 or 90 days and `POST /connect/tokens` refuses `expires_in_days` above 90.

### Security

- Shorter-lived MCP credentials and a per-token request budget, following OWASP MCP01
  (short-lived, scoped tokens) and the MCP security best practices.

### Upgrade notes

- Tokens minted before this release keep their stored expiry, up to 365 days. To enforce the
  new bound at once, revoke them on Connect and mint new ones.
- Optional: add the `voc-mcp-token` regex from `.gitleaks.toml` as a GitHub secret-scanning
  custom pattern for your organisation, to catch tokens pasted in other repositories.
- Version order: the tests-only release numbered 3.00.03 below shipped after 3.01.00. It is
  kept as released; 3.02.00 contains both.

## [3.00.03] - 2026-10-07

Tests only: mutation round 14 (8 modules).

### Changed

- Eight more modules are mutation-hardened to zero survivors — the product-document extractor, company context and design-system storage, document history, the plugins' base webhook, onboarding state, the per-invocation cost line, collision-safe ids and the build-prototype node. About 30 weaker tests removed; the unreachable guards and fallbacks those runs exposed are deleted. No behaviour change.

## [3.01.00] - 2026-10-07

The global MCP server gains `get_agent_run`, so an assistant can follow the agent run it started.

### Added

- Global MCP (`POST /mcp/global`): a read tool `get_agent_run` returns one agent run by `run_id`
  (status, current step, project, error), or without `run_id` the agent's newest runs (`limit`, 1–50,
  default 5). It wraps the existing `GET /agents/{id}/runs[/{run_id}]` routes, so any token whose minter
  can see the agent may use it — read tokens included. Documented in [docs/mcp.md](docs/mcp.md) and the
  downloadable skill (`/voc-mcp-skill.md`).

### Upgrade notes

- No infrastructure change: the MCP Lambda already invokes the agents API. Re-download the skill on
  Connect to give assistants the new tool's guidance.

## [3.00.02] - 2026-10-07

Tests only: mutation round 13 (7 modules/slices).

### Changed

- Seven more modules are mutation-hardened to zero survivors — the Bedrock Converse wrapper (retries, tiers, chains, logging), the global MCP endpoint (every refusal byte for byte), user administration, the Android app-review ingestor, the agents' model helper, the SnapStart hooks and the feedback-form handler's entry point. About 40 weaker tests removed; the unreachable branches and defaults those runs exposed are deleted. No behaviour change.

## [3.00.01] - 2026-10-07

Tests only: mutation round 12 (6 modules/slices).

### Changed

- Six more modules are mutation-hardened to zero survivors — the agents store's first half (ids, cursors, cron parsing, agent normalisation), the run conductor, the agent heartbeat scheduler, CloudFront signed URLs, the agent runtime and the revise-document node. The conductor and heartbeat suites pin the shared instrumentation stack the 3.00.00 handlers wear. About 15 weaker tests removed; the unreachable guards those runs exposed are deleted. No behaviour change.

## [3.00.00] - 2026-10-07

A major release: the per-project MCP server, its token routes and `GET /projects/{id}/autoseed` are removed
(the global MCP on Connect replaces them). Also: the Home onboarding checklist, workflow editor parity, a
draggable assistant button, an unsaved-changes guard and a project Edit dialog; one Lambda sizing policy with
CPU measured on every function, memory raises and Power Tuning pins; faster cold starts (no X-Ray import, SnapStart
on four APIs); a creator index for `GET /connect/tokens` and one batched project read for Prioritization;
failure alarms that actually notify, 400s for malformed bodies, a 409 for a stale document save, collision-safe ids
and honest load-failure states; P2 and P3 production e2e coverage.

### Added

- Every Lambda now logs one `invocation_cost` line per invocation (CPU ms, wall ms, configured MB and CPU as a %
  of the function's share; numbers only, never a payload): the feedback processor, aggregator, agent conductor /
  nodes / persona panel / heartbeat, memory scanner / extractor / retention, the document and persona jobs,
  document merger, category reprocess, manual-import processor, MCP handlers, every plugin ingestor and webhook,
  the product-doc extractor and the TypeScript `voc-chat-stream` — not only the `@api_handler` APIs. One Logs
  Insights query (`filter message = "invocation_cost"`) now covers every function. See
  [docs/lambda-sizing.md](docs/lambda-sizing.md).
- `voc-datalake/scripts/capacity/capacity-query.sh`: a read-only capacity report for every deployed `voc-*`
  Lambda under the sizing policy (peak memory and both CPU figures, grouped by MemorySize), listing unmeasured
  functions and exiting non-zero on a breach; `--repo-sizes` judges at the checkout's sizes before they deploy.
- Read-only ops e2e specs (`E2E_OPS=1`, `frontend/e2e/playwright.ops.config.ts`): `ops-capacity` (every
  Lambda within policy) and `ops-postdeploy` (failure queues empty, alarms OK, processor batching 10 / 5 s,
  0 memory-worker ERROR lines, FlexFallback / ModelFallback / AssistantSessionWriteFailed at 0).
- [docs/lambda-sizing.md](docs/lambda-sizing.md): the policy, the queries, and a runbook for AWS Lambda Power
  Tuning (owner approval, non-production first, read-route payloads).
- `/projects` list: an **Edit** button on each card the caller can edit opens a dialog for the name and description,
  plus visibility for the owner or an admin. It saves through `PUT /projects/{id}` and `PUT /projects/{id}/visibility`,
  sending only what changed, and the card updates immediately
  ([project-workspace.md](docs/project-workspace.md#sharing-and-permissions)).
- Project page header: **Connect via MCP** opens Connect (`/connect?project={id}`) with the project pre-selected as
  the token's pin. It is where the removed Export / MCP tab used to send people for MCP access
  ([project-workspace.md](docs/project-workspace.md#mcp-access)).
- **Home onboarding buddy.** The "Getting started" content on `/` is now a setup checklist with a progress bar. Its
  five steps check themselves off from real state: categories set up with a product each, a feedback source
  connected (scraper or form), first feedback received, a first AI assistant conversation, and a project of your own.
  Each step links to where it is done. When every step is done it shows "You're ready" with **Hide for now** (a
  one-day snooze) and **Don't show again**; before that, **Skip** is always offered. The choice is stored per user
  on the server (`GET|PUT /settings/my-onboarding`, kept in the user's own `USERCTX#{sub}` row of the aggregates
  table, carried by the existing `/settings` proxy, so no new API Gateway resource). Once hidden, `/` shows the
  normal home with a link to the dashboard, and the checklist comes back from Home or **Account → Setup checklist**.
  The Home quick-start cards and the separate category card are folded into the checklist.
- Workflow editor (`/agents/:id?tab=workflow`): the built-in "Reviews → Prototype" workflow can now be built by hand
  from an empty canvas. **Clear canvas** starts from scratch; **Add arrow** in a step's settings wires a branch with a
  condition (pass / fail, agreed / not agreed, or always) and every outgoing arrow's condition is editable there;
  clicking a loop's frame on the canvas (or Tab + Enter) opens its settings — exit condition, max rounds (1–5) and
  member steps — and a step can join or leave a loop from its own settings. With nothing selected the panel shows the
  workflow name, description and an outline of steps and loops. See [docs/autonomous-agents.md](docs/autonomous-agents.md).
- **AI assistant button:** it can be dragged anywhere with the mouse or touch, or moved with the arrow keys
  when focused (Shift = bigger steps, Home = back to the corner). It always stays on screen, also after a
  resize, and keeps its position per user across reloads. Once moved, the open panel has a **Reset assistant
  button position** control, and the panel opens beside the button.
- **Unsaved changes:** every editor now asks before throwing edits away. One "Unsaved changes" dialog
  (Save / Discard / Cancel) appears when you leave with unsaved edits by a link, the Back button or a tab
  that would drop them, and when you close an editor dialog. Closing or reloading the browser tab shows
  the browser's own prompt. Save runs the editor's own save and leaves only once it succeeds. Covers the
  agent configuration tabs and workflow editor (`/agents/:id`), feedback form editor, scraper editor,
  persona and document editors (`/projects/:id`), company vision and design system (`/company`), my
  objectives (`/account`), brand settings (`/admin`), the user edit dialog and prioritization scores.
  Prioritization's earlier Discard/Stay dialog is replaced by this one.
- e2e suite: `tests/security-probes.spec.ts` checks the API directly. It covers the public form `iframe` route (JSON 404 for a bad id; CSP, `nosniff` and `no-referrer` on a real form), the CORS origin and `Bearer` challenge on a gateway 401, SSRF refusals on `POST /scrapers/analyze-url` (metadata IP, a redirect to it, localhost, `file://`), the `days` fallback, the e2e-user 403 on `DELETE /logs/validation/{source}`, and error bodies with no exception text. Latency budgets (`e2e/lib/budgets.ts`) set a p95 per screen and per endpoint from the 2.14.00 production measurements, and `screens.spec.ts` and `api-sweep.spec.ts` assert them. `E2E_BUDGETS=soft` records a breach as an annotation instead of failing. See `voc-datalake/frontend/e2e/README.md`.
- Production e2e suite, P2 coverage (`voc-datalake/frontend/e2e`, see its README): project sharing as two users
  (`sharing.spec.ts`), own personal memory add / +1 / forget / restore (`memory.spec.ts`), global MCP tokens minted,
  used on `/mcp/global` and revoked (`connect.spec.ts`), error states under injected 500 / 403 / timeout
  (`lib/inject.ts`, `error-states.spec.ts`), request counts per page load (`request-counts.spec.ts`), dashboard
  empty-state UI checks, Add Data Source offering enabled plugins only, the Manual Import date gate (cancelled at
  preview), persona create / edit / delete in track s3, and workflow archiving from the Workflow library in track
  s2. The default specs that need one user also run against the local dev mock (`E2E_MOCK=1`).
- P3 e2e specs (see `voc-datalake/frontend/e2e/README.md`, "P3 specs"): prioritization board and the public
  `/vote/:sessionId` ballot without a session; "My objectives & KPIs" save and restore; the FormEditor and Admin
  logs in-page tabs; an 8-locale raw-key and overflow smoke; slow 3G, dropped and offline list loads and a
  `/chat/stream` cut mid-answer recovered after reload; two-tab workflow (409), document and assistant concurrency;
  token expiry ("Session expired", silent refresh, a 401 retry); assistant desktop notifications; the main flows in
  both themes and the project flow at 390 px; prototype Enlarge Escape (#386) and tester pins; the F7 off-palette
  check on five screens. They also run against the local dev mock (`E2E_MOCK=1` with `playwright.config.ts`, the
  suite's one mock switch and runner).

### Changed

- The sizing policy's memory check is now PEAK memory (not p95): ≤ 70 % of MemorySize, ≤ 60 % for
  variable-payload functions (manual import, feedback / aggregation processors, memory extractor, document and
  persona jobs, document merger, category reprocess, S3-import ingestor, product-doc extractor). The rule, the
  classes and every function's pinned size now live in `voc-datalake/lib/sizing/policy.ts`. The first 7-day
  peak check of production (2.14.00) found no function over its ceiling, at the deployed sizes or at the
  CPU-raised sizes below, so no memory size changes for peak memory.
- `PUT /projects/{id}` refuses a blank or non-string `name` and a non-string `description` with **400**. The name
  is stored trimmed. Before this, a blank name was saved as-is.
- Account → Profile no longer says per-project tokens live on a project's Export / MCP tab. The **Copy to Kiro** menu
  no longer shows "Configure Kiro prompt in the Export / MCP tab".
- Workflow editor: a step without a verdict explains why its arrows have no condition; a blank step title is reported
  on the step ("title is required") like the server does; arrows and loop frames have readable accessible names.
- **Agent page:** the Save / Discard row stays pinned to the bottom of the page while you scroll. The
  assistant button keeps above any pinned action bar, so it no longer covers Save
  (e.g. `/agents/ag_eca50fefa298`).
- **Editor dialogs:** Escape and clicking outside now close the persona and document editors when nothing
  was changed, and ask first when something was (they used to ignore Escape entirely once text was typed).
- **Feedback forms (local mock):** the dev-mock forms use Kiro palette theme colours. The default theme of
  a new form was already the Kiro accent (`#8e48ff`, pinned by tests in the frontend and in
  `feedback_form_handler`). Forms saved earlier keep their stored colour, so a form created before 2.13
  with the old blue (`#3b82f6`) still shows that swatch until someone changes its theme.
- API Lambdas that ran above 70% of their CPU share get more memory, and with it more CPU (1,769 MB = 1 vCPU):
  `voc-ballots-api` 256→1024 MB; the agents, chat, metrics, projects, memory and scrapers APIs 512→1024 MB; the
  settings, data-explorer, logs, manual-import, integrations, s3-import, feedback-form and mcp-tokens APIs 256→512 MB.
  The rule is both resources: the worse of the weighted CPU share and the p95 share of calls of 100 ms or more must
  land at or below 70% (expected 36–65%), and peak memory use is already below 60% everywhere (at most 29% after the
  change on the raised functions). Every function's memory size is pinned by a CDK test (`lib/lambda-memory.test.ts`).
- The settings API's `available_models` rows carry a new `supports_flex` flag (false for every allowlisted model).
- Workflow **custom steps** (`custom_llm`) no longer offer pass / fail arrows: the step never reports a verdict, so
  its fail arrow could never be taken. The workflow editor offers only plain arrows out of a custom step, a custom
  step no longer counts as the reviewer of a `review_pass` loop, and `POST /workflows`, `PUT /workflows/{id}`,
  `POST /workflows/import` and `POST /workflows/validate` refuse a pass / fail arrow out of one with a 400 that
  names the step. Stored workflows that already have one are read as the runtime ran them (the `pass` arrow
  becomes plain, a never-taken `fail` arrow is dropped), so they keep running unchanged
  ([docs/autonomous-agents.md](docs/autonomous-agents.md)).
- `voc-research-step` (VocProcessingStack) is raised from 1,024 to 1,536 MB for CPU: its p95 CPU share of the
  calls that ran ≥ 100 ms was 74 % over the 7 days to 2026-10-06, above the 70 % rule in `lib/sizing/policy.ts`
  (docs/lambda-sizing.md).
- **Lambda sizing: AWS Lambda Power Tuning results for the six busiest API Lambdas** (production, 2026-10-06,
  read-only GET payloads, 512–2,048 MB, balanced strategy). The tool's balanced pick matches the 2.17.00 size for
  `voc-settings-api` (512 MB) and `voc-metrics-api`, `voc-projects-api`, `voc-memory-api`, `voc-agents-api`
  (1,024 MB), so those sizes now stand on the measured curve rather than a CPU projection. `voc-ballots-api`
  stays at 1,024 MB: the tool picked 512 MB, but 512 MB breaks the 70 % CPU rule on the production evidence.
  No size changes in this entry; the decisions are pinned in `lib/sizing/policy.ts` and
  `lib/lambda-memory.test.ts`, with the method and figures in [docs/lambda-sizing.md](docs/lambda-sizing.md).
- **Faster cold starts on every Python Lambda.** The X-Ray SDK is no longer imported at start-up. It was
  loaded on every cold start (about 350 ms of a 0.7–1.0 s import) even though no request is sampled, since
  Lambda tracing is `PassThrough` and the REST stage has tracing off. It now loads only for an invocation
  whose trace header says `Sampled=1`, so recorded traces are unchanged. Unsampled requests no longer carry
  an `X-Amzn-Trace-Id: …Sampled=0` header on outgoing calls. See
  [docs/lambda-sizing.md](docs/lambda-sizing.md#cold-starts).
- **SnapStart on `voc-integrations-api`, `voc-feedback-form-api`, `voc-memory-api` and
  `voc-mcp-tokens-api`**, the Lambdas behind the slow first load of `/sources/status`, `/feedback-forms`,
  `/memory` and `/connect/tokens`. API Gateway now invokes each one's published `live` alias. A
  before-snapshot hook builds the DynamoDB tables the route would otherwise build on its first request.
  Internal callers that invoke these functions by name still run `$LATEST`, with no snapshot. Measurements,
  uniqueness audit and costs: [docs/lambda-sizing.md](docs/lambda-sizing.md#snapstart-on-for-the-four-slow-apis).
- `GET /connect/tokens` (Connect page) now lists your global MCP tokens through a creator index — keys-only
  pointer rows in the `MCPGTOKEN` partition written with each mint — instead of reading every user's tokens and
  filtering; the token API role gains `dynamodb:BatchGetItem` on that partition. Authentication at `/mcp/global`,
  revoke, the audit log and the 20-active-token cap behave as before. See [docs/mcp.md](docs/mcp.md).
- The Prioritization page loads every project's documents in one request, `GET /projects?ids=a,b,…`, instead of one
  `GET /projects/{id}` per project. The batch answers only the projects you can view (missing, deleted and unshared
  ids are simply absent), returns no personas, takes up to 200 ids (400 above that; the page splits larger lists),
  and reuses the existing `GET /projects` method, so no API Gateway resource is added.
- e2e cleanup also archives this run's agents and workflows, revokes its global MCP tokens and forgets its memories
  (from the run's ledger only, as each entity's owner).
- **Lambda sizing rule, CPU half** ([docs/lambda-sizing.md](docs/lambda-sizing.md)): the capacity check
  (`scripts/capacity/capacity-query.sh`, the `ops-capacity` e2e spec) now computes BOTH CPU figures (weighted and
  p95 share) over invocations of 100 ms or more only. A function with fewer than 20 such calls in the window is
  reported as "insufficient data", not as a breach. A size pinned by AWS Lambda Power Tuning overrides the CPU rule;
  its peak memory is still judged. Why: the 2026-10-06 Power Tuning run showed an 87–95 % weighted share at 1,024 MB
  on six functions whose duration does not improve with more memory. No function size changes.
- [mcp.md](docs/mcp.md) documents a known limitation: when `/mcp/global` refuses a token, API Gateway renames
  the `WWW-Authenticate` header to `x-amzn-Remapped-WWW-Authenticate`, so MCP clients get the 401 without a
  Bearer challenge. Treat any 401 from that endpoint as "mint a new token on Connect".

### Deprecated

- The per-project MCP server (`POST /mcp`) and its token routes (`/projects/{id}/api-tokens`): the UI no
  longer mints or lists those tokens, and this same release removes them (see **Removed**). The global MCP on
  Connect replaces it ([mcp.md](docs/mcp.md)).

### Removed

- The project page's **Export / MCP** tab: per-project token mint/revoke, the per-project `mcp.json`, the Kiro
  "autoseed" copy-context card and the Kiro export-prompt editor. An old `?tab=mcp` link opens Overview.
- **The per-project MCP server** (breaking): `POST /mcp`, `/mcp/{proxy+}` (including `GET /mcp/autoseed/{project_id}`),
  the `voc-mcp-api` Lambda with its role and log group, and its `/mcp/POST` and `/mcp/{proxy+}` stage throttles
  (VocApiStack). The global server `POST /mcp/global` and the Connect token routes `/connect/tokens` are unchanged;
  `/mcp` stays only as the parent of `/mcp/global`, behind the same bearer-token shape authorizer
  ([docs/mcp.md](docs/mcp.md)).
- **The per-project MCP token routes** (breaking): `GET` / `POST /projects/{id}/api-tokens` and
  `DELETE /projects/{id}/api-tokens/{token_id}` now answer 404.
- **`GET /projects/{id}/autoseed`** (breaking): the Kiro context bundle the removed Export / MCP tab copied; nothing in
  the app, the assistant or the agents runtime called it. It now answers 404.
- **The per-project Kiro export prompt**: **Copy to Kiro** in a document's export menu always pastes the backend's
  instructions (`kiro_default_export_prompt`). A prompt saved on a project is no longer read or returned by
  `GET /projects/{id}`, and `POST /projects` / `PUT /projects/{id}` ignore a `kiro_export_prompt` field
  ([docs/project-workspace.md](docs/project-workspace.md)).

### Fixed

- `POST /scrapers/analyze-url` and `POST /scrapers` answer a malformed body (not JSON, or JSON that is not an
  object) with 400 instead of a 502. `analyze-url` answers a refused redirect (a public page that redirects to a
  private or metadata address) with a 400 that names the refusal, instead of the generic 500 "Failed to analyze
  URL". The redirect target was already never fetched. Both were found by the e2e security probes.
- Every other API write route now does the same: a body that is not JSON, or JSON that is not an object (an
  array, a string), is a 400 and nothing is written, where it used to be a 500/502. Covered: `/chat/conversations/{id}`,
  `/data-explorer/s3` and `/feedback`, `PUT /feedback/{id}/category`, `/feedback-forms` create/update and the
  public `/feedback-forms/{id}/submit` (only the unparseable-JSON case changes there), `/integrations/{source}/credentials`
  and `/apps`, `/scrapers/manual/*` (parse, confirm, CSV and JSON upload), `/memory` writes, retrieve and
  conflict-check, `/s3-import/sources` and `/upload-url`, `/settings/model`, `/resolved-problems`, `/brand`,
  `/categories`, `/categories/generate` and `/categories/reprocess`, `/users` create/update/group/category-access,
  and the `/projects` write routes (project, visibility, members, owner, personas and notes, generation, research,
  documents, API tokens, product context, product docs, PR/FAQ autofill and the AI suggest routes, product report).
  Routes that already refused a non-object body keep their message; an unparseable one now reads "the request
  body must be JSON". `[]`, `false`, `0` and `""` are no longer silently treated as an empty body (except on the
  public form submit and `POST /sources/{source}/run`, which keep accepting them as before).
- **DLQ / failure-queue alarms now actually notify.** The `voc-ops-alarms` SNS topic (VocCoreStack) had only the
  TLS-only Deny in its topic policy (`enforceSSL` replaces SNS's default access policy), so CloudWatch could not
  publish to it: every alarm action failed with "not authorized to perform: SNS:Publish", and none of the five
  failure-queue alarms (Core, Ingestion, Processing) ever emailed. The topic policy now allows
  `cloudwatch.amazonaws.com` to `sns:Publish`, only from this account (`aws:SourceAccount`) and only for this
  deployment's alarms (`aws:SourceArn` = `arn:aws:cloudwatch:<region>:<account>:alarm:voc-*`, or `<prefix>-voc-*`
  with a deployment prefix). It is the app's only SNS topic. Its KMS key already allowed CloudWatch.
- **A job that ends on a user-level answer no longer counts as a Lambda failure.** When a background job
  (`voc-job-persona-generator`, `voc-job-persona-importer`, `voc-job-document-generator`,
  `voc-job-document-merger`) stops with a 4xx-type outcome (no feedback for the chosen filters, a file it
  cannot read, something not found, not allowed, or a conflict), the job is marked **failed** with that reason in
  the project's Background Jobs panel, as before. It is now logged as a WARNING and the invocation ends
  normally, so it no longer shows up as a Lambda error, lands in the `voc-api-async-failures` queue, or trips its
  alarm. Real faults (Bedrock, DynamoDB, unexpected errors) still fail the invocation and reach the queue.
- **Generate personas** and **Run research** on a project answer at once when nothing matches. With no feedback
  for the chosen sources / categories / sentiments / time range (and the caller's category access),
  `POST /projects/{id}/personas/generate` and `POST /projects/{id}/research` now return **400** ("No feedback
  data found for the given filters" / "No feedback data found matching the filters. Try adjusting your filter
  criteria.") before any job is created or started, using a one-item read. Previously the job started and then
  failed, and for personas the failure landed in the async-failure queue. The wizard shows the reason on its
  final step and stays open so the filters can be widened.
- The web app now shows the server's reason for every refused request whose error body carries it under
  `error`, which is how every API Lambda answers a 400 / 403 / 404 / 409. Previously these screens showed
  "API Error: 400" and the like wherever they displayed the request's error.
- AI assistant: the first message of a conversation is saved before the stream starts. The save used to race the
  stream Lambda's first write of the same conversation and was refused (409, a console error) on about half of
  first messages; the server copy was adopted, so nothing was lost, but the error is gone now. A refused early save
  is silent and never replaces the question with the server copy.
- Project documents: a PRD or PR/FAQ generated on its own (wizard or the assistant's `generate_document`) continues
  the series started when both were generated together, and the reverse. 'X', 'X — PRD' and existing
  'X — PRD (vN)' are one PRD series (v1 → v2) instead of a new 'X (v1)'; PR/FAQs keep their own series. A project
  that already has two such series numbers its next version past both.
- Memory extraction no longer asks Bedrock for the Flex service tier on Claude Haiku 4.5, or on any model whose
  Bedrock model card does not list Flex: such models are sent the default tier on the first call (no refused
  request, no `FlexFallback`). A Flex refusal that still happens is logged once at WARNING instead of two ERROR
  lines, retried on the default tier and counted in `FlexFallback`.
- e2e suite: dialogs are found by accessible name (the open assistant panel is a dialog too); each spec starts with
  the persisted assistant/manual-import UI state removed from the saved sessions; every conversation a run starts
  is recorded for cleanup from the `/chat/stream` request, not only from a successful save. Offline checks:
  `npx playwright test -c playwright.unit.config.ts` in `voc-datalake/frontend/e2e`.
- **Projects** and **Feedback Forms** no longer claim there is nothing yet when their list could not be loaded. Offline
  or on an API error they used to show "No projects yet" / "No feedback forms yet" and invite a first create; they
  now show an announced "This could not be loaded" with **Try again**, and recover in place.
- The same applies to **Dashboard**, **Categories**, **Scrapers**, **Prioritization**, **Data Explorer** and an
  agent's **Runs** tab, which used to answer a failed read (offline, 500, 403) with "No feedback in this time range",
  "No categories" / "No feedback found", "No scrapers configured", "No Documents Found", an empty folder or "No runs
  yet". The **Agents** list and the **Workflow library** load-failure notes are now announced alerts with **Try
  again** too.
- **A document saved in two tabs no longer overwrites silently.** The document editor (project → Documents → Edit)
  sends the revision it loaded; when someone saved in between, `PUT /projects/{id}/documents/{document_id}` answers
  **409** and the editor shows "Someone saved a newer version of this document meanwhile." with **Load the latest** or
  **Save mine anyway** (nothing is lost either way: the other save stays in the version history). The new body field
  `expected_revision` is optional: the AI assistant's and MCP's `update_document` send none and behave as before.
- **Two creates in the same second no longer fail.** Project, persona, document, research-report, product-report and
  persona-note ids, and the manual scraper / source run ids, were `<prefix>_<YYYYmmddHHMMSS>`, so a second
  `POST /projects` (or a second document, persona, …) within the same second answered 500. Ids are now
  `<prefix>_<YYYYmmddHHMMSS>_<8 hex>`: still readable and time-sortable, and a create that does land on an existing key
  retries once with a fresh id. Existing ids keep working unchanged.
- e2e suite: the design audit's focus check no longer presses Escape when it finishes (it blurs instead), so it no
  longer closes the overlay it is auditing; the assistant's sessions-drawer spec in `modals.spec.ts` passed only when
  the drawer had more than three Tab stops.

### Upgrade notes

- **Deploy all stacks** (`cdk deploy --all`, the order in [docs/deployment.md](docs/deployment.md)). The VocApiStack
  deploy is slower than before: each changed SnapStart function (`voc-integrations-api`, `voc-feedback-form-api`,
  `voc-memory-api`, `voc-mcp-tokens-api`) publishes a new version and waits for its snapshot, a few minutes each.
- **Run the MCP creator-index backfill once per deployment**, after the new `voc-mcp-tokens-api` is live: from
  `voc-datalake/`, `.venv/bin/python scripts/mcp_tokens/backfill_creator_index.py` (a dry run, the default),
  then the same with `--apply` to write the pointers and the marker row. Until the marker exists,
  `GET /connect/tokens` also reads the old layout, so no token disappears in between ([mcp.md](docs/mcp.md)).
- **Per-project MCP tokens and `mcp.json` configs stop working** with this release: an assistant pointed at
  `{api}/mcp` gets 403, and a per-project token presented to `{api}/mcp/global` gets 401. Mint a global token on
  **Connect → MCP & skills** (`/connect`, optionally pinned to the project) and update the assistant's config
  before or right after deploying. There is nothing to revoke: the `/projects/{id}/api-tokens` routes are gone.
  The old token rows (`MCPTOKEN` partition of the projects table) and any saved per-project `kiro_export_prompt`
  stay stored, unused (Copy to Kiro no longer reads it); nothing is deleted.
- **Confirm alarm delivery** once VocCoreStack is deployed. An alarm already in ALARM (for example
  `voc-api-async-failures-…-messages-visible`) will **not** re-send, because CloudWatch notifies only on a state
  change. Force one on a test alarm with
  `aws cloudwatch set-alarm-state --alarm-name <alarm> --state-value ALARM --state-reason "delivery test"` (it
  returns to its real state at the next evaluation), check that the email arrives and the alarm history shows no
  "Action failed", and check in the SNS console that the alarm email subscription is **Confirmed**.
- **Re-measure cold starts and capacity** after traffic has exercised the new build, with the documented
  read-only queries in [docs/lambda-sizing.md](docs/lambda-sizing.md): the cold-start REPORT query
  ([Cold starts](docs/lambda-sizing.md#cold-starts); API traffic on the four SnapStart functions should show
  `Restore Duration` instead of `Init Duration`) and `scripts/capacity/capacity-query.sh` for every function
  under the sizing policy.
- Scripts that call `GET /projects/{id}/autoseed` or `/projects/{id}/api-tokens` must be removed; both are 404 now.
- Deploying removes the `voc-mcp-api` function, its IAM role/policy, its log group and two API Gateway methods (plus the
  `/mcp/{proxy+}` resource and its CORS method) from VocApiStack, and changes the API deployment.
- A stored workflow whose custom step had a `fail` arrow loses that arrow when it is next opened and saved (it was
  never taken). If the step it pointed at is reachable only through it, the editor now reports "this step is not
  connected to the start" for it: reconnect or delete that step before saving. Runs are unaffected.
- **VocApiStack gains 8 resources:** an `AWS::Lambda::Version` and an `AWS::Lambda::Alias` (`live`) for each
  of the four functions. With the per-project MCP server gone the stack has 472 with every plugin enabled, and a
  new test fails above 490. Each deploy that changes one of these functions publishes a new version and waits for its snapshot, which
  adds a few minutes. The superseded version is deleted.
- **SnapStart cost:** about $9.75/month in snapshot cache at the current sizes, plus about $0.05/month in
  restores at today's cold-start rate. No provisioned concurrency was added; its cost is in the doc.
- The two `voc-api-async-failures-…` messages from 2026-10-05 (persona generation with no feedback yet, F1) are
  not lost work: their jobs no longer exist, so a re-drive would only fail again. Delete them once this is
  deployed (SQS console → Purge, or delete the two messages), and the alarm returns to OK.
- After deploying, the worker and job Lambdas and `voc-chat-stream` start writing the `invocation_cost` line
  (one small INFO line per invocation, a negligible CloudWatch Logs cost). Run
  `scripts/capacity/capacity-query.sh` after a run that exercises them to close the CPU measurement gaps.
- Deploying `VocApiStack` changes `MemorySize` on 15 functions in place; nothing is renamed or replaced. GB-s per
  call doubles (quadruples for `voc-ballots-api`) until durations drop: at current production traffic about
  +551 GB-s/week, roughly $0.03/month. Check Lambda concurrency and cost budgets if your traffic is much higher.
- Document series counters stored under the old key (e.g. 'x — prd') become unused rows; nothing to migrate.

## [2.15.06] - 2026-10-07

Tests only: mutation round 11 (7 modules/slices); the feedback-form API is now hardened end to end.

### Changed

- Seven more modules are mutation-hardened to zero survivors — the MCP endpoint's transport, listing and refusals (lines 4245 to the end), the feedback-form API's second half (so the whole handler is done), prototype pins, MCP token parsing and reach, the agents' pin loop, memory embeddings and the shared table accessors. About 40 weaker tests removed; the unreachable conditions those runs exposed are deleted. No behaviour change.

## [2.15.05] - 2026-10-07

Tests only: mutation round 10 (8 modules/slices); the projects API is now hardened end to end.

### Changed

- Eight more modules are mutation-hardened to zero survivors — projects API lines 3718–4803 (ballot save, MCP token routes, pins, generator jobs; the whole projects handler is now done), the workflow schema, the research step handler, user flags, GitHub source config, the agents' project-selection and prototype nodes, and the plugins' EventBridge loader. About 70 weaker tests and five unused research fixtures removed; the unreachable fallbacks those runs exposed are deleted. No behaviour change.

## [2.15.04] - 2026-10-07

Tests only: mutation round 9 (7 modules/slices).

### Changed

- Seven more modules are mutation-hardened to zero survivors — projects API lines 1008–2233 (prioritization scoring, rows, freeze), document versioning lines 728–1498 (so the whole module is now done), the verification-fixture provider, GitHub issue mapping, plugin secret isolation, the SSRF URL policy and the agents' shared node base. About 10 weaker tests removed; the unreachable guards and fallbacks those runs exposed are deleted. No behaviour change.

## [2.15.03] - 2026-10-07

Tests only: mutation round 8 (7 modules/slices); the mutation runner can no longer leave an orphaned test process.

### Changed

- Seven more modules are mutation-hardened to zero survivors — product context (fields, uploads, documents), document versioning lines 1–727, design references (Figma/GitHub/uploads), the plugins' base ingestor, the S3 import API, the shared concurrency helper and the category gate. About 40 weaker tests removed; the unreachable guards and defaults those runs exposed are deleted. The mutation runner arms its timeout in the test process too, so an infinite-loop mutant can no longer outlive it. No behaviour change.

## [2.15.02] - 2026-10-07

Tests only: mutation round 7 (7 modules/slices).

### Changed

- Seven more modules are mutation-hardened to zero survivors — projects API lines 1–1007 (route wiring, job routes, the access middleware and batched gate reads), the shared feedback queries and LLM formatting, the global MCP tool catalogue and routes, the manual-import processor, the document merger, the plugins' raw archive and the project owner transfer. About 70 weaker tests removed; the unreachable guards and defaults those runs exposed are deleted. No behaviour change.

## [2.16.00] - 2026-10-06

The GitHub Issues connector is enabled, accepts any GitHub URL, and can bound a large backfill.

### Added

- GitHub Issues plugin settings **Only issues and comments created on or after** (`YYYY-MM-DD`) and **Skip authors with these GitHub roles** (e.g. `OWNER, MEMBER, COLLABORATOR`). Both judge each issue and comment on its own, so a customer's new reply on an old or maintainer-filed issue is still ingested; the start date also skips listing older pages. The webhook applies them exactly like the poller. See [docs/github-issues.md](docs/github-issues.md#sizing-a-large-repository), which also records the measured cost of backfilling a 6,500-issue repository.

### Changed

- The GitHub Issues plugin is enabled (`pluginStatus.github_issues: true`). It deploys its ingestor and `POST /webhooks/github_issues`, and stays idle until a token and repositories are saved in Settings and its schedule is enabled.
- The metrics API and plugin webhook receivers each hold one invoke permission scoped to the REST API instead of two per method, which keeps `VocApiStack` at 480 of CloudFormation's 500 resources with every plugin on (it reached 502 and failed to synthesize).

### Fixed

- A pasted repository deep link such as `https://github.com/owner/name/issues`, `…/issues/42` or `…/pulls` was silently dropped; it now names its repository. Entries that name no GitHub repository are logged as warnings on every run.

### Upgrade notes

- The first deploy creates two Lambdas (`voc-ingestor-github_issues`, `voc-webhook-github_issues`), a disabled schedule and a public, signature-checked webhook route. Set `"github_issues": false` in `cdk.context.json` to keep them out.
- CloudFormation replaces the metrics API's 22 per-method invoke permissions with one; the new one is created before the old ones are deleted.
- Before backfilling a large repository, set the start date and excluded roles: every ingested issue and comment costs a Bedrock call.
## [2.15.01] - 2026-10-06

Tests only: mutation round 6 (8 modules/slices).

### Changed

- Eight more modules are mutation-hardened to zero survivors — projects API lines 2234–3717 (row compose/recompose gating, ballot transaction shape, delete enumeration), the memory store's write/retrieval/merge half, app-review utilities, GitHub issue text parsing, the GitHub webhook (every refusal pinned exactly), the concurrent SQS batch processor, enabled-source parsing and the agents' handoff node. About 20 weaker tests removed; the unreachable guards those runs exposed are deleted. No behaviour change.

## [2.15.00] - 2026-10-06

Autonomous agents now receive the company context and the design system they were meant to read.

### Fixed

- **Agent prompts never carried company context or the design system.** The agents' context helper called the
  company-context and design-system builders without the aggregates table they read from, so every call failed
  silently (logged as `Context block unavailable`, `error_type: TypeError`) and the block was left out. The
  aggregate-reviews, custom-step and final-review nodes now get the company vision and objectives from
  **Settings → Company context**, and the final reviewer gets the design-system tokens, guidelines and reference
  summaries it checks prototypes against.

### Upgrade notes

- Agent runs send slightly larger prompts (both blocks are capped), and the final review can now fail a
  prototype that ignores the configured design system — it could not see it before. No stack or IAM change:
  the agent Lambdas already had `AGGREGATES_TABLE` and read access to it.

## [2.14.02] - 2026-10-06

Tests only: feedback-form API, first 450 lines mutation-hardened.

### Changed

- The feedback-form API (voc-feedback-form-api) has its configuration defaults, form-item shape, every submission and link refusal message and the link/URL bounds pinned by literal tests (lines 1-450 of the handler; the rest follows). No behaviour change.

## [2.14.01] - 2026-10-06

Mutation-hardening round 4: seven more Python modules get a suite that pins every refusal message, bound and
write literally; no behaviour change.

### Changed
- Tests: new mutation suites for the agent workflow graph, the `duplicate_document` node, `scrapers_handler`,
  the memory extractor and retention workers, `shared/ingest_schemas.py` and `shared/prompt_safety.py`; the
  weaker checks they supersede were pruned, and the round-4 duplication pairs across the mutation suites were
  folded into shared fixtures (jscpd reports 0 clones over `lambda/` and `plugins/`).
- Unreachable guards removed with no observable effect: the non-dict check inside `_scraper_url_error` (the shape
  check before it already refuses non-objects), the unused `notice` parameter of `prompt_safety.data_block`, the
  redundant `@classmethod` on pydantic validators in `ingest_schemas.py`, and a pre-check in
  `_parses_as_datetime` that pydantic performs itself.

## [2.14.00] - 2026-10-06

Fixes from a second end-to-end QA wave on production: document versions, server-saved assistant
conversations, faster processing, working agent runs and keyboard/contrast fixes across the app.

### Added

- **Document versions** on the project page: open, compare and restore earlier versions of a document.
  Every edit, in the editor or by the assistant, saves a new version, and a restore adds a version instead
  of rewriting one. New routes `GET /projects/{id}/documents/{doc}/versions` and
  `POST /projects/{id}/documents/{doc}/versions/{vid}/restore`. See
  [Project workspace](docs/project-workspace.md).
- **Regenerate avatar** button on personas.
- **Workflow archive**: `DELETE /workflows/{id}` and a Workflow library on the Agents page. See
  [Autonomous agents](docs/autonomous-agents.md).
- The assistant saves the conversation on the server while it answers. A reload mid-answer shows the
  partial answer ("Still generating…") and fills it in when the answer finishes.
- A per-request `invocation_cost` log line on the API Lambdas (CPU ms and % of the allocation).

### Changed

- `POST /chat/conversations/{id}` takes `baseRevision` and answers 409 when the server holds a newer
  revision or a reply is still being written. `GET` and the list return `runStatus`, `runId` and
  `revision`.
- `PUT /projects/{id}/documents/{doc}` returns the saved `document`; editing a PRD or PR/FAQ gives the
  saved version a new id.
- The regenerate-avatar response is a signed URL.
- A PRD and PR/FAQ generated together are titled "… — PRD" and "… — PR/FAQ".
- The project wizard's source list follows the selected time window; jobs are listed newest first.
- Processing: new feedback is picked up within 5 s (was 30 s), and a batch is enriched 5 records at a time
  (`VocProcessingStack`).
- The assistant runs independent lookups in parallel (up to 4).
- Faster `/metrics/*`, `/feedback/entities`, `/logs/*` and `GET /users`; fewer duplicate requests on
  Settings → plugins and Categories.
- The CloudFront URL-signing key Lambda has 256 MB.
- Every control shows the 2px accent focus ring; form controls have a 3:1 boundary in both themes, and
  checkboxes and radios are themed.
- Header copy is translated in all 8 locales.
- Chart axes, keywords, workflow labels and token badges are at least 12 px; corner radii follow the Kiro
  scale.
- Custom categories are coloured by rank (instead of all grey), with a matching legend swatch.

### Fixed

- Data Sources: disabled plugins are no longer offered, and the S3 and GitHub dialogs no longer answer 400
  and point to Settings instead.
- Manual Import: a review with no date gets the import date, the preview says so and the date stays
  editable; a refused import says why.
- Assistant: a conversation is saved as soon as a message is sent and survives a reload mid-answer.
- Assistant: streams no longer drop after 30 s of quiet (15 s keepalive).
- Assistant: feedback search finds feedback older than 90 days behind empty recent days (up to 400 days
  back, 90 days with data).
- Personas: generation now finds feedback older than 90 days with "Last year" or "All time".
- Personas: regenerated or deleted personas no longer leave their avatars in S3, and a regenerated avatar
  no longer shows the cached old image.
- Documents: an edit no longer overwrites the previous content.
- Agents: Run now and Cancel no longer answer 500 when the run started, and Cancel stops the execution.
- Agents: a custom step with no verdict follows its arrow (start → custom → end used to fail with "has no
  next step"); workflow editor arrows can be selected, configured and deleted.
- Agents: the step "Instructions" label no longer shows its translation key; the Runs tab event log is
  keyboard-scrollable and the selected run row is readable (AA contrast).
- Keyboard on phones: the closed menu is out of the Tab order; the open menu takes focus, closes on Escape
  or Tab-out and returns focus.
- The assistant panel and drawer take focus, and Escape closes the drawer; time-range popups support arrow
  keys and Escape; an empty Create Document dialog closes on Escape.
- One h1 per page; AA contrast on the avatar; the Connect and GitHub tables are keyboard-scrollable.
- Icons replace glyph ticks and stars, truncated names have tooltips, and the urgent count is grouped.

### Security

- The stream Lambda gains `GetItem`/`PutItem` on the conversations table only; the caller's partition is
  enforced in code.

### Upgrade notes

- **Deploy `VocProcessingStack`, `VocApiStack` and the frontend together.** The conversation save
  contract changed (`baseRevision`, 409) and the stream Lambda now writes conversations, so an older
  frontend (which sends no `baseRevision`) gets 409 on any conversation the stream has saved. No data
  migration.
- The processor's SQS batching window drops to 5 s and enrichment runs 5 records at a time, so it makes
  more concurrent Bedrock calls. Watch the `BedrockThrottleRetry` metric after the deploy.
- Persona avatars use a new S3 key layout. Old flat keys still resolve, and each one migrates (and the old
  object is swept) when that avatar is regenerated.
- Document edits now create versions. Revision rows live in the projects table under
  `DOCUMENT_VERSIONS#PROJECT#{id}`; deleting a custom document removes its revisions.
- `VocCoreStack` changes one Lambda's memory size (URL-signing key, 256 MB).

## [2.13.00] - 2026-10-05

Production repair from an end-to-end run of every page, plus model capacity fallback, one Account page and
token setup help.

### Added

- **Model capacity fallback.** When a Bedrock model is granted but cannot serve (throttled to zero, not
  ready, quota exceeded, not enabled), AI requests and the assistant fall down a per-surface chain:
  configured model → surface default → Sonnet 5.5 → Sonnet 5 → Sonnet 4.6 → Haiku 4.5. Opus is only used
  when it is the configured choice. A failed model is skipped for 5 minutes per container; the assistant
  falls back only before its first token. A `ModelFallback` CloudWatch metric (Surface/From/To) and the
  stored provenance name the model that actually answered. See [Deployment](docs/deployment.md).
- **Token setup help** on Administration → Integrations: where to create the Figma and GitHub tokens, the
  read-only permissions to grant, how to save and check them, what each failure means, and how they are
  stored. See [Company context](docs/company-context.md).
- **All time** preset in the time-range selector (every data view); the 90-day preset is labelled 90 days.
- `scripts/retention/rebuild_aggregates.py`: rebuilds the dashboard counters from the stored feedback
  (dry run by default; see [Processing pipeline](docs/processing-pipeline.md)).
- A production Playwright e2e suite with an accessibility audit (`npm run e2e:prod`, see
  `voc-datalake/frontend/e2e/README.md`).

### Changed

- **Account:** the sidebar user chip (avatar + name) opens the `/account` page, which now holds everything in
  one place: profile and groups, change password, language and theme, my objectives & KPIs, MCP tokens and
  sign out. `?tab=objectives` still jumps to the objectives.
- **Dashboard:** "Your workspace is empty" only shows when there is no feedback at all; feedback older than
  the selected window shows its newest date and a **Show all time** action.
- **Feedback forms:** a new form says plainly that it is disabled, with an **Enable now** action; the widget's
  default theme uses the Kiro palette, passes contrast and has a main landmark. The forms list loads every
  card's stats in one request (`GET /feedback-forms?include=stats`).
- `GET /users` and `GET /sources/status` are about 3–4× faster.
- PDF and print exports use the Kiro Light palette only.

### Removed

- The "My Profile" dialog (now the Account page).

### Fixed

- **The dashboard and every metrics view were empty:** the counters had expired under the old 90-day TTL;
  they were rebuilt from the 16,799 stored items.
- **Memory:** `GET /memory?scope=personal` and `GET /memory/review` no longer answer 502, so memory retrieval
  for the assistant and agents works again; the memory scanner and extractor can read session cursors again,
  so ended chats are extracted; the Memory page shows an error instead of "Nothing remembered here yet" when
  the review queue fails; review entries show both sides, and **Keep the existing one** keeps it.
- Import Persona, Add User and Edit User dialogs close on Escape and trap focus like every other dialog.
- Accessibility: text links are underlined, scroll regions are keyboard-reachable and named, heading order in
  the chat sidebar.
- A Company → Design system reference that failed to fetch shows "Failed" with its reason, not "Pending".
- The sidebar brand subtitle no longer changes after opening Administration.
- Agent run ids carry four random bytes instead of two, so runs started in the same millisecond no longer
  risk sharing a run record (older ids stay valid).

### Security

- Memory and agents Lambda roles hold only the DynamoDB actions their code calls.

### Upgrade notes

- On a deployment migrated from the 90-day TTL, run `scripts/retention/remove_ttl.py --apply`, then
  `scripts/retention/rebuild_aggregates.py --apply` (both dry-run first).
- Deploy VocProcessingStack and VocApiStack together (memory grants move between them). The users API role
  gains `cognito-idp:ListGroups` and `ListUsersInGroup`.
- A throttled first model costs its full retry budget once before the fallback; Haiku surfaces can fall back
  to the costlier Sonnet. Consider an alarm on `ModelFallback`.

## [2.12.06] - 2026-10-05

Mutation hardening, night rounds 1–2 (14 modules/slices).

### Changed

- Fourteen more Lambda modules are mutation-hardened to zero survivors (shared API resolver, AWS clients, memory store first half, avatar, categorization, derivation, agents store/context blocks/select_personas/write_prd nodes, memory scanner, iTunes client, plugin audit, projects.py lines 1266–2671): every refusal, request shape, boundary and log line is pinned by a literal test; ~40 weaker tests removed; the unreachable guards and defaults those runs exposed are deleted. No response or write changes.

## [2.12.05] - 2026-10-05

Production hotfix: the dashboard and the AI assistant work again.

### Fixed

- **Dashboard, Categories and every feedback view were empty** (`/metrics/*` and `/feedback/*` answered
  502): the metrics Lambda imported `github_metrics`, a module its bundle never ships, so it failed to
  start. The module moved to `lambda/shared/`, and a new test fails when any API handler imports a
  sibling module its bundle does not contain.
- **The AI assistant answered "Stream error: 502"**: the stream Lambda's runtime check expected
  `awslambda.HttpResponseStream` to be a plain object, but the managed Node runtime provides a class,
  so every cold start threw. The check accepts the class.

## [2.12.04] - 2026-10-05

Tests only: mutation-hardening follow-ups.

### Changed

- The 20 Lambda modules mutation-hardened before the agents, memory and MCP features landed were re-run
  against the current code; project access (agent delegation claims), the aggregator's request shapes
  and the request-body protocols gained the literal pins the newer code lacked. 48 tests that only
  restated weaker versions of those pins were removed. No behaviour change.

## [2.12.03] - 2026-10-05

The `Environment` cost tag says production on a production deployment.

### Fixed

- Every stack's `Environment` tag follows the `environment` context key in `cdk.context.json` (default
  `production`), the same key that sets the API's CORS mode. It defaulted to `dev` before, so a
  production deployment was tagged dev. `CDK_ENV` still overrides it.

### Upgrade notes

- The next deploy re-tags every stack's resources; nothing is replaced.

## [2.12.02] - 2026-10-05

Tests only: the persona provenance fallback is pinned.

### Fixed

- A test now pins that a persona whose synthesis result reports no model is stamped with the persona
  surface's configured model.

## [2.12.01] - 2026-10-05

Persona provenance now records the model that actually generated the personas.

### Fixed

- Persona provenance (`llm_metadata.model`) names the model the synthesis step actually ran on, even if
  an admin changes the AI model during generation.

## [2.12.00] - 2026-10-05

Security and reliability fixes from the open-issue triage: public feedback-form hardening, the webscraper
SSRF path, ingest validation that actually runs, failure queues with alarms, private log views, safer
project deletion, and sturdier persona and document generation.

### Added

- **Failure-queue alarms.** Every dead-letter and failure queue (processing DLQ, memory-extract DLQ,
  aggregator stream failures, async API job failures, scheduled-ingestion DLQ) has a CloudWatch alarm that
  fires when a message is waiting, all publishing to one encrypted SNS topic (`voc-ops-alarms-*`). Set
  `-c alarmEmail=you@example.com` to get the emails. See [Deployment](docs/deployment.md#failure-queue-alarms-alarmemail).
- **Failure destinations for async work.** Failed asynchronous invocations of the persona, document,
  merge, persona-import and manual-import jobs land in `voc-api-async-failures`; the aggregator's DynamoDB
  stream sends a batch it cannot process to `voc-aggregator-stream-failures`; scheduled ingestion targets
  retry twice within an hour and then go to `voc-ingest-schedule-dlq` (#253).

### Changed

- **Saving a scraper is open to every signed-in user** (`POST /scrapers`); deleting and running one stay
  admin-only, and so do its schedule fields (`enabled`, frequency), which the server keeps for non-admins.
  Saves are bounded: 50 scrapers, 25 URLs each, field and size limits, a 400 naming the problem. See
  [Scrapers — Who can do what](docs/scrapers.md#who-can-do-what).
- **Ingest validation runs in production.** The message schema moved to the processor's own bundle
  (`lambda/shared/ingest_schemas.py`); a processor that cannot load it fails to start instead of running
  unvalidated, and a message that fails validation goes to the DLQ instead of being deleted. The schema
  now accepts what the real sources send: manual-import fields, form presets and custom fields, display
  source names, ratings 1–10, URLs up to 4,096 characters, and a blank or unparseable date falls back to
  the ingest time (#412, #249; schema fields from #421 by @proton0210).
- **Settings → Logs shows no customer data.** Validation entries list the record's field names and text
  length instead of a raw preview; processing and scraper errors show the error type and a fixed message
  instead of raw exception text. Clearing validation logs (`DELETE /logs/validation/{source}`) is
  admin-only; reading stays open.
- The AI Models card labels **Automatic** with the deployment-wide model when one is pinned (#275, from
  #402 by @perrozzi).
- Prioritization builds each project's document index once per load instead of once per row (#399, from
  #404 by @perrozzi).
- Regenerating personas avoids reusing the project's existing persona names (#240).
- Saved browser settings (sign-in, dashboard, manual-import draft) are versioned; existing data still loads.
- ModalShell's cross-document focus logic lives in `components/ModalShell/frameFocus.ts` with its own unit
  tests; no behaviour change (#385).

### Fixed

- Web scrapers set to **Manual only** no longer run on every scheduled tick; they run only from **Run now**.
- Scrapers page: a rejected save keeps the editor open and shows the server's reason.
- Data Explorer, Users and Logs routes keep a 4xx as a 4xx, `?days=abc`-style parameters answer 400, and
  clearing a large validation-log backlog deletes all of it (#263, from #403 by @perrozzi).
- Persona avatars no longer fail on a fresh account: the roles that call the image model can subscribe to
  its Marketplace product on first use (#274).
- **Deleting a project** also removes its job history, prototypes, product-doc files and its own persona
  avatars, and never another project's avatar (from #407 by @perrozzi).
- Persona avatar prompts use the AI-model picker's Utility model instead of the deployment default, and
  persona provenance names the model that actually ran (#273).
- One malformed persona in the model output no longer discards the whole generation: valid personas are
  kept and the number dropped is reported (#235).
- PRD and PR/FAQ generation sizes its feedback sample to the selected model's context window instead of
  always using 30 of 100 fetched reviews, and records `feedback_items_used` / `context_truncated` (#231).
- The document generator refuses a document type it cannot build, before any model call, instead of
  generating and saving it as a PR/FAQ (#397).
- Research without Step Functions, PRDs, PR/FAQs, personas and the PR/FAQ autofill, document-brief and
  research-question helpers honour and record the **date basis** (#258).
- Editing only the tags of a persona research note no longer fails.
- Dialogs, including the prototype enlarge overlay, keep Escape and the Tab trap working after an embedded
  prototype rewrites itself with `document.open()` (#386).
- Settings → source status and the Logs pages list every enabled plugin, plus manual imports (#256).
- `GET /feedback/urgent` reads past the first page and fetches items in batches instead of one read per row.
- JSON-LD review dates from the web scraper are stored in UTC instead of Europe/Berlin.
- Docs no longer claim a WAF protects the API; none is deployed, the public routes use per-method
  throttles (#246).

### Security

- **Feedback-form iframe XSS** (`GET /feedback-forms/{id}/iframe`): form ids are validated (404 otherwise)
  and every value written into the page is JSON-escaped; the page sends a Content-Security-Policy,
  `nosniff` and `no-referrer` (#379, core from #396 by @perrozzi). See [Feedback forms](docs/feedback-forms.md#public-route-input-limits).
- **Public form submissions are bounded** (`POST /feedback-forms/{id}/submit`): text ≤ 10,000 characters,
  name/email/page URL caps, at most 20 scalar custom fields, rating 1–10, no NaN/Infinity (#222).
- **Webscraper SSRF closed** (#244): one URL policy (public unicast only, embedded-IPv4 and NAT64 forms
  included) checked on scraper save, analyze-url and before every ingestor request; the ingestor pins
  each connection to the vetted address, re-checks every redirect hop, ignores proxy settings and refuses
  `https` → `http` redirects. See [Scrapers](docs/scrapers.md).
- API error responses no longer include raw exception text (Data Explorer, Users, scraper run status), and
  a plugin that fails at startup records only the error type in its run status.
- The Marketplace subscription grant covers only the image model's product (`aws-marketplace:ProductId`)
  and only the roles that call it.
- The streaming assistant no longer sends `Access-Control-Allow-Credentials`, and API Gateway error
  responses (4XX/5XX/401) carry the deployment's frontend origin instead of `*` (except in dev).

### Upgrade notes

- Validation was effectively off before this release. Messages that still do not match the schema (a
  non-http URL, a rating outside 1–10, nested JSON metadata, a numeric id) now go to the processing DLQ;
  watch its alarm after deploying.
- Each alarm costs about $0.10/month, and the topic's KMS key and the scheduled-ingestion DLQ's key about
  $1/month each.
- Hand-seeded feedback-form ids must match `[0-9A-Za-z_.-]{1,64}`; rename any other before upgrading.
- Scraper saves that exceed the new limits are refused with a 400; existing oversized configs can still
  be edited down.
- Persona avatars written before this release have no owner recorded, so deleting a project leaves them
  in place; regenerating a persona's avatar records its owner.
- PRD and PR/FAQ prompts now carry up to about 145 richer review records instead of 30 short snippets:
  expect higher input-token use per document.
- On a gateway error such as a 429, an embedded feedback widget now shows "Failed to load form." instead
  of "Feedback form unavailable."; submissions behave the same.

## [2.11.00] - 2026-10-05

Desktop notifications for the AI assistant, and the multi-session assistant mutation-hardened.

### Added

- **Desktop notifications for the AI assistant** (opt-in: the bell in the assistant header). While the
  app is open in a tab you are not looking at, or a conversation is not on screen, the browser notifies
  you when a conversation needs your approval (stays until clicked), has a new reply, or failed.
  Clicking one brings that conversation into view. The browser asks for permission on that first
  click. Notifications are generic, with no conversation text, so nothing private shows on a lock
  screen. They use the browser's Notification API only (no push service), so they arrive while the app
  is open in some tab, not after it is closed.

### Fixed

- Tests only: the multi-session assistant and its notifications are mutation-tested (Stryker on every
  changed line: 62% → 99.7% killed); the two remaining survivors in the thread store are module-load
  mutants the tests do kill in practice (the store crashes on import).

## [2.10.04] - 2026-10-05

Tests and tooling only: the metrics mutation suite passes the jscpd gate; the mutation programme's
done-list records metrics_handler as fully hardened.

### Fixed

- The metrics mutation suite's two day-walk tests share one partition-reading helper, so the whole-repo
  duplication gate (`jscpd`, threshold 0) passes again.

## [2.10.03] - 2026-10-05

Tests only: the Metrics API is mutation-hardened end to end.

### Changed

- Metrics API (`voc-metrics-api`, `/feedback/*` and `/metrics/*`): every route's reads, budgets,
  defaults and response keys are pinned by tests; `/metrics/summary` drops a few internal fallbacks that
  could never apply. No change to any response.

## [2.10.02] - 2026-10-05

Fixes the agent detail page, fills every gap in the local dev mock, and adds a gate that keeps it complete.

### Added

- New gate `npm run check:mock`, also a `scripts/validate.sh` step (so CI runs it) and part of
  `npm run check`. It fails when a frontend API call has no dev-mock route. Every `fetchApi(...)` call
  site must be listed in `voc-datalake/frontend/mock-coverage.json` with a probe, and the gate sends
  each probe to a freshly started mock. A missing entry, a stale entry, the mock's generic 404, a 405
  or a 5xx is a failure, and a route that never answers fails after 10 s instead of hanging. The rule for contributors and agents ("every frontend API call must be
  mocked") is in `.kiro/steering/tech.md`.
- Regression tests check that each page reads only the route params `routes.tsx` declares, and that
  the Data Sources page asks only the app-review plugins for app configs.

### Fixed

- Autonomous agents: opening an agent (`/agents/{id}`) always showed "This agent doesn't exist or you
  can't see it". The page read a route parameter the router never set, so it requested `/agents/` with
  no id. This affected deployed sites too, not just local dev.
- Data Sources page (`/scrapers`): no longer requests app configs for plugins that don't support them
  (GitHub Issues). That request failed with a 400 on every visit.
- Local dev mock (`npm run dev` / `npm run mock`): every endpoint the frontend can call now has a mock,
  shaped like the real API and keeping state while the mock runs. Newly mocked:
  - system logs and feedback search;
  - source enable/disable/run, integration credentials, and AI category generation;
  - scraper templates, analyze-URL, run history and delete;
  - manual, JSON and CSV import, and S3 import;
  - Data Explorer preview and save. Its listing and buckets now use the real response shape, so you
    can drill down to a file.
  - feedback-form CRUD, submissions and the public widget routes (config, submit, iframe);
  - project personas, documents, research, prototypes and their jobs, MCP API tokens and autoseed;
  - prototype pin threads.

  PATCH requests from the dev server are no longer blocked by CORS, and the source-status mock now
  returns a record keyed by source, like the API.

## [2.10.01] - 2026-10-05

Tests only: more coverage for running several assistant conversations at once.

### Fixed

- Tests now pin that an approval answered for a conversation that is not on screen resumes that
  conversation (not the one in view), and that late events for a closed conversation are dropped
  instead of reopening it.

## [2.10.00] - 2026-10-05

The AI Chat page uses the whole content area and lets you run several conversations at once.

### Added

- **Several assistant conversations at once.** Start a new conversation while another is still
  answering: each one streams, waits for approvals and saves on its own. The conversation list shows
  every open conversation with its state (running, waiting for your approval, failed, or a new reply you
  have not read yet); click one to switch to it without interrupting anything. Closing a running one
  stops it, and the saved session stays in the history. Up to 8 conversations stay open in memory; past
  that, the oldest one that is idle and not in view leaves memory (never a running one) and stays in the
  history.

### Changed

- **`/chat` (AI Chat)** fills the content area instead of a centred 4xl column, with a permanent
  conversation sidebar (New conversation, Open, History) beside the chat from the `lg` breakpoint up.
  The floating assistant's full-screen mode gets the same sidebar. Narrower screens and the bubble or
  expanded panel keep the history button, which opens the same list as a drawer.
## [2.09.01] - 2026-10-05

Tests only: the third mutation-hardening round meets the enforced gates.

### Fixed

- The round-3 mutation suites (metrics, processor, HTTP utils, global MCP tokens, PR/FAQ node, S3 import)
  pass pyright and jscpd again: typed fakes and narrowing instead of untyped attribute access, shared
  assertion helpers instead of repeated blocks, and the S3 import alias table pinned in its own shape.

## [2.09.00] - 2026-10-05

Every quality gate enforced at zero (waves 6–7), one zod major, mutation hardening rounds 1–3.

### Added

- `scripts/validate.sh` also runs pyright (standard mode + `reportUnnecessary*`), `check_tests_assert.py`
  (every pytest test asserts), jscpd over code and tests (threshold 0), and `tsc` on the frontend specs.
  Nothing is pending any more: the ruff `PENDING` block and every ESLint `PENDING_*` map are empty, the
  frontend specs are linted in the normal run, and `noUncheckedIndexedAccess` is on in every tsconfig.
- `scripts/check-version.mjs`: the newest version in this file must equal the three `package.json` versions.
- `lambda/shared/batch.py`: one batch-Lambda handler for the aggregator and the processor.
- Mutation-hardened test suites (`test_*_mutation*.py`, 0 surviving mutants each) for about 40 Python
  modules: the API handlers (metrics, MCP, chat, ballots, settings, data explorer, GitHub metrics), shared
  access and job modules, the agents' nodes, and the iOS/Android/webscraper/S3-import plugins. Weaker
  duplicate tests were deleted; floors per suite live in `scripts/mcp_gate.py`.

### Changed

- zod 4.6.5 (exact) in the CDK app, the frontend and the stream Lambda. The CDK uses the zod 4 APIs
  (`z.url()`, `z.prettifyError`, `error` instead of `errorMap`, `.loose()`), and the assistant contract
  lockstep test imports the stream module directly instead of evaluating it.
- All three core buckets are versioned with lifecycle rules: noncurrent versions expire after 90 days
  (raw data), 30 days (website) and 7 days (access logs); incomplete multipart uploads abort after 7 days.
- A project read with no caller (internal jobs) returns META without owner or member emails.
- No emojis in the frontend: sources, PDF headings and status cues use lucide icons (guarded by a test).
- `bedrock_call_with_retry` has `@overload`s (`raise_on_throttle=True` never returns `None`); the
  aggregator's DynamoDB requests are typed; `api/types.ts` is split (`api/projectTypes.ts`); `TestRouter`
  moved to `src/test/TestRouter.tsx`; Settings uses the shared `TabsTrack`.
- Many best-effort catch-all paths log with `logger.exception` (ERROR + traceback; they logged WARNING).

### Upgrade notes

- Bucket versioning adds storage for overwritten or deleted objects until the lifecycle rules expire them.

## [2.08.00] - 2026-10-05

Prototype pin feedback, one global MCP endpoint, GitHub Issues connector (`kvb/*`).

### Added

- Prototype pin feedback: every built prototype gets a `prototype_pin` feedback form; testers drop pins
  on elements from the in-app viewer (selector, text, position, redacted console errors), threads can be
  replied to, resolved and reopened, and reviewers see markers with `?review=1`. Agents read open pins
  (`collect_prototype_feedback` → `revise_prototype`) and resolve them only after a passing review.
  See [Feedback forms](docs/feedback-forms.md).
- Global MCP endpoint `POST /mcp/global` beside the per-project `/mcp`: personal tokens minted, listed
  and revoked on the new **Connect** page (read/write scope, optional project pin, 30-day default /
  365-day max expiry, per-call audit with 90-day TTL); tokens act as their minter, never as admin; 13
  delegated tools; a downloadable skill at `/voc-mcp-skill.md`. See [MCP](docs/mcp.md).
- GitHub Issues plugin (`plugins/github_issues/`): REST ingestor with `since=` + ETag + rate-limit-aware
  paging and an HMAC-verified webhook; version, label, component, error-signature and repro enrichment
  travel as `issue_attributes`; `GET /metrics/github` and a GitHub section on the Dashboard; `/feedback`
  gains `version` and `label` filters. Off by default (`pluginStatus.github_issues: false`).
  See [GitHub Issues](docs/github-issues.md).

### Upgrade notes

- VocApiStack is at about 488 of CloudFormation's 500 resources; new routes should reuse the frugal
  permission pattern in `lib/stacks/global-mcp.ts`.
- MCP clients and the GitHub webhook can only be tested end to end on a deployed stack.

## [2.07.00] - 2026-10-05

Autonomous agents, Memory, company context and the new navigation (`kvf/*`).

### Added

- Autonomous agents: an Agents tab and detail page (triggers on a schedule, on new reviews or on a
  threshold; personas, models, budget, runs), a React Flow workflow editor with palette and diff, and the
  `voc-agent-run` state machine (conductor → nodes Lambda / persona-panel Map, 24 h max) driven by
  `voc-agent-heartbeat`. Agents reuse or create projects, hand off to the category owner (then a fallback
  admin), never merge, move or delete projects, and finished runs feed Memory.
  Infrastructure: `voc-agents` table (RETAIN, PITR, KMS, index `gsi1-by-agents-listing`), `voc-agents-api`
  behind Cognito-protected `/agents`, `/workflows`. See [Autonomous agents](docs/autonomous-agents.md).
- Memory: company and personal memories extracted from idle assistant sessions, project chats and agent
  runs (Claude Haiku on the Bedrock Flex tier, fallback recorded), with hygiene filters, +1 reinforcement,
  conflicts routed to review, 90-day decay, paste imports, and curation by admins or users with the
  memory-reviewer flag. Company memories honour category access. Infrastructure: `voc-memory` table
  (RETAIN, PITR, KMS), `voc-memory-api`, scanner / extract queue / extractor / retention workers, Titan Text
  Embeddings V2. No role can delete a memory. See [Memory](docs/memory.md).
- Company context: vision and objectives (admins edit, everyone reads), personal objectives and KPIs per
  user, and a design system (tokens, guidelines, logo upload, references from Figma, GitHub, screenshots or
  HTML) that the prototypes and agents follow; `voc/design-integrations` secret for Figma/GitHub tokens.
  See [Company context](docs/company-context.md).
- The AI assistant reads and (with approval) writes memory, agents, workflows and company context; new
  page kinds `company`, `memory`, `agents`, `agent`.

### Changed

- Navigation follows the VoC loop: Listen · Understand · Build · Validate · Knowledge · Connect, plus an
  admin-only **Administration** (`/admin`; `/settings` redirects) and a per-user **Account** page.
  Menu keys `memory`, `agents`, `company`, `connect` in `menuStatus`.

### Fixed

- Memory and agents stores queried `gsi1` instead of the deployed index names; memory handlers read
  `MEMORY_QUEUE_URL` while the stack set `MEMORY_EXTRACT_QUEUE_URL`; the state machine spoke a contract no
  Lambda implemented; a finished run never released its lock. All found before deployment and pinned.

### Upgrade notes

- `cdk deploy --all` creates two RETAINed tables. Flex support for Claude Haiku is unverified (watch the
  `FlexFallback` metric).

## [2.06.00] - 2026-10-05

Owner decisions taken by best practice, SSRF hardening, visual and accessibility review (wave 5).

### Changed

- The S3 import bucket is versioned with lifecycle rules (noncurrent versions after 7 days, incomplete
  multipart uploads after 1 day, expired delete markers removed): a delete through the API is
  recoverable for 7 days.
- Printing and PDF export use a hidden same-origin `<iframe srcdoc>` and `print()` on load instead of
  `document.write` into a popup; export opens the browser's print dialog directly.
- The Lambda layer build creates its virtualenv with `mktemp -d` (private, unpredictable) instead of
  `/tmp/buildenv`, in `python-layer-bundling.ts` and `scripts/build-layers.sh`.
- The chart ramp `--chart-1…8` was re-tuned so every pair is at least 11 ΔE2000 apart (5 under protan /
  deutan simulation) at 4.5:1 or more on a card; sentiment keeps its status colours.

### Fixed

- Scraper URL analysis (`POST /scrapers/analyze-url`) is protected against DNS rebinding: the name is
  resolved once, the socket connects only to the vetted public addresses (Host header, TLS SNI and
  certificate checks keep the hostname), the connected peer is re-checked on every redirect hop, and
  proxy environment variables are ignored for this fetch.
- Accessibility (axe 7 → 0 across 16 screens × both themes × 1440/390 px): muted text on selected rows,
  the assistant launcher drawn over dialogs, an undimmed strip under dialogs, the project header at
  390 px, owner/member alignment, a "Next step" prompt shown to viewers.

## [2.05.00] - 2026-10-05

Quality-gate sweep and the open todo items (wave 4).

### Added

- The i18n audit (`frontend/scripts/i18n-check.mjs`) runs in `validate.sh`: an AST extractor resolves
  namespace arrays, per-hook scope and `t: TFunction<'ns'>` props, and reads the namespaces from the
  English locale directory.
- KiroCrew ghost poses for the assistant's empty and thinking states.

### Changed

- Owner and member emails are returned only to callers who can manage the project (list, get, members).
- The S3 import explorer is translated in all 8 locales; the approval card scrolls its actions into view;
  the assistant's Expand button is hidden on phones.
- 29 more ruff codes and 12 ESLint rules enforced; the reprocess job logs error types only.

### Fixed

- `/chat/conversations/<proxy+>` routes never matched a real API Gateway event (Powertools reads
  `<\w+>`): they are `<conversation_id>` now, so assistant sessions save and load on a deployed stack.
  The legacy save validates its id and size.
- The scraper URL analysis re-validates every redirect hop and refuses every non-global address
  (IPv4-mapped IPv6, 100.64/10, 0/8, multicast, …).

### Removed

- The iOS App Store `most_critical` sort option: Apple's feed answers HTTP 500 for `sortby=mostcritical`.
  Saved configurations fall back to `mostrecent`.

## [2.04.00] - 2026-10-04

KiroCrew chart palette, permission follow-ups, Kiro Dark by default (wave 3).

### Changed

- Charts, categories and distributions use a purple → pink → grey ramp derived from KiroCrew's own hues
  (`--chart-1…8`, both themes); status colours stay for status.
- Kiro Dark is the default theme for visitors who have not picked one.
- Voting-session reads and closes are gated on the row's project; jobs record `initiated_by`; every job
  route answers 404 before writing a job row for a missing project; viewers see write controls hidden or
  disabled on Project Detail; `fetchApi` rejects with the server's error message.
- Settings → Users shows one heading; Settings strings are translated; persona headers use lucide icons.

### Removed

- The legacy non-streaming `POST /chat`, `chat_stream_url` in `GET /projects/config`, the unused
  `BRAND_HANDLES` environment variable and 32 dead i18n keys.

## [2.03.00] - 2026-10-04

Keep everything, categories mapped to products and owners, per-user category access.

### Added

- Categories map to products and product owners (`product`, `owners`); setting them up is an onboarding
  step. See [Categories, Products and Access](docs/categories.md).
- Per-user category access: admins choose which categories of reviews each user can see
  (`GET/PUT /users/{username}/category-access`; no row = all categories; admins and a category's owners
  always see it), enforced on every metrics route, feedback detail, chat, form submissions, the assistant's
  search and job context. `GET /feedback/access` returns the caller's scope.
- Category corrections: `PUT /feedback/{id}/category` (new `voc-feedback-edit-api`) and the assistant's
  approval-gated `set_feedback_category` tool update a review in place and record who changed it.
- Reprocess stored feedback after categories change: `POST/GET /settings/categories/reprocess` (admin),
  run by the new `voc-category-reprocess` worker.
- All-time windows: `days` accepts 0–9999 (`0` = all time) everywhere, including the custom range in the
  header, backed by an earliest-data watermark; per-day walks stop on a time budget and say so
  (`is_partial`, `partial_reason: 'time_budget'`, `scanned_through`).

### Changed

- Nothing is ever deleted: feedback no longer expires, `METRIC#` rows get no TTL, and the feedback,
  aggregates and projects tables, the raw bucket and the KMS key are `RemovalPolicy.RETAIN`.
- The Data Explorer is admin-only and cannot delete; `PUT /data-explorer/s3` refuses to overwrite a
  `raw/` object (409).
- `PUT /settings/categories` is admin-only and validated (≤ 50 categories, unique names, field limits).

### Removed

- `DELETE /data-explorer/s3` and `DELETE /data-explorer/feedback`; `/data-explorer/*` uses explicit routes.

### Upgrade notes

- Run `scripts/retention/remove_ttl.py` after deploying (dry run by default, `--apply` to write): it removes
  the legacy `ttl` and writes the earliest-date watermark. Until then, older rows keep expiring.
  See [Data Retention](docs/deployment.md#data-retention-nothing-is-ever-deleted).
- `cdk destroy` leaves the customer-data tables, the raw bucket and the KMS key behind.

## [2.02.00] - 2026-10-04

One page-aware AI assistant, and the Kiro UX/UI review pass.

### Added

- One floating, page-aware AI assistant replaces the `/chat` page assistant and the Project Detail chat
  tab: a bubble on every protected page that expands to a panel or full screen, speaking AG-UI 1.0 over
  `POST /chat/stream`. The page picks the tool packs and the default subject; server tools only read, and
  every write is a client tool the user approves on a card, executed with the user's own token. Bedrock
  prompt caching covers the tools, the system prompt and the conversation prefix.
- Assistant sessions persist per user in `voc-conversations` (`kind: 'assistant'`, ≤ ~350 KB, 413 above).
- Claude Sonnet 5.5 (`global.anthropic.claude-sonnet-5-5`) in the model allowlist; it is the default of the
  `chat` surface, now labelled "AI Assistant" in Settings → AI Models.

### Changed

- The stream Lambda no longer touches the projects table: it reads through the Projects, Metrics,
  FeedbackForm, Settings and Scrapers APIs (`lambda:InvokeFunction` on exactly those five).
- UX/UI pass on the Kiro theme (Playwright + axe, 15 routes × 2 themes × 2 widths): axe 248 → 0, consistent
  page headers and empty/loading/error states, labelled controls, mobile layouts, a NotFound route, the
  time-range picker only on time-scoped pages.

### Upgrade notes

- Deploy the frontend and the stream Lambda together: the `/chat/stream` request format changed.
- The assistant's default model needs Bedrock access to Claude Sonnet 5.5; otherwise pin the `chat` surface.

## [2.01.00] - 2026-10-04

Per-project permissions, and a browser bridge to a local Kiro CLI.

### Added

- Per-project permissions: projects are `public` (every signed-in user views and edits, the previous
  behaviour) or `private` (owner, invited `editor` / `viewer` members and admins only), with membership,
  ownership transfer and a Cognito member picker. New projects default to private; existing unowned
  projects read as public and are managed by admins. The assistant and MCP tokens act as the calling user.
  See [Sharing and permissions](docs/project-workspace.md#sharing-and-permissions).
- `tools/kiro-acp-bridge`: drive a local `kiro-cli` from a browser over ACP.
  See [Kiro ACP bridge](docs/kiro-acp-browser-bridge.md).

## [2.00.00] - 2026-10-04

The Kiro redesign: the VoC frontend rebuilt on KiroCrew's "Kiro" design system, and the quality gates.

### Added

- The KiroCrew "Kiro" theme (Apache-2.0) in dark and light: tokens, typography (Space Grotesk, JetBrains
  Mono, bundled), the Kiro ghost mark, and recipe classes for buttons, inputs, selects, switches, cards,
  badges, pill tabs, dialogs, menus and markdown. A theme toggle in the header and a pre-paint theme script.
  Every tab, modal and component uses the recipes. See [Kiro design system](docs/kiro-design-system.md).
- Quality gates (`npm run validate` = `scripts/validate.sh`, the only CI step): ruff, vulture, tsc, ESLint
  with a shared rule set, knip (default and `--production --strict`), pytest, vitest; dead code enforced at
  zero in all packages; pending rules counted by `scripts/quality-baseline.sh`; mutation reports with
  mutmut and Stryker. See [Contributing](CONTRIBUTING.md#quality-gates).

### Changed

- About 2,900 palette classes and hex colours replaced by tokens; legacy badge, prose and hue-keyed
  variant props replaced by semantic tones; two layering bugs fixed (modals trapped under the sidebar, an
  uncovered strip under the backdrop).

### Removed

- The previous design-system document, `App.css`, unused assets, `tailwind-merge`, about 190 dead
  Python symbols and 39 frontend re-export barrels.

## [0.3.0] - 2026-09-10

### Added

- Persistent managed version series for PRDs, PR/FAQs, and prototypes. A stable allocation id makes retries return the same artifact; version counters and allocation history prevent a deleted version from being silently reused. Legacy managed documents are normalized into the same series, and the Documents tab exposes revision and derivation lineage.
- An expanded prioritization-row lifecycle: reviewers can compose additional project/document combinations and recompose them until the first value-bearing ballot freezes the concrete selection. Admins can atomically delete an eligible non-default row with at most 98 ballots; larger room-vote rows are retained rather than partially deleted. Lineage indicators distinguish coherent and cross-generation selections, and frozen rows can advise when a strictly newer combination exists without blocking scoring.
- Scoped read-only MCP access with explicit `feedback:read`, `metrics:read`, and `projects:read` grants; workspace or project-set reach; optional expiry; credential-filtered `tools/list`; protocol/output-schema conformance; and eleven delegated tools covering feedback, metrics, projects, personas, and jobs. See [Project Workspace](docs/project-workspace.md#mcp-access).

- An expanded prioritization row can enlarge the prototype it is showing to fill the viewport, in
  place, so a pitch session can look at the artifact without leaving the sliders, the team's numbers
  and the room vote behind on the page. Escape, the visible Close control and a click outside all
  return to the row. Offered for every prototype the row renders, including a legacy inline one and a
  JSON spec, neither of which has an address that "Open in new tab" could use.

### Changed

- Aggregate reads now report lower-bound/partial windows instead of presenting capped data as complete, and persona metrics bucket by archetype rather than display name. DynamoDB Stream `REMOVE` and `MODIFY` records reverse or rebucket counters without recreating aggregate rows that have aged out.
- Chat feedback tools search up to 90 days and disclose truncation. Persona prompts and imports use the same stored field vocabulary as their writers, so generated artifacts and chat no longer lose structured persona content.

### Fixed

- A generation that needs more than five minutes of model time now succeeds, instead of failing three
  times over and reporting nothing. The shared Bedrock client waited five minutes for a response and
  then retried twice by itself, so its real budget was fifteen minutes — exactly the ceiling of the
  job functions that build prototypes, documents, personas and research. A long generation therefore
  had no path to success: it was abandoned and restarted twice, each attempt re-paying for a full
  generation, and the function was killed part-way through the third with nothing to show while the
  job still read as running. Those retries also happened below the platform's own retry loop, so the
  logs said "attempt 1 of 5" for the entire fifteen minutes and the run looked like one slow call.
  The client now makes a single attempt and waits fourteen minutes for it, and a read timeout is
  reported and recorded as a failed job rather than retried into the ceiling. Prototype builds are
  where this was measured, because they ask for the largest output, but every Bedrock surface shared
  the same client and the same ceiling.
  Two of the shorter jobs — merging documents at ten minutes, importing a persona at five — are
  bounded by their own limit rather than by that fourteen minutes, so a generation longer than their
  own budget still ends without an explanation attached to it, exactly as it did before. Retrying a
  throttled request is unaffected everywhere: that is worth a second attempt and is still made, with
  backoff, by the platform rather than by the AWS client underneath it.
- A failed prototype build no longer costs up to three quarters of an hour. The job functions are
  invoked asynchronously, where AWS re-runs a failed invocation twice more by default, so one click
  became roughly forty-five minutes of model work — invisible, because each re-run wrote progress to
  the same job row and looked like the first attempt making none. A failure is now reported once, and
  retrying is the reader's decision.
- The product-document extractor, which builds its own Bedrock client, had the same collision at a
  smaller scale: it waited sixty seconds for an image description with retries behind it, against a
  two-minute function, so its final attempt was always cut off. It now waits eighty seconds once,
  which also lets a slow description finish where it previously gave up.
- A CSV upload no longer overwrites an earlier one whose `id` column covered the same numbers.
  A row's identity was the `id` column value as written, and every CSV upload enters the pipeline
  under the single `source_platform` of `manual_import`, from which the processor derives both its
  idempotency key and its DynamoDB key. Row `1` of one file was therefore the same stored record as
  row `1` of every other file, so importing two 400-row exports each numbered `1..400` left 400
  records holding an arbitrary mixture of the two. Nothing reported the loss: both files were
  archived, and each upload answered with its own full row count, because that count is what the
  queue accepted rather than what was ultimately stored. Rows are now identified by a hash of the
  row itself — its `id`, text, rating, date, author, title, url and its own `source` column — so two
  files that reuse a number no longer conflict, while re-uploading an unchanged file still stores
  nothing new. A row with no `id` of its own also counts its position in the file, so a survey
  export whose free-text answers repeat verbatim keeps one record per answer — which does mean that
  reordering a file re-imports the rows in it that carry no `id`, while rows that carry one are
  unaffected.

  Two consequences are worth knowing before you re-import. Identity now follows a row's content, so
  re-uploading a file with a corrected row stores that row a second time instead of replacing the
  first; correct the data at the source and delete the earlier import rather than uploading over it.
  And rows imported before this release carry keys from the old scheme, so an environment that
  already holds a collided import should delete those records before importing the files again —
  importing on top of them leaves both generations in place. The `id` column each row carried is now
  kept on the record as `csv_row_id`, so a record can still be traced back to the row it came from.

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

- Cognito tokens are sent only to trusted application origins, so a user-entered external URL cannot receive the session token through a frontend request.
- The browser-assumable Identity Pool role no longer has direct Lambda invoke permission; authenticated application traffic goes through the authorized API routes.
- The three public feedback-form routes have explicit API Gateway throttles: higher read capacity for config/iframe traffic and a tighter submission ceiling for the downstream AI pipeline.
- The CloudFront website bucket now writes server access logs to a dedicated encrypted log bucket.
- Plugin secret isolation now fails closed. Each plugin Lambda reads one shared Secrets Manager
  secret whose keys are namespaced `<plugin_id>_<key>`, and — because every ingestion Lambda shares
  one IAM role — that prefix is the only boundary between one plugin's credentials and another's. A
  prefix matching zero keys previously returned the **complete** shared secret, on the theory that
  such a plugin predated prefixing; the effect was that a typo in a plugin id, the input most likely
  to be wrong, produced the maximally permissive outcome. It now raises, naming the plugin and the
  prefix it expected and nothing else. The hand-maintained plugin-id list the filter needed is gone
  with it: forgetting to add a plugin there reclassified its keys as "shared" and leaked them into
  every other plugin.
- A webhook Lambda is now deployed with the environment variable its code reads for the plugin
  identity (`SOURCE_PLATFORM`, which only the ingestor Lambda carried). Combined with the above,
  a deployed webhook would otherwise have failed on every delivery.
- A Secrets Manager read that fails no longer counts against a plugin's circuit breaker. The
  fail-closed change above turned an unreadable secret into a refusal to start, and a refusal was
  counted as a plugin failure — but a read that failed is indistinguishable from an empty secret
  (the client error is logged and discarded), so a handful of throttles inside the breaker's window
  would disable a healthy plugin's ingestion schedule, which nothing re-enables automatically. An
  unreadable secret is now reported without being counted: the `plugin.failed` audit event still
  fires, and the run record moves to `error` on a *manual* run — a scheduled run has no run record
  to move, so an alarm on the `Refusing to load plugin secrets` log line is the escalation path for
  that case, and the exemption depends on it existing (see `docs/plugin-architecture.md`). Only a
  genuine misconfiguration — a malformed plugin id, a namespace holding no keys, or a secret whose
  body is not a JSON object — can trip the breaker.
- Every route taking a `{source}` path parameter now requires `source` to be a plugin that exists.
  Validating only its *form* left a cross-plugin credential write open, because the colliding value
  is itself well-formed: `source=app_reviews` with key `ios_app_id` stored `app_reviews_ios_app_id`,
  which `app_reviews_ios`'s next run then consumed as its own `app_id`. The synth-time guard on
  colliding plugin ids does not reach this — a colliding *stored key* needs no colliding manifest —
  so the namespace a request may address is now restricted to the manifest-derived ids CDK already
  hands this Lambda. It fails open if that variable is unavailable, so one bad environment variable
  cannot break credential management outright. `source` also reached an ingestor Lambda name and an
  EventBridge rule name unvalidated on the `/sources/{source}/*` routes.
- `GET /sources/status` validates the sources it takes from the query string. It is the only route
  whose source is not a path parameter, so the guard above did not reach it, and both of its
  branches derived a resource from an arbitrary value: `?sources=` named EventBridge rules it
  called `describe_rule` on — reflecting each rule name back, so an arbitrary value could enumerate
  rules and learn the naming convention — and `?run_status=` queried an arbitrary `SOURCE_RUN#`
  partition. The `?run_status=` branch now answers 400 for a source that is not a plugin. The
  `?sources=` branch reports such a source as `{'enabled': false, 'exists': false}` rather than
  raising, because it answers about several sources at once and one unknown name must not fail the
  whole response — and because its own default list contains `manual_import`, a legitimate source
  platform that deliberately has no plugin manifest. That is the same answer as before for every
  request the UI sends, since a schedule rule only ever exists per plugin. The `?sources=` list is
  also de-duplicated and capped now: validation bounds *which* rules may be described but not how
  *many* calls are made, and one valid name repeated 500 times issued 500 `describe_rule` calls while
  overwriting the same response entry each time — the caller chose the AWS call count against a fixed
  result, on an API throttled per account and shared with the rest of the stack. It is the only read
  in this handler that fans out one AWS call per list element.
- `POST`/`DELETE /integrations/{source}/apps`, `POST /sources/{source}/run` and
  `PUT /sources/{source}/enable|disable` now require the caller to be in the `admins` group. Only
  the two credentials routes were gated, so the boundary depended on which key a write happened to
  land under: a caller whose only group was `users` could write `{source}_configs` on the same shared
  Secrets Manager secret, invoke an ingestor (a billed third-party fetch, in a loop), and disable a
  plugin's ingestion schedule — which nothing re-enables automatically. `GET /integrations/{source}/apps`
  stays open deliberately: the Scrapers page lists app configs for every authenticated user, and a
  config holds a public app-store id and a display name rather than a credential. On that page the
  Run, Add, Save and Delete controls and the schedule toggle are now disabled for a non-admin, with
  the reason on hover, rather than issuing a request that 403s — and so is the Enabled toggle on the
  Settings page's source cards, which is the other UI caller of `enable|disable`.
- `Save to Secrets Manager` on the Settings page's source cards is now disabled for a non-admin.
  `PUT /integrations/{source}/credentials` behind it was already admin-gated, so unlike the toggle
  above this was not a regression — the control had always behaved this way, and it was the last
  ungated UI entrance to an admin-gated route. It was also the least visible failure of the set:
  that mutation has an `onSuccess` but no `onError`, so the 403 rendered no message and the button
  merely never became `Saved!` — a non-admin typed a credential, clicked Save, and got no indication
  it had been refused. The credential fields stay editable and `Test` stays available, because
  `POST /integrations/{source}/test` is not gated and a non-admin can already read those fields.
- `POST /scrapers`, `DELETE /scrapers/{scraper_id}` and `POST /scrapers/{scraper_id}/run` now require
  the `admins` group. No route in that handler had a gate, while two of them `put_secret_json` the
  SAME shared API-credentials secret the credentials routes protect — rewriting `webscraper_configs`,
  a key the webscraper ingestor consumes, so an unprivileged write steered which URLs got fetched —
  and the third invoked that ingestor, a billed third-party fetch callable in a loop. Gating only the
  `{source}` routes above would have left the boundary depending on which handler a write arrived
  through rather than on what it changed. The `GET` routes and `POST /scrapers/analyze-url` stay open
  to match the read/write split, and the Run and Delete controls on each scraper card are now disabled
  for a non-admin — as is **Save in the scraper editor**, which is the only UI entrance to
  `POST /scrapers` and was the worst of the three: the editor closed as though the change had been
  stored, because it closes unconditionally and its mutation surfaces no error, so a non-admin's edit
  was discarded silently. `scraper_id` is deliberately not allowlisted the way `{source}` is: it is
  not a plugin id and reaches no secret key or function name, only a `SCRAPER_RUN#` partition and the
  invoke payload, where the webscraper resolves it against its own configured list. `/scrapers/manual/*`
  is a **second** handler and is deliberately not covered: those routes write feedback content into
  the ingestion pipeline and reach neither the shared secret nor any plugin resource, which is the
  basis on which the three above were gated — see `docs/plugin-architecture.md`.
- A plugin's `plugin.failed` audit event is no longer lost when the circuit breaker's own DynamoDB
  lookup fails. The three reporting steps for a construction failure shared one `try`, and
  `record_failure` is not exception-safe on its first line (it resolves its table in a property,
  outside its own `try`), so a failure there skipped the audit event — in exactly the correlated
  case where the same DynamoDB trouble affects both, and on a scheduled run that event is the only
  signal the failure leaves anywhere. Each step is now guarded independently.
- `POST /projects/{project_id}/document` validates `doc_type` against an allowlist of `prd` and
  `prfaq` before creating the job. The field steered the job type, the execution path and the
  generated document's DynamoDB sort key straight from the request body, and each attempt billed a
  model call.

### Upgrade notes

- **Reissue MCP credentials created before domain scopes and reach were introduced.** Missing or malformed scopes now grant nothing rather than falling back to the former broad `read` behavior. A legacy row that has valid scopes but no reach is interpreted as workspace-wide for backward compatibility; reissue it with the intended `workspace` or `project-set` reach.
- **Existing aggregate drift is not repaired automatically.** Transactional INSERT deduplication and reversal logic prevent new classes of drift, but counters already stored remain unchanged. Follow [Rebuilding aggregates for a window](docs/processing-pipeline.md#rebuilding-aggregates-for-a-window) and write absolute values rather than replaying deltas.
- **A plugin must declare at least one key in its manifest's `secrets` block.** Following the
  fail-closed change above, a plugin whose namespace holds no key in the shared secret raises a
  `ConfigurationError` when its Lambda is constructed, rather than silently receiving every other
  plugin's keys. Every plugin shipped in this repo declares at least one key and CDK seeds them all
  at deploy time, so no bundled plugin is affected; a custom plugin declaring none must add a key,
  or override `_load_secrets` to return `{}` — a deliberate opt-out of the boundary. Declining to
  *read* `self.secrets` does not avoid the raise: both base classes call `self._load_secrets()` in
  `__init__`, before any subclass body runs. A test over the manifests now fails in CI
  rather than letting this surface in a deployed Lambda. Any onboarding notes telling a plugin
  author to register their prefix in `_get_known_prefixes()` are obsolete — that function no longer
  exists, and registration was never needed for a correctly prefixed key.
- **A plugin id may no longer be a prefix of another plugin id** (`app_reviews` alongside
  `app_reviews_ios`). Secret keys are matched by string prefix, so the shorter id would receive the
  longer one's credentials. `cdk synth` now refuses such a pair, which is the only point at which
  the whole id set is known. No bundled pair collides.
- **`source` on every `{source}` route must now be a configured plugin id.** A request naming a
  well-formed but non-existent source (`app_reviews`, `webscraper_admin`) is answered 400 instead of
  reading or writing that namespace, invoking `voc-ingestor-<source>` or toggling
  `voc-ingest-<source>-schedule`. Anything addressing a real plugin id is unaffected, which is every
  call the web app makes; a script that relied on an arbitrary namespace must use the owning plugin's
  id. Neither this nor the synth-time id guard is retroactive: a key stored by a pre-upgrade write
  survives in the shared secret and is still read by whichever plugin's namespace it landed in.
  A deployment where an arbitrary `source` was used should delete the stale keys by hand.
- **`GET /sources/status?sources=` accepts at most 50 distinct sources per request** and answers 400
  above that. Counted after de-duplication, so repeating one name is not what trips it, and set well
  above both the five plugin manifests and the route's own three-source default — the web app asks
  for at most one source at a time, so no UI call approaches it. A caller passing the same source
  more than once still receives the identical response; only the redundant `describe_rule` calls are
  gone.
- **Triggering a run, toggling a schedule, and writing or deleting an app config now require the
  `admins` group.** A caller in `users` alone receives 403 on `POST /sources/{source}/run`,
  `PUT /sources/{source}/enable|disable` and `POST`/`DELETE /integrations/{source}/apps`. Listing app
  configs (`GET /integrations/{source}/apps`) is unchanged and still open to any authenticated
  caller. A non-admin who previously used the Scrapers page to run a source or edit an app config now
  sees those controls disabled; a script doing the same needs admin credentials. The same applies to
  the scraper routes: `POST /scrapers`, `DELETE /scrapers/{scraper_id}` and
  `POST /scrapers/{scraper_id}/run` answer 403 outside the `admins` group, while `GET /scrapers`, the
  status and run-history reads and `POST /scrapers/analyze-url` stay open. On the Settings page the
  Enabled toggle is now disabled for a non-admin, where it previously issued a request that failed
  silently — as is `Save to Secrets Manager` on the same card, whose route was already admin-gated
  but whose refusal rendered no message at all — and in the scraper editor so is Save, where the
  modal previously closed as though the edit had been saved. The manual-import routes
  (`/scrapers/manual/*`, a different Lambda) are unaffected and stay open to any authenticated caller.
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

<!-- Version 0.3.0 and later use release tags. Historical 0.1/0.2 links remain
     fixed commit ranges because those releases were not tagged. -->

[Unreleased]: https://github.com/aws-samples/sample-voice-of-customer-datalake/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/aws-samples/sample-voice-of-customer-datalake/releases/tag/v0.3.0
[0.2.0]: https://github.com/aws-samples/sample-voice-of-customer-datalake/compare/0b785a87...a7a976b0
[0.1.0]: https://github.com/aws-samples/sample-voice-of-customer-datalake/commit/0b785a87

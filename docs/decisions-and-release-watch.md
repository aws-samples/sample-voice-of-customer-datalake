# Decision records and release watch

Two small, code-first features. A **decision record** writes down what a team chose to do about
a problem, and why. **Release watch** shows whether customers felt better or worse after a release.

## Decision records

A decision is a project document of type `decision`. It needs no table of its own: it is a
`DOC#{id}` row in `voc-projects`, like a custom document, so it shows in the Documents tab, export,
the assistant's project context and as a reference document of a PR/FAQ.

| Field | Notes |
|---|---|
| `title` | Required, at most 200 characters |
| `verdict` | `pursue`, `park` or `reject` |
| `rationale` | Required, at most 4,000 characters |
| `success_metric`, `kill_criterion` | Optional, at most 1,000 characters each |
| `evidence` | `{feedback_ids: [...], document_ids: [...]}`: ids only, never copied text (at most 50 / 20). Document ids must be documents of the same project, and a decision cannot cite itself |
| `review_by`, `launched_at` | Optional `YYYY-MM-DD` dates. `launched_at` turns on the release watch for that decision |
| `decided_by`, `decided_by_name`, `decided_at` | Set by the server from the caller. Reset when the verdict changes; earlier verdicts are kept in `decision.history` (last 20) |

The stored `content` is markdown rendered from the fields, so it never drifts from them. The
document's `derivation` (`shared/derivation.py`) lists the cited documents as `reference` sources
and counts the cited feedback.

### Routes (projects Lambda, under `/projects/{proxy+}`)

| Method | Path | Access | Answer |
|---|---|---|---|
| POST | `/projects/{id}/decisions` | edit | `{success, document}` |
| PUT | `/projects/{id}/decisions/{document_id}` | edit | `{success, document}`. Send only the changed fields, plus `expected_revision` (the `revision` you loaded). A stale revision or a concurrent save is a **409** |
| POST | `/projects/{id}/decisions/{document_id}/pursue` | edit | **202** `{success, job_id, status}`. Only for a `pursue` decision (400 otherwise) |

A decision is listed by `GET /projects/{id}` like any document. It is deleted with
`DELETE /projects/{id}/documents/{document_id}`. The generic document edit
(`PUT .../documents/{id}`) and version restore refuse a decision with a 400.

Access follows `shared/project_access.py`: viewers see decisions; editors, the owner and admins
create and edit them. A viewer gets no write controls in the UI.

### "Pursue" seeds the PR/FAQ chain

`Draft PR/FAQ` on a Pursue decision starts the ordinary PR/FAQ generation
(`POST /projects/{id}/document` internally, the same job and state machine). The decision is the
first reference document, followed by up to two cited documents, the rationale and measures are
the feature idea, and feedback from the last 30 days is included (in the caller's category scope).
It is a user action and never automatic. The decision records the job as `seeded_prfaq_job_id`.

### UI

Project → **Decisions** tab (`?tab=decisions`): the list (verdict badge in a status tone,
measures, dates, evidence links), New decision, Edit, Draft PR/FAQ, Revisit (a new decision
prefilled from this one's title and evidence) and, for a launched decision, its release watch.

### Opening a prefilled decision from elsewhere

`decisionDeepLink(projectId, {title, verdict, rationale, feedbackIds})` in
`frontend/src/pages/ProjectDetail/decisions/decisionDraft.ts` builds:

```
/projects/{id}?tab=decisions&newDecision=1&title=...&verdict=pursue|park|reject&rationale=...&feedback=fb_1,fb_2
```

The tab opens the editor prefilled (for an editor of the project) and drops the parameters from
the URL. Nothing is saved until the user presses Save. A brief card can link here.

## Release watch

`lambda/shared/release_watch.py` compares the feedback before and after a release. Everything is
computed in code, after the caller's category and source scope. No model is called.

**A release** is one of:

- a GitHub release seen by the github_issues plugin: an `issue_attributes.software_version`. Its
  release day is the first day (review date) an item names that version;
- a dated launch: a decision's `launched_at`, or a date the caller names.

**The window** is `window` days before the release day and `window` days from it (default 14, at
most 60). The after side stops at today. For each side: volume, scored items, mean sentiment,
negative items and the top three categories. Then the volume and negative changes per day, the
sentiment change, the negative categories that grew the most (only those whose negative count
went up by 2 or more — `MIN_COMPLAINT_GROWTH`; a flat `1 → 1` is never listed) and the most
negative items after the release (`feedback_ids`, and `evidence`: each id with the review's title
or first words, which the review links show).

**Regression** (constants pinned by `lambda/shared/test/test_release_watch.py`):

| Rule | Fires when |
|---|---|
| `sentiment_drop` | Mean sentiment falls by 0.15 or more, with at least 5 scored items on each side |
| `negative_rise` | Negative items per day rise by 50 % or more, with at least 10 negative items after the release |

Per-day rates are compared, so a release only three days old is not "better" just because its
after side is shorter.

### Route (metrics Lambda, read-only)

`GET /metrics/release-watch` is an explicit Cognito resource next to `/metrics/{proxy+}`.

| Parameter | Meaning |
|---|---|
| `days` | How far back GitHub releases are looked for (default 90, at most 365; `0` = all time, then capped) |
| `window` | Days on each side (1 to 60, default 14) |
| `launched_at`, `label` | Watch this one dated launch instead (within the last 365 days; label at most 120 characters) |
| `category`, `q` | Only items of this category / containing every keyword (at most 5) |
| `source`, `channel`, `dims`, `tag` | The usual metrics filters |

The answer carries `period_days`, `window_days`, `thresholds`, `releases` (newest release day
first, at most the 5 latest GitHub versions) and the usual `is_partial` / `partial_reason` /
`scanned_through`: the walk is bounded by the request's time budget like every per-day walk.

### Where it shows

- Dashboard → GitHub section → **Release watch**, when GitHub Issues feedback exists.
- Project → Decisions → a launched decision → **Release watch**.

Each release row shows both sides' volume, negative items and sentiment, then the top categories
before and after (`top_categories`, at most three each, by their configured labels, each opening
Categories filtered by it). An after-category reads **New in the top list** when it was not in the
top three before, and **Up from N** when its count rose; raw counts are compared, like the growing
complaints (the after side may cover fewer days — the row says how many). Categories cannot take
the release window in its URL, so the link filters by category only, over the header's time range.

### Morning brief card

`release_watch_cards(ctx)` is a card provider (`shared/brief_cards.py`): one `release_watch` card
(layer `org`, `alert` on a regression, otherwise `info`) per release from the last 14 days that has
feedback after it, id `card_id('release_watch', day, release_key)`. It reads the last 28 days of
feedback in the reader group's scope (bounded: 3,000 items, 10 seconds). Dated launches come from
`ctx.extra['launches']` (`[{id, label, day}]`). Facts are numbers only; the brief worker writes the
words.

## Cost

No new infrastructure beyond one API Gateway resource and method. Decision records are a few
DynamoDB writes. Pursue costs what a PR/FAQ generation costs. Release watch reads feedback only
when somebody opens it.

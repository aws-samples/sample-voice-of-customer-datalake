# Prioritization scoring setup

The Prioritization page ranks rows (a project's set of documents) of every project against each
other. How a row is scored is **one setup for the whole workspace**: administrators choose the
metrics, everyone scores with them. Per-person metrics could not add up to a team score, so there
are none (the model most product-discovery tools use).

## The model

Each metric (an *axis*) is scored on a fixed **1–5 scale**; **0 means "not scored"**. Only names,
weights and directions are configurable.

| Field | Meaning |
|---|---|
| `id` | `^[a-z][a-z0-9_]{1,31}$`, minted by the server from the name, never changes |
| `builtin` | One of the four original metrics: `impact`, `time_to_market`, `strategic_fit`, `confidence` |
| `label` | Name, at most 40 characters. `null` on a built-in = the translated name |
| `description` | At most 160 characters. `null` on a built-in = the translated hint |
| `weight` | Whole number 0–100, relative: the composite divides by the sum of the weights used |
| `direction` | `higher_better` or `lower_better` (for example Effort: a 1 is good) |
| `low_label`, `high_label` | What 1 and 5 mean, at most 24 characters each; `null` = default words |
| `archived` | Kept, not shown, not scored, not counted. Metrics are archived, never deleted |

Ids that are never used (they would collide with ballot or aggregate fields): `notes`, `row_id`,
`reviewer`, `updated_at`, `voting_session`, `display_name`, `ballot_id`, `document_id`, `ttl`, `pk`,
`sk`, `score`, `scores`, `composite`, `reviewer_count`, `score_spread`, `axis_counts`, `axes`,
`config_version`, `rows`, `aggregates`. A name that slugs to one of them, or to an id already taken,
gets `_2`, `_3`… (`"Notes"` → `notes_2`; a name with no Latin letters → `metric`).

### The default setup

No stored setup means the four built-ins with the weights the page always used: impact 40, time to
market 30, strategic fit 20, confidence 10, all higher-is-better (`config_version` 0). The ids are
the ones existing ballots already carry, so **no ballot needs a migration**. The default lives in
`voc-datalake/schemas/prioritization-default-axes.json` (the frontend's offline default) and in
`lambda/shared/prioritization_axes.py` (`DEFAULT_AXES`); `test_prioritization_default_axes_lockstep.py`
keeps them identical.

## The composite

One ballot:

```
composite = Σ w · v' / Σ w     over the active metrics the ballot scored
v' = v            for higher_better
v' = 6 − v        for lower_better
```

An unscored metric (absent or 0) is left out of **both** sums, so a partial ballot is the score of
what it said, on the same 1–5 scale. A row's **team composite** is the mean of the composites of its
*fully scored* ballots (every active metric with a weight above 0 scored). Before anyone has scored
every metric, it is the same formula over the team's per-metric means. `score_spread` is the range of
the fully scored ballots' composites (0 below two of them). The server computes it
(`shared/prioritization_axes.composite`); the page uses the same arithmetic.

## Templates (in the editor)

Frontend-only presets on the same 1–5 scale. Applying one **archives** current metrics that are not
in it and adds or restores its own (reusing `impact` and `confidence` where they match). Nothing is
saved until the admin presses Save.

| Template | Metrics (weight) |
|---|---|
| Current default | impact 40, time to market 30, strategic fit 20, confidence 10 |
| RICE | reach 30, impact 30, confidence 20, effort 20 (lower is better) |
| ICE | impact 40, confidence 30, ease 30 |
| Value vs Effort | value 60, effort 40 (lower is better) |

## Storage

voc-aggregates, partition `PRIORITIZATION`:

- `sk=CONFIG`: `{axes: [Axis], config_version, updated_at, updated_by}` (`updated_by` = the
  admin's name or username, never the email).
- Ballots unchanged: `sk=BALLOT#{row}#user:{sub}` or `BALLOT#{row}#anon:{id}`, each metric a
  top-level number named by its id. An archived metric's values stay on the ballot.

## Routes

| Method | Path | Who | Answers |
|---|---|---|---|
| GET | `/projects/prioritization` | signed-in | adds `axes` (as configured, archived ones included with `archived: true`) and `config_version`; `scores` and `aggregates` carry active metrics only; each aggregate has the per-metric means (top-level, keyed by id), `axis_counts`, `reviewer_count`, `score_spread`, `composite` (`null` when nothing weighted was scored) |
| GET | `/projects/prioritization/config` | signed-in | `{axes, config_version, updated_at, updated_by}` |
| PUT | `/projects/prioritization/config` | **admins** | body `{axes: AxisInput[], base_version}` (an axis without `builtin`; a new one without `id`) → 200 `{success, axes, config_version, updated_at, updated_by}`; 400 with a plain message (1–8 metrics in use, at least one with a weight above 0, at most 20 including archived, unknown id, a metric left out — "archive it instead", a name missing or too long, a bad weight or direction); 403 for a non-admin; 409 when `base_version` is not the stored version (someone else saved: reload) |
| PATCH | `/projects/prioritization` | signed-in | scores active metric ids only (1–5, clamped as before; 0/null = leave unchanged); an archived or unknown metric id → 400 |
| GET | `/voting-sessions/{id}/config` | public | adds `axes: [{id, label, description, low_label, high_label, direction, builtin}]` — active metrics, no weights (`[]` for a closed or unknown room) |
| POST | `/voting-sessions/{id}/submit` | public | scores active metric ids only; an archived or unknown id → 400 `reason: invalid` |

Saving the setup also bumps the read-cache config version (`docs/caching.md`). The AI assistant's
`get_prioritization` tool reads the setup from the GET and describes the active metrics by name,
share of the composite and direction.

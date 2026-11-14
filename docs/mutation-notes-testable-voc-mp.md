# Testable rewrite: the retention worker's paged walk (session testable-voc-mp)

Escalated by mut-voc-mp2 (14:10, ~/briefs/escalations.md; docs/mutation-notes-mut-voc-mp.md):
`lambda/jobs/retention/handler.py::_walk` was `while True:`, bounded only by the Lambda's clock and the scan cursor.
A scan that answered the same page with a `LastEvaluatedKey` looped for the whole invocation, and in the tests (the
clock scripted to "time left") without end, so four mutants timed out instead of being judged:
`_erase_from_boards` 32 and `_mark_lineage` 31 (the scan given `None` instead of its cursor), `_deleted_anything` 16
and 17 (`or 0` -> `or 1`: the lineage pass on for every run).

## The rewrite (behaviour unchanged for a store that pages), one refactor per commit

| Commit | What |
|---|---|
| 69c1b262 | Pins first, on today's code: `test_retention_walk_testable.py`, moto tables, the daily mode end to end (several pages from each cursor, an empty page followed, nothing to delete, time low between pages / mid-page / before the first delete, hand-over chains of one to three, `_walk`'s own step order on a finite scripted store). |
| f0e23ddd | The clock injected: `Walk.time_left` (required), `_lambda_clock(context)` in `_run` (`has_time_left` with the 60 s reserve, read at each call); the four time checks read `walk.time_left()`. |
| c290e7dd | An explicit page cap: `MAX_PAGES` = 10,000 pages a phase in one invocation; `_walk` is a bounded `for`, and past the cap hands over at the next page's cursor as on low time (`_page_cap`, logged). The raw sweep's per-prefix loop is `_sweep_prefix`, with the same cap. Helpers shared in `test/walk_store.py`; `test_retention_walk_bounds.py`. |
| d894c42a | A stuck-cursor guard: a page whose `LastEvaluatedKey` is the cursor it was read from raises `CursorStuck` before it is handled (the phase logged, never the key); the run fails audited, an erasure job reads failed and frees its locks. |

What changes for a real store: only the hand-over cadence of a phase that scans more than a million rows in one
invocation with pages faster than 84 ms (one more hand-over per million rows, the same reads); with `MAX_GENERATIONS`
a run now stops past about 500 million rows scanned (the comment at `MAX_PAGES`). A longer cursor cycle (A, B, A) is
bounded by the cap, not detected.

Found on the way: a scan that ignores its cursor does not loop on a phase that deletes what it matches (the deleted
rows drop out, so reading from the start still moves on); it loops where the matched rows stay (boards and members
de-identify, lineage marks): exactly the escalated mutants.

## Scores (killed / survived / no tests / timeout)

`scripts/mutate-python.sh` (mutmut 3.8.1), from `voc-datalake/`, `MUTMUT_MAX_CHILDREN=48`, tests
`lambda/jobs/retention/test`.

| File (lines) | Before | After |
|---|---|---|
| `handler.py`, the walk, scoping, hand-overs, locks, phases (old 215-519, now 233-570) | 535 / 79 / 0 / 4 (unit tests); 616 / 0 / 0 / 2 with mut-voc-mp2's properties (10d4de42) | 649 / 1 / 0 / 0 on d894c42a; 650 / 0 / 0 / 0 with the survivor's test |
| `handler.py`, the whole module (1,128 to 1,138 mutants) | never run whole | 1,107 / 31 / 0 / 0 on d894c42a; **1,128 / 0 / 0 / 0** with `test_retention_handler_entry.py` and two no-effect statements removed |

The four escalated mutants (`_erase_from_boards` 32, `_mark_lineage` 31, `_deleted_anything` 16, 17) are killed on
the rewrite, not timed out: a scan that answers its own start fails the run at its second page.

The 31 survivors of the first whole-module run were statements no test observed, outside the range any session had
mutated: the cutoffs' date read in UTC (`datetime.now(UTC)`, now pinned against a clock that answers only in UTC);
the Radar store's own filter; the refusal of an erase event without a string value or with a workspace_id naming no
workspace (each refused before any read, by its own log line), and the message of a job row naming another
workspace; a hand-over naming a phase this run does not walk (it starts from the first phase, from the start); the
lock releases' log label; the deletes metric's sum; and which counter each cached read compares (`handle_event`'s
`before`). Two were statements with no effect, removed (behaviour unchanged):

- `_finish`'s `run.pop('_progress', None)`: `_progress` is read only by `runs.record_progress`, which nothing calls
  after `_finish`; the audit row, the job row and the result read named keys only.
- `handle_event`'s `job_scope(state) if state.get('job_id') else None`: a run holds `workspace_id` only from
  `_workspace_job`, which sets it with the job id (`new_run` never carries it), so `job_scope(state)` is already None
  without a job id.

No equivalent mutant is claimed.

## Left for later (not in this escalation)

- `exports.clear`'s and `boards._delete_folder`'s `while more:` loops over `delete_raw_prefix_page` are bounded by the
  store's answers (and, for exports, the clock) only, like the raw sweep was; the same per-prefix cap would bound
  them. No mutation run has timed out on them.
- No alarm watches a failed retention run (a `CursorStuck` erasure waits for an admin to see it).

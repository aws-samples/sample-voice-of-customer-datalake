# Property and mutation notes: voc-wiki (session mut-voc-wiki)

What this file records: the critical components of the wiki side of the VoC project (documents, revise from
comments, prototypes, the MCP tool list, project access, export, sections), why a wrong answer would cost, which
ones have property tests, the mutation scores, the equivalent-mutant ignore list, and what was found.

Property tests use Hypothesis (pinned in `voc-datalake/requirements-dev.txt`). Each one states its invariant in its
docstring or class docstring. The regression seeds are the `@example(...)` cases committed in the files that have them; the
Hypothesis example database (`.hypothesis/`) is local and git-ignored. Every property runs 256 examples by default.

## Critical components

| # | Component (module) | Why a wrong answer costs | Property tests | Mutation run |
|---|---|---|---|---|
| 1 | Document versions and titles (`lambda/shared/document_versions.py`: `split_versioned_title`, `canonical_document_title`, `series_base_title`, `normalize_document_versions`) | A wrong version files a document under the wrong number or merges two series; the title is what the page and the MCP tools show. | `test_document_versions_properties.py` (6), `test_document_versions_series_properties.py` (16: one series key and counter however a title is spelled, reads independent of row order and idempotent, lowest-free fill in creation order, the migration writes what a read groups), `test_document_versions_survivors.py` (20) | whole module (with the bounded fill of 7.01.03): 2555 of 2569 killed, 14 equivalent, 0 timeouts; two bugs (below) |
| 2 | Revise from comments: thread selection, grounding and applying changes (`lambda/shared/document_revision.py`: `select_threads`, `ground_changes`, `apply_changes`, `parse_recommendations`) | A change applied to the wrong words, or twice, edits a person's document; the wrong threads feed the model. | `test_document_revision_properties.py` (6 tests), `test_document_revision_survivors.py` (example tests per survivor) | 961 of 968 killed, 7 equivalent; one bug found and fixed (7.01.02) |
| 3 | Project access (`lambda/shared/project_access.py`: `resolve_access`, `required_level`, `project_route`, `validate_*`, `caller_from_claims`, `public_members`) | A token that administers, a viewer who edits, or a private project a stranger can read is a leak. | `test_project_access_properties.py` (20 tests) | 398 of 401 killed, 3 equivalent |
| 4 | MCP tool names and routing (`lambda/shared/mcp_global_tools.py`: `resolve_tool`, `RENAMED`, `TOOLS`) | A renamed or unknown call that runs the wrong tool, or with rewritten arguments, acts on the wrong thing. | `test_mcp_global_tools_properties.py` (5 tests); the fixed catalogue is pinned by `test_mcp_global_tools_mutation.py`, the 10,000-token budget by `test_mcp_global_tools_budget.py`; `test_mcp_global_tools_survivors.py` (16) | 1047 of 1050 killed, 3 equivalent |
| 5 | Revise provenance: `pass_llm_metadata`, `writing_outcome` (`document_revision.py`) | The record of which model wrote a version is the audit trail. | `test_revise_provenance_properties.py` (4 tests); the refusals word for word in `test_document_revision_survivors.py` | with component 2 |
| 6 | Prototype versions and Back to vN (`prototype_versions.py`: `_is_inline_html`, `put_prototype_html`, `version_from_html`, `restore_prototype_version`, `save_walkthrough`) | The Back to vN button must match what the server accepts; a version's object and row are what a tester sees. | `test_prototype_versions_properties.py` (5), `test_prototype_versions_survivors.py` (19, one property over generated source rows) | 378 of 381 killed, 3 equivalent |
| 7 | Feedback-incorporate selection (`prototype_incorporation.py`: which pins a pass takes, the outcomes it accepts, marks and replies once per draft and pin; `prototype_feedback.py`: grouping pins into items by place, their order, the partial read) | A pass that acts on another series' pins, or answers a pin twice, changes what testers see; a wrong grouping hides feedback. | `test_prototype_incorporation_properties.py` (18), `test_prototype_feedback_properties.py` (11) | incorporation 358 of 359, feedback 527 of 528; 1 equivalent each |
| 8 | Project export (`scripts/project_bundle/exporter.py`) | Export must carry every document and nothing of another project. | `test_project_bundle_exporter_properties.py` (10: prefix-colliding project ids, paged and consistent reads, avatars, credentials never exported), `test_project_bundle_exporter_survivors.py` (5) | 426 of 426 killed (on the fixed stage, see "The export"); 16 hand mutants first: 6 killed by the old test, 16 by the new |
| 9 | Sections grouping (`lambda/shared/document_sections.py`: `SECTION_ORDER`, `document_section`, `row_section`) | Ordering and grouping decide what a reader sees as one piece. | `test_document_sections_properties.py` (8) | 54 of 54 killed before the properties (they pin the rules in words) |

Every component has property tests and a mutation run.

## Mutation runs

Each run is `bash scripts/mutate-python.sh <module> <tests...>` from `voc-datalake/` (mutmut 3.8.1, with
`PYTHON_BIN` set to the venv's python), once with the module's existing tests ("before") and once with its
`*_properties.py` added ("after"); every survivor of the "after" run is read and either killed by a new test or
listed below as equivalent with its proof. Under mutmut the properties run derandomized with no example database
(`lambda/shared/test/property_settings.py`), so a score does not move between two runs of one tree.

| Module | Mutants | Before: killed / survived / timeout | After: killed / survived / timeout | Survivors left |
|---|---|---|---|---|
| `project_access.py` | 401 | 396 / 5 / 0 | 398 / 3 / 0 | 3, all equivalent (below) |
| `document_revision.py` | 953, then 968 | 862 / 91 / 0 | 863 / 90 / 0 with the properties; 961 / 7 / 0 with the survivor tests and the two changes of 7.01.02 | 7, all equivalent (below) |
| `document_versions.py` lines 1-727 | 1046 | 1029 / 14 / 3 | 1032 / 10 / 4 | the 4 timeouts were the fill loops (escalated, bounded in 7.01.03) |
| `document_versions.py` lines 728-end | 1500 | 1434 / 21 / 0, 45 with no test | 1496 / 4 / 0 | |
| `document_versions.py` whole, bounded fill | 2569 | (2528 / 14 / 4 over both slices) | 2555 / 14 / 0 | 14, all equivalent (below) |
| `scripts/project_bundle/exporter.py` | 426 | (not run: the old stage) | 426 / 0 / 0 | none |
| `mcp_global_tools.py` | 1050 | 1023 / 27 / 0 | 1047 / 3 / 0 | 3, all equivalent |
| `prototype_versions.py` | 381 | 339 / 42 / 0 | 378 / 3 / 0 | 3, all equivalent |
| `prototype_incorporation.py` | 359 | 326 / 33 / 0 | 358 / 1 / 0 | 1, equivalent |
| `prototype_feedback.py` | 528 | 493 / 23 / 0, 12 with no test | 527 / 1 / 0 | 1, equivalent |
| `document_sections.py` | 54 | 54 / 0 / 0 | 54 / 0 / 0 | none |

The `document_versions.py` runs (before the testable-voc-wiki rewrite of its fill loops, which is in the same
commit and carries its own numbers in `docs/mutation-notes-testable-voc-wiki.md`) used `test_document_versions.py`,
both `test_document_versions_mutation_*.py`, `test_document_versions_properties.py`, `test_document_series.py`,
`test_document_series_identity.py`, `test_document_history_mutation.py` and `test_project_bundle_scripts.py`, then
also `test_document_versions_series_properties.py` and `test_document_versions_survivors.py`. The other modules' test
files are the module's own tests plus the `lambda/api/test` and `lambda/jobs` suites that import it (listed in the
session report), then the new files.

**The export.** `mutate-python.sh` copied only `lambda/` and `plugins/` into its stage and linked the rest, so a
module under `scripts/` would have been mutated in the real tree. The script is fixed in the same commit
(testable-voc-wiki, `docs/mutation-notes-testable-voc-wiki.md`: it copies the module's own top folder and refuses
when the mutants would land in the tree); on the fixed stage `exporter.py` scores 426 of 426 with
`test_project_bundle_scripts.py` and the two new files. Before that: 16 hand mutants on the statements the old
test missed (a prefix-colliding project id taking another project's threads or pages, an inconsistent read, one page
of a paged read, a credential's avatar, pin forms not filtered, `--all` listing fixtures, only the first project
checked, any S3 error read as a missing object, members out of order): 6 killed by the old test, all 16 by the new.

The `document_revision.py` runs used `test_document_revision.py`, `test_document_history_mutation.py` and
`lambda/api/test/test_document_review_routes.py`, then those plus `test_document_revision_properties.py` and
`test_revise_provenance_properties.py`, then also `test_document_revision_survivors.py`. The last run is on the
changed module (7.01.02: `_only_place`, and `apply_changes` refusing two overlapping changes; their new mutants
are all killed). The second change answers the coordinator's review (2026-11-14) of two mutants first called
equivalent (the sort without its key): `apply_changes` is public and did not check that its changes are disjoint, so
two changes at one start told the mutant apart (a `TypeError`). It now refuses them by name.

`project_access.py`: the properties as first written killed none of the five survivors; two new property
classes did: a token's and an agent's caller have `is_admin` exactly `False` (killed `is_admin=None`), and the
member list sorts by the lower-case username (killed `.lower()` to `.upper()`, which reorders `ann_b` and `AnnZ`).

**Hand-made mutants (the first session, before mutmut could run).** Six hand-made mutants were applied to the product code, one at a time, and each was
run against the new property file that covers it; each was reverted and `git diff` on the product code is empty:

| Mutant | Module | Killed by |
|---|---|---|
| `apply_changes` sorts ascending, so earlier offsets move | `document_revision.py` | `test_applying_the_kept_changes_replaces_each_quote_where_it_stands` |
| a quote that occurs twice is kept (`count(before) < 1`) | `document_revision.py` | `test_only_grounded_disjoint_changes_are_kept_and_the_rest_are_counted`, `test_one_grounded_change_...` |
| a public project gives viewer, not editor | `project_access.py` | `test_a_public_project_is_at_least_editable_by_a_signed_in_caller` |
| a token may act as admin | `project_access.py` | `test_a_delegated_caller_is_never_owner_or_admin` |
| a renamed call drops its arguments | `mcp_global_tools.py` | `test_the_old_generate_keeps_its_other_steps_on_generate` and the rename property |
| version allocation ignores the numbers already used | `document_versions.py` | `test_every_document_gets_a_distinct_positive_version_and_its_canonical_title` |

These are not a mutmut score; the table above is.

## Equivalent-mutant ignore list

None is marked `# pragma: no mutate` (a pragma is product code, and an equivalent mutant stands here only with its
proof and an Opus review, ~/briefs/escalations.md). Each one below is escalated for a rewrite that removes the redundant code, so no mutant sits on it:

| Mutant | Change | Why it is equivalent |
|---|---|---|
| `project_access.x_caller_from_claims__mutmut_30` | drops `is_admin=False` from the `mcp:` caller | `Caller.is_admin` defaults to `False` (a dataclass field default, which mutmut does not mutate) |
| `project_access.x__agent_caller__mutmut_29` | drops `is_admin=False` from the agent caller | the same default |
| `project_access.x__base_role__mutmut_16` | looks the subject up even when it is empty | `project_members()` drops every entry with an empty sub, so `.get('')` is always `None` |
| `document_revision.x_user_prompt__mutmut_15`, `_18`, `_19` | `zip(..., strict=True)` becomes `strict=None`, drops `strict`, or `strict=False` | `refs` is built from the same `threads` sequence, one `T<n>` key per thread, so both sides always have the same length and `strict` never fires |
| `document_revision.x__is_new__mutmut_17`, `_20`, `_23` | the same three changes to `zip(saved.count(after), edited.count(after), strict=True)` | `_Texts.count` always returns a pair, so both sides always have two items |
| `document_versions.x_split_versioned_title__mutmut_26`, `x_series_base_title__mutmut_12` | `rstrip` becomes `lstrip` on the slice before a suffix | the cleaned title has no leading space and single spaces, and the match starts on a space after a non-space, so the slice has no space at either end |
| `document_versions.x_series_base_title__mutmut_10` | `> 0` becomes `>= 0` for the label's match start | the label pattern starts with whitespace and a cleaned base never does, so a match cannot start at 0 |
| `document_versions.x_persist_legacy_document_versions__mutmut_21`, `_22`, `_30`, `_34`, `_35` | the `'Untitled'` fallback: four change only its case (`'untitled'`, `'UNTITLED'`, at both sites), one calls `normalized_base_title('Untitled', None)` | the fallback is only read through `normalized_base_title`, which casefolds it, so a case change gives the same key; with no document type no label is stripped, and `'Untitled'` has none to strip. The mutants that change the text itself (`'XXUntitledXX'`) are killed (checked by a run of lines 243-252) |
| `document_versions.x__acquire_legacy_migration__mutmut_33`, `_40`, `x_persist_versioned_document__mutmut_87`, `x__counter_moved__mutmut_8`, `x_series_head_version__mutmut_34` | `if counter` becomes `if counter or True` | `_get_item` always answers a dict; on `{}` the mutant reads `None` and `_positive_int(None)` is `None`, the else branch's value |
| `document_versions.x_series_head_version__mutmut_12` | the fallback base becomes `None` | it only feeds the part of the tuple `series_head_version` throws away |
| `mcp_global_tools.x__feature_requests__mutmut_7`, `x__get_document__mutmut_7` | an `args` passed on becomes `None` | the callee ignores it (`stripped(payload, _args)`, `_get_project(_args, project)`) |
| `mcp_global_tools.x__get_metrics__mutmut_59` | `key or ''` becomes `key or 'XXXX'` | `text_arg(..., required=True)` refused a missing or blank key just before |
| `prototype_versions.x_put_prototype_html__mutmut_21`, `x_read_prototype_html__mutmut_15` | `'utf-8'` becomes `'UTF-8'` | codec names are case-insensitive: the same codec |
| `prototype_versions.x__is_inline_html__mutmut_6` | the 200-character window becomes 201 | the longest opener is 14 characters, `lower()` maps each character in order, so any window of 14 or more gives the same answer (13 is killed) |
| `prototype_incorporation.x_parse_pin_outcomes__mutmut_4` | `raw or ''` becomes `raw or 'XXXX'` | neither text holds an outcomes block, so the search answers no match either way |
| `prototype_feedback.x__new_item__mutmut_15` | a new item's `count` starts at 1, not 0 | `group_pins`, its only caller, sets `count = len(pin_ids)` before anything reads it |
| `document_revision.x_run_revision__mutmut_37` | the `or ''` fallback for a missing `content` becomes `or 'XXXX'` | `require_revisable`, called just before, has already refused a document without content |

The Caller default that the first two rest on is pinned by a test (`test_a_caller_built_without_is_admin_is_not_an_admin`),
and the explicit `is_admin=False` stays in the code (the coordinator's review, 2026-11-14: defence in depth for a
trust field).

## Findings

- **Bug, fixed in 7.01.03: a stored version of an odd digit broke every read of its project.** `_positive_int`
  took a text version when `str.isdigit()` said so, then `int()` raised on a superscript or circled digit (`'²'`,
  `'①'`). It now asks `str.isdecimal()`, the digits `int()` parses. Test first: `TestAStoredVersionOfOddDigitsIsIgnored`.
- **Bug, not fixed (handed on): a title that ends in two "(vN)" suffixes changes series between write and read.**
  `Plan (v2) (v3)` is stored under the base `Plan (v2)` (key `plan (v2)`) but read back under `plan`, so next to a
  real `Plan` its version can move. A fix strips every trailing suffix, server and frontend (`documentSeriesKey`), and
  changes the series key of rows already stored: the area's and the owner's call. Pinned by a strict xfail,
  `TestATitleThatEndsInTwoVersionsKeepsOneSeries`.
- **Not a bug today:** `versioned_document_id` joins its parts with an unescaped `|`; real project and job ids are hex.
- **Export:** the comment and live-project scans read without `ConsistentRead` while every key read is consistent, so
  a comment written a moment before an export can be missed; an explicit `--project <verification fixture>` is
  exported (only `--all` skips fixtures). Both written down for the export's owner.

- **Bug, fixed in 7.01.02: an overlapping repeat counted as one place.** Revise from comments kept a change only
  when its quote "occurs once", but counted with `str.count`, which does not see overlapping places: `aa` in `aaa`
  counted once, so an ambiguous quote was kept and applied at its first place. The surviving mutant
  `x__grounded__mutmut_25` (`index` to `rindex`, which differ only for such a quote) showed it. The draft's
  `isOutOfDate` (frontend) counted the same way and is fixed with it. Tests first:
  `TestAQuoteThatOccursTwiceIsDroppedEvenWhenTheTwoOverlap` and the frontend case in `reviseChanges.test.ts`.

- **Edge in series keys (not fixed, not asserted):** a title whose text holds a copied "(vN)" before its own type
  label, such as `Checkout (v2) — PRD`, is a different series from `Checkout`, because only a terminal "(vN)" is
  read and the label is removed after that. The display titles the module builds always end in "(vN)", so this
  arises only from typed text. The properties avoid the case (the generators keep "(v2)" out of a series' base).
  Whether it should join the series is an owner decision; logged here, no BF row (this repo has no BF table).
- **Only one trailing type label leaves a series key:** `Plan — PRD` and `Plan — PRD — PRD` are two series for a
  PRD (`series_base_title` drops one own-type label). A title the module builds never doubles the label, so this
  too arises only from typed text; the series generator keeps a base that already ends in its own label out.
- **Canonical titles replace a base's own terminal version** (`canonical_document_title('Checkout (v2)', 3)` is
  `Checkout (v3)`). This is the designed behaviour and is now pinned by a test, not a bug.

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
| 1 | Document versions and titles (`lambda/shared/document_versions.py`: `split_versioned_title`, `canonical_document_title`, `series_base_title`, `normalize_document_versions`) | A wrong version files a document under the wrong number or merges two series; the title is what the page and the MCP tools show. | `test_document_versions_properties.py` (6 tests; the fixed refusals are in `test_document_versions_mutation_1_727.py`) | open |
| 2 | Revise from comments: thread selection, grounding and applying changes (`lambda/shared/document_revision.py`: `select_threads`, `ground_changes`, `apply_changes`, `parse_recommendations`) | A change applied to the wrong words, or twice, edits a person's document; the wrong threads feed the model. | `test_document_revision_properties.py` (6 tests) | 862 -> 863 of 953 killed; 90 survivors open |
| 3 | Project access (`lambda/shared/project_access.py`: `resolve_access`, `required_level`, `project_route`, `validate_*`, `caller_from_claims`, `public_members`) | A token that administers, a viewer who edits, or a private project a stranger can read is a leak. | `test_project_access_properties.py` (20 tests) | 398 of 401 killed, 3 equivalent |
| 4 | MCP tool names and routing (`lambda/shared/mcp_global_tools.py`: `resolve_tool`, `RENAMED`, `TOOLS`) | A renamed or unknown call that runs the wrong tool, or with rewritten arguments, acts on the wrong thing. | `test_mcp_global_tools_properties.py` (5 tests); the fixed catalogue is pinned by `test_mcp_global_tools_mutation.py`, the 10,000-token budget by `test_mcp_global_tools_budget.py` | open |
| 5 | Revise provenance: `pass_llm_metadata`, `writing_outcome` (`document_revision.py`); `revise_document`'s refused codes not yet | The record of which model wrote a version is the audit trail. | `test_revise_provenance_properties.py` (4 tests); the refused codes not yet | with component 2 |
| 6 | Prototype versions and Back to vN (`prototype_versions.py`: `_is_inline_html`; `version_from_html`, `restore_prototype_version` not yet) | The Back to vN button must match what the server accepts. | `test_prototype_versions_properties.py` (5 tests) | open |
| 7 | Feedback-incorporate selection (the threads and evidence a pass reads: `select_threads`, `read_evidence`) | Covered in part by component 2; the evidence scope is not yet a property. | partly (component 2) | - |
| 8 | Project export and erasure (`scripts/project-export.py`, `lambda/shared/project_writes.py`) | Export must carry every document and nothing of another project. | **not started** | - |
| 9 | Sections grouping (`lambda/shared/document_sections.py`: `SECTION_ORDER`, `document_section`, `row_section`) | Ordering and grouping decide what a reader sees as one piece. | **not started** | - |

Components 5 and 6 are partly covered; 7 to 9 are open. Component 7 is covered only by component 2's selection
properties.

## Mutation runs

Each run is `bash scripts/mutate-python.sh <module> <tests...>` from `voc-datalake/` (mutmut 3.8.1, with
`PYTHON_BIN` set to the venv's python), once with the module's existing tests ("before") and once with its
`*_properties.py` added ("after"); every survivor of the "after" run is read and either killed by a new test or
listed below as equivalent with its proof. Under mutmut the properties run derandomized with no example database
(`lambda/shared/test/property_settings.py`), so a score does not move between two runs of one tree.

| Module | Mutants | Before: killed / survived / timeout | After: killed / survived / timeout | Survivors left |
|---|---|---|---|---|
| `project_access.py` | 401 | 396 / 5 / 0 | 398 / 3 / 0 | 3, all equivalent (below) |
| `document_revision.py` | 953 | 862 / 91 / 0 | 863 / 90 / 0 (the first-session properties) | 90, open: the next slice |

The `document_revision.py` runs used `test_document_revision.py`, `test_document_history_mutation.py` and
`lambda/api/test/test_document_review_routes.py`, then those plus `test_document_revision_properties.py` and
`test_revise_provenance_properties.py`.

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

None is marked `# pragma: no mutate` (that would change product code, which this work does not own). Each one
below is escalated for a rewrite that removes the redundant code, so no mutant sits on it:

| Mutant | Change | Why it is equivalent |
|---|---|---|
| `project_access.x_caller_from_claims__mutmut_30` | drops `is_admin=False` from the `mcp:` caller | `Caller.is_admin` defaults to `False` (a dataclass field default, which mutmut does not mutate) |
| `project_access.x__agent_caller__mutmut_29` | drops `is_admin=False` from the agent caller | the same default |
| `project_access.x__base_role__mutmut_16` | looks the subject up even when it is empty | `project_members()` drops every entry with an empty sub, so `.get('')` is always `None` |

## Findings

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

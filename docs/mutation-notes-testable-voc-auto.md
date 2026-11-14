# Mutation notes: the engineering agents' code made testable (testable-voc-auto)

This is the follow-up to `docs/mutation-notes-mut-voc-auto.md`, "Survivors left for a rewrite": loops that a mutant
could keep from ending, and mutants that were called equivalent. For each module, the steps were:

1. Pin the module first: tests on real inputs, green on the old code.
2. Rewrite it with its behaviour unchanged: one refactor per commit, the suite green after each.
3. Mutate it again with `scripts/mutate-python.sh`, using the same tests as mut-voc-auto's runs plus the pins.

"Before" is mut-voc-auto2's last run (9332aa06). "After" is the run on this rewrite. Each module's row comes with its
own commit: the patch reader first, then the spend ledger, the broker and the run store.

| Module | The rewrite | Pins (written first) | Mutants: killed / survived / timeout, before -> after |
|---|---|---|---|
| `connectors/patches.py` | Every loop is bounded by its input. `_unquote`, `_quoted_end` and `parse` take at most one step per byte or line. `_hunk_lines` is one forward pass over the lines: the loop owns the line index, and a no-newline mark counts only right after a body line. `_binary` finds its data lines and its reverse part with one bounded search (`_first`) from one start index. `_varint` reads at most the delta's bytes and refuses one that is cut short. `_file`'s hunk loop is capped at the line count. Dead code is gone: the 512-character key bound in `WorkspacePatches._patch` (the longest own key the layout accepts is 497 characters, so the bound never decided), the `& 0xFF` after a three-digit octal escape (at most 0o377), and the repeated `key is not None` checks (now one condition). The codec names and the five text whitespace characters are module constants. The added lines' decode passes its codec and error handler positionally, so dropping either one fails. | `connectors/test/patch_corpus.py`: 15 real `git diff --cached --binary` patches (quoted, spaced and tab paths, renames, modes, no-newline marks, binary literals and deltas) and git's own after-state of each. `connectors/test/test_patches_testable.py`. | 958 mutants: 938 / 10 / 10 -> 969 mutants: 969 / 0 / 0 |
| `spend.py` | `month_spend` has one bound, its own row count. The pages are read lazily, so `iter_query`'s `max_items` never decided. The flow's dollar total is `sum(by_model.values(), Usage()).usd`: it starts from an empty `Usage()` instead of an explicit `Decimal(0)`. | `test/test_spend_testable.py`: the pages read for each cap, no `Limit` of its own, the Decimal total. Then two missing tests the run asked for: `flow_month_usd`'s strongly consistent read, and a group summing its rows. | 593 mutants: 587 / 6 / 0 -> 587 mutants: 587 / 0 / 0 |

An independent review read every hunk. It also fuzzed the old and new parsers against each other on 200,000
generated line soups (no-newline marks two in a row and as a hunk's first line, zero-count hunks, binary parts with
no data, quotes and escapes cut short). There were no differences in results, exception types or messages.

The score is partly helped by moving the codec names and whitespace characters to module constants, which mutmut
does not mutate. Each one is pinned by a test, so a wrong value still fails: U+0085 and U+001C are not text, and an
added line's bad bytes are replaced.

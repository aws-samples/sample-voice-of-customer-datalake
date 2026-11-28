---
item: 7.109.01
test: voc-datalake/lambda/shared/test/test_product_extract_validation.py::TestTheArray::test_each_entry_is_read_as_its_fields_and_a_field_with_none_is_a_gap
digest: 2e51c649f9b1b703f0889736327a6b1ab20ee92d5b1e6b651202107e1c402d37
verdict: ACCEPT
evaluator: voc-e7109-01/evaluator
author: voc-p7109-01/author
sha: b9208710c8f5cc70349503d564c7db398d5b2b77
tree: d8e9012ed0d371596f8044961a2a14a13ed737e3
checks:
  tests_item: true
  real_path: true
  fails_on_break: true
  not_tautology: true
  stable_3x: true
  runs_in_gate: true
---

## Item

With the smaller schema the model answers `fields` as an array of entries, each naming its field. The extract's
validation (`shared/product_extract.py` `validated`) must read each entry as the field it names, keep every other
check as before, and treat a field with no entry as a gap. Otherwise a valid answer in the new shape would come back
as 12 gaps, and the proposal would be empty.

## Command

```bash
bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake -p no:cacheprovider --no-cov -q voc-datalake/lambda/shared/test/test_product_extract_validation.py::TestTheArray::test_each_entry_is_read_as_its_fields_and_a_field_with_none_is_a_gap
```

Every run below is this command, run from the root of a scratch copy of the staged tree (`git archive
d8e9012ed0d371596f8044961a2a14a13ed737e3` into `<scratch>`, its `voc-datalake/.venv` a link to the worktree's
`<venv>`), prefixed with `nice -n 10`. The shared worktree was not edited.

## Break

In the scratch copy, `validated` reads `fields` as 7.104.00 did: as a map keyed by field name, and anything else as
no field at all. The new `_entries` reading of the array is bypassed.

```diff
diff --git a/voc-datalake/lambda/shared/product_extract.py b/voc-datalake/lambda/shared/product_extract.py
--- a/voc-datalake/lambda/shared/product_extract.py
+++ b/voc-datalake/lambda/shared/product_extract.py
@@ -468,7 +468,7 @@
     """The answer's 12 fields and its questions, checked against the sources sent and the form as it was: a field
     the answer has no entry for is a gap."""
     by_id = {source.source_id: source for source in sources}
-    answered = _entries(raw.get('fields'))
+    answered = raw.get('fields') if isinstance(raw.get('fields'), Mapping) else {}
     fields = {name: _field(name, answered.get(name), by_id, state) for name in FIELD_ORDER}
     return fields, _questions(raw.get('questions'), fields)
 
```

## Red

Both entries of the array are lost, and the two fields come back empty:

```
collected 1 item

voc-datalake/lambda/shared/test/test_product_extract_validation.py F     [100%]

=================================== FAILURES ===================================
_ TestTheArray.test_each_entry_is_read_as_its_fields_and_a_field_with_none_is_a_gap _
voc-datalake/lambda/shared/test/test_product_extract_validation.py:147: in test_each_entry_is_read_as_its_fields_and_a_field_with_none_is_a_gap
    assert (fields['one_liner']['value'], fields['product_name']['value']) == ('Orbit plans team trips', 'Orbit')
E   AssertionError: assert ('', '') == ('Orbit plans...ips', 'Orbit')
E     
E     At index 0 diff: '' != 'Orbit plans team trips'
E     Use -v to get more diff
=========================== short test summary info ============================
FAILED voc-datalake/lambda/shared/test/test_product_extract_validation.py::TestTheArray::test_each_entry_is_read_as_its_fields_and_a_field_with_none_is_a_gap
============================== 1 failed in 5.80s ===============================
```

## Green

After `product_extract.py` was copied back and `cmp` showed it byte-identical to the staged blob:

```
collected 1 item

voc-datalake/lambda/shared/test/test_product_extract_validation.py .     [100%]

============================== 1 passed in 4.08s ===============================
```

```
collected 1 item

voc-datalake/lambda/shared/test/test_product_extract_validation.py .     [100%]

============================== 1 passed in 5.87s ===============================
```

```
collected 1 item

voc-datalake/lambda/shared/test/test_product_extract_validation.py .     [100%]

============================== 1 passed in 15.13s ==============================
```

## Reasons

- **Tests the item.** The answer is an array of two entries (`one_liner`, `product_name`) in the shape the new
  schema asks for. The test checks three things: all 12 fields come back in the form's order, the two named fields
  carry the values the entries gave ('Orbit plans team trips', 'Orbit'), and every other field is a gap. That is
  the release's rule: a field's entry is read by its name, and a field with no entry is a gap. The other checks keep
  running on the way: the first entry's quote is verified against the deck source, so it stays `proposed`.
- **Real path.** The product's own `validated` runs, with `_entries` and `_field` and the citation check. The
  sources are in-memory `Source` values. There is no I/O to fake.
- **Not a tautology.** The expected values are the literal strings the test put in the answer. The gap set is the
  form's 12 fields minus the two answered. `FIELD_ORDER` is the form's field list: the specification of the output,
  not a value the code under test computes from its input.
- **Fails on the break.** With the 7.104.00 reading, the values are `('', '')` at line 147.
- **Stable.** Green 3/3 after the restore. No clock, sleep or I/O.
- **Runs in the gate.** `brief` resolved the node, its file holds no skip or xfail mark, and `check` (run after
  `accept`) reports no problem for this test.

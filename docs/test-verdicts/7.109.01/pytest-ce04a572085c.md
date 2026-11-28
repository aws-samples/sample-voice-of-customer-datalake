---
item: 7.109.01
test: voc-datalake/lambda/shared/test/test_product_extract.py::TestThePrompt::test_the_schema_stays_small_enough_for_bedrock_to_compile
digest: 27b5a1286bffb449cec6ec3d80b786b8c3980feac85fe97cb0f159d827b037b8
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

The product extract failed on Bedrock before any token, on every model, with "The compiled grammar is too large":
7.104.00's answer schema named the 12 field objects with their citations, about 8.5k characters. In 7.109.01 the
answer's `fields` is an array of entries, each naming its field (`shared/product_extract.py` `proposal_schema`, about
1.4k characters), which Bedrock compiles. This test keeps the schema under a size bound so the refused shape cannot
come back.

## Command

```bash
bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake -p no:cacheprovider --no-cov -q voc-datalake/lambda/shared/test/test_product_extract.py::TestThePrompt::test_the_schema_stays_small_enough_for_bedrock_to_compile
```

Every run below is this command, run from the root of a scratch copy of the staged tree (`git archive
d8e9012ed0d371596f8044961a2a14a13ed737e3` into `<scratch>`, its `voc-datalake/.venv` a link to the worktree's
`<venv>`), prefixed with `nice -n 10`. The shared worktree was not edited.

## Break

In the scratch copy, `proposal_schema` gets back 7.104.00's body: `fields` is an object of 12 named field entries,
with `current_state`'s lifecycle states as an enum, the form HEAD (7.109.00) holds.

```diff
diff --git a/voc-datalake/lambda/shared/product_extract.py b/voc-datalake/lambda/shared/product_extract.py
--- a/voc-datalake/lambda/shared/product_extract.py
+++ b/voc-datalake/lambda/shared/product_extract.py
@@ -366,15 +366,20 @@
     citation = {'type': 'object', 'additionalProperties': False, 'required': ['source_id', 'quote', 'page'],
                 'properties': {'source_id': _string(), 'quote': _string(),
                                'page': {'anyOf': [{'type': 'integer'}, {'type': 'null'}]}}}
-    entry = {'type': 'object', 'additionalProperties': False,
-             'required': ['field', 'status', 'value', 'citations', 'confidence', 'note'],
-             'properties': {'field': _string(enum=list(FIELD_ORDER)), 'status': _string(enum=list(FIELD_STATUSES)),
-                            'value': _string(), 'citations': {'type': 'array', 'items': citation},
-                            'confidence': _string(enum=list(CONFIDENCES)), 'note': _string()}}
+
+    def entry(value: dict[str, Any]) -> dict[str, Any]:
+        return {'type': 'object', 'additionalProperties': False,
+                'required': ['status', 'value', 'citations', 'confidence', 'note'],
+                'properties': {'status': _string(enum=list(FIELD_STATUSES)), 'value': value,
+                               'citations': {'type': 'array', 'items': citation},
+                               'confidence': _string(enum=list(CONFIDENCES)), 'note': _string()}}
+    fields = {name: entry(_string(enum=[*LIFECYCLE_STATES, '']) if name == CURRENT_STATE else _string())
+              for name in FIELD_ORDER}
     question = {'type': 'object', 'additionalProperties': False, 'required': ['field', 'question'],
                 'properties': {'field': _string(enum=list(FIELD_ORDER)), 'question': _string()}}
     return {'type': 'object', 'additionalProperties': False, 'required': ['fields', 'questions'],
-            'properties': {'fields': {'type': 'array', 'items': entry},
+            'properties': {'fields': {'type': 'object', 'additionalProperties': False, 'required': list(FIELD_ORDER),
+                                      'properties': fields},
                            'questions': {'type': 'array', 'items': question}}}
 
 
```

## Red

The schema measures 8,506 characters, the 8.5k the CHANGELOG names for the refused shape:

```
collected 1 item

voc-datalake/lambda/shared/test/test_product_extract.py F                [100%]

=================================== FAILURES ===================================
___ TestThePrompt.test_the_schema_stays_small_enough_for_bedrock_to_compile ____
voc-datalake/lambda/shared/test/test_product_extract.py:240: in test_the_schema_stays_small_enough_for_bedrock_to_compile
    assert len(json.dumps(extract.proposal_schema())) < 2500
E   assert 8506 < 2500
E    +  where 8506 = len('{"type": "object", "additionalProperties": false, "required": ["fields", "questions"], "properties": {"fields": {"typ...iators", "known_limitations", "non_goals", "success_metrics", "free_form_notes"]}, "question": {"type": "string"}}}}}}')
E    +    where '{"type": "object", "additionalProperties": false, "required": ["fields", "questions"], "properties": {"fields": {"typ...iators", "known_limitations", "non_goals", "success_metrics", "free_form_notes"]}, "question": {"type": "string"}}}}}}' = <function dumps at 0x1063a1010>({'type': 'object', 'additionalProperties': False, 'required': ['fields', 'questions'], 'properties': {'fields': {'type...: ['field', 'question'], 'properties': {'field': {'type': 'string', 'enum': [...]}, 'question': {'type': 'string'}}}}}})
E    +      where <function dumps at 0x1063a1010> = json.dumps
E    +      and   {'type': 'object', 'additionalProperties': False, 'required': ['fields', 'questions'], 'properties': {'fields': {'type...: ['field', 'question'], 'properties': {'field': {'type': 'string', 'enum': [...]}, 'question': {'type': 'string'}}}}}} = <function proposal_schema at 0x108b18eb0>()
E    +        where <function proposal_schema at 0x108b18eb0> = extract.proposal_schema
=========================== short test summary info ============================
FAILED voc-datalake/lambda/shared/test/test_product_extract.py::TestThePrompt::test_the_schema_stays_small_enough_for_bedrock_to_compile
============================== 1 failed in 4.37s ===============================
```

## Green

After `product_extract.py` was copied back and `cmp` showed it byte-identical to the staged blob:

```
collected 1 item

voc-datalake/lambda/shared/test/test_product_extract.py .                [100%]

============================== 1 passed in 4.44s ===============================
```

```
collected 1 item

voc-datalake/lambda/shared/test/test_product_extract.py .                [100%]

============================== 1 passed in 4.30s ===============================
```

```
collected 1 item

voc-datalake/lambda/shared/test/test_product_extract.py .                [100%]

============================== 1 passed in 3.23s ===============================
```

## Reasons

- **Tests the item.** Bedrock refused the schema because of its size, and the fix is a smaller schema. The test
  serialises the real `proposal_schema()` and requires it to stay under 2,500 characters. The staged schema measures
  1,433; 7.104.00's measures 8,506. The bound sits between the shape Bedrock accepted (about 1.4k) and the smallest
  refused variant the test's comment records (7.2k). The grammar compiler can only be exercised live, so a size
  bound is a proxy: a schema under 2,500 characters that Bedrock still refused would pass it. As an offline
  regression guard for this refusal it is the right pin. Its neighbour
  (`test_the_schema_is_an_array_of_entries_each_naming_its_field_and_allowing_nothing_else`) checks that the request
  carries exactly this schema and pins its array shape. The live acceptance (Sonnet 5.5, effort max) is the author's
  recorded measurement, not something this test runs.
- **Real path.** The product's own `proposal_schema` runs. Nothing is faked: it is a pure function.
- **Not a tautology.** 2,500 is a literal. The length is measured from the product's output, not computed by it.
- **Fails on the break.** `assert 8506 < 2500` fails at line 240 once the 7.104.00 shape is back.
- **Stable.** Green 3/3 after the restore. No clock, sleep or I/O.
- **Runs in the gate.** `brief` resolved the node, its file holds no skip or xfail mark, and `check` (run after
  `accept`) reports no problem for this test.

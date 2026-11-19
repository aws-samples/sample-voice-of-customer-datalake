"""The logic operators the server admits per question type must match the JSON the builder and the dev mock read.

`schemas/form-logic-ops.json` is what the builder's validator and its op choices are held to
(frontend/src/pages/FeedbackForms/model/logicOps.ts) and what the dev mock refuses by (frontend/mock-forms-v2.js);
`OPS_BY_TYPE` in `shared/forms_v2.py` is what a save is refused by. `schemas/` is not bundled into the Lambdas, so
the two are copies: an op the server stops taking (or a type it adds) changed on one side alone would let the
builder write a rule the server refuses, as the templates' consent rule `equals false` was (a 400 on
"Use this template", found on a real deployment because the mock took it).
"""
import json

import pytest

from shared import forms_v2 as fv2
from shared.exceptions import ValidationError
from shared.test.repo_paths import repo_root

FIXTURE = repo_root() / 'schemas' / 'form-logic-ops.json'


@pytest.fixture(scope='module')
def ops_by_type() -> dict[str, list[str]]:
    # (no skip on a missing file: the fixture is the half this guard compares with, repo_paths.py)
    return json.loads(FIXTURE.read_text(encoding='utf-8'))['ops_by_type']


class TestLogicOpsLockstep:
    def test_the_fixture_is_present(self):
        assert FIXTURE.is_file(), f'{FIXTURE} is the other half of this pin'

    def test_every_type_admits_the_same_ops(self, ops_by_type):
        assert {kind: frozenset(ops) for kind, ops in ops_by_type.items()} == dict(fv2.OPS_BY_TYPE)

    def test_it_names_every_question_type_once_in_the_servers_order(self, ops_by_type):
        assert tuple(ops_by_type) == fv2.QUESTION_TYPES

    def test_each_list_is_sorted_as_the_refusal_names_them(self, ops_by_type):
        # (the 400 lists them sorted: the mock writes its message from these lists as they are)
        assert all(ops == sorted(set(ops)) for ops in ops_by_type.values())

    def test_a_consent_compares_no_value(self, ops_by_type):
        # Accepted is `submitted`, not accepted (an unticked box, which is no answer) is `skipped`.
        assert ops_by_type['consent'] == ['skipped', 'submitted']
        definition = {'language': 'en', 'languages': ['en'], 'welcome': {'enabled': False}, 'hidden_fields': [],
                      'endings': [{'id': 'end_thanks', 'title': {'en': 'Thanks'}}], 'questions': [
                          {'id': 'q_ok', 'type': 'consent', 'headline': {'en': 'May we contact you?'},
                           'required': False, 'label': {'en': 'Yes'},
                           'logic': [{'when': {'op': 'equals', 'value': False}, 'then': {'jump_to': 'end_thanks'}}]}]}
        with pytest.raises(ValidationError,
                           match=r'questions\[0\]\.logic\[0\]\.when\.op must be one of skipped, submitted for a consent'):
            fv2.validate_definition(definition)

"""`shared/ai_writing.py`: who may have the AI write a PR/FAQ or PRD (docs/ways-of-working.md).

The rules matrix below is written out by hand from the doc's tables, not derived from
the code, so a change to the rules has to change this table too.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError

from shared import ai_mode, ai_writing
from shared.exceptions import AuthorizationError

HD = ai_mode.AiMode('human_driven', frozenset())
HD_PRFAQ = ai_mode.AiMode('human_driven', frozenset({'prfaq'}))
HD_PRD = ai_mode.AiMode('human_driven', frozenset({'prd'}))
HD_BOTH = ai_mode.AiMode('human_driven', frozenset({'prfaq', 'prd'}))
AA = ai_mode.AiMode('ai_assisted', frozenset())
AA_BOTH = ai_mode.AiMode('ai_assisted', frozenset({'prfaq', 'prd'}))
AD = ai_mode.AiMode('ai_driven', frozenset())
MODES = {'HD': HD, 'HD+prfaq': HD_PRFAQ, 'HD+prd': HD_PRD, 'HD+both': HD_BOTH,
         'AA': AA, 'AA+both': AA_BOTH, 'AD': AD}
INTERACTIVE, AUTONOMOUS = 'interactive', 'autonomous'

# (mode, doc type) → (interactive allowed, autonomous allowed)
MATRIX: dict[tuple[str, str], tuple[bool, bool]] = {
    ('HD', 'prfaq'): (False, False),
    ('HD', 'prd'): (False, False),
    ('HD', 'custom'): (True, True),
    ('HD', 'prototype'): (True, True),
    ('HD', 'research'): (True, True),
    ('HD+prfaq', 'prfaq'): (True, False),
    ('HD+prfaq', 'prd'): (False, False),
    ('HD+prfaq', 'custom'): (True, True),
    ('HD+prfaq', 'prototype'): (True, True),
    ('HD+prfaq', 'research'): (True, True),
    ('HD+prd', 'prfaq'): (False, False),
    ('HD+prd', 'prd'): (True, False),
    ('HD+prd', 'custom'): (True, True),
    ('HD+prd', 'prototype'): (True, True),
    ('HD+prd', 'research'): (True, True),
    ('HD+both', 'prfaq'): (True, False),
    ('HD+both', 'prd'): (True, False),
    ('HD+both', 'custom'): (True, True),
    ('HD+both', 'prototype'): (True, True),
    ('HD+both', 'research'): (True, True),
    ('AA', 'prfaq'): (True, False),
    ('AA', 'prd'): (True, False),
    ('AA', 'custom'): (True, True),
    ('AA', 'prototype'): (True, True),
    ('AA', 'research'): (True, True),
    ('AA+both', 'prfaq'): (True, False),
    ('AA+both', 'prd'): (True, False),
    ('AA+both', 'custom'): (True, True),
    ('AA+both', 'prototype'): (True, True),
    ('AA+both', 'research'): (True, True),
    ('AD', 'prfaq'): (True, True),
    ('AD', 'prd'): (True, True),
    ('AD', 'custom'): (True, True),
    ('AD', 'prototype'): (True, True),
    ('AD', 'research'): (True, True),
}
CASES = [
    pytest.param(mode, doc_type, kind, allowed[index], id=f'{mode}-{doc_type}-{kind}')
    for (mode, doc_type), allowed in MATRIX.items()
    for index, kind in enumerate((INTERACTIVE, AUTONOMOUS))
]

HD_PRD_COACHING = ('You work Human-driven on PRDs: you write, the AI coaches. Use "Coach me" or '
                   '"Review my draft", or ask an administrator to unlock "PRD with AI".')
HD_PRFAQ_COACHING = ('You work Human-driven on PR/FAQs: you write, the AI coaches. Use "Coach me" or '
                     '"Review my draft", or ask an administrator to unlock "PR/FAQ with AI".')
AUTONOMOUS_PRD = ('Agents and plans write a PRD only for people working AI-driven. '
                  'Write it in the editor, or ask an administrator to change your way of working.')
UNREADABLE = 'Could not check your way of working with AI. Please retry.'


def _event(claims: Any) -> dict:
    return {'requestContext': {'authorizer': {'claims': claims}}}


def _table_with(item: dict | None) -> MagicMock:
    table = MagicMock()
    table.get_item.return_value = {'Item': item} if item is not None else {}
    return table


def _refusal(table: Any, subject: str, doc_type: object, kind: str) -> AuthorizationError:
    with pytest.raises(AuthorizationError) as caught:
        ai_writing.require_ai_writing(table, subject, doc_type, kind)
    return caught.value


class TestTheRules:
    @pytest.mark.parametrize(('mode', 'doc_type', 'kind', 'allowed'), CASES)
    def test_the_rules_matrix(self, mode: str, doc_type: str, kind: str, allowed: bool):
        assert ai_writing.allows(MODES[mode], doc_type, kind) is allowed

    @pytest.mark.parametrize(('mode', 'doc_type', 'kind', 'allowed'), CASES)
    def test_the_gate_raises_exactly_where_the_matrix_refuses(
            self, mode: str, doc_type: str, kind: str, allowed: bool):
        with patch.object(ai_mode, 'get_ai_mode', return_value=MODES[mode]):
            if allowed:
                assert ai_writing.require_ai_writing(MagicMock(), 'sub-ada', doc_type, kind) is None
            else:
                assert _refusal(MagicMock(), 'sub-ada', doc_type, kind).status_code == 403

    def test_the_matrix_covers_every_mode_and_document_type(self):
        doc_types = ('prfaq', 'prd', 'custom', 'prototype', 'research')
        assert set(MATRIX) == {(mode, doc_type) for mode in MODES for doc_type in doc_types}

    def test_only_prfaq_and_prd_are_gated(self):
        assert ai_writing.GATED_DOC_TYPES == ('prfaq', 'prd')
        assert [t for t in ('prfaq', 'prd', 'custom', 'prototype', 'research', 'decision', None, 7, 'PRD')
                if ai_writing.is_gated(t)] == ['prfaq', 'prd']

    @pytest.mark.parametrize('kind', ['', 'Interactive', 'agent', 'other'])
    def test_an_unknown_kind_is_treated_as_autonomous_for_an_assisted_person(self, kind: str):
        assert ai_writing.allows(AA, 'prd', kind) is False
        assert ai_writing.allows(HD_PRD, 'prd', kind) is False
        assert ai_writing.allows(AD, 'prd', kind) is True


class TestTheKindOfCall:
    @pytest.mark.parametrize(('claims', 'kind'), [
        ({'sub': 'sub-ada'}, INTERACTIVE),
        ({'sub': 'agent:ag_1'}, AUTONOMOUS),
        ({'sub': 'mcp:tok_1', 'voc:acting_subject': 'sub-ada'}, AUTONOMOUS),
        ({'sub': '  agent:ag_1 '}, AUTONOMOUS),
        ({'sub': 'sub-ada', 'voc:principal': 'plan:pl_1'}, AUTONOMOUS),
        ({'sub': 'sub-ada', 'voc:principal': ' plan:pl_1'}, AUTONOMOUS),
        ({'sub': 'sub-ada', 'voc:principal': 'sub-ada'}, INTERACTIVE),
        ({'sub': 'sub-ada', 'voc:principal': 'PLAN:pl_1'}, INTERACTIVE),
        ({'sub': 'sub-ada', 'voc:principal': ['plan:pl_1']}, INTERACTIVE),
        ({'sub': 'AGENT:ag_1'}, INTERACTIVE),
        ({'sub': 'agentx'}, INTERACTIVE),
        ({'sub': 'sub-ada', 'voc:acting_subject': 'agent:ag_1'}, INTERACTIVE),
        ({'sub': 7}, INTERACTIVE),
        ({}, INTERACTIVE),
    ])
    def test_the_kind_comes_from_the_claims(self, claims: dict, kind: str):
        assert ai_writing.writing_kind(_event(claims)) == kind

    @pytest.mark.parametrize('event', [
        {}, {'requestContext': None}, {'requestContext': {'authorizer': 'x'}}, _event('agent:ag_1'), _event(None)])
    def test_a_malformed_event_is_interactive(self, event: dict):
        assert ai_writing.writing_kind(event) == INTERACTIVE


class TestFailingClosed:
    @pytest.mark.parametrize('subject', ['', 'agent:ag_1', 'mcp:tok_1'])
    @pytest.mark.parametrize('kind', [INTERACTIVE, AUTONOMOUS])
    def test_no_person_to_evaluate_is_refused_without_reading(self, subject: str, kind: str):
        table = _table_with({'mode': 'ai_driven'})

        error = _refusal(table, subject, 'prd', kind)

        assert error.status_code == 403
        table.get_item.assert_not_called()

    @pytest.mark.parametrize('failure', [
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}}, 'GetItem'),
        BotoCoreError(),
    ])
    @pytest.mark.parametrize('kind', [INTERACTIVE, AUTONOMOUS])
    def test_an_unreadable_mode_row_refuses_with_a_retry_message(self, failure: Exception, kind: str):
        table = MagicMock()
        table.get_item.side_effect = failure

        error = _refusal(table, 'sub-ada', 'prfaq', kind)

        assert (error.status_code, error.message) == (403, UNREADABLE)
        assert error.__cause__ is failure

    def test_an_unexpected_error_is_not_swallowed_as_a_refusal(self):
        table = MagicMock()
        table.get_item.side_effect = RuntimeError('bug')

        with pytest.raises(RuntimeError):
            ai_writing.require_ai_writing(table, 'sub-ada', 'prd', INTERACTIVE)

    @pytest.mark.parametrize('doc_type', ['custom', 'prototype', 'research', None])
    def test_an_ungated_type_never_reads_and_never_refuses_even_without_a_person(self, doc_type: object):
        table = MagicMock()
        table.get_item.side_effect = BotoCoreError()

        assert ai_writing.require_ai_writing(table, '', doc_type, AUTONOMOUS) is None
        table.get_item.assert_not_called()

    def test_no_mode_row_is_ai_driven_and_allows_autonomous_writing(self):
        table = _table_with(None)

        assert ai_writing.require_ai_writing(table, 'sub-ada', 'prd', AUTONOMOUS) is None
        table.get_item.assert_called_once_with(
            Key={'pk': 'USERFLAGS#sub-ada', 'sk': 'ai_mode'}, ConsistentRead=True)

    def test_the_stored_row_of_the_subject_decides(self):
        table = _table_with({'mode': 'human_driven', 'ai_writing_prd': True})

        assert ai_writing.require_ai_writing(table, 'sub-ada', 'prd', INTERACTIVE) is None
        assert _refusal(table, 'sub-ada', 'prfaq', INTERACTIVE).message == HD_PRFAQ_COACHING


class TestTheRefusalTexts:
    def test_an_interactive_human_driven_refusal_coaches_and_names_the_unlock(self):
        assert _refusal(_table_with({'mode': 'human_driven'}), 'sub-ada', 'prd', INTERACTIVE).message == HD_PRD_COACHING

    def test_an_autonomous_refusal_says_agents_need_ai_driven(self):
        error = _refusal(_table_with({'mode': 'ai_assisted'}), 'sub-ada', 'prd', AUTONOMOUS)

        assert error.message == AUTONOMOUS_PRD
        assert error.message.startswith(ai_writing.AUTONOMOUS_REFUSAL_PREFIX)

    @pytest.mark.parametrize(('doc_type', 'label'), [('prfaq', 'PR/FAQ'), ('prd', 'PRD')])
    def test_every_autonomous_refusal_starts_with_the_prefix_the_agents_runtime_matches(
            self, doc_type: str, label: str):
        for table, subject in ((_table_with({'mode': 'human_driven'}), 'sub-ada'), (MagicMock(), 'agent:ag_1')):
            message = _refusal(table, subject, doc_type, AUTONOMOUS).message
            assert message.startswith(f'{ai_writing.AUTONOMOUS_REFUSAL_PREFIX} {label} ')

    def test_an_interactive_refusal_never_looks_like_an_autonomous_one(self):
        message = _refusal(_table_with({'mode': 'human_driven'}), 'sub-ada', 'prfaq', INTERACTIVE).message

        assert not message.startswith(ai_writing.AUTONOMOUS_REFUSAL_PREFIX)
        assert message == HD_PRFAQ_COACHING

    def test_a_missing_person_on_an_interactive_call_gets_the_coaching_text(self):
        assert _refusal(MagicMock(), '', 'prd', INTERACTIVE).message == HD_PRD_COACHING

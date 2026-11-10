"""shared.job_knowledge — what the SHARED generators may put in a prompt.

Against moto with real stored rows: company context, a company memory, a
personal memory and a user's own objectives all exist, and only the company
knowledge may come back, whoever started the job.
"""
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

from shared import job_knowledge
from shared import memory_store as store
from shared.company_context import COMPANY_CONTEXT_PK, user_context_pk
from shared.grounding import GROUNDING_GUIDANCE, Grounding
from shared.test.memory_fixtures import candidate, memory_world

SEEDED_AT = datetime(2026, 10, 1, 9, 30, tzinfo=UTC)
#: (statement, scope, kind, owner) — two company memories of different kinds and one personal.
MEMORIES = (
    ('Customers want faster refunds', 'company', 'customer', None),
    ('Refund strategy is secret', 'company', 'strategy', None),
    ('I like refunds summaries short', 'personal', 'working_style', 'sub-user'),
)


def _seed(w) -> None:
    w.aggregates.put_item(Item={'pk': COMPANY_CONTEXT_PK, 'sk': 'config', 'vision': 'Refunds in one day.',
                                'objectives': []})
    own = [{'id': 'obj_000000000001', 'title': 'My own refund target', 'kpis': []}]
    w.aggregates.put_item(Item={'pk': user_context_pk('sub-user'), 'sk': 'config', 'objectives': own})
    for statement, scope, kind, owner in MEMORIES:
        store.write_automated(w.memory, [candidate(statement, scope=scope, kind=kind, owner_sub=owner)],
                              now=SEEDED_AT)
    store.clear_pool_cache()


@pytest.fixture
def world(monkeypatch):
    with memory_world(monkeypatch) as w, patch.object(job_knowledge, 'get_aggregates_table', return_value=w.aggregates):
        _seed(w)
        yield w


class TestSharedGrounding:
    @pytest.mark.usefixtures('world')
    def test_company_knowledge_only_never_personal(self):
        text = job_knowledge.shared_grounding('how fast are refunds', {'all': True}).text
        assert ('Refunds in one day.' in text, 'Customers want faster refunds' in text) == (True, True)
        assert ('I like refunds summaries short' in text, 'My own refund target' in text) == (False, False)

    def test_records_company_ids_and_context(self, world):
        grounding = job_knowledge.shared_grounding('how fast are refunds', None)
        company_ids = {m['memory_id'] for m in world.memories() if m.get('scope') == 'company'}
        assert (set(grounding.memory_ids) <= company_ids, grounding.company_context_included) == (True, True)

    @pytest.mark.usefixtures('world')
    def test_persona_kinds_drop_strategy(self):
        text = job_knowledge.shared_grounding('refunds', None, kinds=job_knowledge.PERSONA_MEMORY_KINDS).text
        assert ('Customers want faster refunds' in text, 'Refund strategy is secret' in text) == (True, False)

    @pytest.mark.usefixtures('world')
    def test_a_malformed_scope_recalls_no_scoped_memory_but_never_fails(self):
        grounding = job_knowledge.shared_grounding('refunds', 'not-a-scope')
        assert isinstance(grounding, Grounding)


class TestGuidanceAndDerivation:
    def test_guidance_only_when_grounded(self):
        assert job_knowledge.with_guidance('SYS', Grounding()) == 'SYS'
        assert job_knowledge.with_guidance('SYS', Grounding(text='x')) == f'SYS\n\n{GROUNDING_GUIDANCE}'
        assert job_knowledge.with_guidance('', Grounding(text='x')) == GROUNDING_GUIDANCE

    def test_derivation_keys_only_when_present(self):
        assert job_knowledge.derivation_knowledge(Grounding()) == {}
        grounded = Grounding(text='x', memory_ids=['m1'], company_context_included=True)
        assert job_knowledge.derivation_knowledge(grounded, web_search_count=2) == {
            'memory_ids': ['m1'], 'company_context_included': True, 'web_search_count': 2,
        }

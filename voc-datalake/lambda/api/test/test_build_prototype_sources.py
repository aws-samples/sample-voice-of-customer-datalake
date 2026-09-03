"""
POST /projects/{id}/build-prototype — the source-document trust boundary (U25).

A build can name the PRD and PR/FAQ it should read, and the prototype a
revision is built on. Those ids arrive from the client and the documents they
name are read straight into a Bedrock prompt, so an id that resolved outside
this project would pull another project's document into this project's
generation.

Ownership and type are enforced by the key rather than by a check: `pk` is the
project and `sk` is `{TYPE}#{id}`. This file pins that, plus the reason the
validation happens here at all — an unresolvable id must cost a 4xx, not a
multi-minute billable build that fails at the end.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

PROJECT = 'proj_1'
OTHER_PROJECT = 'proj_2'
PATH = f'/projects/{PROJECT}/build-prototype'


@pytest.fixture
def build_prototype(api_gateway_event, lambda_context):
    """
    Call the endpoint with a projects table holding one PRD, one PR/FAQ and one
    prototype in THIS project, plus one prototype in a DIFFERENT project.

    Reads are answered on the whole composite key rather than on `sk` alone.
    That is what makes "a prototype belonging to another project" a distinct
    fixture from "no such prototype": keyed on `sk` only, the two would be the
    same table and the test could not tell a dropped partition key apart from a
    working one.

    Returns (response, job_config, table, invoke) where `job_config` is the
    doc_config handed to the generator, or None when no job was created.
    """
    def _call(body):
        from projects_handler import MAX_SELECTED_RESEARCH_IDS

        table = MagicMock()
        documents = {
            (f'PROJECT#{PROJECT}', 'PRD#prd_1'): {'document_id': 'prd_1'},
            (f'PROJECT#{PROJECT}', 'PRFAQ#prfaq_1'): {'document_id': 'prfaq_1'},
            (f'PROJECT#{PROJECT}', 'PROTOTYPE#proto_1'): {'document_id': 'proto_1'},
            (f'PROJECT#{PROJECT}', 'RESEARCH#research_a'): {'document_id': 'research_a'},
            (f'PROJECT#{PROJECT}', 'RESEARCH#research_b'): {'document_id': 'research_b'},
            # Enough DISTINCT research reports to fill a selection at the bound.
            # `['research_a'] * 10` dedupes to one, so a fixture at the bound built
            # from repeats would pass against an implementation that never accepted
            # more than a single id. `research_gone` stays absent from this dict on
            # purpose — it is the unresolvable fixture.
            **{
                (f'PROJECT#{PROJECT}', f'RESEARCH#research_{i}'): {'document_id': f'research_{i}'}
                for i in range(MAX_SELECTED_RESEARCH_IDS)
            },
            # Real prototype, wrong project. Only reachable by a lookup that
            # dropped `pk`.
            (f'PROJECT#{OTHER_PROJECT}', 'PROTOTYPE#proto_other'): {'document_id': 'proto_other'},
            # Same, for research: "belongs to another project" is a different
            # fixture from "does not exist" only while `pk` is part of the key.
            (f'PROJECT#{OTHER_PROJECT}', 'RESEARCH#research_other'): {'document_id': 'research_other'},
        }

        def get_item(Key=None, **kwargs):
            key = (Key or {})
            item = documents.get((key.get('pk', ''), key.get('sk', '')))
            return {'Item': item} if item else {}

        table.get_item.side_effect = get_item

        with patch('projects_handler.get_projects_table', return_value=table), \
                patch('projects_handler.create_job', return_value=('job_1', {})) as create_job, \
                patch('projects_handler.invoke_lambda_async') as invoke:
            from projects_handler import lambda_handler
            response = lambda_handler(
                api_gateway_event(method='POST', path=PATH, body=body, path_params={'project_id': PROJECT}),
                lambda_context,
            )
        config = create_job.call_args.args[3] if create_job.call_args else None
        return response, config, table, invoke

    return _call


class TestAimedBuildIsAccepted:
    def test_named_documents_reach_the_generator(self, build_prototype):
        response, config, _table, invoke = build_prototype(
            {'source_prd_id': 'prd_1', 'source_prfaq_id': 'prfaq_1'},
        )

        assert response['statusCode'] == 200
        assert config['source_prd_id'] == 'prd_1'
        assert config['source_prfaq_id'] == 'prfaq_1'
        # And the generator is told the same thing the job records.
        assert invoke.call_args.args[1]['doc_config']['source_prd_id'] == 'prd_1'

    def test_naming_nothing_leaves_both_slots_unaimed(self, build_prototype):
        """The pre-existing request shape. Both slots must come through as None so
        the generator falls back to latest-of-each, exactly as before."""
        response, config, _table, _invoke = build_prototype({'title': 'Prototype'})

        assert response['statusCode'] == 200
        assert config['source_prd_id'] is None
        assert config['source_prfaq_id'] is None

    def test_a_blank_id_is_not_a_choice(self, build_prototype):
        """A cleared picker sends '', which means "unaimed", not "document ''"."""
        response, config, _table, _invoke = build_prototype(
            {'source_prd_id': '', 'source_prfaq_id': '   '},
        )

        assert response['statusCode'] == 200
        assert config['source_prd_id'] is None
        assert config['source_prfaq_id'] is None

    def test_surrounding_whitespace_is_trimmed(self, build_prototype):
        response, config, _table, _invoke = build_prototype({'source_prd_id': ' prd_1 '})

        assert response['statusCode'] == 200
        assert config['source_prd_id'] == 'prd_1'


class TestUnresolvableIdIsRejectedBeforeAnyCost:
    def test_an_unknown_id_is_a_404_and_starts_no_job(self, build_prototype):
        """The whole reason to validate here rather than only in the generator:
        no job row, no generator invocation, no Bedrock spend."""
        response, config, _table, invoke = build_prototype({'source_prd_id': 'prd_nope'})

        assert response['statusCode'] == 404
        assert 'source_prd_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_a_prfaq_id_offered_as_a_prd_is_rejected(self, build_prototype):
        """`prfaq_1` is a real document in this project, just not a PRD. The `sk`
        prefix is what separates the two, so no type check is needed."""
        response, _config, _table, invoke = build_prototype({'source_prd_id': 'prfaq_1'})

        assert response['statusCode'] == 404
        invoke.assert_not_called()

    def test_lookups_only_ever_address_this_project(self, build_prototype):
        """The ownership property, asserted on the key that gets built: the
        supplied string reaches `sk` only, never `pk`."""
        _response, _config, table, _invoke = build_prototype(
            {'source_prd_id': '../PROJECT#victim/prd_1'},
        )

        keys = [call.kwargs.get('Key', {}) for call in table.get_item.call_args_list]
        assert keys, 'expected at least one keyed read'
        assert {k.get('pk') for k in keys} == {f'PROJECT#{PROJECT}'}
        assert keys[0]['sk'] == 'PRD#../PROJECT#victim/prd_1'

    @pytest.mark.parametrize('value', [
        pytest.param(['prd_1'], id='list'),
        pytest.param({'id': 'prd_1'}, id='object'),
        pytest.param(7, id='number'),
        pytest.param(True, id='bool'),
    ])
    def test_a_non_string_id_is_a_400(self, build_prototype, value):
        """JSON can deliver any of these. None of them can be a document id, and
        an f-string would happily interpolate every one into a key."""
        response, config, _table, invoke = build_prototype({'source_prd_id': value})

        assert response['statusCode'] == 400
        assert 'source_prd_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_an_absurdly_long_id_is_a_400_not_a_500(self, build_prototype):
        """A sort key is capped at 1024 bytes. Unbounded, this reaches DynamoDB
        and comes back as a ValidationException — a 500 for what is a bad
        request."""
        response, _config, table, _invoke = build_prototype({'source_prd_id': 'x' * 5000})

        assert response['statusCode'] == 400
        # Rejected before the key was ever built.
        assert not any(
            'x' * 5000 in str(call.kwargs.get('Key', {}))
            for call in table.get_item.call_args_list
        )


class TestBasePrototypeIdIsCheckedLikeTheOtherTwo:
    """
    `base_prototype_id` — the prototype a revision is built on.

    It was the one of the three client-supplied ids that reached `doc_config`
    unchecked. An id naming nothing then produced a build that ran to completion
    as a FRESH generation — no `EXISTING PROTOTYPE (revise this)` block in the
    prompt — and saved a document labelled a revision (`revised_from_id`) that the
    model never saw the base of, after a billed multi-minute Bedrock call.
    """

    def test_a_named_prototype_reaches_the_generator(self, build_prototype):
        response, config, _table, invoke = build_prototype(
            {'feedback': 'Make it admin-facing', 'base_prototype_id': 'proto_1'},
        )

        assert response['statusCode'] == 200
        assert config['base_prototype_id'] == 'proto_1'
        assert invoke.call_args.args[1]['doc_config']['base_prototype_id'] == 'proto_1'

    def test_an_unknown_prototype_is_a_404_and_starts_no_job(self, build_prototype):
        """The load-bearing assertion is `config is None`: a check that ran AFTER
        `create_job` would still return 404 here while having created the job row
        and, with it, the billable build this check exists to prevent."""
        response, config, _table, invoke = build_prototype(
            {'feedback': 'Make it admin-facing', 'base_prototype_id': 'proto_nope'},
        )

        assert response['statusCode'] == 404
        assert 'base_prototype_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_another_projects_prototype_is_a_404(self, build_prototype):
        """`proto_other` is a real prototype, in `proj_2`. This is the fixture that
        fails if the partition key is ever dropped from the lookup — without it,
        "belongs to someone else" and "does not exist" are the same table."""
        response, config, table, invoke = build_prototype(
            {'feedback': 'Make it admin-facing', 'base_prototype_id': 'proto_other'},
        )

        assert response['statusCode'] == 404
        assert 'base_prototype_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()
        # Asserted on the key as well: the id never addresses another partition.
        keys = [call.kwargs.get('Key', {}) for call in table.get_item.call_args_list]
        assert keys, 'expected at least one keyed read'
        assert {k.get('pk') for k in keys} == {f'PROJECT#{PROJECT}'}

    def test_a_prd_id_offered_as_a_base_prototype_is_a_404(self, build_prototype):
        """`prd_1` is a real document in this project, just not a prototype. The
        `sk` prefix is what separates the two, so this is the fixture that fails if
        the `PROTOTYPE#` prefix is ever dropped from the lookup."""
        response, config, _table, invoke = build_prototype(
            {'feedback': 'Make it admin-facing', 'base_prototype_id': 'prd_1'},
        )

        assert response['statusCode'] == 404
        assert 'base_prototype_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_an_unknown_prototype_is_a_404_even_without_feedback(self, build_prototype):
        """The check does not hang off `feedback`. An id that is sent is an id that
        is claimed, so it is resolved whenever it is supplied."""
        response, config, _table, invoke = build_prototype({'base_prototype_id': 'proto_nope'})

        assert response['statusCode'] == 404
        assert 'base_prototype_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    @pytest.mark.parametrize('value', [
        pytest.param(['proto_1'], id='list'),
        pytest.param({'id': 'proto_1'}, id='object'),
        pytest.param(7, id='number'),
        pytest.param(True, id='bool'),
    ])
    def test_a_non_string_base_prototype_id_is_a_400(self, build_prototype, value):
        response, config, _table, invoke = build_prototype({'base_prototype_id': value})

        assert response['statusCode'] == 400
        assert 'base_prototype_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_an_absurdly_long_base_prototype_id_is_a_400_not_a_500(self, build_prototype):
        response, config, table, invoke = build_prototype({'base_prototype_id': 'x' * 5000})

        assert response['statusCode'] == 400
        assert 'base_prototype_id' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()
        # Rejected before the key was ever built.
        assert not any(
            'x' * 5000 in str(call.kwargs.get('Key', {}))
            for call in table.get_item.call_args_list
        )

    @pytest.mark.parametrize('body, label', [
        pytest.param({}, 'absent', id='absent'),
        pytest.param({'base_prototype_id': None}, 'null', id='null'),
        pytest.param({'base_prototype_id': ''}, 'blank', id='blank'),
        pytest.param({'base_prototype_id': '   '}, 'whitespace', id='whitespace'),
    ])
    def test_not_naming_a_base_prototype_still_builds(self, build_prototype, body, label):
        """Every build that is not a revision sends one of these, and all of them
        must keep meaning "not a revision" rather than "prototype ''"."""
        response, config, _table, invoke = build_prototype({'title': 'Prototype', **body})

        assert response['statusCode'] == 200, label
        assert config['base_prototype_id'] is None
        invoke.assert_called_once()


class TestOptionalExtraSources:
    """
    `use_product_context`, `use_research` and `selected_research_ids` — the
    per-build tick-boxes.

    The id list is the same trust boundary as the three ids above (its documents'
    text goes into a Bedrock prompt), with one thing they do not need: a bounded
    arity. One id is one keyed read; an unbounded list is N reads bought with a
    single request.
    """

    def test_all_three_absent_leaves_the_build_unaimed(self, build_prototype):
        """The pre-existing request shape, which every caller before this feature
        sends. It must reach the generator as "asked for nothing" — that is what
        makes the generated prompt identical to the one it produced before."""
        response, config, _table, _invoke = build_prototype({'title': 'Prototype'})

        assert response['statusCode'] == 200
        assert config['use_product_context'] is False
        assert config['use_research'] is False
        assert config['selected_research_ids'] == []

    def test_the_ticked_sources_reach_the_generator(self, build_prototype):
        response, config, _table, invoke = build_prototype({
            'use_product_context': True,
            'use_research': True,
            'selected_research_ids': ['research_a', 'research_b'],
        })

        assert response['statusCode'] == 200
        assert config['use_product_context'] is True
        assert config['selected_research_ids'] == ['research_a', 'research_b']
        # The job row and the generator invocation must say the same thing.
        assert invoke.call_args.args[1]['doc_config']['selected_research_ids'] == [
            'research_a', 'research_b',
        ]

    def test_research_ids_are_read_under_this_project_as_research_only(self, build_prototype):
        """Ownership and type both come from the key: the supplied string reaches
        `sk` under the `RESEARCH#` prefix and never touches `pk`."""
        _response, _config, table, _invoke = build_prototype({
            'use_research': True, 'selected_research_ids': ['research_a'],
        })

        keys = [call.kwargs.get('Key', {}) for call in table.get_item.call_args_list]
        assert {'pk': f'PROJECT#{PROJECT}', 'sk': 'RESEARCH#research_a'} in keys
        assert {k.get('pk') for k in keys} == {f'PROJECT#{PROJECT}'}

    def test_a_research_id_naming_nothing_in_this_project_is_a_404_before_any_job(
        self, build_prototype,
    ):
        """The criterion this endpoint exists to satisfy, and `config is None` is
        the load-bearing half of it: the table answers every read from a dict, so
        an implementation that skipped the unresolvable id — or validated after
        `create_job` — would run to completion and start a billable build. The
        assertion is that no job was created at all, not merely that the status
        code is a 4xx.
        """
        response, config, _table, invoke = build_prototype({
            'use_research': True, 'selected_research_ids': ['research_a', 'research_gone'],
        })

        assert response['statusCode'] == 404
        assert 'selected_research_ids' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_another_projects_research_is_a_404(self, build_prototype):
        """`research_other` is a real research report, in `proj_2`. This is the
        fixture that fails the moment `pk` is dropped from the lookup."""
        response, config, _table, invoke = build_prototype({
            'use_research': True, 'selected_research_ids': ['research_other'],
        })

        assert response['statusCode'] == 404
        assert config is None
        invoke.assert_not_called()

    def test_a_prd_id_offered_as_research_is_a_404(self, build_prototype):
        """`prd_1` is a real document in this project, just not research."""
        response, config, _table, invoke = build_prototype({
            'use_research': True, 'selected_research_ids': ['prd_1'],
        })

        assert response['statusCode'] == 404
        assert config is None
        invoke.assert_not_called()

    def test_an_over_long_research_id_list_is_a_400_naming_the_field(self, build_prototype):
        """The bound `_validated_source_id` has no equivalent of. Without it a
        single request becomes one keyed read per entry, so the list length is
        checked BEFORE the first read — asserted here on `get_item` never having
        been called, which is what separates "rejected the list" from "read all
        200 of them and then rejected".
        """
        response, config, table, invoke = build_prototype({
            'use_research': True,
            'selected_research_ids': [f'research_{i}' for i in range(200)],
        })

        assert response['statusCode'] == 400
        assert 'selected_research_ids' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()
        table.get_item.assert_not_called()

    def test_a_list_of_distinct_ids_at_the_bound_is_accepted(self, build_prototype):
        """The bound is a maximum, not a strict limit — a fixture only at 200 would
        pass against an off-by-one that rejected legitimate selections.

        Ten DISTINCT ids, which is the whole point: the same id repeated ten times
        collapses to one, so a fixture built from repeats passes against an
        implementation that accepts only a single id and against one whose bound is
        really 1. All ten must survive, in the order they were sent.
        """
        from projects_handler import MAX_SELECTED_RESEARCH_IDS

        ids = [f'research_{i}' for i in range(MAX_SELECTED_RESEARCH_IDS)]
        response, config, _table, _invoke = build_prototype({
            'use_research': True, 'selected_research_ids': ids,
        })

        assert response['statusCode'] == 200
        assert config['selected_research_ids'] == ids

    def test_duplicates_count_toward_the_bound_and_then_collapse(self, build_prototype):
        """Both halves of a deliberate asymmetry that looks like an inconsistency.

        The arity check runs on the RAW list, before the first read, so eleven
        entries that dedupe to one are still a 400. That is intended: the bound
        exists to cap how many keyed reads one request can buy, and how many
        entries survive deduplication is not known until they have been read.
        Collapsing happens after, so the same report named ten times is one
        document to read and one prompt section rather than ten copies of it.
        """
        from projects_handler import MAX_SELECTED_RESEARCH_IDS

        at_bound, config, _table, _invoke = build_prototype({
            'use_research': True,
            'selected_research_ids': ['research_a'] * MAX_SELECTED_RESEARCH_IDS,
        })

        assert at_bound['statusCode'] == 200
        assert config['selected_research_ids'] == ['research_a']

        over, over_config, table, invoke = build_prototype({
            'use_research': True,
            'selected_research_ids': ['research_a'] * (MAX_SELECTED_RESEARCH_IDS + 1),
        })

        assert over['statusCode'] == 400
        assert over_config is None
        invoke.assert_not_called()
        # Before the first read, so the cost of an over-long list is one 400.
        table.get_item.assert_not_called()

    @pytest.mark.parametrize('value', [
        pytest.param('research_a', id='bare-string'),
        pytest.param({'id': 'research_a'}, id='object'),
        pytest.param(7, id='number'),
    ])
    def test_a_non_list_selection_is_a_400(self, build_prototype, value):
        """A bare string is the dangerous one: it is iterable, so an
        implementation that skipped the type check would read one key per
        CHARACTER."""
        response, config, _table, invoke = build_prototype({
            'use_research': True, 'selected_research_ids': value,
        })

        assert response['statusCode'] == 400
        assert 'selected_research_ids' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_a_non_string_entry_is_a_400(self, build_prototype):
        response, config, _table, invoke = build_prototype({
            'use_research': True, 'selected_research_ids': ['research_a', 7],
        })

        assert response['statusCode'] == 400
        assert 'selected_research_ids' in json.loads(response['body'])['error']
        assert config is None
        invoke.assert_not_called()

    def test_an_absurdly_long_research_id_is_a_400_not_a_500(self, build_prototype):
        """Per-entry length bound, inherited from `_validated_source_id`: a sort
        key is capped at 1024 bytes, so unbounded this is a DynamoDB
        ValidationException surfacing as a 500."""
        response, config, table, invoke = build_prototype({
            'use_research': True, 'selected_research_ids': ['x' * 5000],
        })

        assert response['statusCode'] == 400
        assert config is None
        invoke.assert_not_called()
        assert not any(
            'x' * 5000 in str(call.kwargs.get('Key', {}))
            for call in table.get_item.call_args_list
        )

    @pytest.mark.parametrize('value', [
        # Resolvable, so this is the one that fails if the reads are still made:
        # nothing about the ids themselves would stop them.
        pytest.param(['research_a', 'research_b'], id='resolvable'),
        # Each of these would be a 4xx if the list were validated regardless of the
        # switch. They are the assertion that "ignored" means ignored, and not
        # "validated a bit more cheaply".
        pytest.param(['research_gone'], id='unresolvable'),
        pytest.param(['research_other'], id='another-projects'),
        pytest.param([f'research_{i}' for i in range(200)], id='over-long'),
        pytest.param('research_a', id='not-a-list'),
    ])
    def test_ids_sent_with_the_switch_off_are_ignored_and_cost_no_reads(
        self, build_prototype, value,
    ):
        """The decision, stated: a list sent with `use_research` off is IGNORED,
        not rejected. `use_research` is the only thing the generator reads before it
        opens the list, so ids beside a false flag name nothing any build will look
        at — there is no claim to check, and a 4xx over a field the build ignores
        would fail a request for a reason the user cannot see.

        Two halves are asserted. No keyed read under `RESEARCH#`: validating
        regardless spent one read per id on a result nothing used. And `[]` in the
        stored config rather than the raw list: every id that reaches `doc_config`
        resolved under this project's prefix, so a replayed job cannot reach an
        unvalidated id even if the switch is read differently later.
        """
        response, config, table, invoke = build_prototype({
            'selected_research_ids': value,
        })

        assert response['statusCode'] == 200
        assert config['use_research'] is False
        assert config['selected_research_ids'] == []
        invoke.assert_called_once()
        assert not [
            call.kwargs.get('Key', {}) for call in table.get_item.call_args_list
            if str(call.kwargs.get('Key', {}).get('sk', '')).startswith('RESEARCH#')
        ]

    @pytest.mark.parametrize('value', [
        pytest.param([], id='empty'),
        pytest.param(None, id='null'),
        pytest.param(['', '   '], id='blank-entries'),
    ])
    def test_naming_no_research_is_valid(self, build_prototype, value):
        """A ticked box with nothing chosen, and a cleared picker, both mean "read
        no research" rather than "document ''"."""
        response, config, _table, invoke = build_prototype({
            'use_research': True, 'selected_research_ids': value,
        })

        assert response['statusCode'] == 200
        assert config['selected_research_ids'] == []
        invoke.assert_called_once()


class TestPrototypeTitleBoundary:
    @pytest.mark.parametrize('title', [
        pytest.param([], id='list'),
        pytest.param({'title': 'Prototype'}, id='object'),
        pytest.param(7, id='number'),
        pytest.param(True, id='boolean'),
        pytest.param('   ', id='whitespace'),
    ])
    def test_invalid_title_is_rejected_before_source_reads_or_job_creation(
        self, build_prototype, title,
    ):
        response, config, table, invoke = build_prototype({
            'title': title,
            'source_prd_id': 'prd_1',
        })

        assert response['statusCode'] == 400
        assert 'title' in json.loads(response['body'])['error'].lower()
        assert config is None
        table.get_item.assert_not_called()
        invoke.assert_not_called()

    def test_terminal_version_suffix_is_stripped_before_job_creation(self, build_prototype):
        response, config, _table, invoke = build_prototype({
            'title': '  Checkout   Prototype (v7)  ',
        })

        assert response['statusCode'] == 200
        assert config['title'] == 'Checkout Prototype'
        assert invoke.call_args.args[1]['doc_config']['title'] == 'Checkout Prototype'

    @pytest.mark.parametrize('body', [
        pytest.param({}, id='absent'),
        pytest.param({'title': None}, id='null'),
        pytest.param({'title': ''}, id='empty'),
    ])
    def test_missing_title_preserves_the_prototype_default(self, build_prototype, body):
        response, config, _table, invoke = build_prototype(body)

        assert response['statusCode'] == 200
        assert config['title'] == 'Prototype'
        assert invoke.call_args.args[1]['doc_config']['title'] == 'Prototype'

"""
POST /projects/{id}/build-prototype — the visual-selection trust boundary.

`selected_product_doc_ids` names uploaded mockups/screenshots whose extracted
design description the generator injects into a Bedrock prompt, so it is the same
trust boundary as the source ids in test_build_prototype_sources.py: an id that
resolved outside this project would pull another project's upload into this
project's build.

Two things are specific to this field and are what this file pins.

There is no `use_visuals` switch. A non-empty list IS the request, so unlike
`selected_research_ids` there is no flag whose "off" position skips the check —
these ids are validated whenever they are sent.

And the bound is small for a reason that is not budget: the prompt drives ONE set
of eight `:root` custom properties, so several mockups with different palettes are
contradictory instructions rather than more grounding.

Fixtures and idioms follow test_build_prototype_sources.py (same directory) —
same keyed-on-the-whole-composite-key table, same (response, config, table,
invoke) tuple, so the two files' assertions mean the same thing.
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
    Call the endpoint with a projects table holding product docs, a PRD and a
    prototype in THIS project, plus one product doc in a DIFFERENT project.

    Reads are answered on the whole composite key rather than on `sk` alone, which
    is what keeps "a visual belonging to another project" a distinct fixture from
    "no such visual": keyed on `sk` only, the two would be the same table and no
    test here could tell a dropped partition key apart from a working one.

    Returns (response, job_config, table, invoke, create_job) where `job_config` is
    the doc_config handed to the generator, or None when no job was created.

    One member more than the sibling file's tuple: `create_job` itself is handed
    back so a rejection can assert on the job-creation call directly rather than
    only on the config derived from it. `config is None` and
    `create_job.assert_not_called()` happen to coincide today, and asserting both
    keeps them coinciding — a check that created the job and then raised would
    otherwise be caught by neither the status code nor the config alone.
    """
    def _call(body):
        from projects_handler import MAX_SELECTED_PRODUCT_DOC_IDS

        table = MagicMock()
        documents = {
            # Real documents in this project, of OTHER types. `prd_1` is the
            # fixture that fails if the `PRODUCT_DOC#` prefix is ever dropped.
            (f'PROJECT#{PROJECT}', 'PRD#prd_1'): {'document_id': 'prd_1'},
            (f'PROJECT#{PROJECT}', 'PROTOTYPE#proto_1'): {'document_id': 'proto_1'},
            # Enough DISTINCT product docs to fill a selection at the bound.
            # Repeats would collapse to one, so a fixture at the bound built from
            # `['doc_a'] * 4` would pass against an implementation that never
            # accepted more than a single id.
            **{
                (f'PROJECT#{PROJECT}', f'PRODUCT_DOC#doc_{i}'): {'doc_id': f'doc_{i}'}
                for i in range(MAX_SELECTED_PRODUCT_DOC_IDS)
            },
            # Real product doc, wrong project. Only reachable by a lookup that
            # dropped `pk`.
            (f'PROJECT#{OTHER_PROJECT}', 'PRODUCT_DOC#doc_other'): {'doc_id': 'doc_other'},
            # `doc_gone` is deliberately absent — it is the unresolvable fixture.
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
        return response, config, table, invoke, create_job

    return _call


class TestASelectionOfVisualsIsAccepted:
    def test_the_chosen_visuals_reach_the_generator_in_order(self, build_prototype):
        """Order is asserted, not just membership: the generator concatenates the
        descriptions into one prompt section, so the order is what decides which
        palette the model reads first."""
        response, config, _table, invoke, _create_job = build_prototype(
            {'selected_product_doc_ids': ['doc_1', 'doc_0', 'doc_2']},
        )

        assert response['statusCode'] == 200
        assert config['selected_product_doc_ids'] == ['doc_1', 'doc_0', 'doc_2']
        # The job row and the generator invocation must say the same thing.
        assert invoke.call_args.args[1]['doc_config']['selected_product_doc_ids'] == [
            'doc_1', 'doc_0', 'doc_2',
        ]

    def test_no_switch_is_needed_to_turn_a_selection_on(self, build_prototype):
        """The design decision, stated as a test: a non-empty list is the whole
        request. Nothing else in the body enables it, so a build that sends only
        this field still gets its visuals."""
        response, config, _table, _invoke, _create_job = build_prototype(
            {'selected_product_doc_ids': ['doc_0']},
        )

        assert response['statusCode'] == 200
        assert config['selected_product_doc_ids'] == ['doc_0']
        assert 'use_visuals' not in config

    def test_visuals_are_read_under_this_project_as_product_docs_only(self, build_prototype):
        """Ownership and type both come from the key: the supplied string reaches
        `sk` under the `PRODUCT_DOC#` prefix and never touches `pk`."""
        _response, _config, table, _invoke, _create_job = build_prototype(
            {'selected_product_doc_ids': ['doc_0']},
        )

        keys = [call.kwargs.get('Key', {}) for call in table.get_item.call_args_list]
        assert {'pk': f'PROJECT#{PROJECT}', 'sk': 'PRODUCT_DOC#doc_0'} in keys
        assert {k.get('pk') for k in keys} == {f'PROJECT#{PROJECT}'}

    def test_a_selection_at_the_bound_is_accepted(self, build_prototype):
        """The bound is a maximum, not a strict limit — without this, an off-by-one
        that refused a legitimate four-visual selection would look correct."""
        from projects_handler import MAX_SELECTED_PRODUCT_DOC_IDS

        ids = [f'doc_{i}' for i in range(MAX_SELECTED_PRODUCT_DOC_IDS)]
        response, config, _table, _invoke, _create_job = build_prototype(
            {'selected_product_doc_ids': ids},
        )

        assert response['statusCode'] == 200
        assert config['selected_product_doc_ids'] == ids


class TestNotSelectingVisualsStillBuilds:
    """
    The positive control. Without it, "rejects bad selections" is
    indistinguishable from "rejects every build" — every rejection test below
    would still pass against a validator that refused everything, including the
    request shape every caller sent before this field existed.
    """

    @pytest.mark.parametrize('body, label', [
        pytest.param({}, 'absent', id='absent'),
        pytest.param({'selected_product_doc_ids': None}, 'null', id='null'),
        pytest.param({'selected_product_doc_ids': []}, 'empty', id='empty'),
    ])
    def test_no_selection_is_an_empty_list_and_a_successful_build(
        self, build_prototype, body, label,
    ):
        response, config, _table, invoke, _create_job = build_prototype(
            {'title': 'Prototype', **body},
        )

        assert response['statusCode'] == 200, label
        assert config['selected_product_doc_ids'] == []
        invoke.assert_called_once()

    def test_a_cleared_picker_is_not_a_selection_of_blanks(self, build_prototype):
        """A picker cleared in the UI can send `''`. That means "no visual", not
        "the document named ''", and it must not become a keyed read either."""
        response, config, table, invoke, _create_job = build_prototype(
            {'selected_product_doc_ids': ['', '   ']},
        )

        assert response['statusCode'] == 200
        assert config['selected_product_doc_ids'] == []
        invoke.assert_called_once()
        assert not [
            call.kwargs.get('Key', {}) for call in table.get_item.call_args_list
            if str(call.kwargs.get('Key', {}).get('sk', '')) in ('PRODUCT_DOC#', 'PRODUCT_DOC#   ')
        ]


class TestAnUnresolvableVisualIsRejectedBeforeAnyCost:
    def test_a_visual_naming_nothing_in_this_project_starts_no_job(self, build_prototype):
        """`create_job is not called` and `invoke is not called` are the
        load-bearing assertions, not the status code. A check placed AFTER
        `create_job` would still answer 404 here while having created the job row
        and, with it, the billable multi-minute Bedrock build this check exists to
        prevent. Both side effects are asserted absent because either one alone can
        survive a badly ordered check."""
        response, config, _table, invoke, create_job = build_prototype(
            {'selected_product_doc_ids': ['doc_0', 'doc_gone']},
        )

        assert response['statusCode'] == 404
        assert 'selected_product_doc_ids' in json.loads(response['body'])['error']
        create_job.assert_not_called()
        assert config is None
        invoke.assert_not_called()

    def test_another_projects_visual_is_rejected(self, build_prototype):
        """`doc_other` is a real product doc, in `proj_2`. This is the fixture that
        fails the moment `pk` is dropped from the lookup — it is the difference
        between "you may not read that" and "that does not exist"."""
        response, config, table, invoke, create_job = build_prototype(
            {'selected_product_doc_ids': ['doc_other']},
        )

        assert response['statusCode'] == 404
        assert 'selected_product_doc_ids' in json.loads(response['body'])['error']
        create_job.assert_not_called()
        assert config is None
        invoke.assert_not_called()
        # Asserted on the key as well: the id never addresses another partition.
        keys = [call.kwargs.get('Key', {}) for call in table.get_item.call_args_list]
        assert keys, 'expected at least one keyed read'
        assert {k.get('pk') for k in keys} == {f'PROJECT#{PROJECT}'}

    @pytest.mark.parametrize('document_id, sk_prefix', [
        pytest.param('prd_1', 'PRD#', id='a-prd'),
        pytest.param('proto_1', 'PROTOTYPE#', id='a-prototype'),
    ])
    def test_a_real_document_of_another_type_is_rejected(
        self, build_prototype, document_id, sk_prefix,
    ):
        """The type check, and the proof that the keyed read IS the type check.
        Both of these exist in THIS project — a lookup that dropped the
        `PRODUCT_DOC#` prefix, or that checked only ownership, would resolve them
        and feed a PRD's text into the slot meant for a sampled palette."""
        response, config, table, invoke, create_job = build_prototype(
            {'selected_product_doc_ids': [document_id]},
        )

        assert response['statusCode'] == 404
        assert 'selected_product_doc_ids' in json.loads(response['body'])['error']
        create_job.assert_not_called()
        assert config is None
        invoke.assert_not_called()
        # The read that was actually attempted addressed the visual namespace, so
        # the id resolving elsewhere is exactly what did not save it.
        keys = [call.kwargs.get('Key', {}) for call in table.get_item.call_args_list]
        assert {'pk': f'PROJECT#{PROJECT}', 'sk': f'PRODUCT_DOC#{document_id}'} in keys
        assert not any(
            str(k.get('sk', '')) == f'{sk_prefix}{document_id}' for k in keys
        )

    def test_an_absurdly_long_visual_id_is_a_400_not_a_500(self, build_prototype):
        """Per-entry length bound, inherited from `_validated_source_id`: a sort key
        is capped at 1024 bytes, so unbounded this reaches DynamoDB and comes back
        as a ValidationException — a 500 for what is a bad request."""
        response, config, table, invoke, create_job = build_prototype(
            {'selected_product_doc_ids': ['x' * 5000]},
        )

        assert response['statusCode'] == 400
        assert 'selected_product_doc_ids' in json.loads(response['body'])['error']
        create_job.assert_not_called()
        assert config is None
        invoke.assert_not_called()
        # Rejected before the key was ever built.
        assert not any(
            'x' * 5000 in str(call.kwargs.get('Key', {}))
            for call in table.get_item.call_args_list
        )


class TestTheSelectionSizeIsBoundedBeforeAnyRead:
    def test_an_over_long_selection_costs_zero_reads(self, build_prototype):
        """`table.get_item.assert_not_called()` is the assertion, not the status
        code. One id is one keyed read, so without an arity check checked FIRST a
        single request buys 500 reads and then answers 400 — the cost is paid
        either way and the 400 hides it."""
        response, config, table, invoke, create_job = build_prototype(
            {'selected_product_doc_ids': [f'doc_{i}' for i in range(500)]},
        )

        assert response['statusCode'] == 400
        assert 'selected_product_doc_ids' in json.loads(response['body'])['error']
        table.get_item.assert_not_called()
        create_job.assert_not_called()
        assert config is None
        invoke.assert_not_called()

    def test_one_over_the_bound_is_already_too_many(self, build_prototype):
        """The boundary itself, paired with `test_a_selection_at_the_bound_is_accepted`:
        together they pin the bound at exactly MAX_SELECTED_PRODUCT_DOC_IDS rather
        than somewhere in a range."""
        from projects_handler import MAX_SELECTED_PRODUCT_DOC_IDS

        response, config, table, invoke, _create_job = build_prototype({
            'selected_product_doc_ids': [
                f'doc_{i}' for i in range(MAX_SELECTED_PRODUCT_DOC_IDS + 1)
            ],
        })

        assert response['statusCode'] == 400
        assert str(MAX_SELECTED_PRODUCT_DOC_IDS) in json.loads(response['body'])['error']
        table.get_item.assert_not_called()
        assert config is None
        invoke.assert_not_called()

    def test_duplicates_count_toward_the_bound_and_then_collapse(self, build_prototype):
        """Both halves of a deliberate asymmetry that reads like an inconsistency.

        The arity check runs on the RAW list, before the first read, so five
        entries that dedupe to one are still a 400: the bound caps how many keyed
        reads one request can buy, and how many survive deduplication is not known
        until they have been read. Collapsing happens after, so the same mockup
        named four times is one read and one palette in the prompt rather than four
        copies of it.
        """
        from projects_handler import MAX_SELECTED_PRODUCT_DOC_IDS

        at_bound, config, _table, _invoke, _create_job = build_prototype({
            'selected_product_doc_ids': ['doc_0'] * MAX_SELECTED_PRODUCT_DOC_IDS,
        })

        assert at_bound['statusCode'] == 200
        assert config['selected_product_doc_ids'] == ['doc_0']

        over, over_config, table, invoke, _create_job = build_prototype({
            'selected_product_doc_ids': ['doc_0'] * (MAX_SELECTED_PRODUCT_DOC_IDS + 1),
        })

        assert over['statusCode'] == 400
        assert over_config is None
        invoke.assert_not_called()
        # Before the first read, so the cost of an over-long list is one 400.
        table.get_item.assert_not_called()

    def test_duplicates_collapse_to_first_seen_order(self, build_prototype):
        """Not just "deduped": the surviving order is the order of FIRST
        appearance, so a set-based implementation (which has no order) fails
        here."""
        response, config, _table, _invoke, _create_job = build_prototype(
            {'selected_product_doc_ids': ['doc_2', 'doc_0', 'doc_2']},
        )

        assert response['statusCode'] == 200
        assert config['selected_product_doc_ids'] == ['doc_2', 'doc_0']


class TestTheSelectionMustBeAList:
    @pytest.mark.parametrize('value', [
        pytest.param('doc_0', id='bare-string'),
        pytest.param({'ids': ['doc_0']}, id='object'),
        pytest.param(7, id='number'),
        pytest.param(True, id='bool'),
    ])
    def test_a_non_list_selection_is_a_400(self, build_prototype, value):
        """A bare string is the dangerous one: it is iterable, so an implementation
        that skipped the type check would read one key per CHARACTER."""
        response, config, table, invoke, create_job = build_prototype(
            {'selected_product_doc_ids': value},
        )

        assert response['statusCode'] == 400
        assert 'selected_product_doc_ids' in json.loads(response['body'])['error']
        create_job.assert_not_called()
        assert config is None
        invoke.assert_not_called()
        table.get_item.assert_not_called()

    def test_a_non_string_entry_is_a_400(self, build_prototype):
        response, config, _table, invoke, create_job = build_prototype(
            {'selected_product_doc_ids': ['doc_0', 7]},
        )

        assert response['statusCode'] == 400
        assert 'selected_product_doc_ids' in json.loads(response['body'])['error']
        create_job.assert_not_called()
        assert config is None
        invoke.assert_not_called()

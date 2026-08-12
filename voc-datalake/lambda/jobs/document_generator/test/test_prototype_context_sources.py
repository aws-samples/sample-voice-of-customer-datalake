"""
The two extra sources a prototype build can be told to read: the project's
product context, and specific research reports.

Both are opt-in per build (`use_product_context`, `use_research` +
`selected_research_ids` in `doc_config`). Three properties:

1. **Ticked reaches the prompt, unticked does not**, and the document's
   `derivation` says which of the two happened. A build that claims grounding it
   did not get is the failure this whole feature exists to avoid.

2. **Research is scoped to `RESEARCH#` only.** It is read by keyed lookups per
   named id, never through `_gather_context` (inert here — every branch of it is
   gated on a `data_sources` map a prototype's `doc_config` does not carry) and
   never through the shared reference-document path, which keeps only the first
   three of a selection and so drops research whenever a PRD and a PR/FAQ are
   also selected. Hence the fixture below holds TWO PRDs, ONE PR/FAQ and TWO
   research reports: with fewer non-research documents, "scoped to research"
   and "reused the general picker" would be the same test.

3. **Asking for neither leaves the prompt byte-identical to what this path
   produced before the feature existed.** Pinned against a golden file captured
   on the pre-change tree (`golden/prototype_prompt_baseline.txt`), because a
   substring assertion cannot see an added blank line or a reordered section.

Every fixture supplies enough table responses for a build to COMPLETE, so a
test that expects a failure fails for the reason it names rather than because
the mock ran out of answers.
"""
from pathlib import Path
from unittest.mock import patch

import pytest

HTML = '<!DOCTYPE html><html><body><h1>Demo</h1></body></html>'

# A block that could not be mistaken for the placeholder `_product_context`
# returns when a project describes nothing. Asserting on the placeholder would
# be vacuous: it appears in the prompt in exactly the same way whether the
# section was injected or omitted, because it is absent from both.
DISTINCTIVE_CONTEXT = '### Structured product context\n**Product**: Wombat Telemetry Console'

PRD_OLD = {'document_id': 'zz_prd_old', 'content': 'OLD PRD body', 'created_at': '2026-01-01T00:00:00Z'}
PRD_NEW = {'document_id': 'aa_prd_new', 'content': 'NEW PRD body', 'created_at': '2026-06-01T00:00:00Z'}
PRFAQ = {'document_id': 'prfaq_1', 'content': 'PRFAQ body', 'created_at': '2026-02-01T00:00:00Z'}
RESEARCH_A = {'document_id': 'research_a', 'title': 'Churn interviews', 'content': 'RESEARCH A findings'}
RESEARCH_B = {'document_id': 'research_b', 'title': 'Pricing survey', 'content': 'RESEARCH B findings'}

GOLDEN_PROMPT = Path(__file__).parent / 'golden' / 'prototype_prompt_baseline.txt'


def _wire(mock_dynamodb, *, prd_pages=(), prfaq_pages=(), documents=None, project_name='My Project'):
    """
    Wire the projects table: newest-of-type query pages per type, plus items
    reachable by key.

    Same shape as `test_prototype_sources._wire` — kept local rather than
    imported so this file's fixtures can be read without opening another, and so
    a change there cannot silently retune the golden test here.
    """
    table = mock_dynamodb['table']
    table.query.side_effect = [*prd_pages, *prfaq_pages]

    by_sk = {}
    for prefix, pages in (('PRD#', prd_pages), ('PRFAQ#', prfaq_pages)):
        for page in pages:
            for item in page.get('Items') or []:
                document_id = item.get('document_id')
                if document_id:
                    by_sk[f'{prefix}{document_id}'] = item
    by_sk.update(documents or {})

    def get_item(Key=None, **kwargs):
        sk = (Key or {}).get('sk', '')
        if sk == 'META':
            return {'Item': {'name': project_name}}
        item = by_sk.get(sk)
        return {'Item': item} if item else {}

    table.get_item.side_effect = get_item
    return table


def _wire_one_of_each(mock_dynamodb, **kwargs):
    """The simplest buildable project: one PRD, one PR/FAQ, plus both research reports."""
    return _wire(
        mock_dynamodb,
        prd_pages=[{'Items': [PRD_NEW]}],
        prfaq_pages=[{'Items': [PRFAQ]}],
        documents={'RESEARCH#research_a': RESEARCH_A, 'RESEARCH#research_b': RESEARCH_B},
        **kwargs,
    )


def _run(sample_job_event, lambda_context, **config):
    from jobs.document_generator.handler import lambda_handler
    return lambda_handler({
        **sample_job_event,
        'doc_config': {'doc_type': 'build_prototype', 'title': 'Test Prototype', **config},
    }, lambda_context)


def _prompt(mock_converse):
    return mock_converse.call_args.kwargs['prompt']


def _saved(mock_dynamodb):
    return mock_dynamodb['table'].put_item.call_args.kwargs['Item']


def _keys(mock_dynamodb):
    return [call.kwargs.get('Key', {}) for call in mock_dynamodb['table'].get_item.call_args_list]


@pytest.fixture
def stub_product_context():
    """`_product_context` answering with a distinctive block, as if the project
    described itself. The real helper is exercised separately (see
    `TestTheDerivationReportsWhatWasUsed`) — here the point is what the caller
    does with an answer, so the answer is fixed."""
    with patch(
        'jobs.document_generator.handler._product_context',
        return_value=(DISTINCTIVE_CONTEXT, True),
    ) as stub:
        yield stub


class TestProductContextIsOptIn:
    def test_ticking_product_context_puts_the_block_in_the_prompt(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event,
        lambda_context, stub_product_context,
    ):
        _wire_one_of_each(mock_dynamodb)
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context, use_product_context=True)

        assert DISTINCTIVE_CONTEXT in _prompt(mock_converse)
        assert _saved(mock_dynamodb)['derivation']['product_context_included'] is True

    def test_not_ticking_product_context_keeps_the_block_out(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event,
        lambda_context, stub_product_context,
    ):
        """The helper is stubbed to succeed, so the only thing keeping the block
        out of the prompt is the flag. It must also not be READ: a build that
        pays for the lookup and discards it is the same defect one step earlier."""
        _wire_one_of_each(mock_dynamodb)
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context)

        assert DISTINCTIVE_CONTEXT not in _prompt(mock_converse)
        assert _saved(mock_dynamodb)['derivation']['product_context_included'] is False
        stub_product_context.assert_not_called()

    def test_a_failure_to_build_the_product_context_does_not_fail_the_build(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The raise is planted INSIDE `build_product_context_block`, which is
        where a real failure happens (a DynamoDB read, an S3 read of extracted
        text). `_product_context` is what swallows it, so stubbing that instead
        would test the stub. The prototype is the artifact the user asked for;
        losing it because an optional section could not be assembled would be a
        worse outcome than building without the section."""
        _wire_one_of_each(mock_dynamodb)
        mock_converse.return_value = HTML

        with patch(
            'api.product_context.build_product_context_block',
            side_effect=RuntimeError('DynamoDB is having a day'),
        ):
            _run(sample_job_event, lambda_context, use_product_context=True)

        item = _saved(mock_dynamodb)
        assert item['document_type'] == 'prototype'
        assert item['derivation']['product_context_included'] is False


class TestResearchIsScopedToResearchDocuments:
    """
    Fixture throughout: two PRDs, one PR/FAQ, two research reports. The three
    non-research documents are what make a general-picker implementation
    observable — its `[:3]` cap keeps PRD/PR-FAQ and drops research.
    """

    def test_both_selected_research_reports_reach_the_prompt(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [PRD_OLD, PRD_NEW]}],
            prfaq_pages=[{'Items': [PRFAQ]}],
            documents={'RESEARCH#research_a': RESEARCH_A, 'RESEARCH#research_b': RESEARCH_B},
        )
        mock_converse.return_value = HTML

        _run(
            sample_job_event, lambda_context,
            use_research=True, selected_research_ids=['research_a', 'research_b'],
        )

        prompt = _prompt(mock_converse)
        assert 'RESEARCH A findings' in prompt
        assert 'RESEARCH B findings' in prompt
        # And the documents the build already read are still there — the research
        # section is additive, not a replacement for the spec.
        assert 'NEW PRD body' in prompt
        assert 'PRFAQ body' in prompt

    def test_the_derivation_records_every_research_report_used(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [PRD_OLD, PRD_NEW]}],
            prfaq_pages=[{'Items': [PRFAQ]}],
            documents={'RESEARCH#research_a': RESEARCH_A, 'RESEARCH#research_b': RESEARCH_B},
        )
        mock_converse.return_value = HTML

        _run(
            sample_job_event, lambda_context,
            use_research=True, selected_research_ids=['research_a', 'research_b'],
        )

        derivation = _saved(mock_dynamodb)['derivation']
        assert derivation['sources'] == [
            {'document_id': 'aa_prd_new', 'role': 'prototype_prd'},
            {'document_id': 'prfaq_1', 'role': 'prototype_prfaq'},
            {'document_id': 'research_a', 'role': 'reference'},
            {'document_id': 'research_b', 'role': 'reference'},
        ]
        # Nothing was capped, so used and selected agree. They are separate
        # numbers precisely so a future cap would show up as a difference.
        assert derivation['selected_document_count'] == 4

    def test_research_is_read_by_key_under_this_project_only(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The ownership and type halves of the trust boundary, asserted on the
        keys that are built rather than on an outcome — one mocked table has no
        other project to reach, so an outcome assertion would be a tautology.

        Also pins that the research read is KEYED: a `RESEARCH#` prefix appearing
        in a `query` here would mean the reader scans the project instead, which
        is how the reference-document cap gets inherited.
        """
        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [PRD_NEW]}],
            prfaq_pages=[{'Items': [PRFAQ]}],
            documents={'RESEARCH#research_a': RESEARCH_A},
        )
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context, use_research=True, selected_research_ids=['research_a'])

        research_keys = [k for k in _keys(mock_dynamodb) if str(k.get('sk', '')).startswith('RESEARCH#')]
        assert research_keys == [{'pk': 'PROJECT#proj_20250101120000', 'sk': 'RESEARCH#research_a'}]
        assert 'RESEARCH#' not in str(mock_dynamodb['table'].query.call_args_list)

    def test_an_unresolvable_research_id_fails_the_build_and_saves_nothing(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """A named report that resolves to nothing must not be quietly skipped:
        the prototype would look grounded in research the model never saw. The
        fixture is wired so a build that skipped it would COMPLETE — both source
        lookups have answers — so this fails for the raise, not for a starved mock.
        """
        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [PRD_NEW]}],
            prfaq_pages=[{'Items': [PRFAQ]}],
            documents={'RESEARCH#research_a': RESEARCH_A},
        )
        mock_converse.return_value = HTML

        with pytest.raises(Exception, match='Document generation failed'):
            _run(
                sample_job_event, lambda_context,
                use_research=True, selected_research_ids=['research_a', 'research_gone'],
            )

        mock_converse.assert_not_called()
        mock_dynamodb['table'].put_item.assert_not_called()
        recorded = str(mock_jobs_table.update_item.call_args_list)
        assert 'selected_research_ids' in recorded
        assert 'research_gone' in recorded

    def test_a_prd_id_offered_as_research_does_not_resolve(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """Type isolation comes from the `sk` prefix, so this is the fixture that
        fails if `RESEARCH#` is ever dropped from the lookup: `aa_prd_new` is a
        real document in this project, just not research."""
        _wire(mock_dynamodb, prd_pages=[{'Items': [PRD_NEW]}], prfaq_pages=[{'Items': [PRFAQ]}])
        mock_converse.return_value = HTML

        with pytest.raises(Exception, match='Document generation failed'):
            _run(sample_job_event, lambda_context, use_research=True, selected_research_ids=['aa_prd_new'])

        mock_converse.assert_not_called()

    @pytest.mark.parametrize('switch', [
        pytest.param({}, id='absent'),
        # What the API actually sends. `bool(body.get(...))` means the key is
        # always present and explicitly False for a build that did not ask —
        # so a switch tested only for absence is a switch tested on a shape
        # production never produces. Found by mutation: reading the switch as
        # "is not None" passes the absent case and turns every real request into
        # a research-reading one.
        pytest.param({'use_research': False}, id='explicit-false'),
        pytest.param({'use_research': None}, id='null'),
    ])
    def test_ids_sent_without_the_research_box_are_not_read(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event,
        lambda_context, switch,
    ):
        """`use_research` is the switch. Ids left behind by an unticked box must
        cost neither a read nor a prompt section."""
        _wire_one_of_each(mock_dynamodb)
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context, selected_research_ids=['research_a'], **switch)

        assert 'RESEARCH A findings' not in _prompt(mock_converse)
        assert not [k for k in _keys(mock_dynamodb) if str(k.get('sk', '')).startswith('RESEARCH#')]

    def test_ticking_research_with_no_ids_reads_nothing(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """An empty selection is not "all of it". The reader is keyed reads per
        named id by design, so there is no project-wide query to fall back to —
        the frontend always names the reports it is showing."""
        _wire_one_of_each(mock_dynamodb)
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context, use_research=True, selected_research_ids=[])

        assert 'RESEARCH FINDINGS' not in _prompt(mock_converse)
        assert _saved(mock_dynamodb)['derivation']['selected_document_count'] == 2


class TestTheResearchSectionIsBoundedInTotal:
    """
    The research section has TWO bounds, and the per-report one is not a bound on
    the section: `RESEARCH_PER_DOC_CAP` x `MAX_SELECTED_RESEARCH_IDS` is 30000
    characters, more than the PRD and PR/FAQ combined (12000 each), on top of the
    product-context block and — on a revision — 24000 of prior prototype HTML. The
    worst case could crowd out the spec the prototype is supposed to implement.

    Every fixture here is therefore built so that each report fits the per-report
    cap COMFORTABLY and the reports only exceed the budget together. That is what
    makes these tests fail against a per-report cap alone: a fixture with one
    oversized report would pass either way.
    """

    #: Under RESEARCH_PER_DOC_CAP (3000) individually, over RESEARCH_TOTAL_CAP
    #: (12000) at eight of them: 8 x 2450 = 19600.
    REPORT_BODY = 2450
    REPORT_COUNT = 8

    #: The other dimension of the same overrun: a block costs its heading too, and
    #: a `title` is bounded nowhere between the UI that writes it and the prompt.
    #: Ten of these headings cost 10130 characters — five sixths of the budget —
    #: so unpaid-for they push the body past 22000 and the hard slice drops the
    #: last five reports ENTIRELY, which is the failure the shared budget exists
    #: to prevent rather than the harmless tail-trim eight short titles cause.
    LONG_TITLE_PAD = 1000
    #: MAX_SELECTED_RESEARCH_IDS — the most the API will pass through.
    LONG_TITLE_COUNT = 10

    @classmethod
    def _reports(cls):
        """Eight reports, each carrying a marker at the START and END of its body,
        so "reached the prompt" and "was truncated" are separately observable."""
        return {
            f'RESEARCH#research_{i}': {
                'document_id': f'research_{i}',
                'title': f'Report {i}',
                'content': f'HEAD{i} ' + ('n' * cls.REPORT_BODY) + f' TAIL{i}',
            }
            for i in range(cls.REPORT_COUNT)
        }

    @staticmethod
    def _research_block(prompt: str) -> str:
        """The research section as it appears in the prompt.

        Sliced out on the template's own boundaries rather than measured on the
        whole prompt, so the assertion is about the section's size and not about
        the PRD's. `index` raises if either marker moves, which is the loud
        failure to want here.
        """
        start = prompt.index('RESEARCH FINDINGS:')
        return prompt[start:prompt.index('\n\nRequirements:', start)]

    def test_the_fixture_would_exceed_the_budget_under_the_per_report_cap_alone(self):
        """Guards the two tests below from going vacuous. If either cap is ever
        retuned so that eight of these reports fit anyway, the fixture stops
        exercising an aggregate bound and this says so instead of passing."""
        from jobs.document_generator.handler import (
            RESEARCH_PER_DOC_CAP,
            RESEARCH_TOTAL_CAP,
        )

        assert self.REPORT_BODY < RESEARCH_PER_DOC_CAP
        assert self.REPORT_COUNT * self.REPORT_BODY > RESEARCH_TOTAL_CAP

    def test_eight_reports_that_each_fit_are_bounded_together(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        from jobs.document_generator.handler import RESEARCH_TOTAL_CAP

        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [PRD_NEW]}],
            prfaq_pages=[{'Items': [PRFAQ]}],
            documents=self._reports(),
        )
        mock_converse.return_value = HTML

        _run(
            sample_job_event, lambda_context, use_research=True,
            selected_research_ids=[f'research_{i}' for i in range(self.REPORT_COUNT)],
        )

        prompt = _prompt(mock_converse)
        block = self._research_block(prompt)
        assert len(block) <= RESEARCH_TOTAL_CAP + len('RESEARCH FINDINGS:\n')
        # A length assertion is satisfied by a body that was truncated INTO the
        # bound as well as by one that fit, and the two are not the same outcome:
        # the hard slice takes the overrun off the end, so the last report is what
        # goes missing. This passed while ~120 characters of report 7 were being
        # dropped. Assert the last report survived, so a truncation regression is
        # visible from here and not only from the long-title fixture below.
        last = self.REPORT_COUNT - 1
        assert f'HEAD{last}' in prompt, f'report {last} was truncated away to fit'
        # The spec is still there — bounding research must not be achieved by
        # bounding the thing research is supposed to support.
        assert 'NEW PRD body' in prompt
        assert 'PRFAQ body' in prompt

    def test_every_named_report_still_reaches_the_prompt_truncated(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The budget is SHARED, not spent front-to-back. A running budget would
        satisfy the bound above by dropping the last reports entirely — and each
        one is recorded in the derivation as having been used, so a report that
        reached none of the prompt would make that record a lie."""
        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [PRD_NEW]}],
            prfaq_pages=[{'Items': [PRFAQ]}],
            documents=self._reports(),
        )
        mock_converse.return_value = HTML

        _run(
            sample_job_event, lambda_context, use_research=True,
            selected_research_ids=[f'research_{i}' for i in range(self.REPORT_COUNT)],
        )

        prompt = _prompt(mock_converse)
        for i in range(self.REPORT_COUNT):
            assert f'Report {i}' in prompt, f'report {i} lost its heading'
            assert f'HEAD{i}' in prompt, f'report {i} contributed nothing'
            assert f'TAIL{i}' not in prompt, f'report {i} was not truncated'
        # And all eight are still claimed as used, because all eight were.
        assert _saved(mock_dynamodb)['derivation']['selected_document_count'] == 2 + self.REPORT_COUNT

    @classmethod
    def _long_titles(cls):
        """Ten titles too long to be headings, each still identifiable by prefix."""
        return [
            f'LONGTITLE{i} ' + ('T' * cls.LONG_TITLE_PAD)
            for i in range(cls.LONG_TITLE_COUNT)
        ]

    @classmethod
    def _long_title_reports(cls):
        """The eight-report fixture's bodies under ten unbounded titles: each body
        still fits the per-report cap comfortably, so anything that goes missing
        went missing to the SECTION's bound and not to its own."""
        return {
            f'RESEARCH#research_{i}': {
                'document_id': f'research_{i}',
                'title': title,
                'content': f'HEAD{i} ' + ('n' * cls.REPORT_BODY) + f' TAIL{i}',
            }
            for i, title in enumerate(cls._long_titles())
        }

    def test_the_long_title_fixture_would_lose_whole_reports_unpaid_for(self):
        """Guards the test below from going vacuous, and states what "unpaid for"
        costs. Dividing the budget without charging each block for its own heading
        leaves a body whose whole blocks do not fit — so the hard slice is not
        trimming a tail, it is deleting reports."""
        from jobs.document_generator.handler import (
            RESEARCH_PER_DOC_CAP,
            RESEARCH_TITLE_CAP,
            RESEARCH_TOTAL_CAP,
        )

        title = self._long_titles()[0]
        assert self.REPORT_BODY < RESEARCH_PER_DOC_CAP, 'each body must fit on its own'
        assert len(title) > RESEARCH_TITLE_CAP, 'the title cap must actually bite'

        unpaid_share = min(RESEARCH_PER_DOC_CAP, RESEARCH_TOTAL_CAP // self.LONG_TITLE_COUNT)
        stride = len(f'### {title}\n') + unpaid_share + len('\n\n')
        assert RESEARCH_TOTAL_CAP // stride < self.LONG_TITLE_COUNT - 1, (
            'the unpaid-for body must overrun by more than one report, or this '
            'fixture is testing the same harmless tail-trim as the short titles'
        )

    def test_ten_long_titled_reports_still_all_reach_the_prompt(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The falsifier for the heading arithmetic. Titles are user-supplied and
        bounded nowhere on this path, so a block's cost is not its content: unpaid
        for, ten of these overrun the budget by 10000 characters and the hard slice
        drops the last five reports outright — each of them still recorded in the
        derivation as having been used.

        The LAST report's marker is the assertion that matters; the others would
        survive front-to-back spending too."""
        from jobs.document_generator.handler import (
            RESEARCH_TITLE_CAP,
            RESEARCH_TOTAL_CAP,
        )

        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [PRD_NEW]}],
            prfaq_pages=[{'Items': [PRFAQ]}],
            documents=self._long_title_reports(),
        )
        mock_converse.return_value = HTML

        _run(
            sample_job_event, lambda_context, use_research=True,
            selected_research_ids=[f'research_{i}' for i in range(self.LONG_TITLE_COUNT)],
        )

        prompt = _prompt(mock_converse)
        last = self.LONG_TITLE_COUNT - 1
        assert f'HEAD{last}' in prompt, f'report {last} reached none of the prompt'
        for i in range(self.LONG_TITLE_COUNT):
            assert f'HEAD{i}' in prompt, f'report {i} contributed nothing'
            assert f'TAIL{i}' not in prompt, f'report {i} was not truncated'
        # The title is a label, and it is capped. Pinned from BOTH sides, so a cap
        # one character either way is visible rather than merely "short enough".
        title = self._long_titles()[last]
        assert title[:RESEARCH_TITLE_CAP] in prompt, 'title cut before the cap'
        assert title[:RESEARCH_TITLE_CAP + 1] not in prompt, 'title cut past the cap'
        assert len(self._research_block(prompt)) <= RESEARCH_TOTAL_CAP + len('RESEARCH FINDINGS:\n')
        assert (
            _saved(mock_dynamodb)['derivation']['selected_document_count']
            == 2 + self.LONG_TITLE_COUNT
        )

    def test_a_ten_report_share_pays_for_its_own_heading(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """Where the equal share binds, it is the budget's share MINUS what the
        block costs around the content, pinned from both sides at the cut.

        Without this the overhead subtraction is only observable through whether
        reports survive, which a share one character out in either direction does
        not change — the same gap the small-selection test closed for the
        per-report cap."""
        from jobs.document_generator.handler import (
            _RESEARCH_BLOCK_OVERHEAD,
            RESEARCH_TOTAL_CAP,
        )

        share = RESEARCH_TOTAL_CAP // self.LONG_TITLE_COUNT - _RESEARCH_BLOCK_OVERHEAD
        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [PRD_NEW]}],
            prfaq_pages=[{'Items': [PRFAQ]}],
            documents={
                f'RESEARCH#research_{i}': {
                    'document_id': f'research_{i}',
                    'title': f'Report {i}',
                    'content': ('z' * (share - 1)) + 'CUT_HERE' + ('z' * 500),
                }
                for i in range(self.LONG_TITLE_COUNT)
            },
        )
        mock_converse.return_value = HTML

        _run(
            sample_job_event, lambda_context, use_research=True,
            selected_research_ids=[f'research_{i}' for i in range(self.LONG_TITLE_COUNT)],
        )

        prompt = _prompt(mock_converse)
        assert 'z' * (share - 1) + 'C' in prompt, 'cut before the share'
        assert 'z' * (share - 1) + 'CU' not in prompt, 'cut past the share'
        assert 'CUT_HERE' not in prompt

    def test_a_small_selection_is_sliced_exactly_as_before(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The aggregate bound must not quietly tighten the common case. At four
        reports the equal share is 12000 // 4 == 3000, which IS the per-report cap,
        so nothing up to four is affected — asserted by giving one report a body
        longer than the per-report cap and seeing it cut at exactly that cap."""
        from jobs.document_generator.handler import RESEARCH_PER_DOC_CAP

        long_report = {
            'document_id': 'research_long', 'title': 'Long report',
            'content': ('z' * (RESEARCH_PER_DOC_CAP - 1)) + 'CUT_HERE' + ('z' * 500),
        }
        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [PRD_NEW]}],
            prfaq_pages=[{'Items': [PRFAQ]}],
            documents={'RESEARCH#research_long': long_report},
        )
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context, use_research=True,
             selected_research_ids=['research_long'])

        prompt = _prompt(mock_converse)
        # Pinned from BOTH sides, so the cut lands on exactly RESEARCH_PER_DOC_CAP.
        # `in prompt` alone was satisfied by any cut at or past the cap, which let a
        # share one character tighter than the cap pass — found by mutation.
        assert 'z' * (RESEARCH_PER_DOC_CAP - 1) + 'C' in prompt, 'cut before the cap'
        assert 'z' * (RESEARCH_PER_DOC_CAP - 1) + 'CU' not in prompt, 'cut past the cap'
        assert 'CUT_HERE' not in prompt


class TestTheHardCeilingIsStillAGuard:
    """
    `body[:RESEARCH_TOTAL_CAP]` no longer bounds the section — the shares pay for
    their own headings, so at every arity the API can reach (ten) the slice is a
    no-op. Which would leave it untested, so this is where it is exercised.

    The by-construction argument has a floor: the share is
    `RESEARCH_TOTAL_CAP // n - overhead`, which reaches zero at about 94 reports,
    and past that the HEADINGS ALONE exceed the budget however little content each
    block carries. `_research_section` is called directly because that arity cannot
    be reached through the route — the guard is what is under test, not the path.
    """

    ARITY = 200

    @staticmethod
    def _documents(count):
        return [
            {'document_id': f'research_{i}', 'title': 'T' * 200, 'content': 'x' * 500}
            for i in range(count)
        ]

    def test_headings_alone_cannot_take_the_section_past_the_total(self):
        from jobs.document_generator.handler import (
            RESEARCH_TITLE_CAP,
            RESEARCH_TOTAL_CAP,
            _research_section,
        )

        # Vacuity guard: at this arity the headings must exceed the budget on their
        # own, or the slice is a no-op here too and this asserts nothing.
        heading = len('### ') + RESEARCH_TITLE_CAP + len('\n')
        assert self.ARITY * heading > RESEARCH_TOTAL_CAP

        section = _research_section(self._documents(self.ARITY))

        assert len(section) == len('\n\nRESEARCH FINDINGS:\n') + RESEARCH_TOTAL_CAP

    def test_a_share_that_goes_negative_takes_no_content_rather_than_all_of_it(self):
        """The share is a subtraction, so at this arity it goes negative, and
        `content[:-67]` keeps everything BUT the last 67 characters — the opposite
        of a cap. Clamping at zero is what makes "no room left for content" mean
        no content."""
        from jobs.document_generator.handler import _research_section

        section = _research_section(self._documents(self.ARITY))

        assert 'x' not in section, 'content reached the prompt through a negative slice'


class TestTheDerivationReportsWhatWasUsed:
    """
    The real `_product_context` and the real `build_product_context_block`, over a
    project with EXACTLY ONE filled field.

    One field is the discriminating fixture: a fully-filled context cannot tell a
    computed flag from a hardcoded `True`, and an empty one cannot tell it from a
    hardcoded `False`. Both directions are asserted here, from the same shape of
    fixture, so neither constant survives.
    """

    @staticmethod
    def _context(**fields):
        base = {
            'product_name': '', 'one_liner': '', 'current_state': '', 'target_users': '',
            'problem_solved': '', 'key_features': '', 'differentiators': '',
            'known_limitations': '', 'non_goals': '', 'success_metrics': '', 'free_form_notes': '',
        }
        return {'context': {**base, **fields}}

    def test_one_filled_field_is_reported_as_grounding(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        _wire_one_of_each(mock_dynamodb)
        mock_converse.return_value = HTML

        with patch('api.product_context.get_context', return_value=self._context(one_liner='A console for wombats')), \
                patch('api.product_context._list_doc_items', return_value=[]):
            _run(sample_job_event, lambda_context, use_product_context=True)

        assert 'A console for wombats' in _prompt(mock_converse)
        assert _saved(mock_dynamodb)['derivation']['product_context_included'] is True

    def test_an_empty_product_context_is_not_reported_as_grounding(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The box was ticked and the read succeeded, but there was nothing to
        say. The placeholder must not reach the prompt (it spends budget telling
        the model nothing) and the document must not claim it was grounded."""
        _wire_one_of_each(mock_dynamodb)
        mock_converse.return_value = HTML

        with patch('api.product_context.get_context', return_value=self._context()), \
                patch('api.product_context._list_doc_items', return_value=[]):
            _run(sample_job_event, lambda_context, use_product_context=True)

        assert 'No product context provided' not in _prompt(mock_converse)
        assert _saved(mock_dynamodb)['derivation']['product_context_included'] is False


class TestAskingForNeitherChangesNothing:
    def test_the_prompt_is_byte_identical_to_the_pre_feature_prompt(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """Golden file, captured by running this exact fixture on the tree before
        the two sections existed. A substring assertion would not notice an extra
        blank line where an empty section sits, or two sections swapping places —
        and every existing caller sends neither flag, so this prompt is what the
        feature must leave alone.

        Regenerating the golden file to make this pass is only correct if the
        prompt change is intended for builds that ask for NOTHING, which is
        exactly the promise being made.
        """
        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [{**PRD_NEW, 'document_id': 'prd_1',
                                   'content': 'PRD body for the golden prompt'}]}],
            prfaq_pages=[{'Items': [{**PRFAQ, 'content': 'PRFAQ body for the golden prompt'}]}],
            project_name='Golden Project',
        )
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context, title='Golden Prototype')

        assert _prompt(mock_converse) == GOLDEN_PROMPT.read_text(encoding='utf-8')

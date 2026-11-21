"""7.63.00's event feedback through the form API (lambda/api/feedback_form_handler.py; docs/feedback-forms.md
"Report" and "Compare"): the template a form is made from (set on create, kept by every save, read back), the report
by segment (``group_by``, at least 5 responses each, the smallest withheld with a withheld merged group), the report
(KPIs, heatmaps, themes with real quotes, the stored AI summary joined against the reader's own rows under its own
filters), the comparison of forms (another workspace's form is the 404, ``by`` only with another form), their gates (a
viewer 403), and a form's delete taking its stored reports with it.

Against moto tables, with the fixtures and helpers of test_feedback_form_v2.py.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from test_feedback_form_v2 import EDITOR, VIEWER, WS, _call, _create, _rows
from test_feedback_form_v2 import world as v2_world

from shared.test.source_profile_fixtures import no_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)
#: test_feedback_form_v2.py's moto tables and wired handler.
world = v2_world

WORKSHOP: dict[str, Any] = {
    'name': 'Example Ltd workshop', 'enabled': False, 'language': 'en', 'languages': ['en'],
    'welcome': {'enabled': True, 'title': {'en': 'Thanks for joining {{event|the workshop}}'}},
    'template': {'id': 'workshop', 'version': 1},
    'questions': [
        {'id': 'q_role', 'type': 'single_select', 'headline': {'en': 'Role'}, 'required': True,
         'options': [{'code': 'product', 'label': {'en': 'Product'}}, {'code': 'qa', 'label': {'en': 'QA'}}]},
        {'id': 'q_value', 'type': 'rating', 'headline': {'en': 'Value'}, 'required': True, 'range': 5,
         'logic': [{'when': {'op': 'gt', 'value': 2}, 'then': {'jump_to': 'q_takeaway'}}]},
        {'id': 'q_value_why', 'type': 'open_text', 'headline': {'en': 'Why {{q_value}}?'}, 'required': False},
        {'id': 'q_takeaway', 'type': 'open_text', 'headline': {'en': 'Takeaway'}, 'required': False},
        {'id': 'q_contact', 'type': 'contact_info', 'headline': {'en': 'Contact'}, 'required': False,
         'fields': {'email': {'show': True, 'required': False}}},
    ],
    'hidden_fields': [{'id': 'customer'}, {'id': 'event'}, {'id': 'event_date'}],
    'endings': [{'id': 'end_thanks', 'title': {'en': 'Thanks'}}],
}


def _feedback(form_id: str, n: int, *, customer: str, value: int, text: str = '', pk: str = 'SOURCE#Acme',
              category: str = 'content') -> dict[str, Any]:
    answers: dict[str, Any] = {'q_role': {'code': 'product' if n % 2 else 'qa'}, 'q_value': value,
                               'q_contact': {'email': f'p{n}@example.com'}}
    if text:
        answers['q_takeaway'] = text
    return {'pk': pk, 'sk': f'FEEDBACK#{form_id}-{n}', 'feedback_id': f'{form_id}-{n}',
            'source_platform': 'feedback_form', 'source_channel': f'form_{form_id}', 'category': category,
            'subcategory': 'labs', 'source_created_at': f'2026-11-{10 + n:02d}T10:00:00', 'original_text': text or 'x',
            'sentiment_label': 'positive',
            'metadata': {'form_answers': answers, 'form_path': list(answers), 'form_ending_id': 'end_thanks',
                         'form_revision': 1, 'form_language': 'en',
                         'form_hidden': {'customer': customer, 'event_date': '2026-11-01'}}}


@pytest.fixture
def seeded(world, lambda_context) -> str:
    fid = _create(lambda_context, WORKSHOP)['form_id']
    for n in range(7):
        world['feedback'].put_item(Item=_feedback(fid, n, customer='Example Ltd', value=5,
                                                  text='Loved the labs' if n < 3 else ''))
    for n in range(7, 9):
        world['feedback'].put_item(Item=_feedback(fid, n, customer='Sample Co', value=1))
    return fid


@pytest.mark.usefixtures('world')
class TestTheTemplateAFormIsMadeFrom:
    def test_it_is_stored_on_create_read_back_and_kept_by_every_save(self, lambda_context):
        form = _create(lambda_context, WORKSHOP)
        assert form['template'] == {'id': 'workshop', 'version': 1}
        status, saved = _call(lambda_context, 'PUT', f"/feedback-forms/{form['form_id']}",
                              body={**WORKSHOP, 'template': {'id': 'nps', 'version': 9}, 'name': 'Renamed'})
        assert (status, saved['form']['template']) == (200, {'id': 'workshop', 'version': 1})

    def test_a_form_made_otherwise_names_none(self, lambda_context):
        assert 'template' not in _create(lambda_context, {k: v for k, v in WORKSHOP.items() if k != 'template'})

    @pytest.mark.parametrize('template', [{'id': 'Workshop'}, {'id': 'workshop', 'version': 0}, 'workshop',
                                          {'id': 'workshop', 'extra': 1}])
    def test_a_malformed_one_is_a_400(self, lambda_context, template):
        status, answer = _call(lambda_context, 'POST', '/feedback-forms', body={**WORKSHOP, 'template': template})
        assert status == 400, answer


@pytest.mark.usefixtures('world')
class TestTheReportBySegment:
    def test_group_by_a_hidden_field_withholds_the_smallest_segment_with_the_merged_one(self, seeded, lambda_context):
        status, report = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/report',
                               query={'group_by': 'hidden.customer'})
        assert status == 200, report
        assert report['responses'] == 9
        # (Sample Co's 2 are merged and withheld; the report's KPIs less Example Ltd's 7 would be theirs, so Example
        # Ltd's figures are withheld with them)
        assert report['segments']['groups'] == [{'value': 'Example Ltd', 'responses': 7, 'scores': None,
                                                 'withheld': 'complement'}]
        assert report['segments']['merged'] == {'segments': 1, 'responses': 2, 'scores': None}

    def test_results_carry_no_segments_and_an_unknown_group_by_is_a_400_on_the_report(self, seeded, lambda_context):
        status, results = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/results',
                                query={'group_by': 'hidden.customer'})
        assert (status, 'segments' in results) == (200, False)
        by_id = {q['id']: q for q in results['questions']}
        assert by_id['q_value_why']['follow_up_of'] == 'q_value'
        status, answer = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/report',
                               query={'group_by': 'hidden.plan'})
        assert (status, answer['code']) == (400, 'group_by_invalid')


@pytest.mark.usefixtures('world')
class TestTheReport:
    def test_it_holds_kpis_segments_and_themes_with_real_quotes_never_a_contact(self, seeded, lambda_context):
        status, report = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/report',
                               query={'group_by': 'q_role'})
        assert status == 200, report
        assert (report['name'], report['template'], report['responses'], report['min_segment']) == (
            'Example Ltd workshop', {'id': 'workshop', 'version': 1}, 9, 5)
        assert report['first_response_at'] == '2026-11-10T10:00:00'
        [value] = report['kpis']
        assert (value['id'], value['average']) == ('q_value', round((7 * 5 + 2) / 9, 2))
        assert [(g['value'], g['scores'], g.get('withheld')) for g in report['segments']['groups']] == [
            ('qa', None, 'complement')]
        takeaway = next(entry for entry in report['themes'] if entry['question_id'] == 'q_takeaway')
        [labs] = takeaway['themes']
        assert (labs['count'], len(labs['quotes']), labs['quotes'][0]['text']) == (3, 3, 'Loved the labs')
        assert 'example.com' not in str(report)
        assert report['ai'] is None

    def test_the_newest_stored_summary_is_joined_against_the_readers_rows(self, world, seeded, lambda_context):
        for report_id, label in (('rpt_20261101000000aaaaaaaa', 'Old'), ('rpt_20261115000000bbbbbbbb', 'Labs')):
            world['aggregates'].put_item(Item={
                'pk': 'FEEDBACK_FORM', 'sk': f'FORMREPORT#{seeded}#{report_id}', 'form_id': seeded,
                'report_id': report_id, 'created_at': '2026-11-15T00:00:00+00:00', 'responses_counted': 3,
                'last_response_at': '2026-11-12T10:00:00', 'response_ids': [f'{seeded}-0', f'{seeded}-1'],
                'themes': [{'label': label, 'count': 2, 'sentiment': 'positive',
                            'quote_ids': [f'{seeded}-1', 'gone']}],
                'ai': {'model': 'm', 'prompt_version': '1.0.0', 'summary': f'{label} summary'}})
        ai = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/report')[1]['ai']
        assert (ai['report_id'], ai['summary'], ai['stale']) == ('rpt_20261115000000bbbbbbbb', 'Labs summary', True)
        assert ai['themes'][0]['quotes'] == [{'response_id': f'{seeded}-1', 'text': 'Loved the labs'}]

    def test_a_summary_made_for_one_customer_quotes_that_customer_only_under_any_view(self, world, seeded,
                                                                                   lambda_context):
        world['feedback'].put_item(Item=_feedback(seeded, 9, customer='Sample Co', value=2, text='Sample Co text'))
        world['aggregates'].put_item(Item={
            'pk': 'FEEDBACK_FORM', 'sk': f'FORMREPORT#{seeded}#rpt_20261115000000cccccccc', 'form_id': seeded,
            'report_id': 'rpt_20261115000000cccccccc', 'created_at': '2026-11-15T00:00:00+00:00',
            'responses_counted': 7, 'last_response_at': '2026-11-16T10:00:00',
            'filters': {'hidden.customer': 'Example Ltd', 'days': 'all'},
            'response_ids': [f'{seeded}-0', f'{seeded}-1', f'{seeded}-2'],
            'themes': [{'label': 'Labs', 'count': 2, 'sentiment': 'positive',
                        'quote_ids': [f'{seeded}-9', f'{seeded}-2']}],
            'ai': {'model': 'm', 'prompt_version': '1.0.0', 'summary': 'Example Ltd liked the labs'}})
        for query in ({'hidden.customer': 'Sample Co'}, {}):
            ai = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/report', query=query)[1]['ai']
            # (Sample Co's newer response is neither quoted nor makes it stale: it was made for Example Ltd)
            assert (ai['filters'], ai['stale']) == ({'hidden.customer': 'Example Ltd', 'days': 'all'}, False)
            assert ai['themes'][0]['quotes'] == [{'response_id': f'{seeded}-2', 'text': 'Loved the labs'}]

    def test_a_viewer_is_refused_the_report_and_the_comparison(self, lambda_context):
        ws_form = _create(lambda_context, WORKSHOP, claims=EDITOR, ws=WS)['form_id']
        for route in ('report', 'compare'):
            assert _call(lambda_context, 'GET', f'/feedback-forms/{ws_form}/{route}', claims=VIEWER, ws=WS)[0] == 403
            assert _call(lambda_context, 'GET', f'/feedback-forms/{ws_form}/{route}', claims=EDITOR, ws=WS)[0] == 200


@pytest.mark.usefixtures('world')
class TestComparingForms:
    def test_forms_of_one_template_line_up_and_a_workspaces_form_is_not_found(self, world, seeded, lambda_context):
        other = _create(lambda_context, {**WORKSHOP, 'name': 'Sample Co workshop'})['form_id']
        for n in range(5):
            world['feedback'].put_item(Item=_feedback(other, n, customer='Sample Co', value=3))
        status, out = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/compare', query={'with': f'{other},{seeded}'})
        assert status == 200, out
        assert [f['form_id'] for f in out['forms']] == [seeded, other]
        assert all(f['same_template'] for f in out['forms'])
        assert [p['scores']['q_value']['average'] for p in out['points']] == [round(37 / 9, 2), 3.0]
        ws_form = _create(lambda_context, WORKSHOP, claims=EDITOR, ws=WS)['form_id']
        status, answer = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/compare', query={'with': ws_form})
        assert (status, answer['error']) == (404, 'Form not found')

    def test_the_brands_partition_is_read_once_for_every_compared_form(self, world, seeded, lambda_context):
        """Review round 1 of the second gate (7.66.00): Compare reads each brand partition once for all the compared
        forms' channels (an IN), then splits the rows by form, as the forms list's stats do."""
        import feedback_form_handler
        others = [_create(lambda_context, {**WORKSHOP, 'name': f'Workshop {n}'})['form_id'] for n in range(3)]
        for other in others:
            for n in range(5):
                world['feedback'].put_item(Item=_feedback(other, n, customer='Sample Co', value=3))
        real = feedback_form_handler._partition_rows
        reads: list[str] = []

        def counted(table, scope, source_pk, query_kwargs):
            reads.append(source_pk)
            return real(table, scope, source_pk, query_kwargs)

        with patch.object(feedback_form_handler, '_partition_rows', side_effect=counted):
            status, out = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/compare',
                                query={'with': ','.join(others)})
        assert status == 200, out
        assert len(reads) == len(set(reads)) == 1
        assert {point['form_id']: point['responses'] for point in out['points']} == {
            seeded: 9, **dict.fromkeys(others, 5)}

    def test_by_a_hidden_field_and_the_limits(self, world, seeded, lambda_context):
        other = _create(lambda_context, {**WORKSHOP, 'name': 'Sample Co workshop'})['form_id']
        for n in range(5):
            world['feedback'].put_item(Item=_feedback(other, n, customer='Sample Co', value=3))
        _, out = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/compare',
                       query={'with': other, 'by': 'hidden.event_date'})
        assert [(p['form_id'], p['value'], p['responses']) for p in out['points']] == [
            (seeded, '2026-11-01', 9), (other, '2026-11-01', 5)]
        # (one form split on its own is its report's segments: no trend without another form)
        status, answer = _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/compare',
                               query={'by': 'hidden.event_date'})
        assert (status, answer['code']) == (400, 'group_by_invalid')
        too_many = ','.join(f'fd_{n:032x}' for n in range(11))
        assert _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/compare', query={'with': too_many})[0] == 400
        assert _call(lambda_context, 'GET', f'/feedback-forms/{seeded}/compare',
                     query={'with': other, 'by': 'q_role'})[0] == 400


@pytest.mark.usefixtures('world')
class TestDeletingAForm:
    def test_its_stored_reports_go_with_it(self, world, seeded, lambda_context):
        world['aggregates'].put_item(Item={'pk': 'FEEDBACK_FORM', 'sk': f'FORMREPORT#{seeded}#rpt_1', 'form_id': seeded})
        assert _call(lambda_context, 'DELETE', f'/feedback-forms/{seeded}')[0] == 200
        assert _rows(world, f'FORMREPORT#{seeded}#') == []

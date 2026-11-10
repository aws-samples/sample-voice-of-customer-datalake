"""`PUT /projects/prioritization/rows/{row_id}/lineage-ack`, against real (moto) tables (#399).

A row composed ON PURPOSE of two versions of one document type (PRD v1 + PRD v2) is
labelled `Crosses generations` on the page. These tests pin the server half of "keep both
versions": the mark is stored on the row for the exact document set the reviewer saw,
read back on the page read, withdrawable, refused for a set that is not the row's, and
left in place (but no longer matching) when the row is recomposed — which is what makes
it lapse on the page.
"""
from unittest.mock import MagicMock

import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

PARTITION = 'PRIORITIZATION'
OWNER, VIEWER, STRANGER, ADMIN = 'owner-1', 'viewer-1', 'stranger-1', 'admin-1'
# `MAX_ROW_DOCUMENT_IDS` in projects_handler.py; the acknowledgement takes the row's own bound.
ROW_BOUND = 25
AXES = {'impact': 4, 'time_to_market': 3, 'confidence': 2, 'strategic_fit': 5}


def _seed(projects):
    """p1 (private): two PRD versions and a PR/FAQ. p2 (public): one PRD."""
    projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Example Air',
                            'visibility': 'private', 'owner_sub': OWNER,
                            'members': {VIEWER: {'role': 'viewer', 'username': 'vic'}}})
    for sk, doc_id, created in (('PRD#v1', 'prd_v1', '2026-01-01'), ('PRD#v2', 'prd_v2', '2026-02-01'),
                                ('PRFAQ#f1', 'prfaq_1', '2026-02-02')):
        projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': sk, 'document_id': doc_id, 'created_at': created})
    projects.put_item(Item={'pk': 'PROJECT#p2', 'sk': 'META', 'project_id': 'p2', 'name': 'Other',
                            'visibility': 'public', 'owner_sub': OWNER})
    projects.put_item(Item={'pk': 'PROJECT#p2', 'sk': 'PRD#x', 'document_id': 'p2_prd', 'created_at': '2026-01-01'})
    return projects


def _claims(subject: str) -> dict:
    """Cognito claims for `subject`; only ADMIN is in the admins group."""
    return {'sub': subject, 'cognito:groups': 'admins' if subject == ADMIN else ''}


def _call(tables, method, path, body=None, subject=ADMIN):
    """One request through `projects_handler.lambda_handler`, both tables real."""
    import projects_handler

    event = rest_event(method, path, claims=_claims(subject), body=body)
    return invoke(projects_handler, event, MagicMock(), aggregates=tables[0], projects=tables[1])


def _ack(tables, row_id, document_ids, acknowledged=True, project_id='p1', subject=ADMIN):
    return _call(tables, 'PUT', f'/projects/prioritization/rows/{row_id}/lineage-ack',
                 {'project_id': project_id, 'acknowledged': acknowledged, 'document_ids': document_ids},
                 subject=subject)


def _stored_row(tables, row_id) -> dict:
    item = tables[0].get_item(Key={'pk': PARTITION, 'sk': f'ROW#{row_id}'}).get('Item')
    assert item is not None
    return dict(item)


@pytest.fixture
def two_versions():
    """Real tables plus one row composed of PRD v1 + PRD v2: `(tables, row_id)`."""
    with mock_aws():
        tables = (pk_sk_table('aggr'), _seed(pk_sk_table('projects')))
        status, body = _call(tables, 'POST', '/projects/prioritization/rows/compose',
                             {'project_id': 'p1', 'document_ids': ['prd_v2', 'prd_v1']})
        assert status == 200
        yield tables, body['row']['row_id']


class TestMarkingARowIntentional:
    def test_the_mark_is_stored_for_the_rows_document_set_in_any_order(self, two_versions):
        tables, row_id = two_versions

        status, body = _ack(tables, row_id, ['prd_v1', 'prd_v2'])

        assert status == 200
        assert body['row']['lineage_ack']['document_ids'] == ['prd_v1', 'prd_v2']
        assert body['row']['lineage_ack']['acknowledged_at']
        stored = _stored_row(tables, row_id)['lineage_ack']
        assert stored['document_ids'] == ['prd_v1', 'prd_v2']
        assert stored['acknowledged_by'] == ADMIN

    def test_who_marked_it_is_kept_for_audit_but_never_published(self, two_versions):
        tables, row_id = two_versions

        _, body = _ack(tables, row_id, ['prd_v2', 'prd_v1'])

        assert set(body['row']['lineage_ack']) == {'document_ids', 'acknowledged_at'}

    def test_the_page_read_carries_the_mark(self, two_versions):
        tables, row_id = two_versions
        _ack(tables, row_id, ['prd_v2', 'prd_v1'])

        status, body = _call(tables, 'GET', '/projects/prioritization')

        assert status == 200
        assert body['rows'][row_id]['lineage_ack']['document_ids'] == ['prd_v1', 'prd_v2']

    def test_a_row_nobody_marked_reads_null(self, two_versions):
        tables, row_id = two_versions

        _, body = _call(tables, 'GET', '/projects/prioritization')

        assert body['rows'][row_id]['lineage_ack'] is None

    def test_a_balloted_row_can_still_be_marked(self, two_versions):
        tables, row_id = two_versions
        status, _ = _call(tables, 'PATCH', '/projects/prioritization', {'scores': {row_id: AXES}})
        assert status == 200
        assert _stored_row(tables, row_id).get('first_ballot_at')

        status, body = _ack(tables, row_id, ['prd_v1', 'prd_v2'])

        assert status == 200
        assert body['row']['is_frozen'] is True
        assert body['row']['lineage_ack'] is not None


class TestWithdrawingTheMark:
    def test_unmarking_removes_the_stored_mark(self, two_versions):
        tables, row_id = two_versions
        _ack(tables, row_id, ['prd_v1', 'prd_v2'])

        status, body = _ack(tables, row_id, ['prd_v1', 'prd_v2'], acknowledged=False)

        assert status == 200
        assert body['row']['lineage_ack'] is None
        assert 'lineage_ack' not in _stored_row(tables, row_id)

    def test_unmarking_a_row_that_holds_no_mark_is_harmless(self, two_versions):
        tables, row_id = two_versions

        status, body = _ack(tables, row_id, ['prd_v1', 'prd_v2'], acknowledged=False)

        assert status == 200
        assert body['row']['lineage_ack'] is None

    def test_unmarking_a_row_that_holds_no_mark_writes_nothing(self, two_versions):
        tables, row_id = two_versions
        before = _stored_row(tables, row_id)

        status, _ = _ack(tables, row_id, ['prd_v1', 'prd_v2'], acknowledged=False)

        assert status == 200
        assert _stored_row(tables, row_id) == before


class TestTheMarkLapsesWithTheComposition:
    def test_a_recomposed_row_keeps_the_old_set_so_it_no_longer_matches(self, two_versions):
        tables, row_id = two_versions
        _ack(tables, row_id, ['prd_v1', 'prd_v2'])

        status, _ = _call(tables, 'PATCH', f'/projects/prioritization/rows/{row_id}',
                          {'project_id': 'p1', 'document_ids': ['prd_v1', 'prd_v2', 'prfaq_1']})
        assert status == 200

        _, body = _call(tables, 'GET', '/projects/prioritization')
        row = body['rows'][row_id]
        assert sorted(row['document_ids']) == ['prd_v1', 'prd_v2', 'prfaq_1']
        assert row['lineage_ack']['document_ids'] == ['prd_v1', 'prd_v2']

    def test_recomposing_back_to_the_marked_set_applies_the_mark_again(self, two_versions):
        """Pinned on purpose (docs/prioritization.md): the mark is about a SET, so a row
        holding exactly that set again reads as acknowledged without a new mark."""
        tables, row_id = two_versions
        _ack(tables, row_id, ['prd_v1', 'prd_v2'])
        for document_ids in (['prd_v1', 'prd_v2', 'prfaq_1'], ['prd_v2', 'prd_v1']):
            status, _ = _call(tables, 'PATCH', f'/projects/prioritization/rows/{row_id}',
                              {'project_id': 'p1', 'document_ids': document_ids})
            assert status == 200

        _, body = _call(tables, 'GET', '/projects/prioritization')
        row = body['rows'][row_id]
        assert sorted(row['document_ids']) == row['lineage_ack']['document_ids'] == ['prd_v1', 'prd_v2']

    def test_marking_a_set_the_row_does_not_hold_is_a_409_that_writes_nothing(self, two_versions):
        tables, row_id = two_versions

        status, body = _ack(tables, row_id, ['prd_v1'])

        assert status == 409
        assert 'reload' in body['error']
        assert 'lineage_ack' not in _stored_row(tables, row_id)


class TestWhoMayMarkARow:
    def test_a_viewer_of_the_project_is_refused(self, two_versions):
        tables, row_id = two_versions

        status, _ = _ack(tables, row_id, ['prd_v1', 'prd_v2'], subject=VIEWER)

        assert status == 403
        assert 'lineage_ack' not in _stored_row(tables, row_id)

    def test_a_stranger_to_a_private_project_learns_nothing(self, two_versions):
        tables, row_id = two_versions

        status, _ = _ack(tables, row_id, ['prd_v1', 'prd_v2'], subject=STRANGER)

        assert status == 404

    def test_naming_another_project_answers_404_and_writes_nothing(self, two_versions):
        tables, row_id = two_versions

        status, _ = _ack(tables, row_id, ['prd_v1', 'prd_v2'], project_id='p2', subject=OWNER)

        assert status == 404
        assert 'lineage_ack' not in _stored_row(tables, row_id)

    def test_a_row_that_does_not_exist_answers_404(self, two_versions):
        tables, _ = two_versions

        status, _ = _ack(tables, 'row_missing', ['prd_v1', 'prd_v2'])

        assert status == 404


class TestTheRequestBody:
    @pytest.mark.parametrize('body', [
        {'project_id': 'p1', 'document_ids': ['prd_v1', 'prd_v2']},
        {'project_id': 'p1', 'acknowledged': 'true', 'document_ids': ['prd_v1', 'prd_v2']},
        {'project_id': 'p1', 'acknowledged': True},
        {'project_id': 'p1', 'acknowledged': True, 'document_ids': []},
        {'project_id': 'p1', 'acknowledged': True, 'document_ids': 'prd_v1'},
        {'project_id': 'p1', 'acknowledged': True, 'document_ids': ['prd_v1', '']},
        {'project_id': 'p1', 'acknowledged': True, 'document_ids': ['prd_v1', 'prd_v1']},
        {'project_id': 'p1', 'acknowledged': True, 'document_ids': [f'd{n}' for n in range(ROW_BOUND + 1)]},
    ], ids=['no-acknowledged', 'string-acknowledged', 'no-ids', 'empty-ids', 'ids-not-a-list',
            'blank-id', 'duplicate-id', 'over-the-row-bound'])
    def test_a_malformed_body_is_a_400_that_writes_nothing(self, two_versions, body):
        tables, row_id = two_versions

        status, _ = _call(tables, 'PUT', f'/projects/prioritization/rows/{row_id}/lineage-ack', body)

        assert status == 400
        assert 'lineage_ack' not in _stored_row(tables, row_id)


class TestAStoredMarkReadsDefensively:
    def test_the_bound_here_is_the_rows_own(self):
        import projects_handler
        from shared.row_lineage_ack import MAX_PUBLISHED_DOCUMENT_IDS

        assert projects_handler.MAX_ROW_DOCUMENT_IDS == ROW_BOUND
        assert MAX_PUBLISHED_DOCUMENT_IDS == ROW_BOUND

    def test_a_mark_longer_than_any_row_is_not_published(self):
        from shared.row_lineage_ack import published_ack

        ids = [f'doc_{i}' for i in range(ROW_BOUND + 1)]
        assert published_ack({'lineage_ack': {'document_ids': ids, 'acknowledged_at': ''}}) is None
        assert published_ack({'lineage_ack': {'document_ids': ids[:ROW_BOUND], 'acknowledged_at': ''}}) is not None

    @pytest.mark.parametrize('stored', [
        'yes', {'document_ids': 'prd_v1'}, {'document_ids': []}, {'document_ids': [1, None]},
        {'document_ids': ['prd_v1', 5]}, {'document_ids': ['prd_v1', '']},
    ], ids=['not-a-map', 'ids-not-a-list', 'empty-ids', 'no-string-ids', 'one-non-string-id', 'one-empty-id'])
    def test_a_malformed_stored_mark_reads_as_none(self, stored):
        """All or nothing: a partly readable set is never published as the smaller set."""
        from shared.row_lineage_ack import published_ack

        assert published_ack({'lineage_ack': stored}) is None

    @pytest.mark.parametrize(('left', 'right', 'same'), [
        (['a', 'b'], ['b', 'a'], True),
        (['a', 'a', 'b'], ['a', 'b', 'b'], False),
        (['a', 'b'], ['a', 'b', 'b'], False),
        (['a'], ['b'], False),
    ], ids=['any-order', 'same-length-other-duplicates', 'extra-duplicate', 'different'])
    def test_the_set_comparison_counts_duplicates(self, left, right, same):
        """Agrees with the page's `sameDocumentSet`, which refuses a duplicated list."""
        from shared.row_lineage_ack import same_document_set

        assert same_document_set(left, right) is same

    def test_an_unreadable_instant_reads_as_empty(self):
        from shared.row_lineage_ack import published_ack

        assert published_ack({'lineage_ack': {'document_ids': ['a'], 'acknowledged_at': 5}}) == {
            'document_ids': ['a'], 'acknowledged_at': '',
        }

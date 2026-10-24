"""
Tests for projects.py - Projects API core functions.
"""
import json
import os
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

from shared.project_access import Caller

# A signed-in workspace admin: sees every project, as before permissions.
ADMIN_CALLER = Caller(
    subject='test-user-id', is_admin=True, username='tester', email='test@example.com',
)


class TestDeleteProject:
    """Tests for delete_project function."""

    @patch('projects._sweep_project_objects')
    @patch('projects._delete_project_job_rows', MagicMock())
    @patch('projects.projects_table')
    def test_deletes_project_and_version_assignment_partitions(self, mock_table, sweep):
        """Deletes project rows, counters, and durable legacy assignments."""
        mock_table.query.side_effect = [
            {
                'Items': [
                    {'pk': 'PROJECT#proj-1', 'sk': 'META'},
                    {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#p1'},
                ],
            },
            {
                'Items': [
                    {'pk': 'DOCUMENT_VERSIONS#PROJECT#proj-1', 'sk': 'PRD#counter'},
                    {
                        'pk': 'DOCUMENT_VERSIONS#PROJECT#proj-1',
                        'sk': 'LEGACY_ASSIGNMENT#PRD#counter#d1',
                    },
                ],
            },
        ]
        batch = MagicMock()
        mock_table.batch_writer.return_value.__enter__.return_value = batch

        from projects import delete_project

        result = delete_project('proj-1')

        assert result['success'] is True
        assert mock_table.query.call_count == 2
        assert all(
            query.kwargs['ProjectionExpression'] == 'pk, sk'
            for query in mock_table.query.call_args_list
        )
        assert mock_table.update_item.call_count == 2
        fence_call, complete_call = [
            item.kwargs for item in mock_table.update_item.call_args_list
        ]
        assert fence_call['Key'] == {'pk': 'PROJECT#proj-1', 'sk': 'META'}
        assert 'if_not_exists(#deleting, :now)' in fence_call['UpdateExpression']
        assert 'REMOVE gsi1pk, gsi1sk' in fence_call['UpdateExpression']
        assert complete_call['ExpressionAttributeValues'][':deleted'] == 'deleted'
        assert 'deleted_at = if_not_exists' in complete_call['UpdateExpression']
        assert mock_table.batch_writer.call_count == 2
        batch.delete_item.assert_has_calls([
            call(Key={'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#p1'}),
            call(Key={
                'pk': 'DOCUMENT_VERSIONS#PROJECT#proj-1', 'sk': 'PRD#counter',
            }),
            call(Key={
                'pk': 'DOCUMENT_VERSIONS#PROJECT#proj-1',
                'sk': 'LEGACY_ASSIGNMENT#PRD#counter#d1',
            }),
        ])
        mock_table.delete_item.assert_not_called()
        # The persona id is collected from the row sweep for the avatar sweep.
        sweep.assert_called_once_with('proj-1', ['p1'])

    @patch('projects.projects_table', None)
    def test_returns_error_when_table_not_configured(self):
        """Returns error when table not configured."""
        from projects import delete_project
        from shared.exceptions import ConfigurationError

        with pytest.raises(ConfigurationError):
            delete_project('proj-1')


class TestGetAvatarCdnUrl:
    """Tests for get_avatar_cdn_url function."""

    @pytest.mark.usefixtures("cdn_signing_configured")
    def test_converts_s3_uri_to_signed_cdn_url(self):
        """Converts S3 URI to a SIGNED CloudFront CDN URL (issue #229)."""
        from shared.avatar import get_avatar_cdn_url

        s3_uri = 's3://bucket/avatars/persona_123.png'
        result = get_avatar_cdn_url(s3_uri, cdn_url='https://cdn.example.com')

        assert result is not None
        assert result.startswith('https://cdn.example.com/persona_123.png?')
        assert 'Signature=' in result
        assert 'Expires=' in result

    def test_returns_none_when_cdn_not_configured(self):
        """Returns None when CDN URL not configured."""
        from shared.avatar import get_avatar_cdn_url

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('AVATARS_CDN_URL', None)
            result = get_avatar_cdn_url('s3://bucket/avatars/test.png', cdn_url='')

        assert result is None

    def test_returns_none_for_invalid_uri(self):
        """Returns None for invalid S3 URI."""
        from shared.avatar import get_avatar_cdn_url

        result = get_avatar_cdn_url('not-an-s3-uri')

        assert result is None

    def test_returns_none_for_empty_uri(self):
        """Returns None for empty URI."""
        from shared.avatar import get_avatar_cdn_url

        result = get_avatar_cdn_url('')

        assert result is None


class TestDocumentVersionBoundaries:
    """Versioned PRD/PRFAQ behavior at the canonical project API boundary."""

    @patch('shared.document_versions.time.sleep')
    @patch('projects.persist_legacy_document_versions')
    @patch('projects.projects_table')
    def test_get_project_canonically_versions_legacy_managed_documents_without_writes(
        self, mock_table, mock_persist, mock_sleep,
    ):
        mock_table.query.side_effect = [
            {
                'Items': [
                    {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Project'},
                    {
                        'pk': 'PROJECT#p1', 'sk': 'PRD#old', 'document_id': 'prd-old',
                        'document_type': 'prd', 'title': 'Launch', 'created_at': '2026-01-01',
                    },
                    {
                        'pk': 'PROJECT#p1', 'sk': 'PRFAQ#old', 'document_id': 'faq-old',
                        'document_type': 'prfaq', 'title': 'Launch FAQ', 'created_at': '2026-01-01',
                    },
                    {
                        'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#old', 'document_id': 'prototype-old',
                        'document_type': 'prototype', 'title': 'Launch App', 'created_at': '2026-01-01',
                    },
                ],
                'LastEvaluatedKey': {'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#old'},
            },
            {
                'Items': [
                    {
                        'pk': 'PROJECT#p1', 'sk': 'PRD#new', 'document_id': 'prd-new',
                        'document_type': 'prd', 'title': 'Launch', 'created_at': '2026-02-01',
                    },
                    {
                        'pk': 'PROJECT#p1', 'sk': 'PRFAQ#new', 'document_id': 'faq-new',
                        'document_type': 'prfaq', 'title': 'Launch FAQ', 'created_at': '2026-02-01',
                    },
                    {
                        'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#new', 'document_id': 'prototype-new',
                        'document_type': 'prototype', 'title': 'Launch App', 'created_at': '2026-02-01',
                    },
                ],
            },
        ]

        from projects import get_project

        documents = get_project('p1')['documents']

        assert {
            document['document_id']: (
                document['base_title'], document['title'], document['version'],
            )
            for document in documents
        } == {
            'prd-old': ('Launch', 'Launch (v1)', 1),
            'prd-new': ('Launch', 'Launch (v2)', 2),
            'faq-old': ('Launch FAQ', 'Launch FAQ (v1)', 1),
            'faq-new': ('Launch FAQ', 'Launch FAQ (v2)', 2),
            'prototype-old': ('Launch App', 'Launch App (v1)', 1),
            'prototype-new': ('Launch App', 'Launch App (v2)', 2),
        }
        assert mock_table.query.call_count == 2
        mock_persist.assert_not_called()
        mock_sleep.assert_not_called()
        mock_table.put_item.assert_not_called()
        mock_table.update_item.assert_not_called()
        mock_table.delete_item.assert_not_called()
        mock_table.transact_write_items.assert_not_called()
        mock_table.meta.client.transact_write_items.assert_not_called()

    @pytest.mark.parametrize('document_type', [
        'prd', 'prfaq', 'prototype', 'research', 'product_report', 'PRD', 'custom ',
    ])
    @patch('projects.projects_table')
    def test_custom_document_route_refuses_every_non_custom_type_with_workflow_guidance(
        self, mock_table, document_type,
    ):
        from projects import create_document
        from shared.exceptions import ValidationError

        with pytest.raises(ValidationError, match='dedicated route'):
            create_document('p1', {
                'title': 'Launch',
                'content': '# Document',
                'document_type': document_type,
            })

        mock_table.put_item.assert_not_called()
        mock_table.update_item.assert_not_called()

    @patch('projects.projects_table')
    def test_custom_document_route_still_creates_custom_documents(self, mock_table):
        mock_table.name = 'test-projects-table'
        from projects import create_document

        result = create_document('p1', {
            'title': 'Operator notes',
            'content': '# Notes',
            'document_type': 'custom',
        })

        assert result['success'] is True
        assert result['document']['document_type'] == 'custom'
        assert result['document']['title'] == 'Operator notes'
        assert result['document']['content'] == '# Notes'
        assert result['document']['sk'].startswith('DOC#doc_')
        transaction = mock_table.meta.client.transact_write_items.call_args.kwargs[
            'TransactItems'
        ]
        assert transaction[0]['Put']['Item'] == result['document']
        count_update = transaction[1]['Update']
        assert count_update['ExpressionAttributeNames']['#count'] == (
            'document_count'
        )
        assert '#status <> :deleting_status' in count_update[
            'ConditionExpression'
        ]
        assert count_update['ExpressionAttributeNames']['#status'] == 'status'
        assert count_update['ExpressionAttributeValues'][':deleting_status'] == (
            'deleting'
        )
        assert count_update['ExpressionAttributeValues'][':deleted_status'] == (
            'deleted'
        )

    @pytest.mark.parametrize(('sk', 'document_type'), [
        ('PRD#d1', 'prd'),
        ('PRFAQ#d1', 'prfaq'),
    ])
    @patch('shared.document_history.persist_versioned_document')
    @patch('projects.projects_table')
    def test_prd_and_prfaq_content_edits_become_a_new_version(
        self, mock_table, mock_persist, sk, document_type,
    ):
        row = {
            'pk': 'PROJECT#p1', 'sk': sk, 'document_id': 'd1',
            'document_type': document_type, 'base_title': 'Launch',
            'title': 'Launch (v2)', 'version': 2, 'content': '# before',
        }
        mock_table.query.return_value = {'Items': [row]}
        mock_table.get_item.return_value = {'Item': row}
        mock_persist.return_value = {'document_id': 'd2', 'version': 3}

        from projects import update_document

        assert update_document('p1', 'd1', {'content': '# edited', 'edit_id': 'e1'}) == {
            'success': True, 'document': {'document_id': 'd2', 'version': 3},
        }
        # Never in place: the stored v2 is untouched, v3 is allocated like a regeneration.
        mock_table.update_item.assert_not_called()
        args = mock_persist.call_args.args
        assert args[1:5] == ('p1', document_type, 'Launch', 'edit:d1:e1')
        assert args[5]['content'] == '# edited'

    @pytest.mark.parametrize(('body', 'refusal'), [
        ({'content': '<html>replacement</html>'}, 'stored in S3'),
        ({'title': 'Different App'}, 'cannot change series'),
    ], ids=['content', 'series'])
    @patch('projects.projects_table')
    def test_a_prototype_is_refused_by_generic_update(self, mock_table, body, refusal):
        mock_table.query.return_value = {
            'Items': [{
                'pk': 'PROJECT#p1', 'sk': 'PROTOTYPE#d1', 'document_id': 'd1',
                'document_type': 'prototype', 'base_title': 'Launch App',
                'title': 'Launch App (v2)', 'version': 2,
            }],
        }
        mock_table.get_item.return_value = {'Item': mock_table.query.return_value['Items'][0]}

        from projects import update_document
        from shared.exceptions import ValidationError

        with pytest.raises(ValidationError, match=refusal):
            update_document('p1', 'd1', body)

        mock_table.update_item.assert_not_called()

    @patch('projects.preserve_versioned_document_allocation')
    @patch('projects.persist_legacy_document_versions')
    @patch('projects.projects_table')
    def test_managed_delete_migrates_snapshot_and_preserves_generated_allocation(
        self, mock_table, mock_persist, mock_preserve,
    ):
        target = {
            'pk': 'PROJECT#p1', 'sk': 'PRD#generated', 'document_id': 'generated',
            'document_type': 'prd', 'base_title': 'Launch', 'title': 'Launch (v2)',
            'version': 2, 'version_allocation_id': 'allocation-2',
        }
        sibling = {
            'pk': 'PROJECT#p1', 'sk': 'PRD#legacy', 'document_id': 'legacy',
            'document_type': 'prd', 'title': 'Launch', 'created_at': '2026-01-01',
        }
        custom = {
            'pk': 'PROJECT#p1', 'sk': 'DOC#notes', 'document_id': 'notes',
            'document_type': 'custom', 'title': 'Notes',
        }
        mock_table.name = 'test-projects-table'
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META'}, target, sibling, custom,
            ],
        }
        events = MagicMock()
        events.attach_mock(mock_persist, 'persist')
        events.attach_mock(mock_preserve, 'preserve')
        events.attach_mock(
            mock_table.meta.client.transact_write_items,
            'transact',
        )

        from projects import delete_document

        assert delete_document('p1', 'generated') == {'success': True}
        assert [event[0] for event in events.method_calls] == [
            'persist', 'preserve', 'transact',
        ]
        mock_persist.assert_called_once_with(
            mock_table, 'p1', [target, sibling, custom],
        )
        mock_preserve.assert_called_once_with(mock_table, 'p1', target)
        transaction = mock_table.meta.client.transact_write_items.call_args.kwargs[
            'TransactItems'
        ]
        assert transaction[0]['Delete']['Key'] == {
            'pk': 'PROJECT#p1', 'sk': 'PRD#generated',
        }
        assert transaction[0]['Delete']['ExpressionAttributeValues'] == {
            ':document_id': 'generated',
        }
        count_update = transaction[1]['Update']
        assert count_update['Key'] == {'pk': 'PROJECT#p1', 'sk': 'META'}
        assert 'document_count = :remaining' in count_update['UpdateExpression']
        assert count_update['ExpressionAttributeValues'][':remaining'] == 2
        assert count_update['ExpressionAttributeValues'][':deleting_status'] == (
            'deleting'
        )
        assert count_update['ExpressionAttributeValues'][':deleted_status'] == (
            'deleted'
        )
        assert count_update['ExpressionAttributeNames']['#status'] == 'status'
        assert '#status <> :deleting_status' in count_update[
            'ConditionExpression'
        ]
        assert 'attribute_not_exists(document_count)' in count_update[
            'ConditionExpression'
        ]

    @patch('projects.persist_legacy_document_versions', new=MagicMock())
    @patch('projects.projects_table')
    def test_conditional_delete_failure_never_decrements_document_count(
        self, mock_table
    ):
        mock_table.name = 'test-projects-table'
        mock_table.query.return_value = {
            'Items': [{
                'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d1', 'document_id': 'd1',
                'document_type': 'prfaq', 'title': 'Launch FAQ',
            }],
        }
        mock_table.meta.client.transact_write_items.side_effect = ClientError(
            {
                'Error': {
                    'Code': 'TransactionCanceledException',
                    'Message': 'gone',
                },
            },
            'TransactWriteItems',
        )
        mock_table.get_item.return_value = {}

        from projects import delete_document
        from shared.exceptions import NotFoundError

        with pytest.raises(NotFoundError, match='no longer exists'):
            delete_document('p1', 'd1')

        mock_table.update_item.assert_not_called()
        mock_table.delete_item.assert_not_called()

    @patch('projects.projects_table')
    def test_point_update_uses_projected_pages_and_stops_at_match(self, mock_table):
        mock_table.query.side_effect = [
            {
                'Items': [{'pk': 'PROJECT#p1', 'sk': 'META'}],
                'LastEvaluatedKey': {'pk': 'PROJECT#p1', 'sk': 'META'},
            },
            {
                'Items': [{
                    'pk': 'PROJECT#p1', 'sk': 'DOC#d1', 'document_id': 'd1',
                    'document_type': 'custom', 'title': 'Notes',
                }],
                'LastEvaluatedKey': {'pk': 'PROJECT#p1', 'sk': 'DOC#d1'},
            },
            {'Items': [{'pk': 'PROJECT#p1', 'sk': 'DOC#later'}]},
        ]
        mock_table.name = 'projects'
        mock_table.get_item.return_value = {'Item': {
            'pk': 'PROJECT#p1', 'sk': 'DOC#d1', 'document_id': 'd1',
            'document_type': 'custom', 'title': 'Notes', 'content': 'before',
        }}

        from projects import update_document

        result = update_document('p1', 'd1', {'content': '# edited'})

        assert result['success'] is True
        assert result['document']['content'] == '# edited'
        assert mock_table.query.call_count == 2
        first_query = mock_table.query.call_args_list[0].kwargs
        second_query = mock_table.query.call_args_list[1].kwargs
        assert first_query['ConsistentRead'] is True
        assert 'content' not in first_query['ProjectionExpression']
        assert second_query['ExclusiveStartKey'] == {
            'pk': 'PROJECT#p1', 'sk': 'META',
        }
        [snapshot, update] = mock_table.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        assert snapshot['Put']['Item']['content'] == 'before'
        assert update['Update']['Key'] == {'pk': 'PROJECT#p1', 'sk': 'DOC#d1'}
        assert update['Update']['ExpressionAttributeValues'][':document_id'] == 'd1'

    @patch('projects.projects_table')
    def test_update_reports_not_found_when_document_is_deleted_after_lookup(
        self, mock_table,
    ):
        mock_table.query.return_value = {
            'Items': [{
                'pk': 'PROJECT#p1',
                'sk': 'DOC#d1',
                'document_id': 'd1',
                'document_type': 'custom',
                'title': 'Notes',
            }],
        }
        # Found by the projected lookup, gone by the full read.
        mock_table.get_item.return_value = {}

        from projects import update_document
        from shared.exceptions import NotFoundError

        with pytest.raises(NotFoundError, match='not found'):
            update_document('p1', 'd1', {'content': '# edited'})

    @patch('projects.projects_table')
    def test_content_edit_cannot_rename_a_versioned_series(self, mock_table):
        mock_table.query.return_value = {
            'Items': [
                {
                    'pk': 'PROJECT#p1', 'sk': 'PRD#d1', 'document_id': 'd1',
                    'document_type': 'prd', 'base_title': 'Launch',
                    'title': 'Launch (v2)', 'version': 2,
                },
            ],
        }
        mock_table.get_item.return_value = {'Item': mock_table.query.return_value['Items'][0]}

        from projects import update_document
        from shared.exceptions import ValidationError

        with pytest.raises(ValidationError, match='cannot change series'):
            update_document('p1', 'd1', {'title': 'Different series', 'content': '# edited'})

        mock_table.update_item.assert_not_called()


class TestProjectChatContext:
    """Bounded canonical context used by streaming project chat."""

    @patch('projects.projects_table')
    def test_returns_redacted_summaries_and_never_inlines_prototypes(self, mock_table):
        families = [
            ('PRD#prd', 'prd'),
            ('PRFAQ#faq', 'prfaq'),
            ('RESEARCH#research', 'research'),
            ('DOC#custom', 'custom'),
            ('PRODUCT_REPORT#report', 'product_report'),
            ('PROTOTYPE#prototype', 'prototype'),
        ]
        documents = [
            {
                'sk': sk,
                'document_id': document_type,
                'document_type': document_type,
                'title': f'{document_type} title',
                'base_title': f'{document_type} title',
                'version': 1,
                'content': f'{document_type} body',
                'large_internal_field': 'must not cross',
            }
            for sk, document_type in families
        ]
        documents[-1].update({
            'prototype_url': 'https://signed.invalid/prototype.html?Signature=secret',
            'prototype_s3_uri': 's3://raw/prototypes/p1/prototype.html',
            'prototype_format': 'html',
        })
        mock_table.query.return_value = {
            'Items': [
                {
                    'pk': 'PROJECT#p1', 'project_id': 'p1', 'sk': 'META',
                    'name': 'Project', 'description': 'internal project description',
                    'secret_config': 'must not cross',
                },
                {
                    'pk': 'PROJECT#p1', 'persona_id': 'one',
                    'sk': 'PERSONA#one', 'name': 'One',
                    'tagline': 'Busy buyer',
                    'identity': {'email': 'secret@example.invalid'},
                },
                *documents,
            ],
        }
        document_by_sk = {document['sk']: document for document in documents}
        mock_table.get_item.side_effect = lambda **kwargs: {
            'Item': {
                'document_id': document_by_sk[kwargs['Key']['sk']]['document_id'],
                'content': document_by_sk[kwargs['Key']['sk']]['content'],
            },
        }

        from projects import get_project_chat_context

        result = get_project_chat_context(
            'p1', ['prd', 'product_report', 'prototype', 'prd'], ADMIN_CALLER,
        )

        assert result['project'] == {'sk': 'META', 'name': 'Project'}
        assert result['personas'] == [{
            'sk': 'PERSONA#one', 'persona_id': 'one', 'name': 'One',
            'tagline': 'Busy buyer',
        }]
        assert [document['sk'] for document in result['documents']] == [
            sk for sk, _document_type in families
        ]
        assert {
            document['document_id']
            for document in result['documents']
            if 'content' in document
        } == {'prd', 'product_report'}
        prototype = next(
            document for document in result['documents']
            if document['document_id'] == 'prototype'
        )
        assert prototype == {
            'sk': 'PROTOTYPE#prototype',
            'document_id': 'prototype',
            'document_type': 'prototype',
            'title': 'prototype title (v1)',
            'base_title': 'prototype title',
            'version': 1,
        }
        serialized = json.dumps(result)
        assert 'large_internal_field' not in serialized
        assert 'prototype_url' not in serialized
        assert 'prototype_s3_uri' not in serialized
        assert 'prototype_format' not in serialized
        assert 'Signature=secret' not in serialized
        assert 'secret_config' not in serialized
        assert 'secret@example.invalid' not in serialized
        query = mock_table.query.call_args.kwargs
        assert query['ConsistentRead'] is True
        assert 'content' not in query['ProjectionExpression']
        assert [call.kwargs['Key']['sk'] for call in mock_table.get_item.call_args_list] == [
            'PRD#prd', 'PRODUCT_REPORT#report',
        ]

    @pytest.mark.parametrize(('project_id', 'selected_document_ids'), [
        ('', []),
        ('p' * 129, []),
        ('p1', 'not-an-array'),
        ('p1', ['d'] * 21),
        ('p1', ['']),
        ('p1', [' padded ']),
        ('p1', ['d' * 129]),
    ])
    @patch('projects.projects_table')
    def test_rejects_invalid_bounds_before_reading_project(
        self, mock_table, project_id, selected_document_ids,
    ):
        from projects import get_project_chat_context
        from shared.exceptions import ValidationError

        with pytest.raises(ValidationError):
            get_project_chat_context(project_id, selected_document_ids, ADMIN_CALLER)

        mock_table.query.assert_not_called()


@patch('projects.persist_legacy_document_versions', new=MagicMock())
@patch('projects.projects_table')
def test_document_delete_transaction_failure_preserves_document_and_count(
    mock_table
):
    document = {
        'pk': 'PROJECT#p1',
        'sk': 'PRFAQ#d1',
        'document_id': 'd1',
        'document_type': 'prfaq',
        'title': 'Launch FAQ',
    }
    mock_table.name = 'test-projects-table'
    mock_table.query.return_value = {'Items': [document]}
    mock_table.get_item.return_value = {'Item': document}
    mock_table.meta.client.transact_write_items.side_effect = ClientError(
        {
            'Error': {
                'Code': 'TransactionCanceledException',
                'Message': 'META condition failed',
            },
        },
        'TransactWriteItems',
    )

    from projects import delete_document
    from shared.exceptions import ServiceError

    with pytest.raises(ServiceError, match='count changed repeatedly'):
        delete_document('p1', 'd1')

    mock_table.delete_item.assert_not_called()
    mock_table.update_item.assert_not_called()


@patch('projects.projects_table')
def test_document_delete_repairs_a_stale_zero_count_instead_of_blocking(mock_table):
    document = {
        'pk': 'PROJECT#p1',
        'sk': 'DOC#d1',
        'document_id': 'd1',
        'document_type': 'custom',
        'title': 'Notes',
    }
    mock_table.name = 'test-projects-table'
    mock_table.query.return_value = {
        'Items': [
            {'pk': 'PROJECT#p1', 'sk': 'META', 'document_count': 0},
            document,
        ],
    }

    from projects import delete_document

    assert delete_document('p1', 'd1') == {'success': True}
    update = mock_table.meta.client.transact_write_items.call_args.kwargs[
        'TransactItems'
    ][1]['Update']
    assert update['ExpressionAttributeValues'][':remaining'] == 0
    assert update['ExpressionAttributeValues'][':observed_count'] == 0
    assert 'document_count = :observed_count' in update['ConditionExpression']


@patch('projects._sweep_project_objects', MagicMock())
@patch('projects._delete_project_job_rows', MagicMock())
@patch('projects.projects_table')
def test_project_delete_retries_fence_when_tombstone_insert_loses(mock_table):
    conditional = ClientError(
        {
            'Error': {
                'Code': 'ConditionalCheckFailedException',
                'Message': 'raced',
            },
        },
        'UpdateItem',
    )
    mock_table.update_item.side_effect = [conditional, {}, {}]
    mock_table.put_item.side_effect = conditional
    mock_table.query.side_effect = [
        {'Items': [{'pk': 'PROJECT#p1', 'sk': 'META'}]},
        {'Items': []},
    ]
    batch = MagicMock()
    mock_table.batch_writer.return_value.__enter__.return_value = batch

    from projects import delete_project

    assert delete_project('p1') == {'success': True}
    assert mock_table.update_item.call_count == 3
    assert mock_table.put_item.call_count == 1
    assert mock_table.batch_writer.call_count == 2
    second_fence = mock_table.update_item.call_args_list[1].kwargs
    assert 'if_not_exists(#deleting, :now)' in second_fence['UpdateExpression']


@patch('projects.projects_table')
def test_persona_delete_transaction_carries_status_tombstone_fence(mock_table):
    mock_table.name = 'test-projects-table'

    from projects import delete_persona

    assert delete_persona('p1', 'persona-1') == {'success': True}
    update = mock_table.meta.client.transact_write_items.call_args.kwargs[
        'TransactItems'
    ][1]['Update']
    assert '#status <> :deleting_status' in update['ConditionExpression']
    assert update['ExpressionAttributeNames']['#status'] == 'status'
    assert update['ExpressionAttributeValues'][':deleting_status'] == 'deleting'
    assert update['ExpressionAttributeValues'][':deleted_status'] == 'deleted'

"""
Tests for projects.py - Projects API core functions.
"""
import json
import os
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError


class TestFixPersonaName:
    """Tests for fix_persona_name helper function."""

    def test_adds_space_between_camel_case(self):
        """Adds space between lowercase and uppercase letters."""
        from projects import fix_persona_name
        
        assert fix_persona_name('VeronicaChen') == 'Veronica Chen'
        assert fix_persona_name('JohnSmith') == 'John Smith'
        assert fix_persona_name('MaryJaneWatson') == 'Mary Jane Watson'

    def test_preserves_already_spaced_names(self):
        """Preserves names that already have proper spacing."""
        from projects import fix_persona_name
        
        assert fix_persona_name('John Smith') == 'John Smith'
        assert fix_persona_name('Mary Jane') == 'Mary Jane'

    def test_handles_single_word_names(self):
        """Handles single word names without changes."""
        from projects import fix_persona_name
        
        assert fix_persona_name('Marcus') == 'Marcus'
        assert fix_persona_name('ALLCAPS') == 'ALLCAPS'

    def test_handles_empty_string(self):
        """Handles empty string input."""
        from projects import fix_persona_name
        
        assert fix_persona_name('') == ''


class TestListProjects:
    """Tests for list_projects function."""

    @patch('projects.projects_table')
    def test_returns_list_of_projects(self, mock_table):
        """Returns list of all projects."""
        mock_table.query.return_value = {
            'Items': [
                {'project_id': 'proj-1', 'name': 'Project 1', 'created_at': '2026-01-01'},
                {'project_id': 'proj-2', 'name': 'Project 2', 'created_at': '2026-01-02'}
            ]
        }
        # Mock the second query for item counts
        mock_table.query.side_effect = [
            {'Items': [{'project_id': 'proj-1', 'name': 'Project 1'}]},
            {'Items': [{'sk': 'META'}, {'sk': 'PERSONA#1'}]},
        ]
        
        from projects import list_projects
        
        result = list_projects()
        
        assert 'projects' in result

    @patch('projects.projects_table', None)
    def test_returns_empty_when_table_not_configured(self):
        """Returns empty list when table not configured."""
        from projects import list_projects
        
        result = list_projects()
        
        assert result['projects'] == []


class TestCreateProject:
    """Tests for create_project function."""

    @patch('projects.projects_table')
    def test_creates_project(self, mock_table):
        """Creates a new project."""
        from projects import create_project
        
        result = create_project({'name': 'New Project', 'description': 'Test'})
        
        assert result['success'] is True
        assert 'project' in result
        mock_table.put_item.assert_called_once()

    @patch('projects.projects_table', None)
    def test_returns_error_when_table_not_configured(self):
        """Returns error when table not configured."""
        from projects import create_project
        from shared.exceptions import ConfigurationError
        
        with pytest.raises(ConfigurationError):
            create_project({'name': 'Test'})


class TestGetProject:
    """Tests for get_project function."""

    @patch('projects.projects_table')
    def test_returns_project_with_personas_and_documents(self, mock_table):
        """Returns project with all related data."""
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#proj-1', 'sk': 'META', 'project_id': 'proj-1', 'name': 'Test'},
                {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'User'},
                {
                    'pk': 'PROJECT#proj-1', 'sk': 'DOC#d1', 'document_id': 'd1',
                    'document_type': 'custom', 'title': 'Document',
                }
            ]
        }
        
        from projects import get_project
        
        result = get_project('proj-1')
        
        assert result['project']['name'] == 'Test'
        assert len(result['personas']) == 1
        assert len(result['documents']) == 1

    @patch('projects.projects_table')
    def test_returns_error_when_project_not_found(self, mock_table):
        """Returns error when project doesn't exist."""
        mock_table.query.return_value = {'Items': []}
        
        from projects import get_project
        from shared.exceptions import NotFoundError
        
        with pytest.raises(NotFoundError):
            get_project('nonexistent')


class TestUpdateProject:
    """Tests for update_project function."""

    @patch('projects.projects_table')
    def test_updates_project_fields(self, mock_table):
        """Updates project with new values."""
        from projects import update_project
        
        result = update_project('proj-1', {'name': 'Updated', 'description': 'New desc'})
        
        assert result['success'] is True
        mock_table.update_item.assert_called_once()

    @patch('projects.projects_table', None)
    def test_returns_error_when_table_not_configured(self):
        """Returns error when table not configured."""
        from projects import update_project
        from shared.exceptions import ConfigurationError
        
        with pytest.raises(ConfigurationError):
            update_project('proj-1', {'name': 'Test'})


class TestDeleteProject:
    """Tests for delete_project function."""

    @patch('projects.projects_table')
    def test_deletes_project_and_version_assignment_partitions(self, mock_table):
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
        batch.delete_item.assert_has_calls([
            call(Key={'pk': 'PROJECT#proj-1', 'sk': 'META'}),
            call(Key={'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#p1'}),
            call(Key={
                'pk': 'DOCUMENT_VERSIONS#PROJECT#proj-1', 'sk': 'PRD#counter',
            }),
            call(Key={
                'pk': 'DOCUMENT_VERSIONS#PROJECT#proj-1',
                'sk': 'LEGACY_ASSIGNMENT#PRD#counter#d1',
            }),
        ])

    @patch('projects.projects_table', None)
    def test_returns_error_when_table_not_configured(self):
        """Returns error when table not configured."""
        from projects import delete_project
        from shared.exceptions import ConfigurationError
        
        with pytest.raises(ConfigurationError):
            delete_project('proj-1')


class TestGetAvatarCdnUrl:
    """Tests for get_avatar_cdn_url function."""

    def test_converts_s3_uri_to_signed_cdn_url(self, cdn_signing_configured):
        """Converts S3 URI to a SIGNED CloudFront CDN URL (issue #229)."""
        from shared.avatar import get_avatar_cdn_url
        
        s3_uri = 's3://bucket/avatars/persona_123.png'
        result = get_avatar_cdn_url(s3_uri, cdn_url='https://cdn.example.com')
        
        assert result.startswith('https://cdn.example.com/persona_123.png?')
        assert 'Signature=' in result and 'Expires=' in result

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


class TestGenerateAvatarPromptWithLlm:
    """Tests for generate_avatar_prompt_with_llm function."""

    @patch('shared.avatar.get_avatar_prompt_config')
    def test_generates_prompt_from_persona_data(self, mock_config):
        """Generates image prompt from persona data."""
        mock_config.return_value = {
            'system_prompt': 'Generate image prompt',
            'user_prompt_template': 'Create avatar for {name}',
            'max_tokens': 200,
            'fallback_prompt_template': 'Professional headshot of a {occupation}'
        }
        
        from shared.avatar import generate_avatar_prompt_with_llm
        
        # Create a mock bedrock client
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = {
            'body': MagicMock(read=lambda: json.dumps({
                'content': [{'type': 'text', 'text': 'Professional headshot of a software engineer'}]
            }).encode())
        }
        
        persona_data = {
            'name': 'John Smith',
            'tagline': 'Tech enthusiast',
            'identity': {
                'bio': 'Software developer',
                'age_range': '30-40',
                'occupation': 'Engineer',
                'location': 'San Francisco'
            }
        }
        
        result = generate_avatar_prompt_with_llm(persona_data, mock_bedrock)
        
        assert 'Professional headshot' in result

    @patch('shared.avatar.get_avatar_prompt_config')
    def test_returns_fallback_on_error(self, mock_config):
        """Returns fallback prompt on LLM error."""
        mock_config.return_value = {
            'system_prompt': 'Generate image prompt',
            'user_prompt_template': 'Create avatar for {name}',
            'max_tokens': 200,
            'fallback_prompt_template': 'Professional headshot of a {occupation}'
        }
        
        from shared.avatar import generate_avatar_prompt_with_llm
        
        # Create a mock bedrock client that raises an error
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.side_effect = Exception('LLM error')
        
        persona_data = {'name': 'Test', 'identity': {'occupation': 'Developer'}}
        
        result = generate_avatar_prompt_with_llm(persona_data, mock_bedrock)
        
        assert 'Professional headshot' in result


class TestDocumentVersionBoundaries:
    """Versioned PRD/PRFAQ behavior at the canonical project API boundary."""

    @patch('projects.persist_legacy_document_versions')
    @patch('projects.projects_table')
    def test_get_project_versions_legacy_same_title_documents_across_pages(
        self, mock_table, mock_persist,
    ):
        from shared.document_versions import normalize_document_versions

        mock_persist.side_effect = (
            lambda _table, _project_id, documents: normalize_document_versions(documents)
        )
        mock_table.query.side_effect = [
            {
                'Items': [
                    {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Project'},
                    {
                        'pk': 'PROJECT#p1', 'sk': 'PRD#old', 'document_id': 'old',
                        'document_type': 'prd', 'title': 'Launch', 'created_at': '2026-01-01',
                    },
                ],
                'LastEvaluatedKey': {'pk': 'PROJECT#p1', 'sk': 'PRD#old'},
            },
            {
                'Items': [
                    {
                        'pk': 'PROJECT#p1', 'sk': 'PRD#new', 'document_id': 'new',
                        'document_type': 'prd', 'title': 'Launch', 'created_at': '2026-02-01',
                    },
                ],
            },
        ]

        from projects import get_project

        documents = get_project('p1')['documents']

        assert [(document['title'], document['version']) for document in documents] == [
            ('Launch (v1)', 1),
            ('Launch (v2)', 2),
        ]
        assert all(document['base_title'] == 'Launch' for document in documents)
        assert mock_table.query.call_count == 2
        mock_persist.assert_called_once()

    @pytest.mark.parametrize('document_type', [
        'prd', 'prfaq', 'PRD', 'research', 'custom ',
    ])
    @patch('projects.projects_table')
    def test_custom_document_route_refuses_non_custom_types(
        self, mock_table, document_type,
    ):
        from projects import create_document
        from shared.exceptions import ValidationError

        with pytest.raises(ValidationError, match='Only custom documents'):
            create_document('p1', {
                'title': 'Launch',
                'content': '# Document',
                'document_type': document_type,
            })

        mock_table.put_item.assert_not_called()

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

        from projects import update_document

        result = update_document('p1', 'd1', {'content': '# edited'})

        assert result == {'success': True}
        assert mock_table.query.call_count == 2
        first_query = mock_table.query.call_args_list[0].kwargs
        second_query = mock_table.query.call_args_list[1].kwargs
        assert first_query['ConsistentRead'] is True
        assert 'content' not in first_query['ProjectionExpression']
        assert second_query['ExclusiveStartKey'] == {
            'pk': 'PROJECT#p1', 'sk': 'META',
        }
        update_call = mock_table.update_item.call_args.kwargs
        assert update_call['Key'] == {
            'pk': 'PROJECT#p1', 'sk': 'DOC#d1',
        }
        assert update_call['ConditionExpression'] == (
            'attribute_exists(pk) AND attribute_exists(sk) '
            'AND document_id = :document_id'
        )
        assert update_call['ExpressionAttributeValues'][':document_id'] == 'd1'

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
        mock_table.update_item.side_effect = ClientError(
            {
                'Error': {
                    'Code': 'ConditionalCheckFailedException',
                    'Message': 'gone',
                },
            },
            'UpdateItem',
        )

        from projects import update_document
        from shared.exceptions import NotFoundError

        with pytest.raises(NotFoundError, match='no longer exists'):
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

        from projects import update_document
        from shared.exceptions import ValidationError

        with pytest.raises(ValidationError, match='cannot be renamed'):
            update_document('p1', 'd1', {'title': 'Different series', 'content': '# edited'})

        mock_table.update_item.assert_not_called()


class TestProjectChatContext:
    """Bounded canonical context used by streaming project chat."""

    @patch('projects.get_project')
    def test_returns_all_summaries_and_only_selected_content(self, mock_get_project):
        families = [
            ('PRD#prd', 'prd'),
            ('PRFAQ#faq', 'prfaq'),
            ('RESEARCH#research', 'research'),
            ('DOC#custom', 'custom'),
            ('PRODUCT_REPORT#report', 'product_report'),
            ('PROTOTYPE#prototype', 'prototype'),
        ]
        mock_get_project.return_value = {
            'project': {'project_id': 'p1', 'name': 'Project'},
            'personas': [{'persona_id': 'one', 'name': 'One'}],
            'documents': [
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
            ],
        }

        from projects import get_project_chat_context

        result = get_project_chat_context(
            'p1', ['prd', 'product_report', 'prd'],
        )

        assert [document['sk'] for document in result['documents']] == [
            sk for sk, _document_type in families
        ]
        assert {
            document['document_id']
            for document in result['documents']
            if 'content' in document
        } == {'prd', 'product_report'}
        assert {
            document['document_id']: document.get('content')
            for document in result['documents']
        } == {
            'prd': 'prd body',
            'prfaq': None,
            'research': None,
            'custom': None,
            'product_report': 'product_report body',
            'prototype': None,
        }
        assert all(
            'large_internal_field' not in document
            for document in result['documents']
        )
        mock_get_project.assert_called_once_with('p1')

    @pytest.mark.parametrize('project_id, selected_document_ids', [
        ('', []),
        ('p' * 129, []),
        ('p1', 'not-an-array'),
        ('p1', ['d'] * 21),
        ('p1', ['']),
        ('p1', [' padded ']),
        ('p1', ['d' * 129]),
    ])
    @patch('projects.get_project')
    def test_rejects_invalid_bounds_before_reading_project(
        self, mock_get_project, project_id, selected_document_ids,
    ):
        from projects import get_project_chat_context
        from shared.exceptions import ValidationError

        with pytest.raises(ValidationError):
            get_project_chat_context(project_id, selected_document_ids)

        mock_get_project.assert_not_called()

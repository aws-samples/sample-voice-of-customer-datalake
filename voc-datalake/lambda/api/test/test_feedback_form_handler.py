"""
Tests for feedback_form_handler.py - /feedback-forms/* endpoints.
"""
import json
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

WIDGET_SOURCE = Path(__file__).resolve().parents[1] / 'static' / 'feedback-widget.js'

# How the widget reaches its config: `config.x` in the fetch callback,
# `this.config.x`, and `c.x` after the `var c = this.config` alias.
#
# The trailing \b is load-bearing rather than tidy: without it a camelCase DOM
# property (`c.appendChild`) matches partially and contributes a bogus field name
# (`append`), which fails the assertion below for a reason that has nothing to do
# with the projection. With it, such a property yields no match at all.
_WIDGET_CONFIG_READ = re.compile(r'(?:this\.config|\bconfig|\bc)\.([a-z_]+)\b')

# Every `c = ...` assignment, with its right-hand side captured. `c` is a single
# letter, so the read pattern above is only safe while `c` means the config and
# nothing else in this file.
#
# `(?<![.\w])` excludes a property named `c` (`foo.c = 1`) and `(?!=)` excludes a
# comparison (`c === x`), either of which would otherwise be reported as a stray
# alias — a failure with nothing to do with the projection under test.
#
# Captures the RHS instead of using `\bc\s*=\s*(?!this\.config)`: `\s*` backtracks
# to zero width, which lets that negative lookahead land on the space and succeed,
# so that spelling flags the one assignment it means to allow.
_WIDGET_C_ASSIGNMENT = re.compile(r'(?<![.\w])c\s*=(?!=)\s*([^;,\n]+)')


def _widget_code_lines(source: str) -> list[str]:
    """The widget's lines with comment-ONLY lines dropped, nothing rewritten.

    Comments have to be excluded because a `config.x` inside a docblock is not a
    read, and collecting it fails the assertion below in the direction that tempts
    a reader to widen the public projection.

    But this drops whole lines rather than substituting `//[^\\n]*` away, because
    that pattern also matches inside a string literal — a `https://…` URL, a regex
    literal — truncating the rest of that line and silently dropping any config
    read after it. That is an UNDER-collection, i.e. fail-open in the opposite
    direction: a field genuinely dropped from `item_to_widget_config` would stop
    failing the test.

    Exactly what this does and does not handle, since a guard that overstates
    itself is the thing being fixed here:

    - Comment-only lines and block-comment bodies are dropped. Nothing is
      rewritten, so no line is ever truncated mid-way.
    - A trailing comment on a code line is KEPT, so a `config.x` mentioned there is
      collected. Loud direction — it can only fail the test, never weaken it.
    - `/* note */ config.foo` and `*/ config.foo` are dropped whole, because the
      line starts with a comment token. That is still the quiet direction, just far
      narrower than the substitution it replaced; the widget has no such line, and
      the alternative is a tokenizer.
    - A block opened mid-line (`init(); /* note`) is not detected, so its body
      lines are kept and may over-collect. Loud direction again.
    """
    kept: list[str] = []
    in_block = False
    for line in source.split('\n'):
        text = line.strip()
        if in_block:
            in_block = '*/' not in text
            continue
        if text.startswith('/*'):
            in_block = '*/' not in text
            continue
        if text.startswith('//'):
            continue
        kept.append(line)
    return kept


def _fields_the_widget_reads() -> set[str]:
    """Config field names read by static/feedback-widget.js, read off the widget.

    Derived rather than hand-listed. The list this replaced had already drifted:
    it claimed the widget reads `custom_fields`, which appears nowhere in the
    widget, so it asserted a dependency that does not exist while a genuinely new
    read would have gone unnoticed.

    Over-collecting is NOT harmless here, which is why the two assertions below
    exist. The caller subtracts this set from the served payload, so a bogus name
    fails the test — and the obvious way to "fix" a red test that names a field
    the widget does not read is to add that field to the public projection, i.e.
    to publish something on an unauthenticated route. The assumptions are
    therefore asserted rather than hoped for.
    """
    raw = WIDGET_SOURCE.read_text(encoding='utf-8')
    code_lines = _widget_code_lines(raw)
    # Sanity bound on the line filter itself: an unterminated block comment would
    # otherwise swallow the file and leave nothing to scan.
    assert len(code_lines) > len(raw.split('\n')) // 2, (
        f'comment filtering kept only {len(code_lines)} of '
        f'{len(raw.split(chr(10)))} lines in {WIDGET_SOURCE.name} — an '
        'unterminated block comment, or the file is now mostly prose.'
    )
    source = '\n'.join(code_lines)

    # `c` must mean the config and nothing else, or `c.style` on a DOM node would
    # be collected as a config field.
    c_assignments = [rhs.strip() for rhs in _WIDGET_C_ASSIGNMENT.findall(source)]
    assert c_assignments, (
        f'{WIDGET_SOURCE.name} no longer aliases the config to `c` — the read '
        'pattern below expects it. Update both together.'
    )
    stray = [rhs for rhs in c_assignments if rhs != 'this.config']
    assert not stray, (
        f'{WIDGET_SOURCE.name} assigns `c` to {stray}, not just this.config. '
        'This derivation reads `c.<field>` as a config access, so that variable '
        'would be collected as a field name; rename it or narrow the pattern.'
    )

    fields = set(_WIDGET_CONFIG_READ.findall(source))
    assert fields, f'found no config reads in {WIDGET_SOURCE.name} — did it move?'
    return fields


# An enabled form recorded under the brand the deployment carried when it was
# created — the pre-rename half of the partition-split cases below.
_FORM_WITH_LEGACY_BRAND = {
    'form_id': 'form-123',
    'name': 'Product Form',
    'enabled': True,
    'brand_name': 'Acme Classic',
}


def _queried_partition(query_kwargs: dict) -> str:
    """The pk a stats/submissions query was aimed at.

    Read off the KeyConditionExpression the handler actually passed rather than
    reconstructed from the brand under test, so the assertion still means
    something if the handler starts building the partition differently.
    """
    return query_kwargs['KeyConditionExpression'].get_expression()['values'][1]


def _fake_feedback_table(items_by_pk: dict[str, list[dict]]):
    """A feedback table that answers a query from the partition it was asked for.

    The point of the brand tests below is that a write and a read must agree on
    ONE partition, which a mock returning the same Items for every pk cannot
    show. This one returns nothing for a partition it was never given items for
    — exactly how a real rename-split reads — and applies the handler's
    source_channel filter, so a submission is only "found" if both the partition
    and the channel line up.
    """
    table = MagicMock()

    def query(**kwargs):
        pk = _queried_partition(kwargs)
        channel = kwargs.get('ExpressionAttributeValues', {}).get(':sc')
        items = [
            item for item in items_by_pk.get(pk, [])
            if channel is None or item.get('source_channel') == channel
        ]
        return {'Items': items}

    table.query.side_effect = query
    return table


class TestListForms:
    """Tests for GET /feedback-forms endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_empty_list_when_no_forms(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty list when no forms exist."""
        mock_table.query.return_value = {'Items': []}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/feedback-forms')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['forms'] == []

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_list_of_forms(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns list of all feedback forms."""
        mock_table.query.return_value = {
            'Items': [
                {
                    'form_id': 'form-1',
                    'name': 'Product Feedback',
                    'enabled': True,
                    'title': 'Product Feedback Form',
                    'created_at': '2026-01-01T00:00:00Z'
                },
                {
                    'form_id': 'form-2',
                    'name': 'Support Feedback',
                    'enabled': False,
                    'title': 'Support Feedback Form',
                    'created_at': '2026-01-02T00:00:00Z'
                }
            ]
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/feedback-forms')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert len(body['forms']) == 2
        # Should be sorted by created_at descending
        assert body['forms'][0]['form_id'] == 'form-2'


class TestCreateForm:
    """Tests for POST /feedback-forms endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_creates_form_with_defaults(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Creates form with default values."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={'name': 'New Form'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert 'form' in body
        assert body['form']['name'] == 'New Form'
        assert body['form']['enabled'] is False
        mock_table.put_item.assert_called_once()

    @patch('feedback_form_handler.aggregates_table')
    def test_creates_form_with_custom_config(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Creates form with custom configuration."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={
                'name': 'Custom Form',
                'enabled': True,
                'title': 'Custom Title',
                'rating_type': 'emoji',
                'category': 'product',
                'subcategory': 'quality'
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['form']['name'] == 'Custom Form'
        assert body['form']['category'] == 'product'
        assert body['form']['subcategory'] == 'quality'


class TestGetForm:
    """Tests for GET /feedback-forms/<form_id> endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_not_found_for_missing_form(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when form doesn't exist."""
        mock_table.get_item.return_value = {}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/nonexistent',
            path_params={'form_id': 'nonexistent'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 404 with error key
        assert response['statusCode'] == 404
        assert 'error' in body
        assert 'not found' in body['error'].lower()

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_form_details(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns form details for existing form."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'name': 'Test Form',
                'enabled': True,
                'title': 'Test Title',
                'rating_type': 'stars',
                'rating_max': 5
            }
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['form']['form_id'] == 'form-123'
        assert body['form']['name'] == 'Test Form'


class TestUpdateForm:
    """Tests for PUT /feedback-forms/<form_id> endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_returns_error_when_no_fields_to_update(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when no updatable fields provided."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
            body={}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'No fields to update' in body['error']

    @patch('feedback_form_handler.aggregates_table')
    def test_updates_form_fields(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Updates form with provided fields."""
        mock_table.update_item.return_value = {
            'Attributes': {
                'form_id': 'form-123',
                'name': 'Updated Name',
                'enabled': True,
                'title': 'Updated Title'
            }
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
            body={
                'name': 'Updated Name',
                'enabled': True,
                'title': 'Updated Title'
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['form']['name'] == 'Updated Name'
        mock_table.update_item.assert_called_once()


class TestDeleteForm:
    """Tests for DELETE /feedback-forms/<form_id> endpoint."""

    @patch('feedback_form_handler.aggregates_table')
    def test_deletes_form_successfully(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Successfully deletes a form."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        mock_table.delete_item.assert_called_once_with(
            Key={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#form-123'}
        )


class TestSubmitFormFeedback:
    """Tests for POST /feedback-forms/<form_id>/submit endpoint."""

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_error_when_text_empty(
        self, mock_table, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns error when feedback text is empty."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': ''}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'required' in body['error'].lower()

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_error_when_form_not_found(
        self, mock_table, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns error when form doesn't exist."""
        mock_table.get_item.return_value = {}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/nonexistent/submit',
            path_params={'form_id': 'nonexistent'},
            body={'text': 'Great product!'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 404 with error key
        assert response['statusCode'] == 404
        assert 'error' in body
        assert 'not found' in body['error'].lower()

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_returns_error_when_form_disabled(
        self, mock_table, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns error when form is not enabled."""
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'form-123', 'enabled': False}
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Great product!'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'not enabled' in body['error'].lower()

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_submits_feedback_with_category_routing(
        self, mock_table, mock_sqs, api_gateway_event, lambda_context
    ):
        """Submits feedback with pre-assigned category from form config."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'name': 'Product Form',
                'enabled': True,
                'category': 'product',
                'subcategory': 'quality',
                'success_message': 'Thank you!'
            }
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Great product quality!', 'rating': 5}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert 'feedback_id' in body
        assert body['message'] == 'Thank you!'
        
        # Verify SQS message includes category routing
        mock_sqs.send_message.assert_called_once()
        call_args = mock_sqs.send_message.call_args
        message_body = json.loads(call_args.kwargs['MessageBody'])
        assert message_body['preset_category'] == 'product'
        assert message_body['preset_subcategory'] == 'quality'
        assert message_body['source_channel'] == 'form_form-123'


class TestItemToForm:
    """Tests for item_to_form helper function."""

    def test_converts_dynamodb_item_to_form_response(self):
        """Converts DynamoDB item to form response format."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import item_to_form
        
        item = {
            'form_id': 'form-123',
            'name': 'Test Form',
            'enabled': True,
            'title': 'Test Title',
            'description': 'Test description',
            'rating_max': 5,
            'theme': {'primary_color': '#3B82F6'},
            'category': 'product',
            'created_at': '2026-01-01T00:00:00Z'
        }
        
        result = item_to_form(item)
        
        assert result['form_id'] == 'form-123'
        assert result['name'] == 'Test Form'
        assert result['enabled'] is True
        assert result['rating_max'] == 5
        assert result['theme']['primary_color'] == '#3B82F6'
        assert result['category'] == 'product'

    def test_handles_missing_fields_with_defaults(self):
        """Returns default values for missing fields."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from feedback_form_handler import item_to_form
        
        item = {'form_id': 'form-123'}
        
        result = item_to_form(item)
        
        assert result['form_id'] == 'form-123'
        assert result['name'] == ''
        assert result['enabled'] is False
        assert result['rating_enabled'] is True
        assert result['rating_max'] == 5
        assert result['theme'] == {}


class TestValidationLink:
    """Tests for the optional project_id / document_id validation link.

    A feedback form may record which project — and, as a refinement, which
    document — it validates, so the Prioritization page can show the ratings
    collected about the artefact being scored. Both fields are optional: a
    standalone website survey stores neither and must behave exactly as it
    did before they existed.
    """

    @patch('feedback_form_handler.aggregates_table')
    def test_create_persists_and_returns_the_link(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """A create request carrying the link persists it and echoes it back.

        Asserts on the *persisted item*, not only the response: the two are
        built by different code paths (DEFAULT_FORM_CONFIG seeding vs. the
        item_to_form allowlist), and a field declared in only one of them is
        silently dropped on the next read.
        """
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={
                'name': 'PR/FAQ validation',
                'project_id': 'proj-1',
                'document_id': 'doc-9',
            },
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['form']['project_id'] == 'proj-1'
        assert body['form']['document_id'] == 'doc-9'

        stored_item = mock_table.put_item.call_args.kwargs['Item']
        assert stored_item['project_id'] == 'proj-1'
        assert stored_item['document_id'] == 'doc-9'

    @patch('feedback_form_handler.aggregates_table')
    def test_create_without_the_link_stores_empty_strings(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """A form that validates nothing keeps working: link fields default empty."""
        event = api_gateway_event(
            method='POST', path='/feedback-forms', body={'name': 'Website Footer Form'}
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['form']['project_id'] == ''
        assert body['form']['document_id'] == ''

    @patch('feedback_form_handler.aggregates_table')
    def test_get_returns_a_stored_link(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """A stored link is readable back through the authenticated get route."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'name': 'Test Form',
                'enabled': True,
                'project_id': 'proj-1',
                'document_id': 'doc-9',
            }
        }

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['form']['project_id'] == 'proj-1'
        assert body['form']['document_id'] == 'doc-9'

    @patch('feedback_form_handler.aggregates_table')
    def test_update_writes_the_link(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """PUT accepts the link fields — they are in UPDATABLE_FIELDS."""
        mock_table.update_item.return_value = {
            'Attributes': {
                'form_id': 'form-123',
                'name': 'Test Form',
                'project_id': 'proj-2',
                'document_id': 'doc-7',
            }
        }

        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
            body={'project_id': 'proj-2', 'document_id': 'doc-7'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['form']['project_id'] == 'proj-2'
        expr_values = mock_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert expr_values[':project_id'] == 'proj-2'
        assert expr_values[':document_id'] == 'doc-7'

    @patch('feedback_form_handler.aggregates_table')
    def test_update_can_clear_the_link(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """Clearing the link (empty strings) reaches DynamoDB rather than being
        dropped as falsy — an admin must be able to unlink a form."""
        mock_table.update_item.return_value = {
            'Attributes': {'form_id': 'form-123', 'project_id': '', 'document_id': ''}
        }

        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
            body={'project_id': '', 'document_id': ''},
        )

        feedback_form_handler.lambda_handler(event, lambda_context)

        expr_values = mock_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert expr_values[':project_id'] == ''
        assert expr_values[':document_id'] == ''

    def test_item_to_form_declares_every_default_config_field(self, feedback_form_handler):
        """Every DEFAULT_FORM_CONFIG field must also be in the item_to_form
        allowlist. build_form_item seeds the record from that dict and
        item_to_form projects it on read, so a field in one and not the other
        persists but is never returned (or vice versa)."""
        projected = set(feedback_form_handler.item_to_form({}))

        assert set(feedback_form_handler.DEFAULT_FORM_CONFIG) <= projected
        assert set(feedback_form_handler.UPDATABLE_FIELDS) <= projected


class TestPublicConfigDoesNotLeakTheLink:
    """The widget config route is UNAUTHENTICATED and fetched cross-origin from
    customers' own websites (lambda/api/static/feedback-widget.js). Internal
    identifiers for the project and document a form validates must never appear
    in it. This is the security-relevant assertion for this change."""

    @patch('feedback_form_handler.aggregates_table')
    def test_public_config_omits_project_and_document_ids(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """GET /feedback-forms/<id>/config must not expose the link fields."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'name': 'Internal name',
                'enabled': True,
                'title': 'Rate this concept',
                'project_id': 'proj-secret',
                'document_id': 'doc-secret',
            }
        }

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/config',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        config = body['config']
        assert 'project_id' not in config
        assert 'document_id' not in config
        # Not merely absent-by-name: the values must not appear anywhere in the
        # serialized public payload under any other key either.
        assert 'proj-secret' not in response['body']
        assert 'doc-secret' not in response['body']
        # And the fields the widget actually renders are still served.
        assert config['enabled'] is True
        assert config['title'] == 'Rate this concept'

    @patch('feedback_form_handler.aggregates_table')
    def test_public_config_serves_every_field_the_widget_reads(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The narrower public projection must not have dropped a field the
        embedded widget depends on."""
        mock_table.get_item.return_value = {
            'Item': {
                'form_id': 'form-123',
                'enabled': True,
                'theme': {'primary_color': '#3B82F6'},
                'rating_max': 5,
            }
        }

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/config',
            path_params={'form_id': 'form-123'},
        )

        body = json.loads(feedback_form_handler.lambda_handler(event, lambda_context)['body'])

        read_by_widget = _fields_the_widget_reads()
        missing = sorted(read_by_widget - set(body['config']))
        assert not missing, (
            f'the widget reads config.{missing} but the public projection no '
            'longer serves it.'
        )


class TestValidationLinkBoundary:
    """The link fields are writable, so they are validated on the way in.

    They are the only writable fields whose values another surface later matches
    on: the Prioritization page pairs a form to a document by them. A non-string
    would be stored verbatim by DynamoDB and then silently match nothing, which
    reads on the page as "this form collected no evidence" rather than as the
    bad request it was.
    """

    @patch('feedback_form_handler.aggregates_table')
    def test_create_rejects_a_non_string_project_id(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """A structured value is a client error, not something to persist."""
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={'name': 'Bad form', 'project_id': {'nested': 'object'}},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        # Nothing may be written: rejecting after the put would leave the record
        # behind and only fail the response.
        mock_table.put_item.assert_not_called()

    @patch('feedback_form_handler.aggregates_table')
    def test_update_rejects_a_non_string_document_id(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """PUT is validated on the same path as POST."""
        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/form-123',
            path_params={'form_id': 'form-123'},
            body={'document_id': ['doc-1', 'doc-2']},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        mock_table.update_item.assert_not_called()

    @patch('feedback_form_handler.aggregates_table')
    def test_create_rejects_an_over_long_link_field(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The values are server-minted identifiers, so anything long is not one."""
        too_long = 'p' * (feedback_form_handler.LINK_FIELD_MAX_LENGTH + 1)
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={'name': 'Bad form', 'project_id': too_long},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        mock_table.put_item.assert_not_called()

    @patch('feedback_form_handler.aggregates_table')
    def test_accepts_a_link_at_the_length_limit(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The cap is inclusive — an id exactly at the limit is still valid."""
        at_limit = 'p' * feedback_form_handler.LINK_FIELD_MAX_LENGTH
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={'name': 'Edge form', 'project_id': at_limit},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert mock_table.put_item.call_args.kwargs['Item']['project_id'] == at_limit

    @patch('feedback_form_handler.aggregates_table')
    def test_a_request_without_the_link_is_untouched_by_validation(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """Absent is always valid: the link is optional and must stay so."""
        event = api_gateway_event(
            method='POST', path='/feedback-forms', body={'name': 'Website Footer Form'}
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200

    def test_the_record_constructor_itself_rejects_a_bad_link(self, feedback_form_handler):
        """Validation is structural, not a line the route remembers to call.

        build_form_item is the only way a new record is constructed, so a future
        second caller cannot reach the table with an unvalidated link by omitting
        a call. Asserted against the function directly, with no route involved.
        """
        # Taken off the module under test rather than imported directly: the
        # sys.path insert that makes `shared` importable lives in the fixture.
        validation_error = feedback_form_handler.ValidationError

        # Length derived from the cap, like the neighbouring tests: a hardcoded
        # 129 would quietly become a VALID length the day the cap is raised, and
        # this case would then assert nothing.
        too_long = 'x' * (feedback_form_handler.LINK_FIELD_MAX_LENGTH + 1)

        for bad in ({'project_id': 123}, {'document_id': too_long}):
            with pytest.raises(validation_error):
                feedback_form_handler.build_form_item(bad)

        # And a link-free body still builds, so the guard cannot have become
        # "reject everything".
        assert feedback_form_handler.build_form_item({'name': 'ok'})['name'] == 'ok'

    def test_every_link_field_is_updatable_and_validated(self, feedback_form_handler):
        """The validated set must not drift from the writable set.

        A link field added to UPDATABLE_FIELDS but not to LINK_FIELDS would be
        writable without validation — the exact gap this class closes — so the
        invariant is asserted over the actual tuples rather than left to review.
        """
        link_fields = set(feedback_form_handler.LINK_FIELDS)
        updatable = set(feedback_form_handler.UPDATABLE_FIELDS)

        assert link_fields <= updatable
        assert link_fields <= set(feedback_form_handler.DEFAULT_FORM_CONFIG)

        # The direction the docstring is about, and the one the two assertions
        # above do NOT cover: a writable identifier that nobody validates. Keyed
        # off the `_id` suffix, because being an identifier another surface
        # matches on is exactly what earns a field validation here; a writable
        # free-text field is out of scope and stays out.
        writable_identifiers = {field for field in updatable if field.endswith('_id')}
        assert writable_identifiers <= link_fields, (
            f'{sorted(writable_identifiers - link_fields)} can be written by a '
            'PUT but is absent from LINK_FIELDS, so validate_link_fields never '
            'sees it.'
        )


class TestFormStatsNeverReportsAZeroItDidNotMeasure:
    """GET /feedback-forms/<id>/stats must fail loudly rather than answer 0.

    The count this route returns is rendered next to a prioritization score, so
    'total_submissions: 0' is read as "customers were asked and did not answer" —
    evidence that lowers a score. A DynamoDB failure, or a Lambda deployed
    without FEEDBACK_TABLE, must therefore be reported as a failure and not be
    indistinguishable from an unanswered form (issue #312). get_form_submissions
    on the same table has always done this; stats now matches it.
    """

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_failed_stats_read_is_an_error_not_a_zero_count(
        self, mock_aggregates, mock_feedback, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """A query that raises returns 500, and no count at all."""
        mock_aggregates.get_item.return_value = {
            'Item': {'form_id': 'form-123', 'brand_name': 'Acme'}
        }
        mock_feedback.query.side_effect = Exception('ProvisionedThroughputExceeded')

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert body['success'] is False
        assert 'error' in body
        # The specific regression: a zero must not be reported for a read that
        # never completed, under any key.
        assert 'stats' not in body
        assert 'total_submissions' not in response['body']

    @patch('feedback_form_handler.feedback_table', None)
    @patch('feedback_form_handler.aggregates_table')
    def test_an_unconfigured_feedback_table_is_a_configuration_error(
        self, mock_aggregates, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """No table configured is a deployment fault, not an empty form."""
        mock_aggregates.get_item.return_value = {
            'Item': {'form_id': 'form-123', 'brand_name': 'Acme'}
        }

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert body['success'] is False
        assert 'not configured' in body['error'].lower()
        assert 'stats' not in body

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_successful_stats_read_still_reports_the_counts(
        self, mock_aggregates, mock_feedback, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """The happy path is unchanged — including a genuine, measured zero."""
        mock_aggregates.get_item.return_value = {
            'Item': {'form_id': 'form-123', 'brand_name': 'Acme'}
        }
        mock_feedback.query.return_value = {
            'Items': [
                {'feedback_id': 'fb-1', 'rating': 5},
                {'feedback_id': 'fb-2', 'rating': 4},
                {'feedback_id': 'fb-3'},
            ]
        }

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['form_id'] == 'form-123'
        assert body['stats']['total_submissions'] == 3
        assert body['stats']['avg_rating'] == 4.5
        assert body['stats']['rating_count'] == 2

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_form_with_no_submissions_still_reports_a_measured_zero(
        self, mock_aggregates, mock_feedback, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """Failing loudly must not have turned "nobody answered" into an error:
        an empty partition is a legitimate 200 with a zero count."""
        mock_aggregates.get_item.return_value = {
            'Item': {'form_id': 'form-123', 'brand_name': 'Acme'}
        }
        mock_feedback.query.return_value = {'Items': []}

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['stats']['total_submissions'] == 0
        assert body['stats']['avg_rating'] is None


class TestSubmissionsStayInThePartitionTheStatsReadQueries:
    """A submission must land where that form's stats read looks for it.

    _get_form_source_pk builds the partition from the FORM's stored brand_name,
    falling back to the environment only when the form has none. So the write has
    to stamp the form's brand too: stamping the deployment's BRAND_NAME splits a
    form's submissions across two partitions the moment the deployment is renamed
    — new submissions under the new brand, the stats read still querying the old,
    and the form reporting 0 with the data sitting intact elsewhere.

    Fixed at the write site deliberately. Making the READ prefer the environment
    would instead strand every submission collected before the rename.
    """

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Rebranded')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_submission_is_stamped_with_the_forms_brand_not_the_environments(
        self, mock_aggregates, mock_sqs, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """The enqueued record carries the form's stored brand after a rename."""
        mock_aggregates.get_item.return_value = {'Item': dict(_FORM_WITH_LEGACY_BRAND)}

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Still a great product', 'rating': 5},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        enqueued = json.loads(mock_sqs.send_message.call_args.kwargs['MessageBody'])
        assert enqueued['brand_name'] == 'Acme Classic'

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Rebranded')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_submission_after_a_rename_is_found_by_that_forms_stats_read(
        self, mock_aggregates, mock_sqs, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """End to end over the split: submit under the renamed deployment, then
        read the stats, with the feedback table only answering the partition the
        record was actually written to."""
        mock_aggregates.get_item.return_value = {'Item': dict(_FORM_WITH_LEGACY_BRAND)}

        submit_event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Still a great product', 'rating': 4},
        )
        submit_response = feedback_form_handler.lambda_handler(
            submit_event, lambda_context
        )
        assert submit_response['statusCode'] == 200

        enqueued = json.loads(mock_sqs.send_message.call_args.kwargs['MessageBody'])
        # The processor writes pk = SOURCE#<brand_name> (lambda/processor/handler.py).
        stored = {
            'feedback_id': enqueued['id'],
            'rating': enqueued['rating'],
            'source_channel': enqueued['source_channel'],
        }
        partition = f"SOURCE#{enqueued['brand_name']}"

        stats_event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )
        with patch(
            'feedback_form_handler.feedback_table',
            _fake_feedback_table({partition: [stored]}),
        ):
            stats_response = feedback_form_handler.lambda_handler(
                stats_event, lambda_context
            )

        body = json.loads(stats_response['body'])
        assert stats_response['statusCode'] == 200
        assert body['stats']['total_submissions'] == 1, (
            'the submission landed in a partition this form\'s stats read does '
            'not query — the brand-rename split is back'
        )
        assert body['stats']['avg_rating'] == 4.0

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Rebranded')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_form_stored_without_a_brand_falls_back_to_the_environment(
        self, mock_aggregates, mock_sqs, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """The read's own fallback, mirrored on the write: a legacy form record
        with no brand_name must still agree with _get_form_source_pk."""
        mock_aggregates.get_item.return_value = {
            'Item': {'form_id': 'form-123', 'name': 'Legacy Form', 'enabled': True}
        }

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Legacy submission'},
        )

        feedback_form_handler.lambda_handler(event, lambda_context)

        enqueued = json.loads(mock_sqs.send_message.call_args.kwargs['MessageBody'])
        assert enqueued['brand_name'] == 'Acme Rebranded'
        assert (
            f"SOURCE#{enqueued['brand_name']}"
            == feedback_form_handler._get_form_source_pk('form-123')
        )

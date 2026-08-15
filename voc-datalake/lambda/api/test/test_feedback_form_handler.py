"""
Tests for feedback_form_handler.py - /feedback-forms/* endpoints.
"""
import json
import re
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

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


def _form_with_legacy_brand(brand_name: str = 'Acme Classic') -> dict:
    """An enabled form recorded under the brand its deployment carried then.

    A factory rather than a shared dict so each test gets its own mutable copy —
    these are handed to a mock as a DynamoDB Item and a handler is free to read
    or reshape one.

    `brand_name=''` is the form created while BRAND_NAME was unset (that is what
    build_form_item stores), i.e. the record with no anchor of its own.
    """
    return {
        'form_id': 'form-123',
        'name': 'Product Form',
        'enabled': True,
        'brand_name': brand_name,
    }


def _queried_partition(query_kwargs: dict) -> str:
    """The pk a stats/submissions query was aimed at.

    Read off the KeyConditionExpression the handler actually passed rather than
    reconstructed from the brand under test, so the assertion still means
    something if the handler starts building the partition differently.

    That means reaching into a boto3 condition object's internal shape, so the
    shape is asserted first: if boto3 changes it, this fails as a broken HELPER
    naming itself rather than as a mystery KeyError inside a test whose subject
    is brands.
    """
    expression = query_kwargs['KeyConditionExpression'].get_expression()
    assert expression['operator'] == '=', (
        '_queried_partition expected an equality condition on the key; boto3 '
        f"gave operator {expression['operator']!r} — the helper needs updating, "
        'this is not a finding about partitions.'
    )
    assert expression['values'][0].name == 'pk', (
        '_queried_partition expected the key condition to be on pk; boto3 gave '
        f"{expression['values'][0]!r} — helper needs updating."
    )
    return expression['values'][1]


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

    @patch.dict('os.environ', {}, clear=False)
    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_read_failure_reaches_cloudwatch_and_not_just_the_caller(
        self, mock_aggregates, mock_feedback, capsys, api_gateway_event,
        lambda_context, feedback_form_handler
    ):
        """A metric is only worth adding if it is actually emitted.

        `metrics.add_metric` BUFFERS: nothing leaves the function unless the
        handler is wrapped in `metrics.log_metrics`, which `api_handler` does —
        and a flush with no namespace raises SchemaValidationError, which on this
        path would replace the read failure with a metrics bug. So this asserts
        the whole way out: an EMF blob on stdout, naming this metric, under the
        namespace shared/logging pins on the Metrics singleton ('VoC', a default
        that does not depend on POWERTOOLS_METRICS_NAMESPACE being deployed).

        Without it, "the failure is now visible to operations" — the answer given
        to the review question about a silent DynamoDB fault — is unverified.
        """
        import os

        os.environ.pop('POWERTOOLS_METRICS_NAMESPACE', None)
        mock_aggregates.get_item.return_value = {'Item': _form_with_legacy_brand()}
        mock_feedback.query.side_effect = Exception('ProvisionedThroughputExceeded')

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 500
        emitted = [
            json.loads(line)
            for line in capsys.readouterr().out.splitlines()
            if 'FeedbackFormStatsReadFailed' in line and '_aws' in line
        ]
        assert emitted, (
            'the read failure emitted no CloudWatch metric — add_metric only '
            'buffers, so this is invisible to operations unless api_handler '
            'flushes it'
        )
        namespaces = {
            directive['Namespace']
            for blob in emitted
            for directive in blob['_aws']['CloudWatchMetrics']
        }
        assert namespaces == {'VoC'}, (
            f'metric emitted under {namespaces}, not the namespace '
            'shared/logging sets on the Metrics singleton'
        )

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

    @patch('feedback_form_handler.BRAND_NAME', 'Acme Rebranded')
    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_failed_form_lookup_is_an_error_not_a_zero_count(
        self, mock_aggregates, mock_feedback, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """The other read on this route. The FORM lookup used to be swallowed and
        degraded to BRAND_NAME, which after a rename is a partition this form's
        submissions were never written to: the feedback query then succeeds
        against the wrong partition, finds nothing, and the route answers 200 with
        total_submissions 0 — issue #312's false zero arriving through the door
        the earlier fix left open."""
        mock_aggregates.get_item.side_effect = Exception(
            'ProvisionedThroughputExceededException'
        )
        # The data is intact, in the partition the form's real brand names. A
        # degraded read queries somewhere else and this is never consulted.
        mock_feedback.query.return_value = {'Items': []}

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert body['success'] is False
        assert 'stats' not in body
        assert 'total_submissions' not in body

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_form_that_does_not_exist_is_a_404_not_a_zero_count(
        self, mock_aggregates, mock_feedback, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """A deleted form must present as a deleted form. get_form_submissions
        over the same table has always answered 404 here; stats answered 200 with
        a measured-looking 0, which LinkedFormEvidence renders as evidence
        against a work item. Its error branch already has an
        `evidence.unavailable` string waiting for the 404."""
        mock_aggregates.get_item.return_value = {}

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/does-not-exist/stats',
            path_params={'form_id': 'does-not-exist'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 404
        assert body['success'] is False
        assert 'stats' not in body
        assert 'total_submissions' not in body
        # A 404 is about the form, so the feedback partition is never read.
        mock_feedback.query.assert_not_called()

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_typed_failure_inside_the_stats_query_keeps_its_own_status(
        self, mock_aggregates, mock_feedback, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """The blanket `except Exception` must not downgrade a typed exception.

        This raises the typed exception from INSIDE the try block, which is what
        makes it a test of the `except ApiError: raise` guard. The obvious
        spelling — a missing form, which raises NotFoundError — proves nothing
        about the guard: that raise happens in _load_form_for_query, above the
        try, so it reaches the caller whether the guard exists or not (this test
        used to be written that way and passed with both guards deleted).

        Currently no statement inside the try raises an ApiError, so the guard is
        precautionary; the mock stands in for the future one that does. Delete
        the guard and this is a 500.
        """
        mock_aggregates.get_item.return_value = {'Item': _form_with_legacy_brand()}
        mock_feedback.query.side_effect = feedback_form_handler.NotFoundError(
            'Form not found'
        )

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 404, (
            'a typed exception raised inside the try was converted to a 500 by '
            'the blanket handler'
        )

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_typed_failure_inside_the_submissions_query_keeps_its_own_status(
        self, mock_aggregates, mock_feedback, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """The same guard on the sibling route, which has the same shape and so
        the same way of being silently correct-for-the-wrong-reason."""
        mock_aggregates.get_item.return_value = {'Item': _form_with_legacy_brand()}
        mock_feedback.query.side_effect = feedback_form_handler.ValidationError(
            'limit must be a number'
        )

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/submissions',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400, (
            'a typed exception raised inside the try was converted to a 500 by '
            'the blanket handler'
        )

    @patch('feedback_form_handler.BRAND_NAME', 'Acme Rebranded')
    @patch('feedback_form_handler.aggregates_table')
    def test_the_stats_read_queries_the_forms_own_partition(
        self, mock_aggregates, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """The partition comes from the form record this route loaded, not from
        the deployment's brand — the read half of the one-partition invariant, now
        that the form is loaded here rather than inside a helper that re-read it
        and tolerated failure."""
        mock_aggregates.get_item.return_value = {'Item': _form_with_legacy_brand()}
        fake_table = _fake_feedback_table({
            'SOURCE#Acme Classic': [
                {'feedback_id': 'fb-1', 'rating': 3, 'source_channel': 'form_form-123'}
            ]
        })

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        with patch('feedback_form_handler.feedback_table', fake_table):
            response = feedback_form_handler.lambda_handler(event, lambda_context)

        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['stats']['total_submissions'] == 1
        assert (
            _queried_partition(fake_table.query.call_args.kwargs)
            == 'SOURCE#Acme Classic'
        )

    @patch('feedback_form_handler.aggregates_table')
    def test_the_form_is_read_once_per_stats_request(
        self, mock_aggregates, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """One get_item, where this route used to make none of its own and let a
        helper read the record separately. Pinned because the 404 check and the
        partition are answered from the same record on purpose — the existence
        check must not have added a read."""
        mock_aggregates.get_item.return_value = {'Item': _form_with_legacy_brand()}

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        with patch(
            'feedback_form_handler.feedback_table', _fake_feedback_table({})
        ):
            feedback_form_handler.lambda_handler(event, lambda_context)

        assert mock_aggregates.get_item.call_count == 1


class TestSubmissionsStayInThePartitionTheStatsReadQueries:
    """A submission must land where that form's stats read looks for it.

    _form_source_pk builds the partition from the FORM's stored brand_name,
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
        mock_aggregates.get_item.return_value = {'Item': _form_with_legacy_brand()}

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
        mock_aggregates.get_item.return_value = {'Item': _form_with_legacy_brand()}

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
        with no brand_name must still agree with _form_source_pk."""
        form = {'form_id': 'form-123', 'name': 'Legacy Form', 'enabled': True}
        mock_aggregates.get_item.return_value = {'Item': dict(form)}

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
            == feedback_form_handler._form_source_pk(form)
        )


class TestABrandlessFormIsAnchoredSoARenameCannotStrandIt:
    """A form with no stored brand must not be left depending on the env var.

    build_form_item writes 'brand_name': BRAND_NAME, so a form created while
    BRAND_NAME was unset is stored with ''. For that record BOTH sides of the
    partition — submit_form_feedback's `form.get('brand_name') or BRAND_NAME` and
    _form_source_pk's identical fallback — resolve through the live environment
    variable. They agree at any instant, so a same-instant test passes either
    way; what does not hold is the property the fix claims, that a submission
    stays in the partition the read queries for the WHOLE LIFE of the form.
    Rename the deployment and the pre-rename submissions are unreachable, which
    is exactly the stranding the write-site fix was chosen over.

    So the resolved brand is written back onto the form record once, and every
    read and write afterwards is anchored to a stored value.
    """

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Original')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_submission_survives_a_rename_that_happens_after_it(
        self, mock_aggregates, mock_sqs, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """The case a same-instant test cannot see: submit against a form stored
        with brand_name '', THEN rename the deployment, then read the stats. The
        submission must still be found, which is only true if the form record was
        anchored to the brand the submission was written under."""
        stored_form = _form_with_legacy_brand(brand_name='')
        mock_aggregates.get_item.return_value = {'Item': dict(stored_form)}

        # The anchor is a real conditional write, so let it mutate the record the
        # subsequent read returns — that is the whole mechanism under test.
        def update_item(**kwargs):
            stored_form['brand_name'] = kwargs['ExpressionAttributeValues'][':brand']
            mock_aggregates.get_item.return_value = {'Item': dict(stored_form)}
            return {}

        mock_aggregates.update_item.side_effect = update_item

        submit_event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Collected before the rename', 'rating': 5},
        )
        submit_response = feedback_form_handler.lambda_handler(
            submit_event, lambda_context
        )
        assert submit_response['statusCode'] == 200

        enqueued = json.loads(mock_sqs.send_message.call_args.kwargs['MessageBody'])
        assert enqueued['brand_name'] == 'Acme Original'
        # The processor writes pk = SOURCE#<brand_name> (lambda/processor/handler.py).
        partition = f"SOURCE#{enqueued['brand_name']}"
        stored_submission = {
            'feedback_id': enqueued['id'],
            'rating': enqueued['rating'],
            'source_channel': enqueued['source_channel'],
        }

        stats_event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )
        # The rename: nothing about the form or the stored feedback changes, only
        # the deployment's environment.
        with patch('feedback_form_handler.BRAND_NAME', 'Acme Rebranded'), patch(
            'feedback_form_handler.feedback_table',
            _fake_feedback_table({partition: [stored_submission]}),
        ):
            stats_response = feedback_form_handler.lambda_handler(
                stats_event, lambda_context
            )

        body = json.loads(stats_response['body'])
        assert stats_response['statusCode'] == 200
        assert body['stats']['total_submissions'] == 1, (
            'a submission collected before the rename is unreachable to the '
            "form's own stats read — the form was never anchored to a brand, so "
            'both sides followed the environment variable when it moved'
        )

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Original')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_the_anchor_write_cannot_overwrite_a_brand_already_stored(
        self, mock_aggregates, mock_sqs, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """Guarded by a condition, so a concurrent submission or an admin edit
        that got there first wins. Without the condition this backfill would be a
        blind write that could move a form's partition — the defect it exists to
        prevent."""
        mock_aggregates.get_item.return_value = {
            'Item': _form_with_legacy_brand(brand_name='')
        }

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Anything'},
        )

        feedback_form_handler.lambda_handler(event, lambda_context)

        kwargs = mock_aggregates.update_item.call_args.kwargs
        assert 'attribute_not_exists(brand_name)' in kwargs['ConditionExpression']
        assert kwargs['ExpressionAttributeValues'][':empty'] == ''
        assert kwargs['ExpressionAttributeValues'][':brand'] == 'Acme Original'
        # UpdateItem is an upsert and attribute_not_exists(brand_name) is
        # satisfied by a MISSING item, so existence has to be required
        # separately or this write recreates a form someone just deleted.
        assert 'attribute_exists(sk)' in kwargs['ConditionExpression']
        # And the parentheses are part of the guard, not formatting: without them
        # `attribute_exists(sk) AND attribute_not_exists(brand_name) OR
        # brand_name = :empty` is satisfied by brand_name = '' alone, on a
        # non-existent item, which is exactly the case being excluded.
        assert '(attribute_not_exists(brand_name) OR brand_name = :empty)' in (
            kwargs['ConditionExpression']
        )

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Original')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_the_anchor_records_when_it_changed_the_form(
        self, mock_aggregates, mock_sqs, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """brand_name is published by item_to_form and by the PUBLIC widget
        config, so the anchor changes what the management UI and the widget on a
        customer's site report. Every other write path here maintains updated_at
        (build_form_item sets it, update_form always appends it); a published
        field that moves with no timestamp is the kind of change nobody can
        account for six months later."""
        mock_aggregates.get_item.return_value = {
            'Item': _form_with_legacy_brand(brand_name='')
        }

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Anything'},
        )

        feedback_form_handler.lambda_handler(event, lambda_context)

        kwargs = mock_aggregates.update_item.call_args.kwargs
        assert 'updated_at' in kwargs['UpdateExpression']
        # A real ISO-8601 instant, not a placeholder that only satisfies the
        # assertion above.
        datetime.fromisoformat(kwargs['ExpressionAttributeValues'][':now'])

    def test_the_brand_is_not_editable_through_the_public_form_api(
        self, feedback_form_handler
    ):
        """A deliberate decision, recorded as a test because the anchor makes the
        stored brand permanent and an obvious "fix" for that is to let PUT change
        it. It must not: brand_name is the input to _form_source_pk, so editing it
        moves where this form's stats read looks WITHOUT moving the submissions
        already written under the old value — the stranding this module's
        write/read agreement exists to prevent, triggered by hand. Correcting a
        brand needs a migration that rewrites the feedback partition too."""
        assert 'brand_name' not in feedback_form_handler.UPDATABLE_FIELDS

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Rebranded')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_form_that_already_has_a_brand_is_not_rewritten(
        self, mock_aggregates, mock_sqs, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """No write for a form that is already anchored: the backfill must not add
        a DynamoDB write to every submission on every form."""
        mock_aggregates.get_item.return_value = {'Item': _form_with_legacy_brand()}

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Anything'},
        )

        feedback_form_handler.lambda_handler(event, lambda_context)

        mock_aggregates.update_item.assert_not_called()

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Original')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_failed_anchor_does_not_fail_the_submission(
        self, mock_aggregates, mock_sqs, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """Best effort by design. The anchor makes future reads durable; the
        record being enqueued already carries the right brand either way, so
        losing a customer's feedback over it would be the worse outcome."""
        mock_aggregates.get_item.return_value = {
            'Item': _form_with_legacy_brand(brand_name='')
        }
        mock_aggregates.update_item.side_effect = Exception('Throttled')

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Feedback that must not be dropped'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        enqueued = json.loads(mock_sqs.send_message.call_args.kwargs['MessageBody'])
        assert enqueued['brand_name'] == 'Acme Original'

    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', '')
    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_no_brand_anywhere_is_left_alone_and_still_agrees(
        self, mock_aggregates, mock_sqs, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """Neither the form nor the deployment has a brand: there is nothing to
        anchor TO, so no write is made and both sides fall through to the
        processor's own default partition (SOURCE#feedback_form, from
        source_platform). Pinned because writing '' would be a pointless write,
        and because this is the one case where the partition comes from neither
        brand."""
        form = _form_with_legacy_brand(brand_name='')
        mock_aggregates.get_item.return_value = {'Item': dict(form)}

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'Unbranded deployment'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        mock_aggregates.update_item.assert_not_called()

        enqueued = json.loads(mock_sqs.send_message.call_args.kwargs['MessageBody'])
        assert enqueued['brand_name'] == ''
        # The processor falls back to source_platform for an empty brand_name
        # (lambda/processor/handler.py: source_display = brand_name or
        # source_platform), which is the partition the read builds too.
        assert (
            f"SOURCE#{enqueued['source_platform']}"
            == feedback_form_handler._form_source_pk(form)
        )


class TestTheAnchorCanOnlyEverUpdateAFormThatExists:
    """The backfill must not be able to bring a deleted form back.

    DynamoDB's UpdateItem is an UPSERT, and `attribute_not_exists(brand_name)` is
    SATISFIED by an item that is not there at all — so a condition written only
    about brand_name lets the anchor CREATE the record it meant to amend. The
    window is real: `POST /feedback-forms/<id>/submit` is public and
    unauthenticated, so a widget on a customer's site can be mid-submission when
    an operator deletes the form, between this route's get_item and its anchor
    write. The role has UpdateItem on the aggregates table
    (`aggregatesTable.grantReadWriteData` in api-stack.ts), so nothing else stops
    it.

    What a resurrected record would cost is worse than the split the anchor
    prevents: it is a bare {pk, sk, brand_name, updated_at} stub, which
    list_forms renders as a nameless row whose own form_id is '' (so its delete
    and edit actions cannot address it), and — on the very route this change made
    honest — a deleted form goes back to answering 200 with total_submissions 0,
    because _load_form_for_query now finds an Item.

    Backed by a real (moto) table rather than a mock, because "UpdateItem creates
    the item" is DynamoDB's behaviour, not the handler's: asserting the condition
    string is what the sibling class does, and it cannot show that the string
    actually excludes this.
    """

    @staticmethod
    def _aggregates_table_that_loses_the_form_mid_request(table):
        """The real table, with the form deleted the instant it is read.

        Stands in for the race: get_item answers with the record submit_form_feedback
        is about to trust, and by the time the anchor writes, the DELETE has landed.
        Every call goes to the real table, so the condition is evaluated by
        DynamoDB and not by this test's idea of it.
        """
        racing = MagicMock()

        def get_item(**kwargs):
            response = table.get_item(**kwargs)
            table.delete_item(Key=kwargs['Key'])
            return response

        racing.get_item.side_effect = get_item
        racing.update_item.side_effect = table.update_item
        return racing

    @staticmethod
    def _table_with_a_brandless_form():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='test-aggregates-anchor',
            KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'pk', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        # A form created while BRAND_NAME was unset: build_form_item stores ''.
        table.put_item(Item={
            'pk': 'FEEDBACK_FORM',
            'sk': 'FORM#form-123',
            'form_id': 'form-123',
            'name': 'Product Form',
            'enabled': True,
            'brand_name': '',
        })
        return table

    @mock_aws
    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Original')
    @patch('feedback_form_handler.sqs')
    def test_a_form_deleted_mid_submission_is_not_written_back(
        self, mock_sqs, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The delete wins, and the anchor is a no-op rather than a resurrection."""
        table = self._table_with_a_brandless_form()
        racing = self._aggregates_table_that_loses_the_form_mid_request(table)

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'In flight when the form was deleted', 'rating': 5},
        )

        with patch('feedback_form_handler.aggregates_table', racing):
            response = feedback_form_handler.lambda_handler(event, lambda_context)

        # The submission itself still succeeds: it was accepted before the delete
        # and its record already carries the brand, so dropping it would be the
        # worse outcome — the anchor has always been best effort.
        assert response['statusCode'] == 200
        assert mock_sqs.send_message.called

        assert 'Item' not in table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#form-123'}
        ), (
            'the anchor upserted a deleted form back into existence — '
            'attribute_not_exists(brand_name) is satisfied by a missing item, so '
            'the condition has to require the item to exist as well'
        )

    @mock_aws
    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Original')
    @patch('feedback_form_handler.sqs')
    def test_the_stats_route_still_reports_that_form_as_gone(
        self, mock_sqs, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The consequence that matters to this change: a phantom record makes
        _load_form_for_query find an Item, so /stats answers 200 with
        total_submissions 0 for a deleted form — reopening the false zero this PR
        closed, for exactly the ids most likely to be read just after a delete."""
        table = self._table_with_a_brandless_form()
        racing = self._aggregates_table_that_loses_the_form_mid_request(table)

        submit_event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'In flight when the form was deleted'},
        )
        with patch('feedback_form_handler.aggregates_table', racing):
            feedback_form_handler.lambda_handler(submit_event, lambda_context)

        stats_event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )
        with patch('feedback_form_handler.aggregates_table', table), patch(
            'feedback_form_handler.feedback_table', _fake_feedback_table({})
        ):
            stats_response = feedback_form_handler.lambda_handler(
                stats_event, lambda_context
            )

        body = json.loads(stats_response['body'])
        assert stats_response['statusCode'] == 404, (
            'a deleted form is answering the stats route again, which means the '
            'anchor recreated it'
        )
        assert 'total_submissions' not in body

    @mock_aws
    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Original')
    @patch('feedback_form_handler.sqs')
    def test_a_form_that_is_still_there_is_anchored_as_before(
        self, mock_sqs, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The boundary the existence check must not have crossed: requiring the
        item to exist is only correct if it still lets the ordinary brandless form
        be anchored. Over-tighten the condition and the backfill quietly stops
        working, which the failure it tolerates would hide."""
        table = self._table_with_a_brandless_form()

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'An ordinary submission', 'rating': 4},
        )

        with patch('feedback_form_handler.aggregates_table', table):
            response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        item = table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#form-123'}
        )['Item']
        assert item['brand_name'] == 'Acme Original'
        # And the rest of the record is intact — an update, never a replacement.
        assert item['name'] == 'Product Form'
        assert item['enabled'] is True
        datetime.fromisoformat(item['updated_at'])

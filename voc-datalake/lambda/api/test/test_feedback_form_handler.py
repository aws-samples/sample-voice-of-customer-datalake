"""
Tests for feedback_form_handler.py - /feedback-forms/* endpoints.
"""
import ast
import inspect
import json
import os
import re
import textwrap
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
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


def _emitted_metrics(capsys, metric_name: str) -> list[dict]:
    """The EMF blobs naming `metric_name` that this request actually flushed.

    `metrics.add_metric` only BUFFERS; nothing reaches CloudWatch unless the
    handler is wrapped in `metrics.log_metrics`, which `api_handler` does. So a
    metric is only worth trusting if it is asserted all the way out, and this
    reads the flushed blobs rather than a mock's call list.

    Note this depends on powertools writing EMF to stdout with `print()`, which
    is what makes it visible to capsys — if a powertools upgrade changes that,
    every caller fails together and the cause is this helper, not a metric that
    stopped being emitted.
    """
    return [
        json.loads(line)
        for line in capsys.readouterr().out.splitlines()
        if metric_name in line and '_aws' in line
    ]


def _namespaces_of(emitted: list[dict]) -> set[str]:
    """The CloudWatch namespaces a set of EMF blobs was published under."""
    return {
        directive['Namespace']
        for blob in emitted
        for directive in blob['_aws']['CloudWatchMetrics']
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

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_read_failure_reaches_cloudwatch_and_not_just_the_caller(
        self, mock_aggregates, mock_feedback, capsys, api_gateway_event,
        lambda_context, feedback_form_handler
    ):
        """A metric is only worth adding if it is actually emitted.

        `metrics.add_metric` BUFFERS: nothing leaves the function unless the
        handler is wrapped in `metrics.log_metrics`, which `api_handler` does. So
        this asserts the whole way out — an EMF blob flushed to stdout naming this
        metric — rather than that add_metric was called.

        The namespace is compared against the Metrics singleton rather than a
        literal, so it cannot drift from shared/logging.py; the test does not
        control it and does not claim to. (POWERTOOLS_METRICS_NAMESPACE plays no
        part: powertools resolves the namespace when Metrics(namespace="VoC") is
        constructed at import time, so the env var never participates.)

        Without this, "the failure is now visible to operations" — the answer
        given to the review question about a silent DynamoDB fault — is
        unverified.
        """
        mock_aggregates.get_item.return_value = {'Item': _form_with_legacy_brand()}
        mock_feedback.query.side_effect = Exception('ProvisionedThroughputExceeded')

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 500
        emitted = _emitted_metrics(capsys, 'FeedbackFormStatsReadFailed')
        assert emitted, (
            'the read failure emitted no CloudWatch metric — add_metric only '
            'buffers, so this is invisible to operations unless api_handler '
            'flushes it'
        )
        assert _namespaces_of(emitted) == {feedback_form_handler.metrics.namespace}, (
            f'metric emitted under {_namespaces_of(emitted)}, not the namespace '
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
        self, mock_aggregates, mock_feedback, capsys, api_gateway_event,
        lambda_context, feedback_form_handler
    ):
        """The other read on this route. The FORM lookup used to be swallowed and
        degraded to BRAND_NAME, which after a rename is a partition this form's
        submissions were never written to: the feedback query then succeeds
        against the wrong partition, finds nothing, and the route answers 200 with
        total_submissions 0 — issue #312's false zero arriving through the door
        the earlier fix left open.

        Asserts the metric too, to the same standard as the stats one: this is the
        BROADER of the two, since _load_form_for_query is shared by the stats and
        submissions routes, so it is the one whose absence would leave the most
        failures invisible to operations."""
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

        emitted = _emitted_metrics(capsys, 'FeedbackFormReadFailed')
        assert emitted, (
            'the form read failed and emitted no CloudWatch metric — the caller '
            'sees a 500 but operations sees nothing, which is half of the defect '
            'this route was fixed for'
        )
        assert _namespaces_of(emitted) == {feedback_form_handler.metrics.namespace}, (
            f'metric emitted under {_namespaces_of(emitted)}, not the namespace '
            'shared/logging sets on the Metrics singleton'
        )

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

    def test_no_other_module_derives_a_feedback_partition_from_the_brand(self):
        """_form_source_pk must stay the ONLY brand-scoped read of SOURCE#.

        The write side keeps a pre-rename form writing under its old brand, which
        is safe precisely because no other reader is scoped by brand: every other
        SOURCE# partition under lambda/ and plugins/ is built from
        source_platform. That is a
        claim about other modules, and the write site used to assert it in a
        comment nothing could falsify — so it is asserted here instead, and a
        future brand-scoped read fails this test rather than quietly inheriting a
        trade-off that was reasoned about without it.

        Deliberately syntactic: it reads the source rather than importing, because
        the point is to catch a NEW construction site, and an f-string's inputs are
        visible in the text. A reader landing here from a failure should decide
        whether the new read wants the form's brand (see _form_source_pk) or the
        environment's, not silence the test.

        The guarantee is therefore precise and worth stating so nobody reads it as
        broader: a new SAME-LINE construction under lambda/ or plugins/. A
        deliberately split one — `brand = BRAND_NAME` then f"SOURCE#{brand}" on the
        next line — is NOT caught, and neither is a partition assembled at
        runtime. Catching those needs dataflow analysis; the value here is
        catching the copy-paste of _form_source_pk, which is how a second
        brand-scoped read would realistically arrive.

        lambda/layers/ is excluded for the same reason pytest.ini
        (--ignore=lambda/layers, norecursedirs) and ruff.toml (extend-exclude)
        exclude it: it is vendored third-party build output from
        scripts/build-layers.sh, absent from git but expected to exist locally, so
        a match there is someone else's prose and not a finding about this repo.
        """
        repo_root = Path(__file__).resolve().parents[3]
        this_module = repo_root / 'lambda' / 'api' / 'feedback_form_handler.py'

        def is_first_party_source(path: Path) -> bool:
            return not (
                path == this_module
                # Vendored: see the docstring. Matches pytest.ini and ruff.toml.
                or 'layers' in path.parts
                # Exact-segment, so it skips a test/ package but not a stray
                # tests/; the name check below covers plugins', which sit beside
                # the code they exercise rather than in a test/ directory.
                or 'test' in path.parts
                or path.name.startswith('test_')
                or path.name == 'conftest.py'
            )

        offenders = []
        for tree in ('lambda', 'plugins'):
            for path in sorted((repo_root / tree).rglob('*.py')):
                if not is_first_party_source(path):
                    continue
                # errors='replace' so one non-UTF-8 vendored fixture cannot abort
                # the run with a UnicodeDecodeError that names neither the file
                # nor this invariant. A mojibake byte cannot spell either token.
                for lineno, line in enumerate(
                    path.read_text(encoding='utf-8', errors='replace').splitlines(),
                    start=1,
                ):
                    if 'SOURCE#' in line and 'BRAND_NAME' in line:
                        rel = path.relative_to(repo_root)
                        offenders.append(f'{rel}:{lineno}: {line.strip()}')

        assert not offenders, (
            'a SOURCE# partition is now derived from BRAND_NAME outside '
            'feedback_form_handler._form_source_pk:\n  '
            + '\n  '.join(offenders)
            + '\nThe write site in submit_form_feedback reasons that a pre-rename '
            'form is safe to leave on its old brand BECAUSE no other reader is '
            'brand-scoped. That reasoning now needs revisiting rather than this '
            'assertion relaxing.'
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
        # Nothing is asserted about the parentheses around the OR: DynamoDB binds
        # AND tighter than OR and an absent attribute compares false, so both
        # spellings behave identically and an assertion on the brackets could
        # only ever fail for reformatting. attribute_exists(sk) is the conjunct
        # that excludes a missing item, and that exclusion is proved against a
        # real table in TestTheAnchorCanOnlyEverUpdateAFormThatExists rather than
        # by matching a string here.

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

    def test_the_brand_is_not_in_the_put_allowlist(
        self, feedback_form_handler
    ):
        """A deliberate decision, recorded as a test because the anchor makes the
        stored brand permanent and an obvious "fix" for that is to let PUT change
        it. It must not: brand_name is the input to _form_source_pk, so editing it
        moves where this form's stats read looks WITHOUT moving the submissions
        already written under the old value — the stranding this module's
        write/read agreement exists to prevent, triggered by hand. Correcting a
        brand needs a migration that rewrites the feedback partition too.

        UPDATABLE_FIELDS gates `PUT /feedback-forms/<id>`, which is Cognito
        AUTHENTICATED (lib/stacks/api-stack.ts passes authMethodOptions); the
        unauthenticated routes are config, submit and iframe. So this is not a
        leak test against the widget surface — brand_name IS published by
        item_to_widget_config and nothing here guards that."""
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

    @mock_aws
    @patch('feedback_form_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('feedback_form_handler.BRAND_NAME', 'Acme Rebranded')
    @patch('feedback_form_handler.sqs')
    def test_a_form_whose_history_predates_its_anchor_reports_only_the_anchored_half(
        self, mock_sqs, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The accepted limit of the fix, pinned so it is a decision and not a
        surprise.

        A form that was already collecting before its brand was resolved onto the
        record can have submissions in TWO SOURCE# partitions: the pre-fix write
        stamped the live BRAND_NAME, so a deployment renamed (or given a brand for
        the first time) mid-collection split them. The anchor pins the form to the
        brand live when it next receives a submission, and the stats read reports
        that partition only — the other half needs a migration that rewrites those
        records' pk, which is why UPDATABLE_FIELDS says so.

        This is NOT a regression: the same form reported the same half before this
        change. What the anchor adds is permanence, and permanence is the reason to
        assert the number rather than leave it incidental — if someone later
        teaches the read to cover the pre-anchor partition, this test is where the
        expected count changes, deliberately.
        """
        table = self._table_with_a_brandless_form()

        submit_event = api_gateway_event(
            method='POST',
            path='/feedback-forms/form-123/submit',
            path_params={'form_id': 'form-123'},
            body={'text': 'The submission that anchors the form', 'rating': 5},
        )
        with patch('feedback_form_handler.aggregates_table', table):
            submit_response = feedback_form_handler.lambda_handler(
                submit_event, lambda_context
            )
        assert submit_response['statusCode'] == 200

        anchored_brand = table.get_item(
            Key={'pk': 'FEEDBACK_FORM', 'sk': 'FORM#form-123'}
        )['Item']['brand_name']
        assert anchored_brand == 'Acme Rebranded'

        # The history: 7 submissions collected under the old brand, 2 under the
        # new one, all stamped by the pre-fix write from whatever BRAND_NAME held
        # at the time. Nine are stored; the form can only reach the anchored half.
        channel = 'form_form-123'
        history = {
            'SOURCE#Acme Classic': [
                {'feedback_id': f'old-{n}', 'rating': 4, 'source_channel': channel}
                for n in range(7)
            ],
            f'SOURCE#{anchored_brand}': [
                {'feedback_id': f'new-{n}', 'rating': 5, 'source_channel': channel}
                for n in range(2)
            ],
        }

        stats_event = api_gateway_event(
            method='GET',
            path='/feedback-forms/form-123/stats',
            path_params={'form_id': 'form-123'},
        )
        with patch('feedback_form_handler.aggregates_table', table), patch(
            'feedback_form_handler.feedback_table', _fake_feedback_table(history)
        ):
            stats_response = feedback_form_handler.lambda_handler(
                stats_event, lambda_context
            )

        body = json.loads(stats_response['body'])
        assert stats_response['statusCode'] == 200
        assert body['stats']['total_submissions'] == 2, (
            'the stats read reports the anchored partition only — 2 of the 9 '
            'stored. Accepted deliberately (see the UPDATABLE_FIELDS comment): '
            'covering the pre-anchor partition means recording the prior brand '
            'and doubling the reads on a route that already pages a whole '
            'partition. If that changed, this expectation changes with it.'
        )


# ============================================
# The public iframe page (issue #379)
# ============================================
#
# `GET /feedback-forms/<form_id>/iframe` is the ONE route in this API that answers
# with a document instead of JSON, unauthenticated, on the API's own origin, and
# it is designed to be framed on customers' sites. Before this change it
# interpolated the caller-supplied path segment straight into a `<script>` block
# and returned 200 without reading the table at all, so
# `a');alert(document.domain);x=('` — which the route's own pattern accepts — was
# rendered as executable script.

# The payload from the issue, kept as one constant because three separate tests
# assert three different things about the same string: that the ROUTE admits it,
# that the HANDLER refuses it, and that the SERIALIZER would have made it inert
# even if it arrived. Its three dangerous characters are the quote that closes the
# string literal, the `)` that closes the init call and the `;` that starts a
# second statement.
_INJECTION_PAYLOAD = "a');alert(document.domain);x=('"


def _iframe_event(api_gateway_event, form_id: str) -> dict:
    """A GET of the public iframe page for `form_id`.

    `resource` is spelled the way API Gateway sends it for the deployed route
    (`/feedback-forms/{form_id}/iframe`) rather than left to the fixture's
    path-derived default, which would embed the id itself and stop Powertools
    matching the dynamic route for an id containing a `/`.

    `domainName` is set because the page's apiEndpoint is built from it, and it is
    a REQUEST-supplied value like the id — asserted below to be serialized too.
    """
    event = api_gateway_event(
        method='GET',
        path=f'/feedback-forms/{form_id}/iframe',
        path_params={'form_id': form_id},
        resource='/feedback-forms/{form_id}/iframe',
    )
    event['requestContext']['domainName'] = 'api.example.com'
    return event


def _route_pattern_for_iframe(handler) -> re.Pattern:
    """The regex Powertools compiled for the iframe route, off the live resolver.

    Read from the app rather than restated: the point of the positive control
    below is that the FRAMEWORK accepts the payload, so a copy of powertools'
    capture group pasted here would prove nothing about the version installed.

    `app._dynamic_routes` is PRIVATE powertools API, used deliberately and for
    that same reason — the installed version's compiled regex is the only thing
    that answers the question, and it is not exposed publicly. So an upgrade that
    renames the attribute should fail HERE, in a helper whose docstring says why
    it reaches in, rather than anywhere else.

    Selected on the full route path rather than on the `/iframe` suffix alone: a
    second `<something>/iframe` route added later would otherwise be a candidate,
    and this helper would either pick it or trip its own count assertion for a
    reason that has nothing to do with the form id.
    """
    routes = [
        route for route in handler.app._dynamic_routes
        if route.rule.pattern.endswith('/iframe/*$')
        and '/feedback-forms/' in route.rule.pattern
    ]
    assert len(routes) == 1, (
        f'expected exactly one dynamic /feedback-forms/<id>/iframe route on the '
        f'resolver, found {len(routes)} — this helper needs updating, it is not '
        'a finding about validation.'
    )
    return routes[0].rule


def _init_call_argument(page: str) -> str:
    """The text between `VoCFeedbackForm.init(` and the end of the page.

    Everything the handler wrote AFTER the opening parenthesis of the init call,
    deliberately unparsed: the assertions below decide where the argument ends by
    handing this to a JSON decoder, which is the whole question. Slicing at a
    matching `)` here would answer it in the helper.

    `rfind`, because the inlined widget's own docblock contains a
    `VoCFeedbackForm.init({` usage example; the call the handler emits is the last
    one on the page.
    """
    marker = 'VoCFeedbackForm.init('
    start = page.rfind(marker)
    assert start != -1, (
        'the rendered page contains no VoCFeedbackForm.init( call — the embed '
        'contract changed; this is a broken helper, not an injection finding.'
    )
    return page[start + len(marker):]


def _quoted_interpolations(source: str, function_name: str) -> list[str]:
    """Interpolations inside `function_name` that a handwritten quote pair wraps.

    Derived from the handler's SOURCE with `ast`, scoped to one function, because
    the defect being pinned is a spelling rather than an output: `'{form_id}'` in
    an f-string is a JavaScript string literal whose quotes the template chose, so
    the value can close them. `json.dumps` brings its own quotes; wrapping its
    result in another pair puts the value back outside them.

    Returns the offending source snippets so a failure names them. An interpolated
    expression that is followed by a quote but not preceded by one (or the reverse)
    is reported too: an unbalanced quote around a value is not a safe spelling
    either, it is a broken one.

    NOTE for whoever this fails on: an interpolation adjacent to a quote is not
    universally wrong — `id="{html.escape(x, quote=True)}"` is the CORRECT spelling
    for a value rendered as MARKUP, and `_js_value`'s docstring says so. This check
    is about the page as it stands, where the only reflected value is in SCRIPT
    context and none is in an attribute. If a legitimate HTML-context value is
    added here, widen this derivation to allow it — do NOT remove the escaping to
    get green.
    """
    tree = ast.parse(source)
    functions = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == function_name
    ]
    assert len(functions) == 1, (
        f'expected exactly one def {function_name} in the source given, found '
        f'{len(functions)} — a rename would otherwise make this derivation '
        'silently scan nothing.'
    )
    function = functions[0]
    joined_strings = [
        n for n in ast.walk(function) if isinstance(n, ast.JoinedStr)
    ]
    # THE VACUITY GUARD, and the reason it is an assert rather than an early
    # return: "no offenders" and "nothing to judge" are the same empty list to the
    # caller, and only one of them is a pass. `get_form_iframe` renders the page
    # from an f-string, so finding none means the template moved — most plausibly
    # into a private helper, since the function is long — and the caller's green
    # result would be about a function that no longer renders anything.
    assert joined_strings, (
        f'{function_name} contains no f-string, so this derivation has nothing '
        'to judge and a green result from it would mean nothing. If the HTML '
        'template moved into a helper, point the caller at that helper (or scan '
        'both) rather than deleting this guard.'
    )
    offenders = []
    for joined in joined_strings:
        parts = joined.values
        for index, part in enumerate(parts):
            if not isinstance(part, ast.FormattedValue):
                continue
            before = parts[index - 1] if index else None
            after = parts[index + 1] if index + 1 < len(parts) else None
            preceded = (
                isinstance(before, ast.Constant)
                and isinstance(before.value, str)
                and before.value.endswith(('"', "'"))
            )
            followed = (
                isinstance(after, ast.Constant)
                and isinstance(after.value, str)
                and after.value.startswith(('"', "'"))
            )
            if preceded or followed:
                # The EXPRESSION, not the `{...}` around it: the name is what a
                # failure has to report, since it is the value whose quoting is
                # wrong and the thing the reader has to go and fix.
                offenders.append(ast.unparse(part.value))
    return offenders


class TestThePublicIframePageRefusesAnIdItCannotHaveMinted:
    """Both gates in front of the iframe page, and the page they gate (#379).

    A malformed id and an id for a form that does not exist answer the same 404,
    and both answer it BEFORE any HTML exists — the route used to render a page
    for any string its pattern matched, having read nothing.
    """

    def test_the_route_pattern_admits_the_payload_this_class_refuses(
        self, feedback_form_handler
    ):
        """The positive control, without which every 404 below is meaningless.

        If powertools' capture group refused this string, the refusals asserted
        below would be the FRAMEWORK's and the tests would pass with
        `_validated_form_id` deleted. Read off the compiled route on the live
        resolver, so it tracks the installed version.
        """
        rule = _route_pattern_for_iframe(feedback_form_handler)

        assert rule.match(f'/feedback-forms/{_INJECTION_PAYLOAD}/iframe'), (
            f'the route pattern {rule.pattern} no longer matches '
            f'{_INJECTION_PAYLOAD!r}, so the 404s in this class prove nothing '
            'about the handler. If powertools narrowed its capture group, this '
            'class needs a payload that still reaches the handler.'
        )

    @patch('feedback_form_handler.aggregates_table')
    def test_a_quote_paren_semicolon_id_is_refused_before_any_html(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The defect itself: this used to be 200 text/html with the payload in a
        script block. It must be a 404, produced without touching the table —
        format is decided before a read is paid for."""
        response = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, _INJECTION_PAYLOAD), lambda_context
        )

        assert response['statusCode'] == 404
        # "This response is not a document" — stated as the response's own
        # content type, which is the positive assertion
        # test_a_server_minted_id_still_serves_the_embeddable_page makes. Asserted
        # this way rather than as "the letters h-t-m-l are absent from the body",
        # which is a property of an unrelated JSON error message.
        assert response['multiValueHeaders']['Content-Type'] != ['text/html']
        assert 'alert(' not in response['body']
        # Not echoed back in any form, either: the refusal names the resource,
        # never the caller's string.
        assert 'document.domain' not in response['body']
        mock_table.get_item.assert_not_called()

    @patch('feedback_form_handler.aggregates_table')
    def test_an_over_long_id_is_refused_without_a_read(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """Length is bounded as well as character set, so a megabyte path segment
        costs no DynamoDB call. Derived from the cap rather than hardcoded: a
        literal would silently become a VALID length the day the cap is raised."""
        too_long = 'a' * (feedback_form_handler.FORM_ID_MAX_LENGTH + 1)

        response = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, too_long), lambda_context
        )

        assert response['statusCode'] == 404
        mock_table.get_item.assert_not_called()

    @patch('feedback_form_handler.aggregates_table')
    def test_a_well_formed_id_for_an_absent_form_is_refused(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The gate the route did not have at all: /config and /submit 404 an id
        the table does not hold, and this route rendered a page for it. An
        attacker-chosen page on this origin is the thing that mattered, and it did
        not need a malformed id."""
        mock_table.get_item.return_value = {}

        response = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, 'deadbeef'), lambda_context
        )

        assert response['statusCode'] == 404
        # Not a document — see the note on the same assertion above.
        assert response['multiValueHeaders']['Content-Type'] != ['text/html']
        # The read HAPPENED — this is the existence gate, not the format one, and
        # a 404 that skipped the lookup would be the format check refusing a
        # legitimate id instead.
        mock_table.get_item.assert_called_once()
        assert (
            mock_table.get_item.call_args.kwargs['Key']['sk'] == 'FORM#deadbeef'
        )

    @patch('feedback_form_handler.aggregates_table')
    def test_a_read_that_fails_refuses_the_page_rather_than_rendering_it(
        self, mock_table, capsys, api_gateway_event, lambda_context,
        feedback_form_handler
    ):
        """The availability trade `get_form_iframe`'s docstring argues, pinned.

        Having an existence gate means this route can now FAIL: before it, a page
        was served having read nothing, so a table blip could not affect it. That
        paragraph calls the 500 acceptable rather than a regression on two grounds,
        and both of them are assertions here rather than prose:

        - The page must NOT render for a form whose existence could not be
          confirmed. A future `except` that swallowed the read failure and rendered
          anyway — the obvious "keep the embed working" fix — restores exactly
          #379's hole, a page on this origin for a form that may not exist, and
          nothing else in the suite would notice.
        - It must be OBSERVABLE. `FeedbackFormReadFailed` is the whole basis for
          calling this a trade: a 500 the customer sees and operations does not is
          the silent half of the defect `_load_form_for_query` was introduced for
          (#312). Asserted all the way out through the EMF flush, like the /stats
          case, so a metric that is buffered and never published still fails.
        """
        mock_table.get_item.side_effect = Exception(
            'ProvisionedThroughputExceededException'
        )

        response = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, 'deadbeef'), lambda_context
        )

        assert response['statusCode'] == 500
        assert json.loads(response['body'])['success'] is False
        # No document, which is the security half: the 500 has to be INSTEAD of
        # the page, not alongside a rendered one.
        assert response['multiValueHeaders']['Content-Type'] != ['text/html']
        assert 'VoCFeedbackForm' not in response['body']

        emitted = _emitted_metrics(capsys, 'FeedbackFormReadFailed')
        assert emitted, (
            'the iframe read failed and emitted no CloudWatch metric — the '
            'customer sees a broken frame and operations sees nothing, which is '
            'what would make this existence check a regression rather than the '
            'trade the docstring argues'
        )
        assert _namespaces_of(emitted) == {feedback_form_handler.metrics.namespace}, (
            f'metric emitted under {_namespaces_of(emitted)}, not the namespace '
            'shared/logging sets on the Metrics singleton'
        )

    @patch('feedback_form_handler.aggregates_table')
    def test_a_server_minted_id_still_serves_the_embeddable_page(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The contract that must survive the two gates: a real form's page still
        renders, inlines the widget and points it at that form's config and submit
        endpoints on this request's own host.

        The id comes from the mint (`_minted_form_id`) rather than from a literal,
        so a validator narrowed past the format this service actually issues fails
        here instead of in a customer's iframe.
        """
        form_id = feedback_form_handler._minted_form_id()
        mock_table.get_item.return_value = {'Item': {'form_id': form_id}}

        response = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, form_id), lambda_context
        )
        page = response['body']

        assert response['statusCode'] == 200
        assert response['multiValueHeaders']['Content-Type'] == ['text/html']
        assert '<div id="voc-feedback-form"></div>' in page
        # The widget is inlined, not linked: the page has no second request to
        # make for its own code (get_widget_js).
        assert 'window.VoCFeedbackForm' in page

        options = json.loads(_json_prefix(_init_call_argument(page)))
        assert options['formId'] == form_id
        assert options['configEndpoint'] == f'/feedback-forms/{form_id}/config'
        assert options['submitEndpoint'] == f'/feedback-forms/{form_id}/submit'
        assert options['apiEndpoint'] == 'https://api.example.com/test'

    @patch('feedback_form_handler.aggregates_table')
    def test_a_hand_seeded_form_id_is_still_embeddable(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The bound is wider than the mint deliberately, and this is why.

        Records seeded by hand or by an import carry readable ids
        ('website-form'), and their /config and /submit routes answer, so an
        iframe narrowed to `[0-9a-f]{8}` would 404 a form that otherwise works —
        which reads as the product breaking rather than as a refusal. Pinned so
        the width is a decision rather than an accident of the pattern.
        """
        mock_table.get_item.return_value = {'Item': {'form_id': 'website-form_2'}}

        response = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, 'website-form_2'), lambda_context
        )

        assert response['statusCode'] == 200

    @patch('feedback_form_handler.aggregates_table')
    def test_the_page_carries_a_policy_that_still_lets_a_customer_frame_it(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """A CSP on the only HTML response in the API — with the ONE directive it
        must not carry.

        `frame-ancestors` (and X-Frame-Options) would refuse the embed this route
        exists for, and `frame-ancestors` has no fallback to `default-src`, so its
        absence is the deliberate half of the header rather than an omission. The
        asserted half is `default-src 'none'`: no external script, image or frame
        can load, so a value that somehow escaped the serializer has nowhere to
        send anything.
        """
        mock_table.get_item.return_value = {'Item': {'form_id': 'deadbeef'}}
        event = _iframe_event(api_gateway_event, 'deadbeef')
        # The resolver only emits a CORS header for a request that carries an
        # Origin it is configured to allow, so the last assertion below needs one
        # sent. In this suite that is conftest's ALLOWED_ORIGIN; the deployed
        # Lambda is given '*' (api-stack.ts) because the embed's origin is a
        # customer's own domain.
        event['headers']['Origin'] = os.environ['ALLOWED_ORIGIN']

        headers = feedback_form_handler.lambda_handler(event, lambda_context)[
            'multiValueHeaders'
        ]

        policy = headers['Content-Security-Policy'][0]
        assert "default-src 'none'" in policy
        assert 'frame-ancestors' not in policy, (
            'frame-ancestors refuses the embed this route exists for — see '
            'docs/feedback-forms.md, which publishes the iframe snippet'
        )
        assert 'X-Frame-Options' not in headers
        # And the CORS header is still there: adding response headers of our own
        # must not have replaced the ones the resolver contributes.
        assert headers['Access-Control-Allow-Origin'] == [
            os.environ['ALLOWED_ORIGIN']
        ]

    def test_the_policy_names_every_directive_the_page_needs_and_no_wildcard(
        self, feedback_form_handler
    ):
        """The FUNCTIONAL half of the policy, pinned in both directions.

        The case above pins the two deliberate OMISSIONS. This one pins what the
        page needs in order to work at all, because `default-src 'none'` is the
        fallback for anything not named: delete `script-src 'unsafe-inline'` and
        the inlined widget never executes, delete `style-src 'unsafe-inline'` and
        the <style> block plus every `style.cssText` assignment is dropped, delete
        `connect-src 'self'` and the widget's /config fetch and submit POST are
        blocked. Each is a TOTAL, SILENT failure of the product on every customer
        site — the frame renders an empty div, and no assertion about `default-src`
        alone notices.

        Compared as a whole mapping rather than directive by directive, so the
        other direction fails too: widening `script-src` to `'unsafe-inline' *`, or
        adding `img-src *`, undoes the containment argument on
        `_IFRAME_SECURITY_HEADERS` — that a value which escaped the serializer has
        nowhere to send anything — and an `in`-style assertion would stay green
        through it.
        """
        policy = feedback_form_handler._IFRAME_SECURITY_HEADERS[
            'Content-Security-Policy'
        ]

        directives = {}
        for directive in policy.split(';'):
            name, _, sources = directive.strip().partition(' ')
            assert name not in directives, (
                f'{name} is stated twice in the policy; a browser honours the '
                'FIRST occurrence, so the second is silently dead'
            )
            directives[name] = sources.split()

        assert directives == {
            'default-src': ["'none'"],
            'script-src': ["'unsafe-inline'"],
            'style-src': ["'unsafe-inline'"],
            'connect-src': ["'self'"],
            'base-uri': ["'none'"],
            'form-action': ["'none'"],
        }, (
            f'the policy is now {directives}. A REMOVAL from script-src, '
            'style-src or connect-src breaks every embed silently (default-src '
            "'none' is the fallback); an ADDITION or a widening undoes the "
            'containment argument on _IFRAME_SECURITY_HEADERS. Either way this '
            'expectation and that comment change together.'
        )
        # Restated as its own assertion because it is the failure worth naming:
        # a wildcard anywhere is what turns the policy from a bound into a
        # formality, and the mapping above would report it as a diff of quoted
        # strings rather than as "this is now open".
        assert not any(
            '*' in source for sources in directives.values() for source in sources
        ), f'a wildcard source makes the policy no bound at all: {directives}'

    def test_the_widget_asks_for_no_asset_the_policy_would_block(
        self, feedback_form_handler
    ):
        """`default-src 'none'` also blocks images, fonts and frames — and that is
        only safe because the widget asks for none of them.

        The policy deliberately carries no `img-src`, `font-src` or `frame-src`,
        on the grounds that feedback-widget.js builds its UI from DOM elements,
        text and CSS alone. That is a claim about ANOTHER file, so it is derived
        from that file rather than trusted: the day the widget grows an icon, a
        `url(...)` background or a webfont, this fails and names the directive the
        policy needs — instead of the asset silently not loading in every
        customer's iframe.

        `form-action 'none'` rides on the same derivation: the widget submits
        through `fetch`, and a real <form> would need that directive relaxed.

        Read through `get_widget_js` rather than off the path, so this judges the
        script the page actually inlines — including the fallback, if the static
        file is ever missing.
        """
        widget = feedback_form_handler.get_widget_js()

        # `data:` is included because it is a source EXPRESSION, not just a URL
        # scheme: `default-src 'none'` blocks a `data:` image or font as surely as
        # a remote one, and a `data:` URI is the shape an inlined icon takes.
        for pattern, directive in (
            (r'<img\b', 'img-src'),
            (r'\.src\s*=', 'img-src (or script-src for a loaded script)'),
            (r'url\(', 'img-src / font-src, for a CSS-referenced asset'),
            (r'data:', 'img-src / font-src, for an inlined asset'),
            (r'@font-face', 'font-src'),
            (r'<iframe\b', 'frame-src'),
            (r'<form\b', "form-action — currently 'none'"),
        ):
            match = re.search(pattern, widget)
            # The MATCHED TEXT and its line, not just the pattern that fired.
            # Several of these patterns are broad on purpose — `data:` matches a
            # Content-Type literal or the word in a comment as readily as a real
            # URI — so a failure has to hand the reader the thing to look at.
            # Otherwise the message points at CSP for what may be a false
            # positive, and the derivation gets deleted rather than narrowed.
            context = ''
            if match:
                line_number = widget.count('\n', 0, match.start()) + 1
                line = widget.splitlines()[line_number - 1].strip()
                context = f' at line {line_number}: {line[:120]!r}'
            assert not match, (
                f'feedback-widget.js now matches {pattern!r}{context}, so the '
                f'page needs {directive} in _IFRAME_SECURITY_HEADERS. Without it '
                'the asset is blocked in every embed and nothing else reports '
                "it — default-src 'none' fails closed and silently. If the match "
                'is not a real asset request, narrow the pattern rather than '
                'dropping the case.'
            )

    def test_a_minted_id_always_satisfies_the_validator(
        self, feedback_form_handler
    ):
        """The ONE coupling between the mint and the validator that must hold.

        The two are deliberately independent — the validator is wider, for the
        reason `test_a_hand_seeded_form_id_is_still_embeddable` pins — so nothing
        else ties `FORM_ID_LENGTH` to `_FORM_ID_PATTERN`. But an id this service
        ISSUES must always be one it will serve a page for, or `create_form`
        would hand back an id whose iframe 404s.

        Asserted over many mints rather than one, because the failure mode is
        value-dependent: a mint that emitted a separator, or a length raised past
        what the pattern admits, would only show up for some draws.

        Also pins the format the mint's docstring CLAIMS — hex, no separator —
        which the pattern alone would not, since it admits `-`. That assertion is
        what makes `FORM_ID_LENGTH` safe to RAISE: the dashed spelling of a uuid4
        puts a '-' at offset 8, so slicing 9 or more characters of it mints an id
        holding a separator the docstring does not describe. With this here,
        raising the constant is a one-line change rather than a trap.
        """
        for _ in range(200):
            minted = feedback_form_handler._minted_form_id()

            assert feedback_form_handler._FORM_ID_PATTERN.match(minted), (
                f'_minted_form_id() produced {minted!r}, which _validated_form_id '
                'refuses — every public route would 404 an id this service just '
                'issued. The mint and the pattern are independent by design, but '
                'not in this direction.'
            )
            assert len(minted) == feedback_form_handler.FORM_ID_LENGTH
            assert re.fullmatch(r'[0-9a-f]+', minted), (
                f'_minted_form_id() produced {minted!r}, which is not the "hex '
                'characters" its docstring describes. This is what fails if the '
                'slice goes back to `str(uuid.uuid4())` — harmless at length 8, '
                'a separator in the id at 9 or more.'
            )

    @patch('feedback_form_handler.aggregates_table')
    def test_an_id_padded_with_whitespace_is_not_an_alias_for_the_id(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """A form id is EXACT: `' deadbeef'` is not `'deadbeef'`.

        `ballots_handler._validated_session_id`, the sibling this is modelled on,
        `.strip()`s — harmlessly, since a session id is a 128-bit token. Inheriting
        that here would make every whitespace variant of an id a distinct URL
        serving byte-identical HTML, which is a cache-key multiplier for the
        `Cache-Control` follow-up recorded in `lib/stacks/api-stack.ts` — whose
        premise is that this response is a pure function of the id and the host.
        With a strip it is a pure function of the STRIPPED id while the cache keys
        on the raw path.

        So the leniency is dropped rather than inherited, and pinned here so
        re-adding it is a decision. No id this service mints has whitespace to
        forgive (`test_a_minted_id_always_satisfies_the_validator`).
        """
        response = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, ' deadbeef'), lambda_context
        )

        assert response['statusCode'] == 404
        mock_table.get_item.assert_not_called()


def _json_prefix(text: str) -> str:
    """The longest leading substring of `text` that is one JSON value.

    `raw_decode` is the point rather than a convenience: it reports where the
    value ENDS, so the caller can assert what follows it. That is how "the input
    could not create a second statement" is checked without a JavaScript engine —
    if a payload had closed the argument, the decoder would stop early and the
    remainder would carry the caller's code instead of just `);`.
    """
    value, end = json.JSONDecoder().raw_decode(text)
    assert value is not None
    return text[:end]


class TestEveryJavaScriptValueOnTheIframePageIsSerialized:
    """Escaping, asserted independently of the validation in front of it.

    The two are not alternatives: `_validated_form_id` bounds what reaches the
    handler, and this bounds what a value can DO once there — so widening the
    pattern later, or a change in the route regex underneath it, cannot turn into
    executable script. Which means these cases have to reach the serializer
    directly, since the route now refuses the payload before rendering.
    """

    def test_the_injection_payload_serializes_to_one_inert_string(
        self, feedback_form_handler
    ):
        """Quote, `)` and `;` become data: one JSON string, nothing after it.

        The failing spelling — `'{form_id}'` — produced
        `formId: 'a');alert(document.domain);x=('',` i.e. a closed string, a
        closed call and a second statement. The assertion is therefore about the
        REMAINDER: a serialized value that consumed the whole text cannot have
        ended early enough to start anything.
        """
        serialized = feedback_form_handler._js_value(_INJECTION_PAYLOAD)

        value, end = json.JSONDecoder().raw_decode(serialized)
        assert value == _INJECTION_PAYLOAD, (
            'the value did not survive as itself — the widget would receive a '
            'different form id than the caller asked for'
        )
        assert end == len(serialized), (
            f'the JSON value ends at {end} of {len(serialized)}; '
            f'{serialized[end:]!r} is trailing text a JavaScript engine would '
            'read as further code'
        )
        # The serializer chose the delimiters, which is why the payload's
        # apostrophe is harmless while still being emitted as itself: the literal
        # is double-quoted, so `'` is an ordinary character inside it and the `)`
        # and `;` after it never leave it. Asserted this way rather than as "`'`
        # does not appear", which would be a claim about JSON's escaping style
        # rather than about what the value can do.
        assert serialized.startswith('"') and serialized.endswith('"')
        assert '"' not in serialized[1:-1], (
            'an unescaped double quote inside the literal would close the '
            'delimiter the serializer chose, which is the same defect one '
            'delimiter along'
        )

    def test_a_script_closing_tag_cannot_end_the_element(
        self, feedback_form_handler
    ):
        """`</script>` ends a script element wherever it appears, INCLUDING inside
        a JavaScript string literal — the HTML parser gets there first and knows
        nothing about quoting. So `json.dumps` alone is not enough for this
        position, and `html.escape` would be wrong (its `&lt;` is an entity the
        script context never decodes, corrupting the value).
        """
        serialized = feedback_form_handler._js_value('</script><img src=x>')

        assert '<' not in serialized
        assert '>' not in serialized
        # Still the same string to the JavaScript engine, which is the half a
        # naive strip-the-characters fix would lose.
        assert json.loads(serialized) == '</script><img src=x>'

    def test_an_ampersand_cannot_reach_the_html_parser(
        self, feedback_form_handler
    ):
        """`&` is the other character the HTML parser gives meaning to, and it is
        escaped by the implementation — asserted here because it was the one of the
        three replacements nothing covered.

        It matters for the same reason `<` does and for one more: an entity the
        parser decodes could reconstitute a character the escaping above removed,
        so leaving `&` as itself would make the `<`/`>` handling conditional on
        the parser's behaviour rather than absolute.
        """
        serialized = feedback_form_handler._js_value('a &lt; b &amp; c')

        assert '&' not in serialized, (
            'an unescaped & lets the HTML parser decode an entity inside the '
            'script, which is how a removed character comes back'
        )
        assert json.loads(serialized) == 'a &lt; b &amp; c'

    def test_a_line_separator_cannot_end_the_statement(
        self, feedback_form_handler
    ):
        """U+2028 and U+2029 terminate a JavaScript LINE but are legal, raw, inside
        a JSON string — so a serializer that emitted them as themselves would end
        the statement from inside the literal, which is the same defect as an
        unescaped quote arriving by a route JSON considers valid.

        They are handled by `ensure_ascii=True`, which is `json.dumps`'s default
        AND is now passed explicitly — this case is what fails if someone writes
        `ensure_ascii=False` to make a non-ASCII value readable in a debug dump.
        Before this test, the safety of the two most JavaScript-specific
        characters on the page rested on an implicit default that nothing checked.
        """
        # Spelled as escapes, deliberately: a literal U+2028 in this file is
        # invisible to a reader and is exactly the character some tools
        # normalise away, which would make the case pass by having no subject.
        value = 'before\u2028after\u2029end'

        serialized = feedback_form_handler._js_value(value)

        assert '\u2028' not in serialized and '\u2029' not in serialized, (
            'a raw U+2028/U+2029 ends the JavaScript line inside the string '
            'literal — check that _js_value still passes ensure_ascii=True'
        )
        assert json.loads(serialized) == value

    def test_no_javascript_value_is_wrapped_in_a_handwritten_quote_pair(
        self, feedback_form_handler
    ):
        """The spelling, not just this render's output.

        Read off `get_form_iframe`'s source with `ast`: an interpolation with a
        quote character on either side is a template deciding where a JavaScript
        string begins and ends, which is the defect. A serializer's output brings
        its own quotes, so it needs none around it — and quotes around it would
        make the ones it wrote into data.
        """
        source = Path(inspect.getsourcefile(feedback_form_handler)).read_text(
            encoding='utf-8'
        )
        offenders = _quoted_interpolations(source, 'get_form_iframe')

        assert offenders == [], (
            f'{offenders} are interpolated inside handwritten quotes in '
            'get_form_iframe. A JS value must be emitted through _js_value, '
            'which quotes it itself.'
        )

    def test_the_quoted_interpolation_check_can_fail(self):
        """Positive control for the derivation above: it flags the real defect.

        Without it, a parse that quietly matched nothing would report an empty
        list and the test above would pass while pinning nothing. The input is the
        exact spelling this change removed.
        """
        source = textwrap.dedent('''
            def get_form_iframe(form_id):
                return f"""
                  formId: '{form_id}',
                  options: {init_options}
                """
        ''')

        offenders = _quoted_interpolations(source, 'get_form_iframe')

        assert offenders == ['form_id'], (
            'the derivation did not flag the exact spelling this change removed, '
            f'it reported {offenders} — so a green result above means nothing.'
        )

    def test_the_quoted_interpolation_check_refuses_to_pass_vacuously(self):
        """The OTHER way the derivation could be meaningless: nothing to judge.

        The control above proves the walk flags the defect when the template is
        inline. It does not cover the case where `get_form_iframe` contains no
        f-string at all — which is what happens if the ~90-line HTML template is
        ever refactored into a private helper, a very plausible change. The walk
        would then find no `JoinedStr`, return `[]`, and
        `test_no_javascript_value_is_wrapped_in_a_handwritten_quote_pair` would
        pass while checking nothing.

        So that case must RAISE rather than return `[]`. The input is the
        moved-to-helper shape, with the offending spelling sitting in the helper
        where the derivation cannot see it: the guard has to fire on the absence
        of a subject, not on the absence of offenders.
        """
        source = textwrap.dedent('''
            def _iframe_page(form_id):
                return f"""
                  formId: '{form_id}'
                """

            def get_form_iframe(form_id):
                return _iframe_page(form_id)
        ''')

        with pytest.raises(AssertionError, match='no f-string'):
            _quoted_interpolations(source, 'get_form_iframe')

    @patch('feedback_form_handler.aggregates_table')
    def test_the_rendered_init_call_carries_exactly_one_statement(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """End to end, on a page that really renders: the init argument is one
        JSON value and what follows it is only the call's own punctuation.

        This is the property the route-level 404s cannot show, because they never
        get as far as HTML — and it is the property that survives someone
        widening the id pattern.
        """
        form_id = feedback_form_handler._minted_form_id()
        mock_table.get_item.return_value = {'Item': {'form_id': form_id}}

        page = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, form_id), lambda_context
        )['body']

        argument = _init_call_argument(page)
        _value, end = json.JSONDecoder().raw_decode(argument)
        remainder = argument[end:]

        assert remainder.startswith(');'), (
            f'the init argument is followed by {remainder[:40]!r} rather than '
            'the call being closed immediately — anything between the value and '
            "the `)` is code the page's own template put there"
        )
        # Nothing but the closing of the script and the document after it.
        assert remainder.split(');', 1)[1].strip() == (
            '</script>\n</body>\n</html>'
        )


class TestEveryRouteThatKeysOnAFormIdChecksItsFormatFirst:
    """`_validated_form_id` at every route that turns a URL segment into a key.

    Its docstring makes a general argument — "a format check before any read
    means a probe for `/feedback-forms/admin` or a 1 MB path segment costs no
    DynamoDB call" — and that argument is only true where it is applied. It was
    applied on `/iframe` alone, so the two sibling PUBLIC routes (`/config`,
    `/submit`) took the raw capture group straight into a `get_item`, which is the
    cost basis the throttle pair in `lib/stacks/api-stack.ts` is argued from. The
    two authenticated read routes reach the same check through
    `_load_form_for_query`.

    Not an injection finding on any of them — those four answer JSON through
    `json.dumps` — but the gap is what would make the next reader of
    `_validated_form_id` assume a protection that was not there.
    `ballots_handler` applies its equivalent at all five of its routes; this
    mirrors that.

    These four are the routes an UNAUTHENTICATED caller can reach plus the two
    authenticated reads. The authenticated CRUD trio is covered separately, by
    `TestTheAuthenticatedCrudRoutesAreBoundedToo`, because what is at stake there
    is a write rather than a read cost — and the whole set is derived from the
    module's routing table by
    `test_no_route_keys_on_a_form_id_without_validating_it_first`, so neither class
    is the list of record.

    Asserted as "no read happened", route by route, because that is the property
    the comment claims and the only one a 404 alone would not distinguish from a
    lookup that merely found nothing.
    """

    # (route path suffix, method, whether the route needs a JSON body). The
    # malformed id must be refused BEFORE the body is considered too, which is why
    # `/submit` is exercised with a valid one: a 404 that only happened because
    # the body failed validation would prove nothing about the id.
    ROUTES = (
        ('config', 'GET', None),
        ('submit', 'POST', {'text': 'a real submission'}),
        ('stats', 'GET', None),
        ('submissions', 'GET', None),
    )

    @staticmethod
    def _malformed_ids(handler) -> tuple[str, ...]:
        """The two shapes the pattern refuses, derived rather than restated.

        The over-length one comes off `FORM_ID_MAX_LENGTH` so that raising the cap
        does not silently turn this case into a VALID id — the same reason
        `test_an_over_long_id_is_refused_without_a_read` derives its own.
        """
        return (_INJECTION_PAYLOAD, 'a' * (handler.FORM_ID_MAX_LENGTH + 1))

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_malformed_id_never_reaches_dynamodb_on_any_of_them(
        self,
        mock_table,
        _mock_feedback_table,
        api_gateway_event,
        lambda_context,
        feedback_form_handler,
    ):
        """The cost argument, checked where it is stated.

        A 4000-character path segment or the #379 payload must cost zero
        `get_item` calls on every route that keys on a form id — not just on the
        one whose rendering made it a security defect.
        """
        for suffix, method, body in self.ROUTES:
            for malformed in self._malformed_ids(feedback_form_handler):
                mock_table.reset_mock()
                event = api_gateway_event(
                    method=method,
                    path=f'/feedback-forms/{malformed}/{suffix}',
                    path_params={'form_id': malformed},
                    body=body,
                    resource=f'/feedback-forms/{{form_id}}/{suffix}',
                )

                response = feedback_form_handler.lambda_handler(
                    event, lambda_context
                )

                assert response['statusCode'] == 404, (
                    f'{method} /{suffix} answered {response["statusCode"]} for a '
                    f'malformed id ({malformed[:20]!r}...) rather than the same '
                    '404 every sibling gives'
                )
                mock_table.get_item.assert_not_called()
                # Nor echoed: none of these four renders HTML, but a message that
                # quotes an unbounded path segment back is its own problem.
                assert malformed not in response['body']

    @patch('feedback_form_handler.aggregates_table')
    def test_a_well_formed_id_is_still_read_and_answered(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The other direction: the format gate must not have become the answer.

        `/config` with a real form still reads the table and serves its
        projection — so the 404s above are the validator refusing a shape, not a
        route that stopped working. The id is the hand-seeded style the pattern is
        deliberately wide enough for.
        """
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'website-form', 'enabled': True}
        }

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/website-form/config',
            path_params={'form_id': 'website-form'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['config']['enabled'] is True
        assert (
            mock_table.get_item.call_args.kwargs['Key']['sk']
            == 'FORM#website-form'
        )

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_malformed_id_never_reaches_the_queue_either(
        self,
        mock_table,
        mock_sqs,
        api_gateway_event,
        lambda_context,
        feedback_form_handler,
    ):
        """`/submit` is the one public route that also WRITES, so its refusal has a
        second thing to prove.

        A record enqueued for a form id that cannot be one of ours would be
        processed downstream — a Comprehend, Translate and Bedrock invocation
        each — and would land in the feedback partition under a `source_channel`
        no form can ever be read back through. So the refusal has to come before
        the send, not just before the read.
        """
        event = api_gateway_event(
            method='POST',
            path=f'/feedback-forms/{_INJECTION_PAYLOAD}/submit',
            path_params={'form_id': _INJECTION_PAYLOAD},
            body={'text': 'a real submission'},
            resource='/feedback-forms/{form_id}/submit',
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 404
        mock_table.get_item.assert_not_called()
        mock_sqs.send_message.assert_not_called()


class TestTheAuthenticatedCrudRoutesAreBoundedToo:
    """`GET`/`PUT`/`DELETE /feedback-forms/<form_id>`, and the write PUT used to do.

    These three are behind Cognito (`authMethodOptions` in
    `lib/stacks/api-stack.ts`), so none of this is the #379 vulnerability and the
    cost argument for a public probe does not apply. Two other things do:

    - `_validated_form_id`'s docstring claims the check is at EVERY route that
      turns a URL segment into a key. These were the three that disproved it.
    - `update_form` called `update_item` with no condition, and UpdateItem is an
      UPSERT. A `PUT` to an id the table did not hold therefore CREATED a row,
      keyed on whatever the caller put in the path.
    """

    # A VALID `PUT` body, and it has to be: `update_form` 400s on an empty update
    # (`No fields to update`), so a body with nothing in it would produce a refusal
    # that says nothing about the id. What is malformed in these cases is the ID.
    A_VALID_UPDATE_BODY = {'name': 'pwn'}

    @patch('feedback_form_handler.aggregates_table')
    def test_no_crud_route_turns_a_malformed_id_into_a_key(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The claim, checked at the three routes that used to break it.

        `get_item`, `update_item` and `delete_item` alike: a segment the pattern
        refuses must not reach the table at all, so the refusal cannot be confused
        with a lookup that found nothing (`GET`) or a write that happened to be
        harmless (`DELETE`).
        """
        for method, body in (
            ('GET', None),
            ('PUT', self.A_VALID_UPDATE_BODY),
            ('DELETE', None),
        ):
            for malformed in (
                _INJECTION_PAYLOAD,
                'a' * (feedback_form_handler.FORM_ID_MAX_LENGTH + 1),
            ):
                mock_table.reset_mock()
                event = api_gateway_event(
                    method=method,
                    path=f'/feedback-forms/{malformed}',
                    path_params={'form_id': malformed},
                    body=body,
                    resource='/feedback-forms/{form_id}',
                )

                response = feedback_form_handler.lambda_handler(
                    event, lambda_context
                )

                assert response['statusCode'] == 404, (
                    f'{method} /feedback-forms/<malformed> answered '
                    f'{response["statusCode"]}, not the 404 every other route '
                    'gives for an id that cannot be one of ours'
                )
                mock_table.get_item.assert_not_called()
                mock_table.update_item.assert_not_called()
                mock_table.delete_item.assert_not_called()

    @patch('feedback_form_handler.aggregates_table')
    def test_a_put_to_a_malformed_id_does_not_mint_a_phantom_form(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The write, which is what made this more than a docstring problem.

        Before the fix this answered **200** and called `update_item` with
        `sk='FORM#a\\');alert(document.domain);x=(\\''`. UpdateItem being an upsert,
        that CREATED the row — and since UPDATABLE_FIELDS does not include
        `form_id`, the row it created had none, so `item_to_form` read it back as
        `form_id: ''`: a nameless entry in `list_forms` that no route could then
        address or delete by id.

        The response body is asserted as well as the call, because the empty
        `form_id` coming back to the caller is the visible half of the same defect.
        """
        event = api_gateway_event(
            method='PUT',
            path=f'/feedback-forms/{_INJECTION_PAYLOAD}',
            path_params={'form_id': _INJECTION_PAYLOAD},
            body=self.A_VALID_UPDATE_BODY,
            resource='/feedback-forms/{form_id}',
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 404
        mock_table.update_item.assert_not_called()
        assert '"form_id":""' not in response['body'].replace(' ', '')

    @patch('feedback_form_handler.aggregates_table')
    def test_a_put_to_a_well_formed_absent_id_is_refused_by_the_table(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The other half, and the reason a format check alone was not the fix.

        `deadbeef` is a perfectly well-formed id, so the validator passes it and
        the upsert would still have created a row for a form that does not exist.
        `attribute_exists(sk)` is what refuses it, and the route must report that
        as the same 404 `GET` gives rather than as a 500 — a condition failing is
        the table answering the question, not an error.
        """
        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException',
                       'Message': 'The conditional request failed'}},
            'UpdateItem',
        )

        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/deadbeef',
            path_params={'form_id': 'deadbeef'},
            body={'name': 'a rename of a form that is not there'},
            resource='/feedback-forms/{form_id}',
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 404
        assert 'Form not found' in response['body']
        # The condition is on the request, not just in the docstring: without it
        # the write above would have succeeded and this test would need the mock
        # to fail for a different reason.
        assert (
            mock_table.update_item.call_args.kwargs['ConditionExpression']
            == 'attribute_exists(sk)'
        )

    @patch('feedback_form_handler.aggregates_table')
    def test_a_put_to_a_form_that_exists_still_updates_it(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The contract the two guards must not have broken.

        A real form still updates and still answers with the new record — so the
        404s above are the id or the condition refusing, not the route having
        stopped working.
        """
        mock_table.update_item.return_value = {
            'Attributes': {'form_id': 'deadbeef', 'name': 'Updated', 'enabled': True}
        }

        event = api_gateway_event(
            method='PUT',
            path='/feedback-forms/deadbeef',
            path_params={'form_id': 'deadbeef'},
            body={'name': 'Updated'},
            resource='/feedback-forms/{form_id}',
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['form']['name'] == 'Updated'
        assert (
            mock_table.update_item.call_args.kwargs['Key']['sk'] == 'FORM#deadbeef'
        )

    @patch('feedback_form_handler.aggregates_table')
    def test_a_delete_of_an_absent_form_stays_idempotent(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """`delete_form` deliberately gets NO existence condition, unlike `PUT`.

        DeleteItem on a missing key writes nothing, so there is no phantom row to
        prevent and the idempotent 200 is the honest answer — a caller retrying a
        delete should not get a 404 for having succeeded the first time. Pinned so
        the asymmetry with `update_form` reads as a decision rather than as the
        condition having been forgotten on one of the two writes.
        """
        event = api_gateway_event(
            method='DELETE',
            path='/feedback-forms/deadbeef',
            path_params={'form_id': 'deadbeef'},
            resource='/feedback-forms/{form_id}',
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert mock_table.delete_item.call_args.kwargs['Key']['sk'] == (
            'FORM#deadbeef'
        )
        assert 'ConditionExpression' not in mock_table.delete_item.call_args.kwargs


def _routes_keying_on_a_form_id(source: str) -> dict[str, str]:
    """Every `@app.<method>` route under `/feedback-forms/` that captures anything.

    Returns route path -> handler function name, read off the module with `ast`
    rather than listed here. The two classes above name their routes explicitly,
    which is what makes their failures legible; this exists so neither of those
    lists is what the module is measured against. A route added later appears here
    for free, and if it does not validate its id the test below fails naming it.

    Selected on the PATH PREFIX plus the presence of a `<...>` capture, and
    deliberately NOT on the literal `<form_id>`: the capture's NAME is the route
    author's choice, so `<id>`, `<formId>` or `<form>` are all plausible spellings
    for a route added later — and every one of them would have escaped a
    `'<form_id>' in path` filter while keying on the same partition. A universal
    claim whose universe is chosen by a name nobody has to use is not a universal
    claim; `test_a_route_that_captures_the_id_under_another_name_is_still_judged`
    is the control.

    Still excludes `/feedback-forms` and `POST /feedback-forms`: those carry no
    capture, so they take no id out of the URL and have nothing to check. A route
    under this prefix that captures something OTHER than a form id (a submission
    id, say) would be included and would have to establish the bound or say why —
    which is the right side to err on, since the alternative is silence.
    """
    tree = ast.parse(source)
    routes = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            target = decorator.func
            # `@app.get(...)`, `@app.put(...)` and so on — the attribute is the
            # HTTP method and the object has to be `app`, so `@tracer.capture_method`
            # (not a Call with a string argument) and any other decorator are out.
            if not isinstance(target, ast.Attribute):
                continue
            if not (isinstance(target.value, ast.Name) and target.value.id == 'app'):
                continue
            if not decorator.args:
                continue
            path = decorator.args[0]
            if not (isinstance(path, ast.Constant) and isinstance(path.value, str)):
                continue
            if path.value.startswith('/feedback-forms/') and '<' in path.value:
                routes[f'{target.attr.upper()} {path.value}'] = node.name
    assert routes, (
        'no @app route under /feedback-forms/ with a <...> capture was found in '
        'the handler source — the derivation found nothing to judge, so a green '
        'result below would be meaningless. If the routes moved or the decorator '
        'spelling changed, fix this helper; do not delete the assertion.'
    )
    return routes


# The objects a route reaches a form id INTO: the two DynamoDB tables, and the
# queue because `/submit` writes there and an enqueued record for an id that
# cannot be one of ours costs a Comprehend, Translate and Bedrock invocation
# downstream. A call on any of these is what "keys on it" means below, and the
# first one is the deadline the validation has to beat.
_FORM_ID_SINKS = frozenset({'aggregates_table', 'feedback_table', 'sqs'})


def _refused_names(function: ast.FunctionDef) -> set[str]:
    """Names this function tests in an `if` that then raises or returns.

    `_validated_form_id` returns None rather than raising — deliberately, since
    every caller answers the same 404 — so the CALL is not the bound; the refusal
    after it is. A function that calls the validator and ignores what comes back
    has no bound at all, which is the natural mistake for someone copying the call
    and dropping the two lines that follow it at every current site.
    """
    refused = set()
    for node in ast.walk(function):
        if not isinstance(node, ast.If):
            continue
        if not any(
            isinstance(child, (ast.Raise, ast.Return))
            for statement in node.body
            for child in ast.walk(statement)
        ):
            continue
        refused |= {
            name.id for name in ast.walk(node.test) if isinstance(name, ast.Name)
        }
    return refused


def _validates_its_form_id(source: str, function_name: str) -> bool:
    """Does `function_name` reach the validator, and REFUSE, before keying on
    anything?

    Positional and result-aware, because the order and the refusal are the whole
    claim. An earlier version of this helper was an order-insensitive set-membership
    test over every call name in the body, which three unsafe shapes satisfied: a
    `get_item` before the validator, a validator whose return value was discarded,
    and a validator mentioned only inside `if False:`. Each is reported False now,
    and each has a control below — the second one mattering most, since a route
    with no bound at all looked identical to a correct one.

    A validating statement is one of two spellings, both required to sit at the
    function's TOP LEVEL:

    - `<name> = _validated_form_id(...)` where `<name>` is later tested in an `if`
      whose body raises or returns. The assignment alone is not enough (see
      `_refused_names`).
    - a call to `_load_form_for_query(...)`, which needs no result check because it
      RAISES for itself. Following the delegation rather than demanding the direct
      call is deliberate: `/stats` and `/submissions` validate through it, and a
      derivation that named only `_validated_form_id` would push someone into
      adding a redundant second call to each.

    Top level rather than anywhere is what excludes dead code and conditional
    validation together — a check that only runs on some paths is not a bound, and
    `if False:` is just the extreme of that. If a legitimate spelling ever needs to
    nest (validation inside a `with`, say), widen this deliberately and add the
    control alongside the three below; do not relax it to get green.
    """
    tree = ast.parse(source)
    functions = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == function_name
    ]
    assert len(functions) == 1, (
        f'expected exactly one def {function_name}, found {len(functions)}'
    )
    function = functions[0]
    refused = _refused_names(function)

    def _calls(statement) -> list[ast.Call]:
        return [n for n in ast.walk(statement) if isinstance(n, ast.Call)]

    def _named(call: ast.Call, name: str) -> bool:
        return isinstance(call.func, ast.Name) and call.func.id == name

    validated_at = None
    for statement in function.body:
        for call in _calls(statement):
            if _named(call, '_load_form_for_query'):
                position = (statement.lineno, statement.col_offset)
                validated_at = min(validated_at or position, position)
            if not _named(call, '_validated_form_id'):
                continue
            # The result has to be BOUND and then refused. An `Expr` statement, or
            # an assignment to a name nothing tests, is the shape that has no bound.
            targets = (
                statement.targets if isinstance(statement, ast.Assign)
                else [statement.target] if isinstance(statement, ast.AnnAssign)
                else []
            )
            if any(
                isinstance(target, ast.Name) and target.id in refused
                for target in targets
            ):
                position = (statement.lineno, statement.col_offset)
                validated_at = min(validated_at or position, position)

    if validated_at is None:
        return False

    sink_positions = [
        (call.lineno, call.col_offset)
        for call in ast.walk(function)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Attribute)
        and isinstance(call.func.value, ast.Name)
        and call.func.value.id in _FORM_ID_SINKS
    ]
    # No sink is not a pass by default: #379 was a route that touched no AWS
    # service at all and still put the id in its response, so a route that keys on
    # nothing yet takes an id out of the URL still has to establish the bound.
    return all(validated_at < sink for sink in sink_positions)


class TestTheFormIdBoundIsUniversalRatherThanAListOfRoutes:
    """`_validated_form_id`'s docstring says EVERY route; this is what checks it.

    That claim was false when it was written — `/config`, `/submit`, `/iframe`,
    `/stats` and `/submissions` were covered and the authenticated CRUD trio was
    not, while the docstring enumerated five routes as if they were all of them.
    A prose list is the wrong instrument for a universal claim: it goes stale
    silently, and the reader who trusts it assumes a protection that is not there.

    So the universe is derived from the module's own routing table instead.
    """

    def test_no_route_keys_on_a_form_id_without_validating_it_first(
        self, feedback_form_handler
    ):
        """Every route under `/feedback-forms/<...>` validates and refuses first, or
        the failure names the ones that do not.

        This is the test that makes the docstring's "EVERY" audit itself. A route
        added later is included automatically — whatever it calls its capture — so
        the next person to write `@app.get("/feedback-forms/<id>/something")` finds
        out here rather than in a review.
        """
        source = Path(inspect.getsourcefile(feedback_form_handler)).read_text(
            encoding='utf-8'
        )
        routes = _routes_keying_on_a_form_id(source)

        unbounded = sorted(
            f'{route} ({function})'
            for route, function in routes.items()
            if not _validates_its_form_id(source, function)
        )

        assert unbounded == [], (
            f'{unbounded} take a form id out of the URL without establishing the '
            'bound before their first read or send. Three shapes report here, and '
            'the message cannot tell them apart: no validator call at all; a call '
            'whose None result is never refused (which is no bound — see '
            '_refused_names); or a call that comes AFTER the table or the queue is '
            "touched. Add the check rather than narrowing the claim: the value of a "
            'universal bound is that a reader does not have to hold the exceptions.'
        )

    def test_the_derivation_sees_the_routes_this_module_actually_has(
        self, feedback_form_handler
    ):
        """The positive control: the walk finds the whole surface, not a subset.

        Without this, `_routes_keying_on_a_form_id` returning only the routes that
        happen to pass would make the test above vacuous in the most convincing
        way possible — a green run over an empty-ish universe. The eight are named
        here because THIS is the assertion that is supposed to fail when the
        surface changes, prompting a decision about the new route.
        """
        source = Path(inspect.getsourcefile(feedback_form_handler)).read_text(
            encoding='utf-8'
        )

        assert set(_routes_keying_on_a_form_id(source)) == {
            'GET /feedback-forms/<form_id>',
            'PUT /feedback-forms/<form_id>',
            'DELETE /feedback-forms/<form_id>',
            'GET /feedback-forms/<form_id>/config',
            'POST /feedback-forms/<form_id>/submit',
            'GET /feedback-forms/<form_id>/iframe',
            'GET /feedback-forms/<form_id>/submissions',
            'GET /feedback-forms/<form_id>/stats',
        }

    def test_the_derivation_can_fail(self):
        """A route that keys on an id and does not check it must be REPORTED.

        The control for the check itself: fed a module with one unvalidated route,
        `_validates_its_form_id` has to say so. Otherwise the test above passes
        because the derivation always returns True, which is indistinguishable
        from a module that is correct.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/new-thing")
            def get_new_thing(form_id: str):
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )

            @app.get("/feedback-forms/<form_id>/checked")
            def get_checked(form_id: str):
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return validated
            '''
        )

        routes = _routes_keying_on_a_form_id(source)
        assert routes == {
            'GET /feedback-forms/<form_id>/new-thing': 'get_new_thing',
            'GET /feedback-forms/<form_id>/checked': 'get_checked',
        }
        assert not _validates_its_form_id(source, 'get_new_thing')
        # And the accepting side, so the check is not simply always False: the
        # module's own spelling — validate, refuse on None, then proceed.
        assert _validates_its_form_id(source, 'get_checked')

    def test_the_derivation_refuses_a_read_that_happens_before_the_check(self):
        """ORDER is part of the claim, and the old derivation ignored it.

        A route that reads first and validates afterwards satisfies "calls the
        validator" while paying for the DynamoDB call the check exists to avoid —
        which is the entire cost argument `_validated_form_id`'s docstring makes and
        the basis for the throttle pair in `lib/stacks/api-stack.ts`. So the
        validation has to beat the first sink, not merely appear somewhere in the
        body.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/backwards")
            def get_backwards(form_id: str):
                item = aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return item
            '''
        )

        assert not _validates_its_form_id(source, 'get_backwards'), (
            'a get_item before the validator was reported as validated — the '
            'derivation is order-insensitive again, and the cost argument it '
            'checks is about order'
        )

    def test_the_derivation_refuses_a_validator_whose_result_is_discarded(self):
        """The shape that has NO bound while looking exactly like one.

        `_validated_form_id` returns None rather than raising — deliberately, since
        every caller answers the same 404 — so the call is not the bound; the
        refusal after it is. A route that calls it and drops the result reads a
        malformed id straight into the table, and under the old set-membership
        derivation it was indistinguishable from a correct route.

        It is also the likeliest mistake in practice: the two-line
        `if not validated: raise` is separable from the call, and every one of the
        module's current sites spells it out by hand.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/discarded")
            def get_discarded(form_id: str):
                _validated_form_id(form_id)
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
            '''
        )

        assert not _validates_its_form_id(source, 'get_discarded'), (
            'a discarded validator result was reported as a bound — the value the '
            'derivation is checking for is the REFUSAL, not the call'
        )

        # And the same thing one step subtler: the result is bound to a name, but
        # nothing ever tests it. An assignment is not a refusal either.
        assigned_but_unchecked = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/assigned")
            def get_assigned(form_id: str):
                validated = _validated_form_id(form_id)
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
                )
            '''
        )

        assert not _validates_its_form_id(assigned_but_unchecked, 'get_assigned'), (
            'a validated value used as a key without being refused first was '
            "reported as bounded — `f'FORM#None'` is still a read"
        )

    def test_the_derivation_refuses_validation_that_only_runs_sometimes(self):
        """Dead or conditional validation is not validation.

        `if False:` is the extreme of a check that does not run on every path, and
        it passed the old derivation because the call was lexically present. The
        general property is what matters: validation nested under a condition
        bounds some requests and not others, so the derivation requires it at the
        function's top level.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/dead")
            def get_dead(form_id: str):
                if False:
                    validated = _validated_form_id(form_id)
                    if not validated:
                        raise NotFoundError('Form not found')
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
            '''
        )

        assert not _validates_its_form_id(source, 'get_dead'), (
            'validation inside dead code was reported as a bound — the check has '
            'to be on every path, not merely in the source'
        )

    def test_a_route_that_captures_the_id_under_another_name_is_still_judged(self):
        """The universe is chosen by the PATH, not by the capture's name.

        This is the hole a `'<form_id>' in path` filter left: a route capturing the
        same id as `<id>` keyed on the same partition while being invisible to the
        claim, so `test_no_route_keys_on_a_form_id_without_validating_it_first`
        passed with it unvalidated — silence, which is the failure mode this
        derivation replaced a prose list to avoid. `<id>` is not a hypothetical
        spelling; it is the shorter and more natural one for someone adding a
        route.

        Both directions, because only the pair makes the selector meaningful: the
        renamed route must be REPORTED as part of the universe, and then reported
        as UNVALIDATED. A selector that included it but a check that waved it
        through would be the same hole one step along.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<id>/export")
            def export_form(id: str):
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{id}'}
                )
            '''
        )

        routes = _routes_keying_on_a_form_id(source)

        assert routes == {'GET /feedback-forms/<id>/export': 'export_form'}, (
            f'the derivation reported {routes} — a route capturing the form id '
            'under a name other than form_id escapes the universal claim entirely'
        )
        assert not _validates_its_form_id(source, 'export_form')

    def test_the_derivation_accepts_the_delegating_spelling(self):
        """`/stats` and `/submissions` validate through `_load_form_for_query`.

        Pinned separately from the direct call because it is the one that would be
        lost first: a stricter derivation that demanded `_validated_form_id` by
        name would report those two as unbounded, and the tempting fix would be to
        add a redundant second call to each rather than to fix the test.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/stats")
            def get_form_stats(form_id: str):
                form = _load_form_for_query(form_id, 'Failed')
                return form
            '''
        )

        assert _validates_its_form_id(source, 'get_form_stats')


class TestTheValidatorIsExactSoNoRouteCanDisagreeWithAnother:
    """`_validated_form_id` returns what it was given, and that is load-bearing.

    Callers use their own `form_id` for things that are not the key —
    `source_channel` in `/submissions`, the id echoed in a response — so the
    validated value and the parameter have to be the same string. `.strip()` was
    removed for a related reason, but exactness is the broader property and it was
    carried entirely by a sentence in a docstring.
    """

    def test_the_validator_returns_its_input_unchanged(self, feedback_form_handler):
        """Identity, not merely truthiness.

        A normalizing validator — lower-casing, say, for a plausible "form ids are
        case-insensitive" change — would pass every existing test while splitting
        the module: `/stats` would read the record its key names and then filter
        submissions on a `source_channel` its CALLER built from the raw id, which
        no write ever used. Zero submissions for a form that has them, which is
        the false zero `_load_form_for_query` exists to prevent (#312).

        So the invariant gets a test instead of a sentence. If ids ever should be
        case-insensitive, the normalization belongs at the mint and at every read
        alike, and this test is the place to come and argue with.
        """
        for valid in (
            'deadbeef',
            'DEADBEEF',
            'website-form_2',
            'a',
            'a' * feedback_form_handler.FORM_ID_MAX_LENGTH,
            feedback_form_handler._minted_form_id(),
        ):
            assert feedback_form_handler._validated_form_id(valid) == valid, (
                f'{valid!r} came back as '
                f'{feedback_form_handler._validated_form_id(valid)!r} — a '
                'normalized return splits the key a route reads from the '
                'source_channel it filters on'
            )

    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_the_key_a_query_route_reads_is_the_id_in_its_url(
        self,
        mock_table,
        mock_feedback_table,
        api_gateway_event,
        lambda_context,
        feedback_form_handler,
    ):
        """The consequence, end to end on the route where it would surface.

        `_load_form_for_query` keys on the VALIDATED value while its callers build
        `source_channel` from the parameter. Both are asserted here against the id
        in the URL, so the two halves cannot drift apart without a failure — which
        is the only way this defect would ever have been noticed, since it produces
        a plausible-looking zero rather than an error.
        """
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'DeadBeef', 'brand_name': 'acme'}
        }
        mock_feedback_table.query.return_value = {'Items': []}

        event = api_gateway_event(
            method='GET',
            path='/feedback-forms/DeadBeef/submissions',
            path_params={'form_id': 'DeadBeef'},
            resource='/feedback-forms/{form_id}/submissions',
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert mock_table.get_item.call_args.kwargs['Key']['sk'] == 'FORM#DeadBeef'
        assert (
            mock_feedback_table.query.call_args.kwargs[
                'ExpressionAttributeValues'
            ][':sc']
            == 'form_DeadBeef'
        )


class TestTheSubmitRouteChecksTheIdBeforeTheBody:
    """The one input shape whose ERROR CLASS changed, pinned as a decision.

    Putting the format check above `app.current_event.json_body` is deliberate —
    `/submit` is the only public route that enqueues, so an id that cannot be one
    of ours must reach neither the table nor the queue, whatever the body says.

    The side effect is a contract change: a request carrying BOTH a malformed id
    and an invalid body used to be told about the body (400) and is now told about
    the id (404). That is the better answer — the id is wrong regardless of what
    the body contains — but it is observable to an integrator whose client
    distinguishes "fix your input" from "this form is gone", so it is recorded in
    `docs/feedback-forms.md` as well as here, and pinned so the ordering is a
    decision rather than an artefact of statement order.
    """

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_malformed_id_with_an_invalid_body_reports_the_id(
        self,
        mock_table,
        mock_sqs,
        api_gateway_event,
        lambda_context,
        feedback_form_handler,
    ):
        """404 for the id, not 400 for the empty text — and no read, no send."""
        event = api_gateway_event(
            method='POST',
            path=f'/feedback-forms/{_INJECTION_PAYLOAD}/submit',
            path_params={'form_id': _INJECTION_PAYLOAD},
            body={'text': ''},
            resource='/feedback-forms/{form_id}/submit',
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 404
        assert 'Form not found' in response['body']
        assert 'Feedback text is required' not in response['body']
        mock_table.get_item.assert_not_called()
        mock_sqs.send_message.assert_not_called()

    @patch('feedback_form_handler.sqs')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_well_formed_id_with_an_invalid_body_still_reports_the_body(
        self,
        mock_table,
        mock_sqs,
        api_gateway_event,
        lambda_context,
        feedback_form_handler,
    ):
        """The other side of the precedence, which is what makes it a precedence.

        With an id that could be ours, the empty `text` is still a 400 — so the
        404 above is the id being refused first, not the route having lost its body
        validation. Without this case, deleting the text check would leave the case
        above green.
        """
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms/deadbeef/submit',
            path_params={'form_id': 'deadbeef'},
            body={'text': ''},
            resource='/feedback-forms/{form_id}/submit',
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert 'Feedback text is required' in response['body']
        # Still before any read: the body is refused on its own terms, and the
        # form's existence was never the question.
        mock_table.get_item.assert_not_called()
        mock_sqs.send_message.assert_not_called()

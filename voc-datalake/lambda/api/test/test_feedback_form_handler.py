"""
Tests for feedback_form_handler.py - /feedback-forms/* endpoints.
"""
import ast
import inspect
import itertools
import json
import os
import re
import textwrap
from datetime import datetime
from pathlib import Path
from typing import ClassVar
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


def _form_id_route_paths(handler, form_id: str) -> list[tuple[str, str, re.Pattern]]:
    """Every form-id route's concrete path with `form_id` substituted in.

    The generalization of `_route_pattern_for_iframe` to the whole set, and it
    reaches into `app._dynamic_routes` for the same reason that one does: the
    question is what the INSTALLED powertools admits, so a copy of its capture
    group pasted here would answer it in the helper.

    Substituting into the compiled pattern rather than composing the path from a
    route table restated here, so the eight paths cannot drift from the eight
    routes. The group is spliced out by locating `(?P<form_id>` and the `]+)` that
    closes it, NOT by a non-greedy `\\(\\?P<form_id>.+?\\)` — powertools' class
    contains a literal `)`, so the lazy form stops inside it and yields a path
    every route rejects. That failure is silent in the direction that matters (an
    "excluded" verdict for every character), which is why the caller's positive
    control on a well-formed id is not optional.
    """
    paths = []
    for route in handler.app._dynamic_routes:
        pattern = route.rule.pattern
        start = pattern.find('(?P<form_id>')
        if start < 0:
            continue
        end = pattern.index(']+)', start) + len(']+)')
        path = pattern[:start] + form_id + pattern[end:]
        paths.append((
            route.method,
            path.removeprefix('^').removesuffix('/*$'),
            route.rule,
        ))
    return paths


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

    `ast.FunctionDef` alone, where `_sink_bearing_helpers` and
    `_routes_keying_on_a_form_id` accept `ast.AsyncFunctionDef` too, and that is a
    decision rather than the last place a widening was forgotten. The argument for
    widening those two is a failure DIRECTION: a route or a helper they cannot see
    leaves the universe silently, so the verdict is a vacuous pass. This function
    fails LOUDLY instead — the assert below reports "found 0" and names the function
    it could not find, because it is scoped to one concretely named subject rather
    than deriving a set. So an `async def get_form_iframe` breaks this test rather
    than emptying it, which is the outcome the widening exists to produce. Widen it
    anyway if it ever takes its subject from a derivation.
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
    def test_a_dotted_hand_seeded_form_id_still_resolves(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The sibling above pins the width for `-` and `_`; this pins it for `.`.

        The one respect in which this change is not additive: the character class is
        a NEW refusal applied to ids that are ALREADY STORED, so for a row outside
        it the change turns a record that resolved into one that 404s on all eight of
        its routes. The whitespace case in the upgrade notes is exempt from that by
        an argument — ` abc123` never addressed `abc123`, the space was always part
        of the key — but a dotted id has no such argument available: `acme.website`
        was found, and nothing about it is malformed.

        `.` is therefore inside the class, and it costs the #379 fix nothing: a dot
        cannot close a JavaScript string, open a tag or begin a statement, so no
        character the serializer depends on moved. The characters still outside
        (`:`, `+`, `@`, `%`, non-ASCII) get an operator scan in the upgrade notes
        instead, because for those the 404 is real.

        Asserted on the KEY the route read rather than on the status alone: a 200
        would also be produced by a route that had stopped keying on the id at all,
        and it is reachability of the stored row — not the response code — that this
        case is about.
        """
        mock_table.get_item.return_value = {'Item': {'form_id': 'acme.website'}}

        response = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, 'acme.website'), lambda_context
        )

        assert response['statusCode'] == 200, (
            'a dotted hand-seeded id was refused its page — that row resolved '
            'before this change, so refusing it is a stored form becoming '
            'unreachable rather than a probe being refused'
        )
        assert (
            mock_table.get_item.call_args.kwargs['Key']['sk'] == 'FORM#acme.website'
        )
        options = json.loads(_json_prefix(_init_call_argument(response['body'])))
        assert options['formId'] == 'acme.website'

    @patch('feedback_form_handler.aggregates_table')
    def test_a_disabled_form_still_serves_its_page_so_the_widget_can_say_so(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The gate checks EXISTENCE, not `enabled` — and that is a decision.

        It reads like an oversight, especially since the returned record is
        discarded: someone arriving via "the iframe route now checks the form
        exists" has a standing invitation to add `if not form.get('enabled')` here,
        and it would look like tightening.

        It would be a regression. The widget has to RUN in order to render its own
        disabled state, so refusing the page replaces that with a raw API Gateway
        404 frame on the customer's site — a broken embed for a customer who merely
        turned the form off. The division of labour is `GET /config` publishing
        `enabled` in its projection and `submit_form_feedback` enforcing it, and
        this route matches /config rather than /submit.

        Asserted on the PAGE, not just the status, because a 200 alone would not
        show that the widget is present to do the saying.
        """
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'deadbeef', 'enabled': False}
        }

        response = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, 'deadbeef'), lambda_context
        )

        assert response['statusCode'] == 200, (
            'a disabled form was refused its page — the visitor now sees a raw '
            'API Gateway error frame instead of the widget saying the form is '
            'unavailable. `enabled` belongs to /config and /submit, not to this '
            'existence gate.'
        )
        assert response['multiValueHeaders']['Content-Type'] == ['text/html']
        assert 'window.VoCFeedbackForm' in response['body']

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

    @patch('feedback_form_handler.aggregates_table')
    def test_the_response_carries_the_two_headers_the_csp_does_not(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """`nosniff` and `no-referrer`, which nothing else in this suite reads.

        The CSP is pinned in both directions by the case below, but that case reads
        `_IFRAME_SECURITY_HEADERS['Content-Security-Policy']` BY KEY — so it sees no
        other entry in the dict, and deleting either of the other two headers left
        the whole suite green.

        Asserted as the WHOLE key set rather than as two `in` checks, so a header
        added later has to be argued for here and in the comment above the dict
        together — which is the convention the CSP already follows.

        Read off the rendered response rather than off the constant, because the
        constant being right is only half of it: `get_form_iframe` passes
        `headers=dict(_IFRAME_SECURITY_HEADERS)`, and a `Response` that dropped them
        or a resolver that overwrote them would leave the dict itself untouched.
        """
        mock_table.get_item.return_value = {'Item': {'form_id': 'deadbeef'}}

        headers = feedback_form_handler.lambda_handler(
            _iframe_event(api_gateway_event, 'deadbeef'), lambda_context
        )['multiValueHeaders']

        assert set(feedback_form_handler._IFRAME_SECURITY_HEADERS) == {
            'Content-Security-Policy',
            'X-Content-Type-Options',
            'Referrer-Policy',
        }, (
            'a header was added to or removed from _IFRAME_SECURITY_HEADERS. A '
            'REMOVAL of X-Content-Type-Options or Referrer-Policy is otherwise '
            'silent — the CSP case reads the policy by key and sees no other '
            'entry — and an ADDITION needs its reason recorded in the comment '
            'above the dict, as the CSP and these two both are.'
        )

        # nosniff, because this is the only text/html in an otherwise all-JSON API:
        # the one response a browser would otherwise be free to type for itself,
        # and the one whose point is to be parsed as a document on this origin.
        assert headers['X-Content-Type-Options'] == ['nosniff']
        # no-referrer, because the page is framed on a customer's site, so the
        # Referer on the widget's own fetches would put the customer's page URL in
        # this API's access logs. The submit body carries `page_url` deliberately,
        # so the product is not losing the URL — a log is just not where it was
        # asked for.
        assert headers['Referrer-Policy'] == ['no-referrer']

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
    A_VALID_UPDATE_BODY: ClassVar[dict[str, str]] = {'name': 'pwn'}

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

    @patch('feedback_form_handler.aggregates_table')
    def test_a_create_that_would_overwrite_a_stored_form_is_refused(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The mirror image of `PUT`'s condition, on the write that OVERWRITES.

        `update_form` needed `attribute_exists(sk)` because UpdateItem creates
        silently. PutItem replaces just as silently, so `create_form` is the other
        half: with no condition, a minted id that collides with a stored form
        REPLACES it — that customer's `enabled` flag, theme and prioritization link
        gone, answered 200, the response echoing the NEW record so nothing anywhere
        says a form was lost.

        Not reachable by a caller, since the id is minted and never taken from the
        body, so it takes a collision: two `_minted_form_id()` draws agreeing, a
        birthday problem over 32 bits at `FORM_ID_LENGTH = 8`. Small, not zero —
        and the constant's comment says it is safe to RAISE, which this condition
        is what keeps a free choice rather than one eventually forced by the loss.

        500 rather than a 4xx is the deliberate part: a collision is the server's
        problem, the caller did nothing wrong, and a retry mints a different id.
        """
        mock_table.put_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException',
                       'Message': 'The conditional request failed'}},
            'PutItem',
        )

        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={'name': 'a form whose minted id is already taken'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 500
        assert json.loads(response['body'])['success'] is False
        # The condition is on the REQUEST rather than only in the docstring —
        # without it this write succeeds and the stored form is gone.
        assert (
            mock_table.put_item.call_args.kwargs['ConditionExpression']
            == 'attribute_not_exists(sk)'
        )

    @patch('feedback_form_handler.aggregates_table')
    def test_a_create_of_a_new_form_still_succeeds(
        self, mock_table, api_gateway_event, lambda_context, feedback_form_handler
    ):
        """The contract the condition must not have broken.

        Every create in practice is of an id nothing holds, so the condition has to
        be invisible on the path that matters. Without this, the case above would
        pass just as well with `create_form` broken outright.
        """
        event = api_gateway_event(
            method='POST',
            path='/feedback-forms',
            body={'name': 'A brand new form'},
        )

        response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        form = json.loads(response['body'])['form']
        assert form['name'] == 'A brand new form'
        # And a real minted id came back, so the caller can address what it made.
        assert feedback_form_handler._validated_form_id(form['form_id'])


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

    `async def` is selected too, and this is the one place where a node type the
    selector cannot see costs more than anywhere else: a route missing from THIS
    dict is not judged unbounded, it leaves the universal claim entirely. The
    decision function answers correctly for an `async` route when asked — it was
    never asked, and the pinned-route assertion in
    `test_the_derivation_sees_the_routes_this_module_actually_has` cannot catch the
    omission either, because an absent route matches the pinned set on both sides.
    `test_an_async_route_is_inside_the_universal_claim` is the control.
    """
    tree = ast.parse(source)
    routes = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
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
#
# `dynamodb` is here for a different reason than the other three: no route calls
# it today, but `dynamodb.Table(AGGREGATES_TABLE).get_item(...)` is the spelling
# the module DEMONSTRATES at module scope (line ~40), so it is the one a route
# needing a different table would copy — and a resource handle obtained inline is
# a read just as much as one bound at import. Only module-level uses exist now,
# which is why adding it costs nothing and closes the shape before it appears.
_FORM_ID_SINKS = frozenset({
    'aggregates_table', 'feedback_table', 'sqs', 'dynamodb',
})

# The OPERATION names, which is the property that is closed over spellings where
# the receiver names above are not.
#
# A receiver allowlist cannot be complete for "reaches a form id into a sink",
# because the handle can be produced by anything: this repo alone reads the same
# table as `aggregates_table.get_item(...)`, as
# `dynamodb.Table(AGGREGATES_TABLE).get_item(...)` (module scope, line ~40), as
# `table = get_aggregates_table()` then `table.get_item(...)` (the PREVAILING
# style — `ballots_handler.py:379`, `projects_handler.py:1347`/`:2283`/`:2402`,
# `integrations_handler.py:545`, `scrapers_handler.py:228`, twelve sites), and
# `lambda/shared/tables.py` routes that factory through
# `get_dynamodb_resource().Table(...)`. Every one of those names a different
# receiver and the same METHOD, and it is the method that makes the call a read or
# a write. `ballots_handler` is the sibling `_validated_form_id`'s docstring names
# as this design's model, so the shape the receiver allowlist could not see was the
# one a new form-id route was most likely to be written in.
#
# Adding a name to the frozenset above closes one spelling; matching the operation
# closes the class. Both are kept: the receiver match still catches a call whose
# method this set does not name (a `meta.client` call, a paginator), and the
# operation match catches a named method through any handle at all.
#
# Erring toward calling something a sink is the right side of this: a false
# positive costs a route author an explanation, while a false negative is a read
# NOBODY reports — a sink the derivation cannot see is a sink it asks no question
# about, so `_validates_its_form_id` answers "bounded" having understood nothing.
_SINK_OPERATIONS = frozenset({
    'get_item', 'put_item', 'update_item', 'delete_item', 'query', 'scan',
    'batch_get_item', 'batch_write_item', 'send_message', 'send_message_batch',
})


def _sink_bearing_helpers(tree: ast.Module) -> frozenset[str]:
    """Module-level functions that reach what they are handed into a sink.

    A sink does not have to be spelled in the route. `_anchor_form_brand`
    (`feedback_form_handler.py:269`) performs an `update_item` on a key built from
    the id it is passed, and `submit_form_feedback` already calls it — so a route
    that hands an unvalidated id to a helper writes it to the table with no sink
    call of its own anywhere in its body. `_sink_calls` matched only an
    `ast.Attribute` callee, so a plain `helper(form_id)` was not a sink at all, the
    list came back empty, and a route with nothing to answer for was reported
    bounded. Silence again, through the call SHAPE rather than the receiver name.

    Two exclusions, both in the false-positive direction, because this set only
    ever ADDS sinks to a caller:

    - A function that BOUNDS for itself — `_bounds_its_id`, the same
      refusal-plus-order-plus-linkage decision the route check applies, asked of
      the helper. That is what keeps `_load_form_for_query` — which reads, and
      which three routes delegate to — a refusal rather than an unguarded sink:
      it refuses the id it was handed before its own read, and keys that read on
      the value the refusal vouched for. Counting it would report `/iframe`,
      `/stats` and `/submissions` as unbounded.

      Deliberately NOT "the body mentions `_validated_form_id` somewhere", which
      is what this used to ask. A mention is not a bound, and the three shapes it
      wrongly excluded are the ones a hardening edit produces: a validator call
      under `if False:`, a call about a DIFFERENT value than the one written, and
      a call whose result is never refused. Each dropped the helper out of this
      set, so its write went back to being invisible and a route handing it a raw
      id reported bounded. The last of those is `_anchor_form_brand` plus a
      defensive-looking line, i.e. the plausible next edit to the one helper this
      set names — see
      `test_the_helper_set_is_not_escaped_by_mentioning_the_validator`.
    - A ROUTE handler, since a route is entered by the resolver rather than called
      by another function here. Without this the set names `list_forms`,
      `create_form`, `get_form_stats` and `get_form_submissions` — true of them
      (they do read) and useless, because nothing calls them; and the day something
      did, the caller would be accused for a read the route bounds for itself.

    A fixpoint rather than one level, because a helper calling a helper is the same
    hole one step further out and the loop costs four lines. Both questions are
    re-asked on every pass, since a helper joining the set can give another one a
    sink it did not have before — the set only ever grows, so this terminates.

    Termination is not the whole argument, though, and the other half is what makes
    the ANSWER well defined rather than merely reached. Each candidate is judged
    against `known`, the set as it stands on THIS pass, and a name is never
    re-examined once added — so the result is a LEAST fixpoint, and its value rests
    on growth being monotone: adding a helper can only give a caller MORE sinks, and
    more sinks can only move `_bounds_its_id` from True to False, never back. So a
    candidate excluded early against a small set cannot become includable later in a
    way this loop misses, and one added cannot need withdrawing.

    Worth stating because `candidates` is a dict and its iteration order is SOURCE
    order: if that invariant broke, the symptom would be a verdict that depends on
    the order two helpers happen to be defined in — a failure that reproduces only
    under the file it was written against.
    `test_the_helper_set_does_not_depend_on_definition_order` is the control, over
    every permutation of a three-link chain and of the case that actually exercises
    re-evaluation (a helper whose own bound comes AFTER its indirect write).

    Three ceilings, all in the same direction — a write this set cannot see is one
    no question is asked about, so the verdict is the vacuous pass the helper
    exists to close. Named rather than implied, so the next reader knows they are
    accepted rather than overlooked:

    - it resolves NAMES defined in THIS module, so a sink reached through an
      imported function is invisible;
    - candidates are the module's TOP-LEVEL definitions, so a `def` nested one
      level (inside `if TYPE_CHECKING:`, a `try:`/`except ImportError:` shim, a
      feature flag) is not one;
    - a call reaches a helper by its own NAME, so `fn = _writer` then `fn(id)` is
      not matched — the alias class `_collect_aliases` handles for table handles,
      unhandled for functions.

    `async def` is NOT among them: it is a candidate like any other
    (`test_the_helper_set_sees_an_async_writer`), because a different node type is
    the weakest possible reason for a write to escape.
    """
    def _routed(node) -> bool:
        return any(
            isinstance(decorator, ast.Call)
            and isinstance(decorator.func, ast.Attribute)
            and isinstance(decorator.func.value, ast.Name)
            and decorator.func.value.id == 'app'
            for decorator in node.decorator_list
        )

    candidates = {
        node.name: node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and not _routed(node)
    }
    helpers: set[str] = set()
    growing = True
    while growing:
        growing = False
        for name, node in candidates.items():
            if name in helpers:
                continue
            known = frozenset(helpers)
            if _sink_calls(node, known) and not _bounds_its_id(node, known):
                helpers.add(name)
                growing = True
    return frozenset(helpers)


def _sink_calls(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
    helpers: frozenset[str] = frozenset(),
) -> list[tuple[tuple[int, int], frozenset[str]]]:
    """Every call in `function` that reaches a form id into a sink.

    `(position, the names mentioned in the call's arguments)` per sink — the names
    because a position alone answers "was something validated before this read",
    and the claim is that the id THIS read keys on was. See
    `_validates_its_form_id`.

    A call counts as a sink three ways, and any one is enough:

    - its METHOD is one of `_SINK_OPERATIONS`, whatever handle it arrives through.
      That is the one that is closed over spellings; the constant's comment carries
      the argument and the in-repo lines it is derived from.
    - a sink NAME appears anywhere in the callee chain — including a local alias of
      one — which still catches a call whose method that set does not name.
    - it calls a module-level function that reaches its own argument into a sink
      (`_sink_bearing_helpers`), so an indirect write is a write.

    All three exist because an earlier version had only the second, spelled as
    `<sink>.<method>` on the immediate owner, and every shape it could not see
    reported as bounded while reading before validating. The failure mode is
    SILENCE rather than a wrong answer: a sink missing from this list is one
    `_validates_its_form_id` asks neither of its questions about, so an empty list
    passes both vacuously. Each shape below is a control in
    `TestTheFormIdBoundIsUniversalRatherThanAListOfRoutes`:

    - `table = aggregates_table` then `table.get_item(...)` — alias tracking.
    - `dynamodb.Table(AGGREGATES_TABLE).get_item(...)` — the sink name sits deeper
      in the chain than `call.func.value`.
    - `table = get_aggregates_table()` then `table.get_item(...)`, and
      `get_dynamodb_resource().Table(T).get_item(...)` — no sink name anywhere, so
      only the operation match sees them.
    - `_anchor_form_brand(form_id, ...)` — no attribute callee at all, so only the
      helper match sees it.

    Aliases are collected in source order and from NESTED bodies as well as the top
    level (`try`, `with`, `if`, `for`), because every table read in this handler
    sits inside a `try:` — so the plausible spelling of an alias is an indented
    one, and three of the twelve in-repo `table = get_aggregates_table()` sites are
    themselves inside one. An untracked alias is a FALSE NEGATIVE, not a cautious
    false positive: the call drops out of this list, so nothing is asked about it
    and the shorter list is MORE likely to pass. That is the same vacuous pass the
    controls exist to prevent, which is why alias collection is generous while the
    REFUSAL's top-level requirement — a separate axis — stays strict.

    An alias is a HANDLE, though, not a RESULT: `response = aggregates_table.
    get_item(...)` mentions a sink and binds a dict, so counting it would make
    every subsequent `response.get(...)` and `form.get(...)` a sink. That is not
    merely noise — the whole point of the position comparison is which call comes
    FIRST, so a spurious early "sink" on a line above the refusal would report a
    correctly guarded route as unbounded. Hence an assignment whose value is itself
    a call to a sink OPERATION binds nothing:
    `test_the_derivation_names_only_the_real_sinks_in_the_module` pins the count on
    the live routes, so this stays honest in both directions.
    """
    aliases: set[str] = set()

    def _mentions_a_sink(node: ast.AST) -> bool:
        return any(
            isinstance(child, ast.Name)
            and (child.id in _FORM_ID_SINKS or child.id in aliases)
            for child in ast.walk(node)
        )

    def _is_operation_result(value: ast.expr) -> bool:
        return (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Attribute)
            and value.func.attr in _SINK_OPERATIONS
        )

    def _collect_aliases(body: list[ast.stmt]) -> None:
        for statement in body:
            if (
                isinstance(statement, ast.Assign)
                and _mentions_a_sink(statement.value)
                # A handle, not what a read returned. See the docstring.
                and not _is_operation_result(statement.value)
            ):
                aliases.update(
                    target.id for target in statement.targets
                    if isinstance(target, ast.Name)
                )
            # A sink handle bound inside a `try:`/`with`/`if`/`for` is still bound.
            for field in ('body', 'orelse', 'finalbody'):
                nested = getattr(statement, field, None)
                if isinstance(nested, list):
                    _collect_aliases(nested)
            for handler in getattr(statement, 'handlers', []):
                _collect_aliases(handler.body)

    _collect_aliases(function.body)

    def _is_sink(call: ast.Call) -> bool:
        if isinstance(call.func, ast.Attribute):
            return (
                call.func.attr in _SINK_OPERATIONS or _mentions_a_sink(call.func)
            )
        # A module-level helper that writes what it is handed. See
        # `_sink_bearing_helpers`.
        return isinstance(call.func, ast.Name) and call.func.id in helpers

    def _names_in_arguments(call: ast.Call) -> frozenset[str]:
        """Every identifier the call's arguments mention.

        Includes names inside an f-string, since `f'FORM#{form_id}'` is how every
        key in this module is built — `ast.walk` reaches into `JoinedStr` for free.
        The callee is deliberately excluded: `table.get_item(...)`'s receiver is not
        an id that needed validating.
        """
        return frozenset(
            child.id
            for argument in [*call.args, *(kw.value for kw in call.keywords)]
            for child in ast.walk(argument)
            if isinstance(child, ast.Name)
        )

    return [
        ((call.lineno, call.col_offset), _names_in_arguments(call))
        for call in ast.walk(function)
        if isinstance(call, ast.Call) and _is_sink(call)
    ]


def _refused_names(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
) -> dict[str, tuple[int, int]]:
    """Name -> position of the earliest top-level `if` refusing it.

    `_validated_form_id` returns None rather than raising — deliberately, since
    every caller answers the same 404 — so the CALL is not the bound; the refusal
    after it is. A function that calls the validator and ignores what comes back
    has no bound at all, which is the natural mistake for someone copying the call
    and dropping the two lines that follow it at every current site.

    A POSITION rather than a bare name, because WHERE the refusal sits is half the
    claim and an earlier version of this helper answered only WHETHER one existed.
    That let the refusal sit AFTER the read: the assignment binds None for a
    malformed id, `get_item` runs with `Key={'sk': 'FORM#None'}` — the call the
    whole cost argument exists to avoid — and the raise happens once it has been
    paid for. Reported as a bound, because only the assignment's position was ever
    compared against the sinks.
    `test_the_derivation_refuses_a_refusal_that_happens_after_the_read` is the
    control.

    `function.body` rather than `ast.walk`, for the same reason
    `_validates_its_form_id` requires the assignment at the top level: a refusal
    nested under a condition refuses on some paths only, and `if False:` is the
    extreme of that. Walking the whole function counted a dead refusal as a real
    one, so hoisting just the assignment out of the dead block escaped the
    top-level requirement while nothing was ever refused
    (`test_the_derivation_refuses_a_refusal_that_only_runs_sometimes`).

    A NEGATIVE test of the name — `if not <name>:` or `if <name> is None:` — and
    not any `if` mentioning it. An earlier version accepted whatever the test
    asserted, so an `if` returning on the SUCCESS path was credited as the
    refusal: `if validated: return render(validated)` and
    `if validated in _PAGE_CACHE: return _PAGE_CACHE[validated]` both reported a
    bound while refusing nothing at all — the malformed id falls THROUGH the
    condition with None bound and reaches the read. The second is the natural
    spelling of the in-Lambda half of the `Cache-Control` follow-up recorded in
    `lib/stacks/api-stack.ts`, so the gap sat in front of the next planned change
    (`test_the_derivation_refuses_a_success_path_return`,
    `test_the_derivation_refuses_a_cache_hit_return`).

    Those two spellings are the only ones the module uses, so narrowing to them
    changed no verdict. If a third legitimate one appears (`if validated is None
    or ...`), widen this deliberately and add the control; do not go back to
    accepting any test that names the value, because "the name is mentioned in a
    condition" was never the claim.
    """
    def _negatively_tested(test: ast.expr) -> list[str]:
        # `if not <name>:`
        if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            if isinstance(test.operand, ast.Name):
                return [test.operand.id]
            return []
        # `if <name> is None:`
        if (
            isinstance(test, ast.Compare)
            and isinstance(test.left, ast.Name)
            and len(test.ops) == 1
            and isinstance(test.ops[0], ast.Is)
            and isinstance(test.comparators[0], ast.Constant)
            and test.comparators[0].value is None
        ):
            return [test.left.id]
        return []

    refused: dict[str, tuple[int, int]] = {}
    for node in function.body:
        if not isinstance(node, ast.If):
            continue
        if not any(
            isinstance(child, (ast.Raise, ast.Return))
            for statement in node.body
            for child in ast.walk(statement)
        ):
            continue
        position = (node.lineno, node.col_offset)
        for name in _negatively_tested(node.test):
            known = refused.get(name)
            refused[name] = position if known is None else min(known, position)
    return refused


def _bounds_its_id(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
    helpers: frozenset[str] = frozenset(),
) -> bool:
    """Does `function` reach the validator, and REFUSE, before keying on anything?

    THE decision, asked of any `FunctionDef` or `AsyncFunctionDef` — a route
    (`_validates_its_form_id`, which is this with the module parsed for it) or a
    module-level helper (`_sink_bearing_helpers`, which excludes one that bounds
    for itself). Both node types are real inputs at both call sites, which is what
    `test_the_helper_set_sees_an_async_writer` and
    `test_an_async_route_is_inside_the_universal_claim` pin. One
    function rather than two, because the two callers were asking the same
    question and only one of them was asking it properly: the helper exclusion
    used to test whether `_validated_form_id` was MENTIONED anywhere in the body,
    which a dead call, a call about another value and an unenforced call all
    satisfy. Sharing this makes "bounds its id" mean the same thing on both sides
    by construction.

    Positional and result-aware, because the order and the refusal are the whole
    claim. An earlier version of this helper was an order-insensitive set-membership
    test over every call name in the body, which three unsafe shapes satisfied: a
    `get_item` before the validator, a validator whose return value was discarded,
    and a validator mentioned only inside `if False:`. Each is reported False now,
    and each has a control below — the second one mattering most, since a route
    with no bound at all looked identical to a correct one.

    A validating statement is one of three spellings, all required to sit at the
    function's TOP LEVEL:

    - `<name> = _validated_form_id(...)` where `<name>` is later tested in an `if`
      whose body raises or returns. The assignment alone is not enough (see
      `_refused_names`), and the position that has to beat the sinks is the
      REFUSAL's, not the assignment's: an assignment that binds None costs nothing,
      so a read between it and the raise is a read of `FORM#None` that the check
      was supposed to prevent.
    - `if not (<name> := _validated_form_id(...)):` — the walrus form, ACCEPTED
      rather than tolerated. It is strictly safer than the two-statement one: there
      is no statement boundary between the binding and the refusal, so the
      `FORM#None` window the bullet above has to measure cannot exist in it at all.
      An earlier version of this helper recognised only the two-statement spelling
      and would therefore have reported a correctly guarded route as unbounded —
      pushing whoever wrote the safer form back to the weaker one to get green,
      which runs the cost of a false positive the wrong way
      (`test_the_derivation_accepts_the_walrus_spelling`). The `if`'s own position
      is the refusal's, because they are the same statement.
    - a call to `_load_form_for_query(...)`, which needs no result check because it
      RAISES for itself — so for that spelling the call's own position IS the
      refusal's. Following the delegation rather than demanding the direct call is
      deliberate: `/stats` and `/submissions` validate through it, and a derivation
      that named only `_validated_form_id` would push someone into adding a
      redundant second call to each.

    Top level rather than anywhere is what excludes dead code and conditional
    validation together — a check that only runs on some paths is not a bound, and
    `if False:` is just the extreme of that. If a legitimate spelling ever needs to
    nest (validation inside a `with`, say), widen this deliberately and add the
    control alongside the ones below; do not relax it to get green.

    Two questions are asked of every sink, not one:

    - ORDER: no sink may precede the earliest refusal. That is the cost argument —
      a read paid for before the check is a read the check existed to avoid — and
      it holds even for a sink that mentions no id at all.
    - LINKAGE: the id the sink keys on has to be one that WAS bounded. Position
      alone answered "was something validated first", and a route that validated a
      DIFFERENT capture satisfied that while keying on a raw one:
      `validated = _validated_form_id(submission_id)` refused, then
      `get_item(Key={'sk': f'FORM#{form_id}'})`. Reported bounded, with `form_id`
      reaching the key unchecked. Not remote — the route selector is deliberately
      capture-name-agnostic, so a two-capture route like
      `/feedback-forms/<form_id>/submissions/<submission_id>` is already in the
      universe, and it could satisfy the derivation by bounding whichever capture
      was easier (`test_the_derivation_refuses_validating_the_wrong_capture`).

    Linkage is asked of the PARAMETERS, because they are the untrusted values: a
    parameter is bounded once it has been handed to `_validated_form_id` (or
    `_load_form_for_query`) in a statement whose refusal precedes the sink, and so
    is anything the validator handed back. Every other local is judged by what it
    was built from, so `key = f'FORM#{form_id}'` before the check is a tainted key
    rather than an unremarkable string. The ceiling: propagation follows `Assign`
    and `AnnAssign` only, so an id smuggled through a `for` target or a mutated
    container is not traced — a deliberate stopping point, since the shapes that
    exist here build keys and filters by assignment. For the same reason the taint
    SOURCE is the parameter list, so an id taken from `app.current_event` rather
    than from the capture group is outside this instrument by construction:
    Powertools always hands the capture in as a parameter, and an id out of the
    request BODY is a different validation question. "Universal over the values
    Powertools binds as parameters" is the accurate reading of the claim.
    """
    refused = _refused_names(function)

    def _calls(statement) -> list[ast.Call]:
        return [n for n in ast.walk(statement) if isinstance(n, ast.Call)]

    def _named(call: ast.Call, name: str) -> bool:
        return isinstance(call.func, ast.Name) and call.func.id == name

    def _mentioned(node: ast.AST) -> set[str]:
        return {
            child.id for child in ast.walk(node) if isinstance(child, ast.Name)
        }

    def _bare_arguments(call: ast.Call) -> set[str]:
        """The call's arguments that are a NAME and nothing else.

        What the refusal of `_validated_form_id(form_id)` vouches for is `form_id`
        — the value that was handed in. It vouches for nothing about a value that
        was TRANSFORMED on the way in: `_validated_form_id(form_id.lower())`
        establishes that the lowercased string is well formed, and a key built from
        raw `form_id` afterwards is built from a value nothing checked.

        That distinction is not academic here. `_load_form_for_query`'s docstring
        reasons about "a plausible 'form ids are case-insensitive' change",
        `_validated_form_id`'s argues at length against `.strip()`ing, and
        `test_a_query_route_filters_on_the_id_it_read_even_if_the_validator_normalizes`
        monkeypatches a normalizing validator for that exact reason — so a
        normalizing spelling is the change this module has already anticipated
        twice, and walking the whole argument expression would have made this
        derivation the one instrument that kept reporting such a route bounded
        (`test_the_derivation_refuses_a_bound_on_a_transformed_argument`).
        """
        return {
            argument.id
            for argument in [*call.args, *(kw.value for kw in call.keywords)]
            if isinstance(argument, ast.Name)
        }

    def _target_names(statement) -> set[str]:
        targets = (
            statement.targets if isinstance(statement, ast.Assign)
            else [statement.target] if isinstance(statement, ast.AnnAssign)
            else []
        )
        # A tuple target too: `validated, form = _load_form_for_query(...)` binds
        # both, and the validated id is the one the caller keys and filters on.
        return {
            name.id
            for target in targets
            for name in ast.walk(target)
            if isinstance(name, ast.Name)
        }

    def _walrus_refusal(
        statement,
    ) -> tuple[tuple[int, int], ast.Call, str] | None:
        """`if not (<name> := _validated_form_id(...)):` — bind and refuse in one.

        The `if`'s own position, because for this spelling the binding and the
        refusal are the same statement — there is no gap between them to measure.
        The walrus TARGET is returned alongside the call, rather than read back out
        of the condition with `_mentioned`, so this spelling binds exactly what the
        two-statement one does: the target and the bare arguments, not every name a
        transformed argument happens to mention.
        """
        if not isinstance(statement, ast.If):
            return None
        test = statement.test
        if not (isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not)):
            return None
        bound = test.operand
        if not (
            isinstance(bound, ast.NamedExpr)
            and isinstance(bound.target, ast.Name)
            and isinstance(bound.value, ast.Call)
            and _named(bound.value, '_validated_form_id')
        ):
            return None
        if not any(
            isinstance(child, (ast.Raise, ast.Return))
            for node in statement.body
            for child in ast.walk(node)
        ):
            return None
        return (
            (statement.lineno, statement.col_offset), bound.value, bound.target.id
        )

    # name -> the earliest position from which it is known to be bounded. Both the
    # id handed TO the validator and the value handed BACK are bounded from the
    # refusal, since the refusal is what makes the one a well-formed id and the
    # other not None.
    #
    # Only the names the refusal actually vouches for: the statement's TARGETS and
    # the call's BARE-NAME arguments (`_bare_arguments`). A transformed argument is
    # deliberately not a bound on its source — `_validated_form_id(form_id.lower())`
    # says nothing about `form_id`.
    bounded_at: dict[str, tuple[int, int]] = {}

    def _bind(names, position: tuple[int, int]) -> None:
        for name in names:
            known = bounded_at.get(name)
            bounded_at[name] = position if known is None else min(known, position)

    for statement in function.body:
        walrus = _walrus_refusal(statement)
        if walrus is not None:
            position, call, target = walrus
            _bind(_bare_arguments(call) | {target}, position)
        for call in _calls(statement):
            if _named(call, '_load_form_for_query'):
                # This one raises for itself, so the call is the refusal.
                position = (statement.lineno, statement.col_offset)
                _bind(_bare_arguments(call) | _target_names(statement), position)
            if not _named(call, '_validated_form_id'):
                continue
            # The result has to be BOUND and then refused. An `Expr` statement, or
            # an assignment to a name nothing tests, is the shape that has no bound.
            targets = _target_names(statement)
            # The REFUSAL's position, not the assignment's: binding None is free,
            # and anything between the two runs with it.
            refusals = [refused[target] for target in targets if target in refused]
            if refusals:
                _bind(targets | _bare_arguments(call), min(refusals))

    if not bounded_at:
        return False
    validated_at = min(bounded_at.values())

    sinks = _sink_calls(function, helpers)
    # No sink is not a pass by default: #379 was a route that touched no AWS
    # service at all and still put the id in its response, so a route that keys on
    # nothing yet takes an id out of the URL still has to establish the bound.
    if any(position <= validated_at for position, _ in sinks):
        return False

    parameters = {
        argument.arg for argument in (
            *function.args.posonlyargs, *function.args.args,
            *function.args.kwonlyargs,
        )
    }
    assignments = [
        ((node.lineno, node.col_offset), _target_names(node), _mentioned(node.value))
        for node in ast.walk(function)
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None
    ]

    def _unbounded_at(position: tuple[int, int]) -> set[str]:
        """Names holding a value no refusal before `position` has vouched for."""
        tainted = {
            name for name in parameters
            if name not in bounded_at or bounded_at[name] >= position
        }
        growing = True
        while growing:
            growing = False
            for at, targets, mentioned in assignments:
                if at >= position or not (mentioned & tainted):
                    continue
                spreading = {
                    target for target in targets - tainted
                    if bounded_at.get(target, position) >= position
                }
                if spreading:
                    tainted |= spreading
                    growing = True
        return tainted

    return not any(
        mentioned & _unbounded_at(position) for position, mentioned in sinks
    )


def _validates_its_form_id(source: str, function_name: str) -> bool:
    """`_bounds_its_id` for the named function in `source`.

    The route-facing entry point: it resolves the name against the module and
    derives the sink-bearing helper set, which is the only thing the decision needs
    beyond the function itself.
    """
    tree = ast.parse(source)
    functions = [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == function_name
    ]
    assert len(functions) == 1, (
        f'expected exactly one def {function_name}, found {len(functions)}'
    )
    return _bounds_its_id(functions[0], _sink_bearing_helpers(tree))


class TestTheFormIdBoundIsUniversalRatherThanAListOfRoutes:
    """`_validated_form_id`'s docstring says EVERY route; this is what checks it.

    That claim was false when it was written — `/config`, `/submit`, `/iframe`,
    `/stats` and `/submissions` were covered and the authenticated CRUD trio was
    not, while the docstring enumerated only those five public and read routes as
    if they were all of them. (It now enumerates all eight, which is the number
    `test_the_derivation_sees_the_routes_this_module_actually_has` pins; the five
    here is the historical shape of the defect, not a live count.)
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
            'bound before their first read or send. Several shapes report here and '
            'the message cannot tell them apart, so check each in turn: no '
            'validator call at all; a result that is never refused, or refused by '
            'something that is not a NEGATIVE test of it — a success-path or '
            'cache-hit `return` is not a refusal (see `_refused_names`); a refusal '
            'that is nested, so it runs on some paths only; a REFUSAL that comes '
            'after the table or the queue is touched; or a bound established on a '
            'DIFFERENT value than the one the read keys on — validating '
            '`submission_id` and keying on a raw `form_id` reports here, as does a '
            'key built from the raw id before the refusal. Add the check rather '
            'than narrowing the claim: the value of a universal bound is that a reader '
            'does not have to hold the exceptions. And if the route is genuinely '
            'bounded in a spelling this derivation does not know, widen the '
            'derivation and add a control for it — '
            '`test_the_derivation_accepts_the_walrus_spelling` is the precedent.'
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

    def test_the_derivation_names_only_the_real_sinks_in_the_module(
        self, feedback_form_handler
    ):
        """The other half of non-vacuity: the sink count is right, not merely
        non-zero.

        The controls in this class all check that a read is not MISSED, because a
        missed read makes `all(...)` vacuously true. This checks the opposite
        direction, which matching on the operation name made possible: a call that
        is not a read must not be counted either. `form.get('name')` and
        `response.get('Item')` are dict access, and they were being counted while
        `aliases` tracked the RESULT of a read as though it were a table handle —
        twelve "sinks" in `submit_form_feedback`, ten of them dict lookups.

        That is not cosmetic. The whole comparison is which call comes FIRST, so a
        spurious sink on a line above the refusal reports a correctly guarded route
        as unbounded — and the failure would arrive as this class's own universal
        test accusing a route that is fine, which is the least useful failure it
        could produce.

        So the count is pinned per route, against what each one actually does. The
        numbers are small enough to read: one read each, `submit_form_feedback`
        alone having a read AND the send that makes its cost argument different —
        plus the `_anchor_form_brand` call, which is a sink because that helper
        writes what it is handed (`_sink_bearing_helpers`).
        """
        source = Path(inspect.getsourcefile(feedback_form_handler)).read_text(
            encoding='utf-8'
        )
        tree = ast.parse(source)
        helpers = _sink_bearing_helpers(tree)

        counted = {}
        for route, function_name in _routes_keying_on_a_form_id(source).items():
            function = next(
                node for node in ast.walk(tree)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == function_name
            )
            counted[route] = len(_sink_calls(function, helpers))

        assert counted == {
            'GET /feedback-forms/<form_id>': 1,
            'PUT /feedback-forms/<form_id>': 1,
            'DELETE /feedback-forms/<form_id>': 1,
            'GET /feedback-forms/<form_id>/config': 1,
            # The read for the enabled check, the enqueue, and the
            # `_anchor_form_brand` call — that helper's own `update_item` writes a
            # key built from the id it is handed, so the call site is a write
            # whatever it is spelled like.
            'POST /feedback-forms/<form_id>/submit': 3,
            # The existence gate is inside `_load_form_for_query`, so this route
            # touches no sink of its own — which is why "no sink" is deliberately
            # not a pass by default in `_validates_its_form_id`.
            'GET /feedback-forms/<form_id>/iframe': 0,
            'GET /feedback-forms/<form_id>/submissions': 1,
            'GET /feedback-forms/<form_id>/stats': 1,
        }, (
            f'{counted} — a route gained or lost a read, or the derivation started '
            'counting something that is not one. If a count went UP without the '
            'route changing, suspect two things: `aliases`, since binding the '
            'RESULT of a read makes every subsequent `.get(...)` on it look like a '
            'sink; and `_sink_bearing_helpers`, since a module-level function that '
            'starts writing makes every call to it a sink. Both are the right '
            'answer when the call really does reach an id into a table, and both '
            'are a false positive otherwise — the earliest sink is what decides '
            'the verdict, so one spurious early entry accuses a correct route.'
        )

    def test_the_only_helper_that_writes_what_it_is_handed_is_the_brand_anchor(
        self, feedback_form_handler
    ):
        """The helper set is exactly one function, and the two exclusions earn it.

        `_sink_bearing_helpers` only ever ADDS sinks to a caller, so its
        over-reporting direction is the one that accuses a correct route. Both
        exclusions were needed to get here and neither is cosmetic: without the
        `_validated_form_id` one, `_load_form_for_query` becomes an unguarded sink
        and `/iframe`, `/stats` and `/submissions` are all reported unbounded;
        without the route-decorator one, the set names `list_forms`, `create_form`,
        `get_form_stats` and `get_form_submissions` — each of which does read, and
        none of which is CALLED by anything here, so naming them buys nothing and
        would accuse whatever first called one.

        Pinned as a set rather than a count so the failure says which function
        arrived. A helper that starts writing SHOULD appear here — that is the
        finding, not the breakage — and then every route calling it has to bound its
        id first.
        """
        source = Path(inspect.getsourcefile(feedback_form_handler)).read_text(
            encoding='utf-8'
        )

        assert _sink_bearing_helpers(ast.parse(source)) == {'_anchor_form_brand'}, (
            'the set of module-level helpers that write what they are handed '
            'changed. If a new helper appears, check every route that calls it '
            'validates first; if one disappeared, check the exclusions have not '
            'started swallowing a real write.'
        )

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

    def test_the_derivation_refuses_a_refusal_that_happens_after_the_read(self):
        """The order defect one step along: the CALL beats the read, the RAISE
        does not.

        `test_the_derivation_refuses_a_read_that_happens_before_the_check` moves
        the whole validating statement after the sink. This moves only the two
        lines that do the refusing — which is both subtler to read and the shape a
        reorder produces naturally, since the assignment looks like the check.

        It is unsafe for exactly the reason that test's shape is: `validated` binds
        None for an id the pattern refuses, so `get_item` runs with
        `Key={'sk': 'FORM#None'}` before the raise. The DynamoDB call the bound
        exists to prevent is paid for, and the 404 the caller sees is
        indistinguishable from the correct one — which is why nothing but this
        derivation would report it.

        So the position compared against the sinks has to be the refusal's, not the
        assignment's (`_refused_names` returns it for that reason). This is what
        fails if it goes back to reporting a bare set of names.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/late-refusal")
            def get_late_refusal(form_id: str):
                validated = _validated_form_id(form_id)
                item = aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
                )
                if not validated:
                    raise NotFoundError('Form not found')
                return item
            '''
        )

        assert not _validates_its_form_id(source, 'get_late_refusal'), (
            'a refusal placed after the read was reported as a bound — the '
            'assignment binds None for free, so it is the RAISE that has to beat '
            "the first sink. `Key={'sk': 'FORM#None'}` is still a get_item."
        )

    def test_the_derivation_refuses_a_refusal_that_only_runs_sometimes(self):
        """The dead-code defect one step along: the ASSIGNMENT is hoisted, the
        refusal is not.

        `test_the_derivation_refuses_validation_that_only_runs_sometimes` nests the
        whole block, so the top-level requirement on the assignment catches it.
        Hoisting just the assignment out satisfies that requirement while the
        refusal stays unreachable — no request is ever refused, and the read runs
        with None bound exactly as in the case above.

        This is why `_refused_names` iterates `function.body` rather than walking:
        a refusal found anywhere in the tree includes ones that never execute, and
        "the check is somewhere in the source" was never the claim.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/dead-refusal")
            def get_dead_refusal(form_id: str):
                validated = _validated_form_id(form_id)
                if False:
                    if not validated:
                        raise NotFoundError('Form not found')
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
                )
            '''
        )

        assert not _validates_its_form_id(source, 'get_dead_refusal'), (
            'a refusal inside dead code was reported as a bound — the assignment '
            'being at the top level is not the property that matters, the refusal '
            'running on every path is'
        )

    def test_the_derivation_refuses_a_read_through_a_local_alias(self):
        """The SINK side of the derivation, where the previous rounds' fixes did
        not reach.

        Every control above moves the validation relative to a sink spelled
        `aggregates_table.get_item(...)`. This leaves the validation alone and
        changes how the READ is spelled: bind the table to a local name first, and a
        selector matching only `<sink>.<method>` stops recognising it.

        The failure mode is what makes this worth a case rather than a note — it is
        SILENCE, not a wrong answer. `_sink_calls` comes back empty, so neither the
        order question nor the linkage one is asked of anything, and a route
        reading before validating is reported as bounded. A derivation that reports
        "fine" when it understood nothing is worse than no derivation, because the
        docstring above it is then trusted.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/aliased-read")
            def get_aliased_read(form_id: str):
                table = aggregates_table
                item = table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return item
            '''
        )

        assert not _validates_its_form_id(source, 'get_aliased_read'), (
            'a read through a local alias of a sink was not recognised as a read, '
            'so the route was reported as bounded on an EMPTY sink list — '
            'vacuously, which is the silent failure this control exists for'
        )

    def test_the_derivation_refuses_a_read_through_a_freshly_built_table(self):
        """The same sink-side gap, in the spelling the module itself demonstrates.

        `dynamodb.Table(AGGREGATES_TABLE).get_item(...)` puts the sink name deeper
        in the callee chain than `call.func.value`, so a selector looking only at
        the attribute's immediate owner sees no sink and `_sink_calls` is empty —
        nothing to ask a question about, vacuously bounded again.

        This is the more plausible of the two shapes, and that is the whole argument
        for the case: the module binds its tables exactly this way at module scope,
        so a route that needs a different table has a working example of the
        spelling in front of it. Nothing in the module does it inside a function
        today, which is precisely when to close the shape — before the first one.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/fresh-table")
            def get_fresh_table(form_id: str):
                item = dynamodb.Table(AGGREGATES_TABLE).get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return item
            '''
        )

        assert not _validates_its_form_id(source, 'get_fresh_table'), (
            'a read through dynamodb.Table(...) built inline was not recognised '
            'as a read — the sink name sits further down the callee chain, and '
            'this is the spelling the module demonstrates at module scope'
        )

    def test_the_derivation_refuses_a_read_through_a_table_factory(self):
        """The sink-side gap in the spelling this PACKAGE actually prefers.

        `table = get_aggregates_table()` is not a hypothetical: it is how the
        aggregates table is read at twelve sites here — `ballots_handler.py:379`
        (the sibling `_validated_form_id`'s docstring names as this design's model),
        `projects_handler.py:1347`/`:2283`/`:2402`, `integrations_handler.py:545`,
        `scrapers_handler.py:228` among them — and `lambda/shared/tables.py:17`
        routes that factory through `get_dynamodb_resource().Table(...)`, which
        `feedback_form_handler.py:31` is itself a caller of.

        So the single most likely way the NEXT form-id route gets written in this
        repo was the one shape a receiver-name allowlist could not see: no sink name
        appears anywhere in the callee chain, `_sink_calls` comes back empty, and a
        read nothing was asked about is a read that passed. Matching the OPERATION
        (`_SINK_OPERATIONS`) rather than the receiver is what closes the class
        instead of one more spelling — the method is what makes a call a read.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/factory-read")
            def get_factory_read(form_id: str):
                table = get_aggregates_table()
                item = table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return item
            '''
        )

        assert not _validates_its_form_id(source, 'get_factory_read'), (
            'a read through get_aggregates_table() was not recognised as a read — '
            'no sink NAME appears in the chain, so only matching the operation '
            'sees it, and this is the prevailing read idiom in this package'
        )

        # And the factory one level further out, which `shared/tables.py` itself
        # composes and this module calls at line ~31 to obtain `dynamodb`.
        resource_factory = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/resource-read")
            def get_resource_read(form_id: str):
                item = get_dynamodb_resource().Table(AGGREGATES_TABLE).get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return item
            '''
        )

        assert not _validates_its_form_id(resource_factory, 'get_resource_read'), (
            'a read through get_dynamodb_resource().Table(...) was not recognised '
            'as a read — the receiver is produced by a call, so no name in the '
            'chain is a sink and the verdict came from an EMPTY sink list'
        )

    def test_the_derivation_refuses_a_write_through_an_in_module_helper(self):
        """The sink-side gap that is not about the RECEIVER but about the call SHAPE.

        Every control above spells the sink as a method on something. This one has
        no attribute callee at all: `_anchor_form_brand(form_id, ...)` is a plain
        call, and the `update_item` is inside the helper — on a key built from the
        id it was handed (`feedback_form_handler.py:269`). So a route can write an
        unvalidated id to the table with no sink call anywhere in its own body.

        Not a spelling nobody would reach for: `submit_form_feedback` already calls
        that helper, so it is the in-module example of writing through a function.
        And it is the same silence as the receiver cases — matching only
        `ast.Attribute` callees left the list EMPTY, and `all(...)` over an empty
        list is vacuously True, so the instrument answered "bounded" having seen
        nothing.

        `_sink_bearing_helpers` derives the set of such helpers from the module
        rather than naming them, and excludes any that validates for itself — which
        is what keeps `_load_form_for_query` a refusal rather than an unguarded
        sink.
        """
        source = textwrap.dedent(
            '''
            def _anchor_form_brand(form_id, effective_brand):
                aggregates_table.update_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'},
                    UpdateExpression='SET brand_name = :brand',
                )

            @app.post("/feedback-forms/<form_id>/helper-write")
            def post_helper_write(form_id: str):
                _anchor_form_brand(form_id, 'Acme')
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
            '''
        )

        assert not _validates_its_form_id(source, 'post_helper_write'), (
            'a write reached through an in-module helper was not recognised as a '
            'write — the helper call has no attribute callee, so the sink list came '
            'back EMPTY and the route was reported bounded vacuously'
        )

        # The accepting side, because a helper call must not become a blanket
        # accusation: the same helper AFTER the refusal is what `submit_form_feedback`
        # does, and it has to stay green.
        after = textwrap.dedent(
            '''
            def _anchor_form_brand(form_id, effective_brand):
                aggregates_table.update_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'},
                    UpdateExpression='SET brand_name = :brand',
                )

            @app.post("/feedback-forms/<form_id>/helper-write")
            def post_helper_write(form_id: str):
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                _anchor_form_brand(validated, 'Acme')
            '''
        )

        assert _validates_its_form_id(after, 'post_helper_write'), (
            'a helper write AFTER the refusal was reported as unbounded — the '
            'helper match is meant to see an indirect write, not to accuse every '
            'route that delegates one'
        )

    @pytest.mark.parametrize(
        'shape, helper',
        [
            pytest.param(
                '''
                def _writer(form_id):
                    aggregates_table.put_item(Item={'sk': f'FORM#{form_id}'})
                    if False:
                        _validated_form_id(form_id)
                ''',
                '_writer',
                id='the validator call is dead code',
            ),
            pytest.param(
                '''
                def _writer(form_id, brand):
                    aggregates_table.put_item(Item={'sk': f'FORM#{form_id}'})
                    if not _validated_form_id(brand):
                        raise NotFoundError('Form not found')
                ''',
                '_writer',
                id='it refuses a different value than the one it writes',
            ),
            pytest.param(
                '''
                def _anchor_form_brand(form_id, effective_brand):
                    validated = _validated_form_id(form_id)
                    aggregates_table.update_item(
                        Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                    )
                ''',
                '_anchor_form_brand',
                id='it validates but never refuses',
            ),
        ],
    )
    def test_the_helper_set_is_not_escaped_by_mentioning_the_validator(
        self, shape, helper
    ):
        """A helper leaves the sink-bearing set by BOUNDING, not by mentioning.

        The exclusion used to be `any(... == '_validated_form_id' ...)` over
        `ast.walk` — the validator's name appearing anywhere in the body. Its own
        docstring justified it with `_load_form_for_query`, "which bounds the id it
        was handed BEFORE its own read": a refusal-and-order-and-linkage property.
        The code asked the much weaker "does the name appear", so each shape here
        dropped the helper out of the set, its write became invisible again, and a
        route handing it a raw id was reported bounded on an EMPTY sink list — the
        exact silence `_sink_bearing_helpers` was added to close.

        None is exotic, and the third is not hypothetical at all: it is
        `_anchor_form_brand` with a defensive-looking validator call added and the
        two lines that refuse omitted, i.e. the plausible next hardening edit to the
        one helper this set names — which under the old exclusion would silently
        remove the control this class just gained for it.

        `_bounds_its_id` is what decides the exclusion now, so "bounds its id" means
        the same thing for a helper as for a route by construction.
        """
        helper_source = textwrap.dedent(shape)
        source = helper_source + textwrap.dedent(
            '''
            @app.post("/feedback-forms/<form_id>/helper-write")
            def post_helper_write(form_id: str):
                _WRITER_(form_id, 'Acme')
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
            '''
        ).replace('_WRITER_', helper)

        assert _sink_bearing_helpers(ast.parse(source)) == {helper}, (
            f'{helper} dropped out of the sink-bearing set because it MENTIONS '
            '_validated_form_id — a dead, misdirected or unenforced call is not a '
            'bound, and excluding on one makes the write it performs invisible'
        )
        assert not _validates_its_form_id(source, 'post_helper_write'), (
            'the route handed a raw id to a helper that writes it and was reported '
            'bounded — the helper escaped the set, so there was no sink to ask '
            'either question about'
        )

    def test_the_helper_set_sees_an_async_writer(self):
        """`async def` is a different node type, not a different question.

        Candidates were `isinstance(node, ast.FunctionDef)` over `tree.body`, which
        `ast.AsyncFunctionDef` is not — so an `async def` helper that wrote what it
        was handed was never even considered, and the route calling it reported
        bounded on an empty sink list. Nothing in this sync Lambda handler is
        `async` today, which is exactly when the shape costs one token to close.

        Pinned so the widening is deliberate rather than incidental. The two
        remaining shapes — a `def` nested one level at module scope, and a helper
        reached through a local alias — are named as accepted ceilings in
        `_sink_bearing_helpers`'s docstring instead, since closing them needs
        machinery rather than a token.
        """
        source = textwrap.dedent(
            '''
            async def _write_form(form_id):
                aggregates_table.put_item(
                    Item={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )

            @app.post("/feedback-forms/<form_id>/async-write")
            def post_async_write(form_id: str):
                _write_form(form_id)
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
            '''
        )

        assert _sink_bearing_helpers(ast.parse(source)) == {'_write_form'}, (
            'an async def helper that writes what it is handed was not a candidate '
            'for the sink-bearing set — the node type is AsyncFunctionDef, and the '
            'candidate filter has to admit both'
        )
        assert not _validates_its_form_id(source, 'post_async_write'), (
            'a write through an async helper was reported as bounded — the sink '
            'list was empty, so neither question was asked'
        )

    @pytest.mark.parametrize(
        'definitions, expected',
        [
            pytest.param(
                {
                    '_a': '''
                        def _a(form_id):
                            aggregates_table.put_item(Item={'sk': f'FORM#{form_id}'})
                    ''',
                    '_b': '''
                        def _b(form_id):
                            _a(form_id)
                    ''',
                    '_c': '''
                        def _c(form_id):
                            _b(form_id)
                    ''',
                },
                {'_a', '_b', '_c'},
                id='a three-link chain, every link reached transitively',
            ),
            pytest.param(
                {
                    '_a': '''
                        def _a(form_id):
                            aggregates_table.put_item(Item={'sk': f'FORM#{form_id}'})
                    ''',
                    '_h': '''
                        def _h(form_id):
                            _a(form_id)
                            validated = _validated_form_id(form_id)
                            if not validated:
                                raise NotFoundError('Form not found')
                    ''',
                },
                {'_a', '_h'},
                id='a helper whose own bound comes after its indirect write',
            ),
            pytest.param(
                {
                    '_a': '''
                        def _a(form_id):
                            aggregates_table.put_item(Item={'sk': f'FORM#{form_id}'})
                    ''',
                    '_g': '''
                        def _g(form_id):
                            validated = _validated_form_id(form_id)
                            if not validated:
                                raise NotFoundError('Form not found')
                            _a(validated)
                    ''',
                },
                {'_a'},
                id='a helper that refuses before its indirect write',
            ),
        ],
    )
    def test_the_helper_set_does_not_depend_on_definition_order(
        self, definitions, expected
    ):
        """The fixpoint's value, not just its termination.

        Each candidate is judged against the set as it stands on the current pass,
        and a name is never re-examined once added — so the result is a least
        fixpoint whose value rests on growth being monotone (more helpers ⇒ more
        sinks ⇒ `_bounds_its_id` only ever goes True→False). `candidates` is a
        source-ordered dict, so the symptom of that invariant breaking is not a
        wrong answer but an answer that depends on the order two helpers happen to
        be defined in — which reproduces only under the file it was written against
        and looks like a flake everywhere else.

        Every permutation is asserted, so no single ordering can be the one that
        happens to work. The second and third cases are the ones that exercise
        re-evaluation rather than merely transitivity: `_h` acquires its sink only
        once `_a` is in the set, and it must then be judged UNBOUNDED because its
        refusal sits after that write — under a single-pass exclusion it escapes.
        `_g` is the same shape with the refusal first, and must stay out, so the
        pair pins both directions rather than "everything ends up in the set".
        """
        for order in itertools.permutations(definitions):
            source = ''.join(
                textwrap.dedent(definitions[name]) for name in order
            )

            assert _sink_bearing_helpers(ast.parse(source)) == expected, (
                f'definition order {order} derived a different sink-bearing set '
                'than its permutations — the fixpoint judges each candidate '
                'against the partial set of the current pass, so its result is '
                'well defined only while growth is monotone (see '
                '_sink_bearing_helpers). An order-dependent answer means an edit '
                'broke that, not that this expectation is stale'
            )

    def test_an_async_route_is_inside_the_universal_claim(self):
        """A route the selector cannot see does not fail the claim — it leaves it.

        The `async def` widening landed at the two functions that DECIDE (the helper
        set and the name resolution) and stopped one short of the one that chooses
        the UNIVERSE. So an `async` route keying on a raw id was answered correctly
        whenever it was asked — and it was never asked, because
        `_routes_keying_on_a_form_id` short-circuited on `ast.FunctionDef`.

        That is a worse failure than a wrong verdict, and it is the direction this
        whole class exists to close: an unbounded route that fails is a red test
        naming it, while an unbounded route that is not in the universe is a green
        one. The sibling pinned-route assertion cannot substitute for this control,
        because it asserts set EQUALITY against the eight known routes — an added
        `async` route is absent from the derived set and from the pinned set alike,
        so it matches.

        Both halves are asserted: the route is selected, and once selected it is
        judged unbounded. Asserting only the first would pass with the decision
        function broken; asserting only the second is what already passed while the
        route sat outside the claim.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/sync")
            def get_sync(form_id: str):
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return aggregates_table.get_item(Key={'sk': f'FORM#{validated}'})

            @app.get("/feedback-forms/<form_id>/asyncroute")
            async def get_async(form_id: str):
                return aggregates_table.get_item(Key={'sk': f'FORM#{form_id}'})
            '''
        )

        routes = _routes_keying_on_a_form_id(source)

        assert routes == {
            'GET /feedback-forms/<form_id>/sync': 'get_sync',
            'GET /feedback-forms/<form_id>/asyncroute': 'get_async',
        }, (
            'an async def route under /feedback-forms/<...> was not selected into '
            'the universe the universal claim is asked about — the node type is '
            'AsyncFunctionDef, and a route the selector cannot see is one no '
            'question is asked about, so the suite stays green while it reads a raw '
            'id'
        )
        # And the route the selector now admits is genuinely judged, so the
        # widening buys a verdict rather than only an entry.
        unbounded = sorted(
            function for function in routes.values()
            if not _validates_its_form_id(source, function)
        )
        assert unbounded == ['get_async'], (
            'the async route was selected but its verdict is wrong — it keys on the '
            'raw parameter with no refusal anywhere, so it must report unbounded, '
            'and the bounded sync route beside it must not'
        )

    def test_the_derivation_refuses_a_bound_on_a_transformed_argument(self):
        """Validating `form_id.lower()` is not validating `form_id`.

        The linkage rule binds the names the refusal vouches for, and an earlier
        version bound every name reachable inside the validator CALL. So a
        normalizing spelling — `validated = _validated_form_id(form_id.lower())`,
        refuse, then key on raw `form_id` — reported bounded, although only the
        transformed value was ever checked and the key was built from the parameter.

        This is the one shape worth its own case, because a normalizing validator is
        a change this module has already anticipated twice and defended against:
        `_validated_form_id`'s docstring argues at length against `.strip()`ing,
        `_load_form_for_query`'s reasons about "a plausible 'form ids are
        case-insensitive' change", and
        `test_a_query_route_filters_on_the_id_it_read_even_if_the_validator_normalizes`
        monkeypatches exactly that validator. The day such a change lands, this
        derivation would have been the one instrument still reporting a route
        bounded while it read a key it never checked.

        Both directions, since narrowing the binding must not cost the spelling
        every real route uses: the bare-name argument still binds the parameter.
        """
        transformed = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/normalized")
            def get_normalized(form_id: str):
                validated = _validated_form_id(form_id.lower())
                if not validated:
                    raise NotFoundError('Form not found')
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
            '''
        )

        assert not _validates_its_form_id(transformed, 'get_normalized'), (
            'a route that validated form_id.lower() and keyed on raw form_id was '
            'reported as bounded — the refusal vouches for the value handed IN, so '
            'a transformed argument is not a bound on its source'
        )

        bare = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/plain")
            def get_plain(form_id: str):
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
            '''
        )

        assert _validates_its_form_id(bare, 'get_plain'), (
            'the bare-name spelling stopped binding its argument — every real route '
            'in the module passes the parameter directly and keys on it or on the '
            'value handed back, so this must stay accepted'
        )

    def test_the_derivation_refuses_validating_the_wrong_capture(self):
        """Validating SOMETHING is not validating the id the read keys on.

        The derivation used to compare positions only, which answers "was a refusal
        reached before the first sink" — not "was the value this sink keys on the
        one that was refused". So a route could bound one capture and key on
        another: `_validated_form_id(submission_id)` refused, then
        `Key={'sk': f'FORM#{form_id}'}` with `form_id` never checked at all.

        This is the residual half of making the route selector capture-name-agnostic
        rather than a hypothetical: a two-capture route under this prefix is already
        in the derived universe, and
        `/feedback-forms/<form_id>/submissions/<submission_id>` is the natural next
        one for this module. Bounding whichever capture is easier would satisfy the
        old check while the other one — the one that becomes the key — arrived raw.

        Both directions, because only the pair means anything: validating the KEYED
        capture passes, validating the other does not. Without the accepting case a
        derivation that simply rejected every two-capture route would look correct
        here.
        """
        wrong = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/submissions/<submission_id>")
            def get_one_wrong(form_id: str, submission_id: str):
                validated = _validated_form_id(submission_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
            '''
        )

        assert not _validates_its_form_id(wrong, 'get_one_wrong'), (
            'a route that validated one capture and keyed on another was reported '
            'as bounded — the position of a refusal says nothing about WHICH value '
            'it vouched for, and the raw one is what reached the key'
        )

        right = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/submissions/<submission_id>")
            def get_one_right(form_id: str, submission_id: str):
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
                )
            '''
        )

        assert _validates_its_form_id(right, 'get_one_right'), (
            'a two-capture route that validated the id it keys on was reported as '
            'unbounded — the linkage check must judge WHICH value was bounded, not '
            'refuse every route with more than one capture'
        )

    def test_the_derivation_refuses_a_key_built_before_the_check(self):
        """The linkage check has to follow the value, not just the parameter name.

        A route can put the raw id into a local first and hand THAT to the read:
        `key = {'sk': f'FORM#{form_id}'}` above the refusal, `get_item(Key=key)`
        below it. The sink then mentions no parameter at all, so a linkage check
        that looked only for parameter names in the arguments would see nothing to
        object to — while the key it reads was built from a value nothing had
        vouched for at the time.

        Ordering is what makes this the interesting case rather than a duplicate of
        the read-before-check control: the READ is correctly placed after the
        refusal. It is the key's CONSTRUCTION that is not, and the string does not
        become well-formed later because the id it was built from was checked
        afterwards.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/prebuilt-key")
            def get_prebuilt_key(form_id: str, raw: str):
                key = {'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{raw}'}
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
                return aggregates_table.get_item(Key=key)
            '''
        )

        assert not _validates_its_form_id(source, 'get_prebuilt_key'), (
            'a key built from an unvalidated value before the refusal was reported '
            'as bounded — the read mentions only the local, so the derivation has '
            'to follow what that local was built from'
        )

    def test_the_derivation_refuses_a_read_through_an_alias_bound_in_a_try(self):
        """The alias one indentation level in, which is where the real ones are.

        Aliases used to be collected from `function.body` only, so an alias bound
        inside a `try:` was untracked — and EVERY table read in this handler sits
        inside a `try:`, as do three of the twelve in-repo
        `table = get_aggregates_table()` sites. The existing alias control passes
        only because its own alias happens to be at the top level, which is the
        less likely of the two placements.

        Worth being precise about the direction, because the helper's own docstring
        used to have it backwards: an untracked alias is a FALSE NEGATIVE. The call
        drops out of `_sink_calls`, so neither question is asked of it and the
        shorter list is MORE likely to pass — the read is not reported at all. That
        is the vacuous pass these controls exist for, not a cautious over-report.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/nested-alias")
            def get_nested_alias(form_id: str):
                try:
                    table = aggregates_table
                    table.get_item(
                        Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                    )
                except Exception:
                    pass
                validated = _validated_form_id(form_id)
                if not validated:
                    raise NotFoundError('Form not found')
            '''
        )

        assert not _validates_its_form_id(source, 'get_nested_alias'), (
            'a read through an alias bound inside a try: was not recognised as a '
            'read — alias collection has to descend into nested bodies, because '
            'every read in this handler is inside one'
        )

    def test_the_derivation_refuses_a_success_path_return(self):
        """An `if` that returns on the SUCCESS path is not a refusal.

        `_refused_names` used to accept any top-level `if` whose body contained a
        `Raise` or a `Return`, without looking at what the test asserted. So
        `if validated: return render(validated)` was credited as the refusal while
        refusing nothing at all: a malformed id falls THROUGH the condition with
        `validated` bound to None and reaches the read below it, which is the
        `Key={'sk': 'FORM#None'}` call the whole cost argument exists to avoid.

        This is why the refusal is now recognised only as a NEGATIVE test of the
        name — `if not <name>:` or `if <name> is None:`, the two spellings the
        module uses. "An `if` mentions the value" was never the claim.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/success-return")
            def get_success_return(form_id: str):
                validated = _validated_form_id(form_id)
                if validated:
                    return render(validated)
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
                )
            '''
        )

        assert not _validates_its_form_id(source, 'get_success_return'), (
            'a success-path return was counted as the refusal — nothing in this '
            'function refuses anything, and the malformed id falls through to the '
            'read with None bound'
        )

    def test_the_derivation_refuses_a_cache_hit_return(self):
        """The same shape in the spelling the NEXT planned change would produce.

        `lib/stacks/api-stack.ts` records a `Cache-Control` follow-up as unblocked
        by #379. If it lands as an in-Lambda cache rather than at the edge, this is
        what the route looks like — `if validated in _PAGE_CACHE: return ...` — and
        under the old derivation it was credited as the refusal because the test
        mentions the name and the body returns.

        So the gap sat directly in front of the one change this PR declares next,
        which is what makes it worth a case of its own rather than being covered by
        the success-path one: they fail for the same reason, but only this one is
        already on somebody's list.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/cached")
            def get_cached(form_id: str):
                validated = _validated_form_id(form_id)
                if validated in _PAGE_CACHE:
                    return _PAGE_CACHE[validated]
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
                )
            '''
        )

        assert not _validates_its_form_id(source, 'get_cached'), (
            'a cache-hit return was counted as the refusal — a cache MISS for a '
            'malformed id falls through to the read with None bound, so this '
            'function has no bound at all'
        )

    def test_the_derivation_accepts_the_walrus_spelling(self):
        """The one spelling that CANNOT exhibit the window the others are measured
        against — accepted, not merely tolerated.

        `if not (validated := _validated_form_id(form_id)):` binds and refuses in a
        single statement, so there is no boundary between the two for a read to be
        inserted into. Every other control in this class is about that gap: the
        assignment binds None for free, so it is the refusal's position that has to
        beat the first sink.

        The derivation used to reject it, which is the wrong direction for the cost
        of a false positive to run: the explanation offered to whoever wrote it
        would have been "rewrite your safe code into the shape with the window in
        it" to get green. Reported here as the accepting side so a future narrowing
        of the helper cannot quietly reintroduce that.
        """
        source = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/walrus")
            def get_walrus(form_id: str):
                if not (validated := _validated_form_id(form_id)):
                    raise NotFoundError('Form not found')
                return aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{validated}'}
                )
            '''
        )

        assert _validates_its_form_id(source, 'get_walrus'), (
            'the walrus guard was reported as unbounded — it is strictly safer '
            'than the two-statement form it models, so rejecting it pushes an '
            'author toward the weaker spelling'
        )

        # And the same spelling with the read moved AHEAD of it, so acceptance is
        # not simply "a walrus anywhere passes": the position still has to win.
        read_first = textwrap.dedent(
            '''
            @app.get("/feedback-forms/<form_id>/walrus-late")
            def get_walrus_late(form_id: str):
                item = aggregates_table.get_item(
                    Key={'pk': 'FEEDBACK_FORM', 'sk': f'FORM#{form_id}'}
                )
                if not (validated := _validated_form_id(form_id)):
                    raise NotFoundError('Form not found')
                return item
            '''
        )

        assert not _validates_its_form_id(read_first, 'get_walrus_late'), (
            'a walrus guard AFTER the read was reported as a bound — recognising '
            'the spelling must not cost the ordering that is the actual claim'
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

    Callers use their own `form_id` for the id echoed in a response, so the
    validated value and the parameter have to be the same string. `.strip()` was
    removed for a related reason, but exactness is the broader property and it was
    carried entirely by a sentence in a docstring.

    The `source_channel` those routes filter on no longer depends on it — it is
    built from the id `_load_form_for_query` hands back, which is the same string
    the write side used — but the identity below is what keeps the echoed id and
    the key describing the same form, and it is the assertion a future "form ids
    are case-insensitive" change has to come and argue with.
    """

    def test_the_validator_returns_its_input_unchanged(self, feedback_form_handler):
        """Identity, not merely truthiness.

        A normalizing validator — lower-casing, say, for a plausible "form ids are
        case-insensitive" change — would pass every existing test while making the
        record a route reads and the id it echoes describe two different forms: the
        caller answers with its own `form_id` while the key names the normalized
        one, so a client that stores what it was told would then address something
        else. The `source_channel` half of that split is closed structurally
        (`_load_form_for_query` hands the validated id to both read routes), which
        is why this identity is the assertion that remains.

        So the invariant gets a test instead of a sentence. If ids ever should be
        case-insensitive, the normalization belongs at the mint and at every read
        alike, and this test is the place to come and argue with.
        """
        for valid in (
            'deadbeef',
            'DEADBEEF',
            'website-form_2',
            'acme.website',
            'a',
            'a' * feedback_form_handler.FORM_ID_MAX_LENGTH,
            feedback_form_handler._minted_form_id(),
        ):
            assert feedback_form_handler._validated_form_id(valid) == valid, (
                f'{valid!r} came back as '
                f'{feedback_form_handler._validated_form_id(valid)!r} — a '
                'normalized return makes the record a route reads and the id it '
                'echoes back describe two different forms'
            )

    def test_the_two_relative_path_segments_are_not_form_ids(
        self, feedback_form_handler
    ):
        """`.` and `..` are refused, and this is why admitting `.` is safe.

        The exclusion is about URL RESOLUTION rather than about DynamoDB, so it is
        the one part of the character class whose reason is not "this character
        could close a string". `feedbackFormPublicUrl` and the snippet in
        `docs/feedback-forms.md` both build a path by joining a base to
        `feedback-forms/<id>/iframe`; with an id of `..` a client resolves that to a
        path with the segment REMOVED before any request is sent, so the caller
        reaches a different resource and sees it working rather than being refused.
        A stored row cannot be addressed at all under those two ids, which makes
        admitting them worse than refusing them.

        Exactly those two strings, which is the reason for a negative lookahead
        anchored with `\\Z` rather than a ban on dots in some position: `'...'` is an
        ordinary path segment, and `.hidden-form` and `form.` are ordinary ids. A
        blanket "no leading dot" rule would refuse three reachable shapes to
        exclude two unreachable ones.
        """
        for relative in ('.', '..'):
            assert feedback_form_handler._validated_form_id(relative) is None, (
                f'{relative!r} was accepted as a form id — it is a relative-path '
                'segment, so a client resolves it away and addresses a different '
                'resource than the one asked for'
            )
        # The other direction, and the whole reason the exclusion is exact: without
        # these the lookahead could be widened to any leading dot (or to any id
        # containing one) and nothing would notice.
        for ordinary in ('...', '.hidden-form', 'form.', 'acme.website'):
            assert feedback_form_handler._validated_form_id(ordinary) == ordinary, (
                f'{ordinary!r} was refused — it is an ordinary path segment, not a '
                'relative one, so the exclusion has been widened past the two '
                'strings it is for'
            )

    def test_widening_the_class_for_a_dot_moved_no_character_the_fix_needs(
        self, feedback_form_handler
    ):
        """The control on the compatibility widening above.

        `.` was added to the character class so a hand-seeded `acme.website` keeps
        resolving, and the argument for that being free is that a dot cannot end a
        JavaScript string, open an HTML tag or begin a statement. This is that
        argument as an assertion rather than a sentence: every character the #379
        fix actually turns on is still refused, so a future widening cannot cite
        this one as precedent for `'` or `<`.

        The `scanned_ascii` loop is here for a different reason — those are the
        exclusions the upgrade notes tell an operator to SCAN for, so they have to be
        genuinely refused for that instruction to describe the code. All 24 of them,
        not the five the notes name as illustrations: both documents now state that
        set as a complement (every character the route's capture group admits and this
        pattern does not) and print it, and a check covering only the memorable
        characters is what let the prose stand at six of twenty-four. Seven of the
        rest are the #379 payload's own, so the `dangerous` loop above asserts those
        for their own reason and this loop re-covers them deliberately: they are in
        both sets, and each set's claim should be readable without the other.
        `my form` earns its place for the same reason `a:b` has one: a stored id with
        an INTERIOR SPACE resolved before this change (every route keyed
        `f'FORM#{form_id}'` with nothing checked) and answers 404 after it, so it is
        reachable-then-orphaned rather than exempt. That is why the whitespace
        exemption in `CHANGELOG.md` and `docs/feedback-forms.md` is scoped to an id
        merely ADDRESSED with surrounding space — ` abc123` never resolved to
        `abc123` — and not to whitespace-bearing ids as a category.

        A space rather than whitespace generally, which is the narrower claim and
        the true one: a tab or a newline inside an id never matched the route either,
        so such a row is unreachable rather than orphaned and is out of the scan's
        scope. `test_the_scan_is_scoped_to_ids_a_route_could_actually_resolve` below
        is where that split is asserted, off the live resolver.

        `my form` is deliberately NOT an independent detector, and saying so is the
        honest version: `'a b'` in the loop above already fails on any class that
        admits a space, so widening the class would be caught with or without it
        (verified by mutation). It is here as the spelling an operator will actually
        recognise in their own table, next to the characters the scan names, so the
        list a reader checks the upgrade note against is the same list the note
        gives them.

        The accepting cases at the top are the vacuity control, and they are what
        makes the two refusal loops an argument rather than a tautology. Adding a
        character to a class can never make a previously-refused string accepted, so
        the refusal loops alone are one-directional in the direction a NARROWING
        travels — which is the direction the compatibility regression this change is
        about actually moves. Without the accepting cases every assertion here is
        satisfied by reverting the class to `[0-9A-Za-z_-]`, and also by an oracle
        that refuses every input; with them, both of those fail.
        """
        for accepted in ('acme.website', 'website-form', 'a_b',
                         feedback_form_handler._minted_form_id()):
            assert feedback_form_handler._validated_form_id(accepted) == accepted, (
                f'{accepted!r} was refused — the refusal loops below only mean '
                'something read against a class that still admits the shapes the '
                'widening exists for, so this is the control that stops them '
                'passing against a validator which refuses everything'
            )
        for dangerous in ('a\'b', 'a"b', 'a(b', 'a)b', 'a;b', 'a<b', 'a>b',
                          'a&b', 'a\\b', 'a b', 'a\tb', 'a/b', 'a\nb'):
            assert feedback_form_handler._validated_form_id(dangerous) is None, (
                f'{dangerous!r} was accepted — this is a character the #379 fix '
                'depends on being outside the class, and admitting `.` must not '
                'have moved it'
            )
        scanned_ascii = ' !$%&\'()*+,:;<=>@[]^{|}~'
        for scanned in [f'a{c}b' for c in scanned_ascii] + ['café', 'my form']:
            assert feedback_form_handler._validated_form_id(scanned) is None, (
                f'{scanned!r} was accepted — CHANGELOG.md tells an operator to '
                'scan stored ids for exactly these, so if one is now admitted the '
                'upgrade note describes a refusal that does not happen'
            )
        assert len(scanned_ascii) == 24, (
            f'{len(scanned_ascii)} ASCII characters here, not 24 — both documents '
            'state the in-scope ASCII set as a COMPLEMENT and then print it, so '
            'this literal is the copy that has to agree with them. '
            'test_the_scan_is_scoped_to_ids_a_route_could_actually_resolve is where '
            'membership is derived off the live resolver rather than listed.'
        )

    def test_the_scan_is_scoped_to_ids_a_route_could_actually_resolve(
        self, feedback_form_handler
    ):
        """The scan's REACH, which is a different claim from its accuracy.

        `CHANGELOG.md` tells an operator that the ids it names went from resolving
        to answering 404, and that a literal tab or newline — and a non-ASCII symbol
        or space — is NOT something the scan has to find. Both halves rest on one
        fact about a file this one does not own: powertools' capture group lists a
        literal space but no other whitespace, and reaches past ASCII only through
        `\\w`, which matches any Unicode LETTER OR NUMBER. So an id holding a tab, a
        newline, or a non-ASCII symbol never matched a route and answered 404 before
        this change as well as after — unreachable rather than
        reachable-then-orphaned.

        The `\\w` half is asserted rather than the ASCII boundary, because that is
        where the line actually falls and the two are easy to conflate: `'café'` and
        `'表単'` are both non-ASCII and both resolved, while `'form€a'` is non-ASCII
        and never did. An upgrade note that said "any non-ASCII character" would send
        an operator to rename a row that was never served.

        The `\\w` boundary is sampled across CATEGORIES rather than at the ASCII
        line, and EVERY category is sampled on both sides rather than a
        representative few. `\\w` is exactly `L* | N* | {'_'}` — verified by
        enumerating all 0x110000 codepoints — so the reachable loop carries one id
        per `\\w` category (`Ll` `'café'`, `Lm` `'hawaiʼi-form'`, `Lo` `'表単'`,
        `Lt` `'ǅigit'`, `Lu` `'ÉCOLE'`, `Nd` `'form٠a'`, `Nl` `'section-Ⅷ'`, `No`
        `'surface-m²'`) and the unreachable loop one per class `\\w` excludes:
        every class either document NAMES (`Mn`, `Mc`, `So`, `Pd`, `Pi`, `Pf`, `Zs`,
        `Cf`, `Sc`), plus `Me`, `Pc`, `Zl` and `Zp`, which they do not name but which
        are outside `\\w` for the same reason.

        On the ASCII side the same principle applies to the CLASS rather than to a
        category: the in-scope set is 24 characters, and the note named six of them,
        so `'form(1)'` and `'a;b'` are sampled beside the named `'a:b'`. Those two
        hold characters from the #379 payload itself, which is the reason a list
        written by hand omits them — they read as attack syntax rather than as an id
        anyone would seed, and they resolved regardless.

        Exhaustively rather than representatively, because a partial sample is what
        let the prose go wrong twice. `Lm` and `No` read to a human as punctuation,
        so a note glossing `\\w` as "a letter or a digit" put them in the SAME
        sentence as `€` and `—` — and that error runs in the expensive direction:
        an operator sees `hawaiʼi-form` printed by the scan, classifies it out of
        scope, skips the rename, and the row 404s in production. Every other
        imprecision in this note over-reports; that one loses a reachable row. The
        converse is cheaper but also live: `Mc`/`Mn` read as LETTERS, so a
        Devanagari or Thai id looks in scope while never having matched a route.
        Both documents cite this test as asserting "the whole split", so a category
        named in either of them and absent here would make that citation false —
        which is the state a four-of-eight sample was in.

        That is the SAME distinction the whole upgrade note turns on, applied one
        level down: ` abc123` is exempt because it never resolved, and `abc<TAB>def`
        is out of scope for the same reason. Only `my form` and `'   '` are in
        scope, because those really did resolve — the merge base keyed
        `f'FORM#{form_id}'` with nothing checked — and now do not.

        Asserted off the live resolver rather than from the pattern quoted in the
        note, because the note's scope is only as true as the installed powertools:
        an upgrade that widened the class to admit a tab would make a tab-bearing id
        reachable, and then the paragraph saying the scan need not look for one
        would be wrong in the under-reporting direction. This is that sentence as an
        assertion.

        The `my form` half is the positive control, and it is doing real work here
        rather than balancing the loop for symmetry: `_form_id_route_paths` splices
        a substring out of a regex, and the plausible way for it to break yields a
        path that matches NOTHING — which would report every character as excluded
        and pass an assertion set made only of exclusions.
        """
        # The ASCII cases first. `a:b` is one of the characters both documents name;
        # `form(1)` and `a;b` are two they do NOT. The in-scope ASCII set is 24
        # characters, and the seven the #379 payload is built from (`&`, `'`, `(`,
        # `)`, `;`, `<`, `>`) are exactly the ones a hand-written list drops, because
        # they read as attack syntax rather than as an id anyone would seed. They
        # resolved all the same, so sampling only a NAMED character would pin the
        # note's list rather than the class the classifier actually tests.
        #
        # Then one id per `\w` category, so no category stands in for another: `Ll`
        # `café`, `Lm` `hawaiʼi-form` (U+02BC, an apostrophe to the eye), `Lo`
        # `表単`, `Lt` `ǅigit`, `Lu` `ÉCOLE`, `Nd` `form٠a` (ARABIC-INDIC DIGIT
        # ZERO), `Nl` `section-Ⅷ`, `No` `surface-m²`.
        for reachable in ('my form', '   ', 'a:b', 'form(1)', 'a;b', 'café',
                          'hawaiʼi-form', '表単', 'ǅigit', 'ÉCOLE',
                          'form٠a', 'section-Ⅷ', 'surface-m²'):
            admitting = [
                f'{method} {path}'
                for method, path, rule in _form_id_route_paths(
                    feedback_form_handler, reachable
                )
                if rule.match(path)
            ]
            assert len(admitting) == 8, (
                f'{reachable!r} is admitted by {len(admitting)} of the form-id '
                'routes, expected all 8 — CHANGELOG.md lists this id as one that '
                'DID resolve before the validator existed, so if no route matches '
                'it the upgrade note is telling an operator to scan for a row that '
                'was never reachable'
            )
            assert feedback_form_handler._validated_form_id(reachable) is None, (
                f'{reachable!r} is accepted, so it did not stop resolving and does '
                'not belong in the scan at all'
            )

        # One id per class `\w` EXCLUDES, mirroring the per-category loop above so
        # that neither side of the boundary rests on a representative sample:
        # `form€a` is `Sc`, `form°a` and `form\U0001f600a` are `So`,
        # `form—a` is `Pd`, `form«a` is `Pi`, `hawai\u2019i-form` is `Pf`,
        # `form\uff3fa` is `Pc`, `cafe\u0301` is `Mn`, `form\u0488a` is `Me`,
        # `form\u200da` is `Cf` (a zero-width joiner), `form\xa0a` is `Zs`, and
        # `form\u2028a` / `form\u2029a` are `Zl` / `Zp`. The Devanagari id carries
        # BOTH a matra (`Mc`) and a virama (`Mn`) — `['Lo','Mc','Lo','Mn','Lo']` — so
        # it is the `Mc` sample and is NOT disjoint from the `Mn` one, which is
        # `cafe\u0301`.
        #
        # `So`, `Pd`, `Pi` and `Pf` are in the loop because both documents NAME them:
        # `€`, `°` and an emoji as symbols, `—` and `«` as punctuation, and U+2019
        # as the out-of-scope half of the apostrophe look-alike pair. The criterion is
        # the one this test's docstring states — a class named in either document and
        # absent here would make their "asserts this split" citation false — and a
        # selection of only marks, one symbol, one separator and one format character
        # was in exactly that state.
        #
        # `Zl` and `Zp` are the pair NEITHER document's `Z*` illustration covers:
        # U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are not `Zs` like the
        # U+00A0 and U+3000 both documents name, and they are the exact two characters
        # `_js_value`'s `ensure_ascii=True` exists to escape — so a reader meets them
        # in both roles and is owed the fact that no route admits them either.
        #
        # `Pc` earns its line because it is the NEAR MISS: `_` is the one `\w`
        # member outside `L*`/`N*`, and `_` is `Pc` — but the REST of `Pc` (U+FF3F
        # here, also U+2040 and U+203F) is excluded like any other punctuation. So
        # "connector punctuation" is not a shorthand for the exception; `_` alone is,
        # and `_` is inside the validator's OWN class, so an id holding one is
        # accepted rather than refused and belongs to neither of the scan's lists.
        #
        # The Devanagari id is Hindi for "form": `Lo` base letters carrying a matra,
        # which is `Mc`. It is here as the OPPOSITE misfiling to `hawai\u02bci-form`
        # in the loop above — this one reads as letters and never reached a route,
        # that one reads as punctuation and resolved. Getting them from one fact
        # (`\w` is `L*`/`N*`) is why both documents state the categories now.
        #
        # The confusable and invisible entries are spelled as escapes on purpose.
        # `cafe\u0301` is the DECOMPOSED spelling of `caf\u00e9`, visually identical to
        # the composed `caf\u00e9` in the loop above, and the whole point is that the
        # two are different strings with OPPOSITE verdicts: a combining accent is a
        # MARK, so the decomposed form never reached a route while the composed one
        # did. Both documents name `caf\u00e9` in scope without saying which of the
        # two spellings they mean. `\u200d` and `\u0488` would be invisible, or would
        # stack onto the preceding character, in an editor.
        for unreachable in ('abc\tdef', 'abc\ndef', 'form€a', 'form°a',
                            'form\U0001f600a', 'form—a', 'form«a',
                            'hawai\u2019i-form', 'form\uff3fa', 'cafe\u0301',
                            'फॉर्म', 'form\u0488a', 'form\u200da',
                            'form\xa0a', 'form\u2028a', 'form\u2029a'):
            admitting = [
                f'{method} {path}'
                for method, path, rule in _form_id_route_paths(
                    feedback_form_handler, unreachable
                )
                if rule.match(path)
            ]
            assert not admitting, (
                f'{unreachable!r} is now admitted by {admitting} — powertools has '
                'widened its capture group, so this id CAN reach a handler and is '
                'reachable-then-orphaned after all. '
                "CHANGELOG.md's paragraph saying the scan need not find it is now "
                'wrong, in the under-reporting direction: an operator is told the '
                'row was never served when it was. (For a tab or a newline the '
                'scan could not find one anyway, through a line-oriented pipeline.)'
            )

    def test_a_trailing_newline_is_not_a_valid_form_id(
        self, feedback_form_handler
    ):
        """`$` matches before a final newline; `\\Z` is why this now refuses.

        The one whitespace character the character class did not actually exclude.
        `re`'s `$` also matches immediately BEFORE a trailing newline, so
        `_FORM_ID_PATTERN.match('deadbeef\\n')` succeeded and the validator returned
        the newline-bearing string — while the pattern's own comment says "No
        whitespace either, and that is a choice rather than an oversight" and
        `test_an_id_padded_with_whitespace_is_not_an_alias_for_the_id` pins only the
        LEADING-space case. So the single character that got through was precisely
        the one nothing checked.

        Two consequences, both asserted:

        - It reached `f'FORM#{validated}'`, the `source_channel` the query routes
          filter on, and the log line in `_load_form_for_query`, where an embedded
          newline in a structured log record is its own small problem.
        - The length cap bounded the matched PREFIX rather than the id, so
          `'a' * FORM_ID_MAX_LENGTH + '\\n'` was admitted at 65 characters while
          `'a' * (FORM_ID_MAX_LENGTH + 1)` was refused. Derived from the constant
          rather than spelled as a literal, for the same reason every other
          over-length case here is.

        Unreachable through the deployed route today — powertools' capture group
        excludes `\\n`, and `%0A` arrives as the three literal characters `%0A`,
        which `%` already refuses — and that is exactly the argument for fixing it
        HERE: the pattern is documented as the bound that does not depend on the
        route regex, so it has to hold on its own terms.
        """
        assert feedback_form_handler._validated_form_id('deadbeef\n') is None, (
            "a trailing newline was accepted — check that _FORM_ID_PATTERN ends "
            'in \\Z rather than $, which also matches before a final newline'
        )
        over_long = 'a' * feedback_form_handler.FORM_ID_MAX_LENGTH + '\n'
        assert feedback_form_handler._validated_form_id(over_long) is None, (
            f'{len(over_long)} characters were accepted against a cap of '
            f'{feedback_form_handler.FORM_ID_MAX_LENGTH} — with `$` the cap bounds '
            'the matched prefix, not the id'
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

        The `sk` read and the `source_channel` filtered on are asserted TOGETHER
        against the id in the URL, because it is their agreement rather than either
        one that decides whether the route reports the submissions a form has. Both
        now come from the same string — `_load_form_for_query` returns the validated
        id and its caller builds the channel from that — where the filter used to
        be built from the raw parameter beside a key built from the validated one.

        This is the only way the defect would ever have been noticed: a filter that
        names a channel no write used produces a plausible-looking zero, not an
        error. So the case has to be the composite one; asserting the key alone
        passes while the filter is wrong.
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

    @pytest.mark.parametrize('route', ['submissions', 'stats'])
    @patch('feedback_form_handler.feedback_table')
    @patch('feedback_form_handler.aggregates_table')
    def test_a_query_route_filters_on_the_id_it_read_even_if_the_validator_normalizes(
        self,
        mock_table,
        mock_feedback_table,
        route,
        api_gateway_event,
        lambda_context,
        feedback_form_handler,
    ):
        """The case above cannot fail while the two strings are equal; this one can.

        `test_the_key_a_query_route_reads_is_the_id_in_its_url` asserts the key and
        the filter against the URL's id, which they both match whether the route
        builds them from the validated value or from the raw parameter — so it
        pins the OUTCOME today without pinning the DERIVATION. That leaves the very
        coupling this test class exists for resting on the identity next door, and
        a "form ids are case-insensitive" change would edit that identity rather
        than discover this.

        So the validator is made to normalize FOR THIS CASE ONLY, and the two are
        asserted to still agree with each other. That is the property: whatever the
        validator returns, the channel a read route filters on is the id its read
        was keyed on, which is the id `submit_form_feedback` wrote
        (`f'form_{validated}'`). A route that rebuilt the channel from its raw
        parameter would filter on `form_DeadBeef` beside a key of `FORM#deadbeef`
        and select nothing — zero submissions for a form that has them, answered
        as a 200, which is #312's false zero.

        The RESPONSE's `form_id` is asserted alongside them, because it is the
        third use of the same string and the one a caller reads: a body naming
        `DeadBeef` beside a count measured on `form_deadbeef` reports a number for
        a record it does not name, and it looks authoritative while doing it. Both
        query routes therefore echo the validated id, as
        `submit_form_feedback` already stores it — which is why this case runs over
        BOTH of them rather than over `/submissions` alone: they are two copies of
        the same three-way agreement, and only pinning each catches the one that
        drifts.
        """
        exact = feedback_form_handler._validated_form_id
        mock_table.get_item.return_value = {
            'Item': {'form_id': 'deadbeef', 'brand_name': 'acme'}
        }
        mock_feedback_table.query.return_value = {'Items': []}

        event = api_gateway_event(
            method='GET',
            path=f'/feedback-forms/DeadBeef/{route}',
            path_params={'form_id': 'DeadBeef'},
            resource=f'/feedback-forms/{{form_id}}/{route}',
        )

        with patch.object(
            feedback_form_handler,
            '_validated_form_id',
            lambda raw: (exact(raw) or '').lower() or None,
        ):
            response = feedback_form_handler.lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        key = mock_table.get_item.call_args.kwargs['Key']['sk']
        channel = mock_feedback_table.query.call_args.kwargs[
            'ExpressionAttributeValues'
        ][':sc']
        reported = json.loads(response['body'])['form_id']
        assert (key, channel, reported) == (
            'FORM#deadbeef', 'form_deadbeef', 'deadbeef'
        ), (
            f'the route read {key}, filtered on {channel} and reported '
            f'{reported!r} — these are built from different strings, so the filter '
            'names a source_channel no write produced (zero rows for a form that '
            'has submissions) or the body names an id other than the record the '
            'count was measured on'
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

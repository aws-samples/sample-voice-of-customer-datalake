"""The processor reads the settings of the scope a message names (7.08.00, docs/multi-workspace.md, "Per-workspace
configuration"): a workspace's message is classified with that workspace's categories and dimensions and stored under
its source profile's PII policy, never the deployment's; a message that names no workspace exactly as before; and a
workspace that saved none of a kind gets the built-in defaults, not the deployment's rows (its sources' PII redacted). Driven through the real
``record_handler`` against moto (voc-feedback and voc-aggregates)."""
import json
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

from moto import mock_aws

from processor import handler
from shared.test.moto_tables import create_pk_sk_table

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'


def review(**fields) -> dict:
    """A review message as an ingestor queues it, without ``pii_policy_applied`` (the processor reads the profile)."""
    return {'id': 'rev-1', 'source_platform': 'webscraper', 'source_channel': 'reviews',
            'text': 'The trail shoes split after a week', 'author': 'Robin Example',
            'created_at': '2026-01-01T00:00:00Z', **fields}


def _config(pk: str, *, category: str, dimension: str, pii: str) -> list[dict]:
    return [
        {'pk': f'{pk}categories', 'sk': 'config', 'categories': [{'id': category, 'name': category}]},
        {'pk': f'{pk}dimensions', 'sk': 'config', 'dimensions': [
            {'key': dimension, 'label': dimension, 'infer': True, 'values': [{'name': f'{dimension}_one'}]}]},
        {'pk': f'{pk}sources', 'sk': 'config', 'sources': [{'id': 'webscraper', 'label': 'Reviews', 'pii': pii}]},
    ]


#: The deployment keeps everything (allow); the workspace summarises (summary_only), with its own taxonomy.
DEPLOYMENT_ROWS = _config('SETTINGS#', category='billing_desk', dimension='plan', pii='allow')
WORKSPACE_ROWS = _config(f'WS#{WS}#SETTINGS#', category='trail_gear', dimension='terrain', pii='summary_only')


def _answer(category: str) -> dict:
    return {'insights': {
        'category': category, 'subcategory': None, 'sentiment_label': 'negative', 'sentiment_score': -0.5,
        'urgency': 'medium', 'journey_stage': 'usage', 'impact_area': 'product',
        'problem_summary': 'Shoes split early', 'direct_customer_quote': 'split after a week',
    }, 'metadata': {'model_name': 'haiku'}}


@contextmanager
def world(*, workspace_rows: bool = True):
    """Moto voc-feedback and voc-aggregates (the deployment's settings, and the workspace's unless left out), the
    enrichment model stubbed so its prompt and dimensions can be read back; every settings cache empty."""
    with mock_aws():
        feedback = create_pk_sk_table('test-feedback')
        aggregates = create_pk_sk_table('test-aggregates')
        for row in DEPLOYMENT_ROWS + (WORKSPACE_ROWS if workspace_rows else []):
            aggregates.put_item(Item=row)
        model = MagicMock(side_effect=lambda _record, instruction, **_kw: _answer(
            'trail_gear' if 'trail_gear' in instruction else 'billing_desk'))
        handler._settings_cache.clear()
        handler._failed_settings.clear()
        with patch.object(handler, 'feedback_table', feedback), \
             patch.object(handler, 'aggregates_table', aggregates), \
             patch.object(handler, 'persistence_layer', None), \
             patch.object(handler, 'idempotency_config', None), \
             patch.object(handler, '_categories_cache', None), \
             patch.object(handler, '_categories_cache_time', None), \
             patch.object(handler, 'detect_language', return_value='en'), \
             patch.object(handler, 'translate_text', side_effect=lambda text, _s, _d: text), \
             patch.object(handler, 'get_comprehend_sentiment', return_value={'label': 'negative', 'score': -0.5}), \
             patch.object(handler, 'invoke_enrichment_llm', model):
            yield feedback, model


def deliver(message: dict) -> dict:
    return handler.record_handler(MagicMock(body=json.dumps(message)))


def _item(feedback, pk: str) -> dict:
    (item,) = [row for row in feedback.scan()['Items'] if row['pk'] == pk]
    return item


def _prompt(model: MagicMock, call: int) -> tuple[str, list[str]]:
    """The categories instruction and the dimension keys the model was given on its ``call``-th call."""
    args, kwargs = model.call_args_list[call]
    return args[1], [dimension['key'] for dimension in kwargs['dimensions_config']]


class TestAWorkspacesMessage:
    def test_is_classified_with_the_workspaces_categories_and_dimensions_not_the_deployments(self):
        with world() as (feedback, model):
            assert deliver(review(workspace_id=WS))['status'] == 'success'
            item = _item(feedback, f'WS#{WS}#SOURCE#webscraper')
            instruction, dimensions = _prompt(model, 0)

        assert 'trail_gear' in instruction
        assert 'billing_desk' not in instruction
        assert 'terrain' in dimensions
        assert 'plan' not in dimensions
        assert item['category'] == 'trail_gear'
        assert item['gsi2pk'] == f'WS#{WS}#CATEGORY#trail_gear'

    def test_is_stored_under_the_workspaces_pii_policy_not_the_deployments(self):
        with world() as (feedback, _):
            deliver(review(workspace_id=WS))
            item = _item(feedback, f'WS#{WS}#SOURCE#webscraper')

        # summary_only (the workspace's profile): the customer's own words and identity are not kept.
        assert item['pii_policy'] == 'summary_only'
        assert item['original_text'] == 'Shoes split early'
        assert 'author' not in item
        assert 'direct_customer_quote' not in item

    def test_a_workspace_that_saved_no_settings_gets_the_defaults_never_the_deployments(self):
        with world(workspace_rows=False) as (feedback, model):
            deliver(review(workspace_id=WS))
            item = _item(feedback, f'WS#{WS}#SOURCE#webscraper')
            instruction, dimensions = _prompt(model, 0)

        assert 'billing_desk' not in instruction
        assert 'plan' not in dimensions
        # No profile of its own: the workspace default, which redacts (privacy by default), whatever the
        # deployment's profile (allow) says.
        assert item['pii_policy'] == 'redact'

    def test_another_workspace_does_not_read_this_ones_settings(self):
        with world() as (feedback, model):
            deliver(review(workspace_id=OTHER_WS))
            item = _item(feedback, f'WS#{OTHER_WS}#SOURCE#webscraper')
            instruction, _ = _prompt(model, 0)

        assert 'trail_gear' not in instruction
        assert item['pii_policy'] == 'redact'  # its own default, not WS's summary_only


class TestADeploymentMessage:
    def test_is_processed_with_the_deployments_settings_as_before(self):
        with world() as (feedback, model):
            deliver(review())
            item = _item(feedback, 'SOURCE#webscraper')
            instruction, dimensions = _prompt(model, 0)

        assert 'billing_desk' in instruction
        assert 'trail_gear' not in instruction
        assert 'plan' in dimensions
        assert 'terrain' not in dimensions
        assert item['category'] == 'billing_desk'
        assert 'pii_policy' not in item
        assert item['author'] == 'Robin Example'

    def test_the_caches_keep_each_scope_apart_in_one_container(self):
        """A workspace's message, then the deployment's, then the workspace's again, in one warm container: each
        is processed with its own scope's settings (one cache entry per scope)."""
        with world() as (feedback, model):
            deliver(review(workspace_id=WS))
            deliver(review(id='rev-2'))
            deliver(review(id='rev-3', workspace_id=WS))
            prompts = [_prompt(model, call)[0] for call in range(3)]
            deployment = _item(feedback, 'SOURCE#webscraper')

        assert ['trail_gear' in prompt for prompt in prompts] == [True, False, True]
        assert deployment['category'] == 'billing_desk'

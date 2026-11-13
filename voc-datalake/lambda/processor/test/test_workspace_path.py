"""The processor's two paths (docs/multi-workspace.md, phase 2): a message that names a workspace is stored in it,
one that names none deployment-wide exactly as before, and a malformed workspace id is rejected, never stored
deployment-wide instead. Driven through the real ``record_handler`` against moto (DynamoDB + S3)."""
import json
from contextlib import ExitStack, contextmanager
from unittest.mock import MagicMock, patch

import boto3
import pytest

from processor import handler
from processor.test import test_source_updates as issues
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import OutOfScopeError, WorkspaceScope

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
BUCKET = 'voc-raw-workspaces'


#: Each workspace keeps its sources' PII here (a workspace with no profile redacts by default, 7.08.00), so its items
#: are stored as the deployment's are.
ALLOW_PROFILES = ({'id': 'webscraper', 'label': 'Reviews', 'pii': 'allow'},
                  {'id': 'github_issues', 'label': 'Issues', 'pii': 'allow'})


@pytest.fixture(autouse=True)
def _workspace_settings():
    """No dimensions and allow-PII profiles in either workspace (as the conftest seeds the deployment's): the
    processor reads a workspace's own settings for its messages (7.08.00; test_workspace_config.py reads them)."""
    for ws in (WS, OTHER_WS):
        handler._settings_cache[('dimensions', ws)] = (float('inf'), [])
        handler._settings_cache[('sources', ws)] = (float('inf'), list(ALLOW_PROFILES))


def review(**fields) -> dict:
    """A plain (not update-capable) review message, as an ingestor queues it."""
    return {'id': 'rev-1', 'source_platform': 'webscraper', 'source_channel': 'reviews', 'text': 'Late parcel again',
            'created_at': '2026-01-01T00:00:00Z', **fields}


def _items(feedback) -> list[dict]:
    return sorted(feedback.scan()['Items'], key=lambda item: item['pk'])


@contextmanager
def world_with_logs(**kwargs):
    """``issues.world`` plus a moto voc-aggregates for the LOGS# rows (created inside its moto context)."""
    with issues.world(**kwargs) as (feedback, llm):
        aggregates = create_pk_sk_table('test-aggregates')
        with patch.object(handler, 'aggregates_table', aggregates):
            yield feedback, llm, aggregates


class TestAMessageOfAWorkspace:
    def test_is_stored_under_the_workspace_with_every_partition_prefixed(self):
        with issues.world() as (feedback, _):
            result = issues.deliver(review(workspace_id=WS))
            (item,) = _items(feedback)

        assert result['status'] == 'success'
        prefix = f'WS#{WS}#'
        assert item['pk'] == f'{prefix}SOURCE#webscraper'
        assert item['sk'] == f"FEEDBACK#{item['feedback_id']}"
        assert item['gsi1pk'] == f"{prefix}DATE#{item['date']}"
        assert item['gsi2pk'] == f'{prefix}CATEGORY#product_quality'
        assert item['gsi3pk'] == f'{prefix}URGENCY#medium'
        assert item['gsi4pk'] == f"{prefix}FEEDBACK#{item['feedback_id']}"
        assert item['gsi5pk'] == f'{prefix}CHANNEL#reviews'
        # Plain attributes, as on every item; the workspace is in the keys, not an attribute of its own.
        assert (item['feedback_id'], item['source_channel'], item['source_platform']) == (
            handler.feedback_id_of(review()), 'reviews', 'webscraper')
        assert 'workspace_id' not in item

    def test_a_deployment_wide_message_is_stored_exactly_as_before(self):
        with issues.world() as (feedback, _):
            issues.deliver(review())
            (item,) = _items(feedback)

        feedback_id = handler.feedback_id_of(review())
        assert (item['pk'], item['sk']) == ('SOURCE#webscraper', f'FEEDBACK#{feedback_id}')
        assert item['gsi1pk'] == f"DATE#{item['date']}"
        assert (item['gsi2pk'], item['gsi3pk']) == ('CATEGORY#product_quality', 'URGENCY#medium')
        assert (item['gsi4pk'], item['gsi5pk']) == (f'FEEDBACK#{feedback_id}', 'CHANNEL#reviews')

    @pytest.mark.parametrize('channel', [{}, {'source_channel': None}, {'source_channel': ''}])
    @pytest.mark.parametrize('workspace', [{}, {'workspace_id': WS}])
    def test_a_missing_null_or_empty_channel_is_unknown_with_its_partition(self, channel, workspace):
        """One rule for every channel-less message, the one a CSV correction applies (shared/csv_updates.py)."""
        message = {key: value for key, value in review(**workspace).items() if key != 'source_channel'}
        with issues.world() as (feedback, _):
            issues.deliver({**message, **channel})
            (item,) = _items(feedback)

        prefix = f'WS#{WS}#' if workspace else ''
        assert (item['source_channel'], item['gsi5pk']) == ('unknown', f'{prefix}CHANNEL#unknown')

    def test_the_same_source_item_in_two_workspaces_and_the_deployment_is_three_items(self):
        with issues.world([issues.insights()] * 3, idempotent=True) as (feedback, llm):
            for body in (review(workspace_id=WS), review(workspace_id=OTHER_WS), review()):
                assert issues.deliver(body)['status'] == 'success'
            items = _items(feedback)

        assert [item['pk'] for item in items] == [
            'SOURCE#webscraper', f'WS#{WS}#SOURCE#webscraper', f'WS#{OTHER_WS}#SOURCE#webscraper']
        assert len({item['feedback_id'] for item in items}) == 1  # one id, three partitions
        assert len({item['gsi4pk'] for item in items}) == 3
        assert llm.call_count == 3  # the idempotency key names the workspace: none answered another's

    def test_a_redelivery_in_the_same_workspace_is_a_duplicate(self):
        with issues.world() as (feedback, llm):
            issues.deliver(review(workspace_id=WS))
            second = issues.deliver(review(workspace_id=WS))
            items = _items(feedback)

        assert second == {'status': 'skipped', 'reason': 'duplicate'}
        assert len(items) == 1
        assert llm.call_count == 1

    def test_the_idempotency_key_names_the_workspace(self):
        assert handler.message_idempotency_key(review(), None) == 'webscraper:rev-1'
        assert handler.message_idempotency_key(review(), WorkspaceScope(WS)) == f'WS#{WS}#webscraper:rev-1'

    def test_an_issue_refresh_stays_in_the_workspace_and_keeps_its_version_there(self, monkeypatch):
        monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
        answers = [issues.insights(), issues.insights('performance', urgency='high')]
        with issues.world(answers) as (feedback, _):
            s3 = boto3.client('s3', region_name='us-east-1')
            s3.create_bucket(Bucket=BUCKET)
            issues.deliver({**issues.issue_message(), 'workspace_id': WS})
            issues.deliver({**issues.issue_message(issues.CHANGED, text=issues.TEXT + ' Also on resume.'),
                            'workspace_id': WS})
            (item,) = _items(feedback)
            keys = [entry.get('Key', '') for entry in s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])]

        assert item['pk'] == f'WS#{WS}#SOURCE#github_issues'
        assert item['category'] == 'performance'
        assert (item['gsi2pk'], item['gsi3pk']) == (f'WS#{WS}#CATEGORY#performance', f'WS#{WS}#URGENCY#high')
        assert len(keys) == 1
        assert keys[0].startswith(f"ws/{WS}/silver/github_issues/{item['feedback_id']}/")


class TestTheInlineRawFallback:
    def test_a_workspace_message_with_inline_raw_data_is_archived_under_the_workspace(self):
        """A message whose producer could not archive it (``raw_data``, no ``s3_raw_uri``): one object under
        ``ws/{ws}/raw/<source>/…``, and the stored item names it."""
        from shared.test.raw_lake_fixtures import RAW_BUCKET, raw_keys, raw_lake_client
        from shared.test.source_profile_fixtures import seeded_source_profiles

        # The workspace keeps its PII (its own allow profile; with none, its default redacts and keeps no copy).
        with issues.world() as (feedback, _), raw_lake_client() as s3, \
                seeded_source_profiles(workspaces={WS: list(ALLOW_PROFILES)}):
            issues.deliver(review(workspace_id=WS, raw_data={'id': 'rev-1', 'body': 'Late parcel again'}))
            (item,) = _items(feedback)
            keys = raw_keys(s3)

        assert len(keys) == 1
        assert keys[0].startswith(f'ws/{WS}/raw/webscraper/')
        assert item['s3_raw_uri'] == f's3://{RAW_BUCKET}/{keys[0]}'


class TestAMalformedWorkspaceId:
    @pytest.mark.parametrize('value', ['ws_nope', '', 'WS#ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', None, 7])
    def test_is_rejected_to_the_dlq_path_and_nothing_is_stored(self, value):
        with world_with_logs() as (feedback, llm, aggregates):
            with pytest.raises(handler.MessageRejectedError) as raised:
                issues.deliver(review(workspace_id=value))
            stored = feedback.scan()['Items']
            logged = aggregates.scan()['Items']

        assert raised.value.errors[0].startswith('workspace_id')
        assert stored == []
        llm.assert_not_called()
        # Logged where a message of no trusted workspace can be: deployment-wide, without its text.
        (row,) = logged
        assert row['pk'] == 'LOGS#validation#webscraper'
        assert 'Late parcel' not in json.dumps(row, default=str)

    def test_is_counted(self):
        with world_with_logs(), patch.object(handler, 'metrics') as metrics, \
                pytest.raises(handler.MessageRejectedError):
            issues.deliver(review(workspace_id='ws_nope'))
        names = [call.kwargs['name'] for call in metrics.add_metric.call_args_list]
        assert 'WorkspaceMessagesRefused' in names


class TestLogRows:
    def test_a_failure_of_a_workspace_message_is_logged_under_the_workspace(self):
        with world_with_logs() as (_feedback, _llm, aggregates), \
                patch.object(handler, 'build_feedback_item', side_effect=RuntimeError('boom')):
            with pytest.raises(RuntimeError):
                issues.deliver(review(workspace_id=WS))
            (row,) = aggregates.scan()['Items']

        assert row['pk'] == f'WS#{WS}#LOGS#processing#webscraper'
        assert row['error_type'] == 'RuntimeError'

    def test_a_validation_failure_of_a_workspace_message_is_logged_under_the_workspace(self):
        with world_with_logs() as (_feedback, _llm, aggregates):
            with pytest.raises(handler.MessageRejectedError):
                issues.deliver(review(workspace_id=WS, text=''))
            (row,) = aggregates.scan()['Items']

        assert row['pk'] == f'WS#{WS}#LOGS#validation#webscraper'


class TestRadar:
    def test_a_stamped_workspace_message_is_refused_and_stored_nowhere(self):
        """Its own config named a Radar brand (``radar_brand_key``): Radar is not keyed by workspace."""
        radar = MagicMock()
        with world_with_logs() as (feedback, llm, _aggregates), ExitStack() as stack:
            stack.enter_context(patch.object(handler, 'radar_table', radar))
            metrics = stack.enter_context(patch.object(handler, 'metrics'))
            with pytest.raises(handler.WorkspaceRadarRefusedError):
                issues.deliver(review(workspace_id=WS, radar_brand_key='rival'))
            stored = feedback.scan()['Items']

        assert [call.kwargs['name'] for call in metrics.add_metric.call_args_list].count('WorkspaceRadarRefused') == 1
        assert stored == []
        assert radar.method_calls == []
        llm.assert_not_called()

    def test_a_workspace_message_under_a_radar_profiled_source_is_the_workspaces_own(self):
        """The deployment's source profile naming a Radar brand is the deployment's Radar setting: it claims no
        workspace's message, which is stored as the workspace's feedback, nothing written to voc-radar."""
        radar = MagicMock()
        with world_with_logs() as (feedback, _llm, _aggregates), ExitStack() as stack:
            stack.enter_context(patch.object(handler, 'radar_table', radar))
            profile = stack.enter_context(patch.object(handler, 'radar_brand_for', return_value='Example Rival'))
            result = issues.deliver(review(workspace_id=WS))
            (item,) = _items(feedback)

        assert result['status'] == 'success'
        assert item['pk'] == f'WS#{WS}#SOURCE#webscraper'
        assert radar.method_calls == []
        profile.assert_not_called()

    def test_deployment_wide_the_profile_still_claims_the_message(self):
        with world_with_logs() as (feedback, _llm, _aggregates), ExitStack() as stack:
            stack.enter_context(patch.object(handler, 'radar_brand_for', return_value='Example Rival'))
            claimed = stack.enter_context(patch.object(handler, 'process_radar_record',
                                                       return_value={'status': 'success', 'radar': True}))
            result = issues.deliver(review())
            stored = feedback.scan()['Items']

        assert result == {'status': 'success', 'radar': True}
        claimed.assert_called_once()
        assert stored == []


class TestTheLayerRefusesAMixedItem:
    def test_a_workspace_write_with_a_deployment_wide_partition_never_reaches_dynamodb(self):
        backing = MagicMock()
        item = {'pk': f'WS#{WS}#SOURCE#web', 'sk': 'FEEDBACK#f1', 'gsi4pk': 'FEEDBACK#f1', 'feedback_id': 'f1'}
        with patch.object(handler, 'feedback_table', backing), \
                pytest.raises(OutOfScopeError, match='gsi4pk outside the workspace'):
            handler.write_to_dynamodb(item, WorkspaceScope(WS))
        assert backing.method_calls == []

"""The runtime half of deployment isolation, for integrations_handler.py.

Synth-time prefixing is not sufficient: POST /sources/{source}/run and the
enable/disable routes address a PER-PLUGIN ingestor Lambda and schedule rule, and
this handler used to REBUILD those names from DEPLOY_ACCOUNT_ID/DEPLOY_REGION.
Under a deployment prefix that names resources which do not exist — the invoke
raises ResourceNotFoundException and the user experiences it as "the scraper runs
but pulls no reviews", with nothing pointing at naming.

So CDK hands down a resolved PATTERN and the handler substitutes {source}, the
same way scrapers_handler.py already receives WEBSCRAPER_FUNCTION_NAME. The
handler stays unaware that prefixes exist: it prefers a pattern when given one
and otherwise keeps its original derivation, which is what makes the no-prefix
template byte-identical (lib/app-baseline.test.ts).

The pattern strings themselves are pinned on the CDK side by
lib/app-deployment-prefix.test.ts, so the two halves cannot drift apart.
"""
import json
from unittest.mock import MagicMock, patch


class TestScheduleRuleNameUnderAPrefix:
    def test_uses_the_pattern_cdk_supplied(self):
        from integrations_handler import _build_rule_name
        with patch(
            'integrations_handler.INGEST_SCHEDULE_RULE_NAME_PATTERN',
            'stg-voc-ingest-{source}-schedule-123456789012-us-east-1',
        ):
            assert _build_rule_name('webscraper') == (
                'stg-voc-ingest-webscraper-schedule-123456789012-us-east-1'
            )

    def test_falls_back_to_its_own_derivation_when_no_pattern_is_set(self):
        # The unprefixed deployment gets no pattern, so this branch is the
        # default path and must keep producing exactly today's name.
        from integrations_handler import _build_rule_name
        with patch('integrations_handler.INGEST_SCHEDULE_RULE_NAME_PATTERN', ''), \
             patch('integrations_handler.AWS_ACCOUNT_ID', '123456789012'), \
             patch('integrations_handler.AWS_REGION', 'us-east-1'):
            assert _build_rule_name('webscraper') == (
                'voc-ingest-webscraper-schedule-123456789012-us-east-1'
            )


class TestIngestorFunctionNameUnderAPrefix:
    def test_uses_the_pattern_cdk_supplied(self):
        from integrations_handler import _build_ingestor_function_name
        with patch(
            'integrations_handler.INGESTOR_FUNCTION_NAME_PATTERN',
            'stg-voc-ingestor-{source}-123456789012-us-east-1',
        ):
            assert _build_ingestor_function_name('webscraper') == (
                'stg-voc-ingestor-webscraper-123456789012-us-east-1'
            )

    def test_falls_back_to_its_own_derivation_when_no_pattern_is_set(self):
        from integrations_handler import _build_ingestor_function_name
        with patch('integrations_handler.INGESTOR_FUNCTION_NAME_PATTERN', ''), \
             patch('integrations_handler.AWS_ACCOUNT_ID', '123456789012'), \
             patch('integrations_handler.AWS_REGION', 'us-east-1'):
            assert _build_ingestor_function_name('webscraper') == (
                'voc-ingestor-webscraper-123456789012-us-east-1'
            )


class TestManualRunInvokesThePrefixedIngestor:
    """The end-to-end shape of the bug: which function name reaches Lambda."""

    @patch('shared.tables.get_aggregates_table')
    @patch('boto3.client')
    def test_invokes_the_prefixed_function_name(
        self, mock_boto_client, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_get_table.return_value = MagicMock()
        mock_lambda = MagicMock()
        mock_lambda.invoke.return_value = {'StatusCode': 202}
        mock_boto_client.return_value = mock_lambda

        with patch(
            'integrations_handler.INGESTOR_FUNCTION_NAME_PATTERN',
            'stg-voc-ingestor-{source}-123456789012-us-east-1',
        ):
            from integrations_handler import lambda_handler
            event = api_gateway_event(
                method='POST',
                path='/sources/webscraper/run',
                path_params={'source': 'webscraper'},
            )
            response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['success'] is True
        invoked = mock_lambda.invoke.call_args.kwargs['FunctionName']
        assert invoked == 'stg-voc-ingestor-webscraper-123456789012-us-east-1'

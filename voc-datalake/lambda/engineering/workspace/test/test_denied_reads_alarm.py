"""The alarm on the engineering workspace's denied reads (shared/ops_alerts.py), created at runtime like every alert
only once an administrator turns alerting on: present only with the engineering module (CDK sets its services), and
watching the metric the workspace store emits, in the namespace the shared metrics write to."""
from __future__ import annotations

from typing import Any

from engineering.workspace import store
from shared import ops_alerts
from shared.logging import metrics

PREFIX = 'voc-alerts-123456789012-us-east-1'
TOPIC = 'arn:aws:sns:us-east-1:123456789012:voc-ops-alarms-123456789012-us-east-1'
BASE = {'OPS_ALERTS_TOPIC_ARN': TOPIC, 'OPS_ALERTS_ALARM_PREFIX': PREFIX}
SERVICES = 'voc-agents-api,voc-engineering-board,voc-engineering-reports'


def _alarms(env: dict[str, str]) -> dict[str, dict[str, Any]]:
    targets = ops_alerts.load_targets(env)
    assert targets is not None
    return {d['AlarmName'].removeprefix(f'{PREFIX}-'): d for d in ops_alerts.alarm_definitions(targets)}


def test_no_alarm_without_the_engineering_services() -> None:
    assert 'engineering-denied-reads' not in _alarms(BASE)


def test_one_alarm_sums_the_store_metric_over_each_reader_service() -> None:
    alarm = _alarms({**BASE, 'OPS_ALERTS_ENGINEERING_SERVICES': SERVICES})['engineering-denied-reads']
    stats = [metric['MetricStat'] for metric in alarm['Metrics'] if 'MetricStat' in metric]
    assert {(stat['Metric']['Namespace'], stat['Metric']['MetricName']) for stat in stats} == {
        (metrics.namespace, store.ENGINEERING_DENIED_READS_METRIC)}
    assert [stat['Metric']['Dimensions'] for stat in stats] == [
        [{'Name': 'service', 'Value': service}] for service in SERVICES.split(',')]
    assert (alarm['Metrics'][-1]['Expression'], alarm['Threshold'], alarm['AlarmActions'],
            alarm['TreatMissingData']) == ('SUM([m0,m1,m2])', ops_alerts.ENGINEERING_DENIED_READS_THRESHOLD, [TOPIC],
                                           'notBreaching')
    assert ops_alerts.billed_metric_count([alarm]) == 3

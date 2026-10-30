"""shared/system_logs.py + shared/system_log_groups.py: the `GET /logs/system` search."""
from __future__ import annotations

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from shared.exceptions import ConfigurationError, ValidationError
from shared.system_log_groups import MAX_GROUPS, MAX_MESSAGE_CHARS, MAX_SAMPLE_CHARS, LogLine, group_lines, normalize
from shared.system_logs import (
    FAILED_MESSAGE,
    GROUPS_PER_QUERY,
    POLL_INTERVAL_SECONDS,
    POLL_INTERVALS_SECONDS,
    ROW_LIMIT,
    SearchRequest,
    parse_level,
    parse_query_ids,
    query_string,
    search,
)
from shared.test.system_logs_fake import PATTERN, FakeLogs, group, row

NOW = 1_800_000_000.0
QUERY_ID = '0b6a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'


@pytest.fixture(autouse=True)
def _pattern(monkeypatch):
    monkeypatch.setenv('SYSTEM_LOG_GROUP_PATTERN', PATTERN)


def _run(fake: FakeLogs, *, days: int = 1, level: str = 'error', query_ids: tuple[str, ...] = (),
         budget: float = 0.0) -> dict:
    ticks = iter(range(10_000))
    return search(fake, SearchRequest(days, level, query_ids), now=NOW, budget=budget,
                  sleep=lambda _s: None, clock=lambda: float(next(ticks)))


class TestParams:
    def test_level_defaults_to_error_and_accepts_warning(self):
        assert (parse_level(None), parse_level(''), parse_level('warning')) == ('error', 'error', 'warning')

    def test_unknown_level_is_a_400(self):
        with pytest.raises(ValidationError):
            parse_level('debug')

    def test_query_ids_are_split_and_checked(self):
        assert parse_query_ids(f'{QUERY_ID},{QUERY_ID}') == (QUERY_ID, QUERY_ID)
        assert parse_query_ids(None) == ()

    @pytest.mark.parametrize('value', ['not-an-id', f'{QUERY_ID};drop', ','.join([QUERY_ID] * 7), QUERY_ID.upper()])
    def test_bad_query_ids_are_a_400(self, value):
        with pytest.raises(ValidationError):
            parse_query_ids(value)

    def test_unconfigured_pattern_is_a_configuration_error(self, monkeypatch):
        monkeypatch.delenv('SYSTEM_LOG_GROUP_PATTERN')
        with pytest.raises(ConfigurationError):
            _run(FakeLogs([]))

    def test_query_filters_levels_and_platform_lines_and_warning_adds_warn(self):
        error, warning = query_string('error'), query_string('warning')
        assert error.startswith('filter not ispresent(test_run) | ')  # e2e test invocations are left out
        assert 'level in ["ERROR", "CRITICAL", "FATAL"]' in error
        assert 'Task timed out' in error
        assert '\\tERROR\\t' in error
        assert 'WARNING' not in error
        assert '\\tWARN\\t' not in error
        # The TypeScript stream Lambda's JSON lines say `WARN` / `FATAL`, Powertools says `WARNING` / `CRITICAL`.
        assert 'level in ["ERROR", "CRITICAL", "WARNING", "FATAL", "WARN"]' in warning
        assert '\\tWARN\\t' in warning
        assert f'limit {ROW_LIMIT}' in error


class TestDiscoveryAndQueries:
    def test_keeps_only_this_deployments_groups_and_batches_by_50(self):
        mine = [group(f'fn-{i:03d}') for i in range(GROUPS_PER_QUERY + 4)]
        other_region = '/aws/lambda/voc-x-123456789012-eu-west-1'
        prefixed = group('x', prefix='p1-')
        fake = FakeLogs([*mine, other_region, prefixed])
        body = _run(fake, days=7)
        assert fake.prefixes == ['/aws/lambda/voc-']
        assert body['log_groups'] == len(mine)
        assert sorted(len(q['logGroupNames']) for q in fake.started) == [4, GROUPS_PER_QUERY]  # started concurrently
        searched = {name for q in fake.started for name in q['logGroupNames']}
        assert searched == set(mine)
        assert {(q['startTime'], q['endTime']) for q in fake.started} == {(int(NOW) - 7 * 86400, int(NOW))}

    def test_no_log_groups_is_an_empty_complete_answer_without_a_query(self):
        fake = FakeLogs([])
        assert _run(fake) == {'days': 1, 'level': 'error', 'log_groups': 0, 'status': 'complete',
                              'log_groups_by_source': {'lambda': 0, 'workflow': 0, 'api': 0},
                              'truncated': False, 'count': 0, 'groups': []}
        assert fake.started == []

    def test_a_slow_query_answers_running_with_its_ids(self):
        fake = FakeLogs([group('a')], statuses=['Running'])
        body = _run(fake)
        assert body['status'] == 'running'
        assert body['query_id'] == fake.started[0]['queryId']
        assert 'groups' not in body

    def test_polls_within_the_budget_until_complete(self):
        fake = FakeLogs([group('a')], rows=[row('a', '2026-10-27 08:00:00.000', level='ERROR', message='boom')],
                        statuses=['Scheduled', 'Running', 'Complete'])
        body = _run(fake, budget=10.0)
        assert body['status'] == 'complete'
        assert body['count'] == 1

    def test_a_poll_with_query_ids_reads_them_and_starts_nothing(self):
        fake = FakeLogs([group('a')], rows=[row('a', '2026-10-27 08:00:00.000', level='ERROR', message='boom')])
        body = _run(fake, query_ids=(QUERY_ID,))
        assert fake.started == []
        assert fake.polls == {QUERY_ID: 1}
        assert body['status'] == 'complete'
        assert body['groups'][0]['message'] == 'boom'

    @pytest.mark.parametrize('status', ['Failed', 'Cancelled', 'Timeout'])
    def test_a_failed_query_is_failed_and_stops_the_others(self, status):
        fake = FakeLogs([group('a')], statuses=[status])
        body = _run(fake)
        assert body['status'] == 'failed'
        assert body['message'] == FAILED_MESSAGE
        assert fake.stopped == [fake.started[0]['queryId']]

    def test_an_aws_error_is_failed_without_its_text(self):
        fake = FakeLogs([group('a')])
        fake.fail_start = True
        body = _run(fake)
        assert body == {'days': 1, 'level': 'error', 'log_groups': 1, 'status': 'failed', 'message': FAILED_MESSAGE,
                        'log_groups_by_source': {'lambda': 1, 'workflow': 0, 'api': 0}}
        assert 'secret detail' not in str(body)

    def test_hitting_the_row_cap_is_truncated(self):
        rows = [row('a', '2026-10-27 08:00:00.000', level='ERROR', message='same')] * ROW_LIMIT
        assert _run(FakeLogs([group('a')], rows=rows))['truncated'] is True


class _PerQueryLogs(FakeLogs):
    """Each started query answers its own status sequence (by start order); one batch can refuse to start."""

    def __init__(self, names: list[str], sequences: list[list[str]], refuse: str = '') -> None:
        super().__init__(names)
        self.sequences = sequences
        self.refuse = refuse

    def start_query(self, **kwargs):
        if self.refuse in kwargs['logGroupNames']:
            raise ClientError({'Error': {'Code': 'LimitExceededException', 'Message': 'x'}}, 'StartQuery')
        return super().start_query(**kwargs)

    def get_query_results(self, *, queryId: str) -> dict:
        count = self.polls[queryId]
        self.polls[queryId] = count + 1
        index = sorted(self.started, key=lambda q: q['logGroupNames'][0]).index(
            next(q for q in self.started if q['queryId'] == queryId))
        sequence = self.sequences[index]
        return {'status': sequence[min(count, len(sequence) - 1)], 'results': []}


class TestPolling:
    TWO_BATCHES: tuple[str, ...] = tuple(group(f'fn-{i:03d}') for i in range(GROUPS_PER_QUERY + 1))

    def test_a_finished_query_is_not_read_again_while_another_runs(self):
        fake = _PerQueryLogs(list(self.TWO_BATCHES), [['Complete'], ['Running', 'Running', 'Complete']])
        body = _run(fake, budget=10.0)
        assert body['status'] == 'complete'
        first, second = sorted(fake.started, key=lambda q: q['logGroupNames'][0])
        assert (fake.polls[first['queryId']], fake.polls[second['queryId']]) == (1, 3)

    def test_the_first_waits_are_short_then_one_second(self):
        waits: list[float] = []
        fake = FakeLogs([group('a')], statuses=['Running', 'Running', 'Running', 'Running', 'Complete'])
        ticks = iter(range(10_000))
        body = search(fake, SearchRequest(1, 'error', ()), now=NOW, budget=30.0, sleep=waits.append,
                      clock=lambda: float(next(ticks)))
        assert body['status'] == 'complete'
        assert waits == [*POLL_INTERVALS_SECONDS, POLL_INTERVAL_SECONDS, POLL_INTERVAL_SECONDS]

    def test_a_query_that_cannot_start_stops_the_ones_that_did(self):
        fake = _PerQueryLogs(list(self.TWO_BATCHES), [['Complete']], refuse=self.TWO_BATCHES[-1])
        body = _run(fake)
        assert body['status'] == 'failed'
        assert [q['logGroupNames'][0] for q in fake.started] == [self.TWO_BATCHES[0]]
        assert fake.stopped == [fake.started[0]['queryId']]

    @pytest.mark.parametrize('operation', ['get_query_results', 'get_paginator'])
    @pytest.mark.parametrize('error', [
        ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'secret detail'}}, 'Op'),
        EndpointConnectionError(endpoint_url='https://logs.secret-detail.example'),
    ], ids=['ClientError', 'BotoCoreError'])
    def test_a_throttled_read_or_listing_inside_the_concurrent_calls_is_failed_without_its_text(
            self, operation, error, monkeypatch):
        # ordered_map re-raises the worker's own exception, so search() still answers its fixed message.
        fake = FakeLogs(list(self.TWO_BATCHES))

        def broken(*_args, **_kwargs):
            raise error
        monkeypatch.setattr(fake, operation, broken)
        body = _run(fake, budget=10.0)
        assert (body['status'], body['message']) == ('failed', FAILED_MESSAGE)
        assert 'secret' not in str(body)
        # A failed read stops every query the search started (a failed listing starts none).
        assert sorted(fake.stopped) == sorted(q['queryId'] for q in fake.started)


def _groups(rows: list, level: str = 'error') -> list[dict]:
    return _run(FakeLogs([group('projects-assist'), group('chat-stream'), group('ingestor-app_reviews')], rows=rows),
                level=level)['groups']


class TestGrouping:
    def test_groups_by_function_level_and_normalized_message_newest_first(self):
        groups = _groups([
            row('projects-assist', '2026-10-27 09:01:02.456', level='ERROR', function_request_id='req-new',
                message='[PERSONA_AVATAR] FAILED - project 4f3c2a1b9d8e7f60 took 812 ms',
                exception='Traceback: AccessDeniedException'),
            row('projects-assist', '2026-10-27 08:44:43.123', level='ERROR', function_request_id='req-old',
                message='[PERSONA_AVATAR] FAILED - project 0a1b2c3d4e5f6a7b took 90 ms'),
            row('projects-assist', '2026-10-27 08:50:00.000', level='CRITICAL', message='[PERSONA_AVATAR] FAILED'),
            row('chat-stream', '2026-10-27 09:30:00.000', level='ERROR', message='other'),
        ])
        assert [(g['function'], g['level'], g['count']) for g in groups] == [
            ('chat-stream', 'ERROR', 1), ('projects-assist', 'ERROR', 2), ('projects-assist', 'CRITICAL', 1)]
        avatar = groups[1]
        assert avatar['message'] == '[PERSONA_AVATAR] FAILED - project <hex> took <n> ms'
        assert (avatar['first_seen'], avatar['last_seen']) == ('2026-10-27T08:44:43.123Z', '2026-10-27T09:01:02.456Z')
        assert avatar['request_id'] == 'req-new'
        assert avatar['sample'] == ('[PERSONA_AVATAR] FAILED - project 4f3c2a1b9d8e7f60 took 812 ms\n'
                                    'Traceback: AccessDeniedException')

    def test_warning_lines_only_with_level_warning(self):
        rows = [row('ingestor-app_reviews', '2026-10-27 08:00:00.000', level='WARNING', message='App Store 429'),
                row('ingestor-app_reviews', '2026-10-27 08:00:01.000', level='INFO', message='Status: error seen')]
        assert _groups(rows) == []
        assert [(g['level'], g['message']) for g in _groups(rows, level='warning')] == [('WARNING', 'App Store <n>')]

    def test_platform_lines_without_a_level(self):
        groups = _groups([
            row('projects-assist', '2026-10-27 08:00:00.000', '2026-10-27T08:00:00.000Z 1b2c3d4e-0000-4000-8000-'
                '000000000001 Task timed out after 900.00 seconds', **{'@requestId': 'req-t'}),
            row('projects-assist', '2026-10-27 08:00:01.000', 'REPORT RequestId: 1b2c3d4e-0000-4000-8000-000000000001'
                '\tDuration: 900000.00 ms\tStatus: timeout'),
            row('chat-stream', '2026-10-27 08:00:02.000', '[ERROR] Runtime.ImportModuleError: no module'),
        ])
        assert {g['level'] for g in groups} == {'PLATFORM'}
        messages = {g['message'] for g in groups}
        assert '<time> <id> Task timed out after <n> seconds' in messages
        assert 'REPORT: invocation ended with Status: timeout' in messages
        assert 'Runtime.ImportModuleError: no module' in messages
        timed_out = next(g for g in groups if 'Task timed out' in g['message'])
        assert timed_out['request_id'] == 'req-t'

    def test_node_text_lines_and_raw_json_lines(self):
        groups = _groups([
            row('chat-stream', '2026-10-27 08:00:00.000',
                '2026-10-27T08:00:00.000Z\t1b2c3d4e-0000-4000-8000-000000000001\tERROR\tAssistant run failed: X'),
            row('chat-stream', '2026-10-27 08:00:01.000',
                '2026-10-27T08:00:01.000Z\t1b2c3d4e-0000-4000-8000-000000000002\tINFO\tfine'),
            row('chat-stream', '2026-10-27 08:00:02.000', '{"level": "ERROR", "message": "json boom"}'),
        ])
        assert sorted((g['level'], g['message']) for g in groups) == [
            ('ERROR', 'Assistant run failed: X'), ('ERROR', 'json boom')]

    def test_every_text_is_redacted_and_truncated(self):
        long_tail = 'x' * (MAX_SAMPLE_CHARS + 50)
        groups = _groups([row('projects-assist', '2026-10-27 08:00:00.000', level='ERROR',
                              message=f'Invite to jane.doe@example.com failed {long_tail}')])
        assert 'jane.doe@example.com' not in str(groups)
        assert len(groups[0]['message']) == MAX_MESSAGE_CHARS
        assert len(groups[0]['sample']) == MAX_SAMPLE_CHARS

    def test_rows_of_a_foreign_log_group_are_dropped(self):
        foreign = row('a', '2026-10-27 08:00:00.000', level='ERROR', message='not ours')
        foreign[1] = {'field': '@log', 'value': '123456789012:/aws/lambda/someone-else'}
        assert _groups([foreign]) == []

    def test_at_most_max_groups(self):
        rows = [row('chat-stream', f'2026-10-27 08:00:{i % 60:02d}.000', level='ERROR', message=f'kind {chr(65 + i % 26)}'
                    f'{chr(65 + i // 26 % 26)}') for i in range(MAX_GROUPS + 30)]
        assert len(_groups(rows)) == MAX_GROUPS


class TestApiGrouping:
    def test_api_rows_keep_their_status_so_403_and_500_are_separate_groups(self):
        def api_line(status: str, at: str) -> LogLine:
            return LogLine(function='api', level='WARNING', text=f'POST /v1/scrapers/{{id}} → {status} integration {status}',
                           sample='', timestamp=at, request_id=None, source='api')
        groups = group_lines([api_line('403', '2026-10-27T08:00:00Z'), api_line('500', '2026-10-27T09:00:00Z'),
                              api_line('403', '2026-10-27T10:00:00Z')])
        assert [(g['message'], g['count']) for g in groups] == [
            ('POST /v1/scrapers/{id} → 403 integration 403', 2),
            ('POST /v1/scrapers/{id} → 500 integration 500', 1),
        ]


class TestNormalize:
    @pytest.mark.parametrize(('text', 'expected'), [
        ('at 2026-10-27T08:44:43.123Z ok', 'at <time> ok'),
        ('id 0b6a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', 'id <id>'),
        ("key 'reviews/a.json' and \"b\"", 'key <value> and <value>'),
        ('voc2 has 3 items  of 4.5', 'voc2 has <n> items of <n>'),
        ('deadbeef12 vs deadbeef', '<hex> vs deadbeef'),  # all-letter hex is a word, not an id
        ('failed for job=job_80cbfb058cf7408f', 'failed for job=job_<hex>'),  # `_` separates: one group per message
        ('abc80cbfb058cf7408fx', 'abc80cbfb058cf7408fx'),  # hex glued inside a word stays
    ])
    def test_placeholders(self, text, expected):
        assert normalize(text) == expected

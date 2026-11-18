"""The readiness ports on the Agents API's clients (engineering/readiness_aws.py): what each reads, and that every
failed call is ``ReadFailed`` (a check's ``unknown``), never a pass."""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from engineering.readiness import ReadFailed
from engineering.readiness_aws import (
    ISSUES_WATERMARK_PREFIX,
    PROBE_KEY,
    SESSIONS_QUOTA_CODE,
    AwsReadinessPorts,
    agent_subject,
    settings_from_environment,
    template_subject,
)


def refused(code: str, operation: str = 'Call') -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': code}}, operation)


@dataclass
class Table:
    """A boto3 Table's get_item and query, answering ``items`` by key (``error``: raised instead)."""

    items: dict[str, dict[str, Any]] = field(default_factory=dict)
    error: Exception | None = None
    asked: list[dict[str, Any]] = field(default_factory=list)

    def get_item(self, **request: Any) -> dict[str, Any]:
        self.asked.append(request)
        if self.error is not None:
            raise self.error
        key = '#'.join(str(value) for value in request['Key'].values())
        return {'Item': self.items[key]} if key in self.items else {}

    def query(self, **request: Any) -> dict[str, Any]:
        self.asked.append(request)
        if self.error is not None:
            raise self.error
        return {'Items': list(self.items.values())[:1]}


@dataclass
class S3:
    """put_object's answers in turn (an exception is raised)."""

    answers: list[Any] = field(default_factory=list)
    puts: list[dict[str, Any]] = field(default_factory=list)

    def put_object(self, **request: Any) -> dict[str, Any]:
        self.puts.append(request)
        answer = self.answers.pop(0) if self.answers else {}
        if isinstance(answer, Exception):
            raise answer
        return answer


@dataclass
class Quotas:
    answer: Any = field(default_factory=lambda: {'Quota': {'Value': 5000.0}})
    asked: list[dict[str, Any]] = field(default_factory=list)

    def get_service_quota(self, **request: Any) -> dict[str, Any]:
        self.asked.append(request)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


@dataclass
class Bedrock:
    """get_foundation_model_availability's answers by foundation model id (an exception is raised)."""

    answers: dict[str, Any] = field(default_factory=dict)
    asked: list[str] = field(default_factory=list)

    def get_foundation_model_availability(self, *, modelId: str) -> dict[str, Any]:
        self.asked.append(modelId)
        answer = self.answers[modelId]
        if isinstance(answer, Exception):
            raise answer
        return answer


def ports(*, agents: Table | None = None, s3: S3 | None = None, quotas: Quotas | None = None,
          inspect: Callable[[dict[str, Any]], dict[str, Any]] | None = None, watermarks: Table | None = None,
          engineering: Table | None = None, client: Any = None, bedrock: Bedrock | None = None,
          clock: Callable[[], float] | None = None) -> AwsReadinessPorts:
    quota, control = quotas or Quotas(), bedrock or Bedrock()
    return AwsReadinessPorts(agents=agents or Table(), aggregates=Table(), engineering=engineering or Table(),
                             engineering_client=client, engineering_table='voc-engineering', s3=s3 or S3(),
                             workspace_bucket='voc-eng-workspace', quotas=lambda: quota, bedrock=lambda: control,
                             inspect=inspect or (lambda _request: {}), watermarks=watermarks,
                             clock=clock or time.monotonic)


AVAILABLE = {'regionAvailability': 'AVAILABLE', 'authorizationStatus': 'AUTHORIZED',
             'entitlementAvailability': 'AVAILABLE', 'agreementAvailability': {'status': 'AVAILABLE'}}


@dataclass
class Rows:
    """A low-level client's get_item of voc-engineering: ``items`` by (pk, sk); ``error`` raised instead."""

    items: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    error: Exception | None = None

    def get_item(self, *, TableName: str, Key: dict[str, Any], ConsistentRead: bool) -> dict[str, Any]:
        assert (TableName, ConsistentRead) == ('voc-engineering', True)
        if self.error is not None:
            raise self.error
        found = self.items.get((Key['pk']['S'], Key['sk']['S']))
        return {} if found is None else {'Item': found}


def test_the_sessions_walls_are_the_runtimes_record_of_the_language_or_none_yet() -> None:
    from engineering.readiness import SandboxSeen
    rows = Rows()
    assert ports(client=rows).sandbox_walls('python') is None
    rows.items[('WS#default#SANDBOX', 'LANG#python')] = {
        'egress': {'S': 'namespaces'}, 'code': {'S': 'namespaces'},
        'hardlink_guard': {'L': [{'S': 'own_device'}, {'S': 'protected_hardlinks'}]}, 'at': {'S': '2026-11-17T12:00:00Z'}}
    assert ports(client=rows).sandbox_walls('python') == SandboxSeen(
        'namespaces', 'namespaces', ('own_device', 'protected_hardlinks'), '2026-11-17T12:00:00Z')
    with pytest.raises(ReadFailed, match='walls: ThrottlingException'):
        ports(client=Rows(error=refused('ThrottlingException', 'GetItem'))).sandbox_walls('python')
    with pytest.raises(ReadFailed, match='not a language'):
        ports(client=rows).sandbox_walls('py thon')


def test_each_models_access_is_read_by_its_foundation_id_within_a_budget() -> None:
    bedrock = Bedrock({'anthropic.claude-sonnet-5-5': AVAILABLE,
                       'anthropic.claude-opus-5-5': {**AVAILABLE, 'authorizationStatus': 'NOT_AUTHORIZED'},
                       'anthropic.claude-haiku-5-5': refused('ThrottlingException')})
    found = ports(bedrock=bedrock).models_access(
        ['global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-opus-5-5', 'global.anthropic.claude-haiku-5-5'])
    assert found == {'global.anthropic.claude-sonnet-5-5': 'available', 'global.anthropic.claude-opus-5-5': 'no_access'}
    assert bedrock.asked == ['anthropic.claude-sonnet-5-5', 'anthropic.claude-opus-5-5', 'anthropic.claude-haiku-5-5']
    # Past the budget nothing more is read: the rest is left out (unknown).
    ticks = iter([0.0, 0.0, 11.0, 11.0])
    late = Bedrock({'anthropic.claude-sonnet-5-5': AVAILABLE})
    assert ports(bedrock=late, clock=lambda: next(ticks)).models_access(
        ['global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-opus-5-5']) == {
        'global.anthropic.claude-sonnet-5-5': 'available'}


def test_the_probe_passes_when_the_bucket_refuses_a_put_without_if_none_match() -> None:
    s3 = S3([refused('PreconditionFailed'), refused('AccessDenied')])
    assert ports(s3=s3).probe_storage() is True
    assert [put['Key'] for put in s3.puts] == [PROBE_KEY, PROBE_KEY]
    assert s3.puts[0]['IfNoneMatch'] == '*'
    assert 'IfNoneMatch' not in s3.puts[1]
    # The first probe of a deployment writes the object; the bucket still refuses the second put.
    assert ports(s3=S3([{}, refused('AccessDenied')])).probe_storage() is True
    # A bucket that takes a put without If-None-Match is not create-only.
    assert ports(s3=S3([{}, {}])).probe_storage() is False
    with pytest.raises(ReadFailed, match='NoSuchBucket'):
        ports(s3=S3([refused('NoSuchBucket')])).probe_storage()
    with pytest.raises(ReadFailed):
        ports(s3=S3([{}, EndpointConnectionError(endpoint_url='https://s3')])).probe_storage()


def test_the_sessions_quota_is_agentcores_one_quota() -> None:
    quotas = Quotas()
    assert ports(quotas=quotas).session_quota() == 5000.0
    assert quotas.asked == [{'ServiceCode': 'bedrock-agentcore', 'QuotaCode': SESSIONS_QUOTA_CODE}]
    with pytest.raises(ReadFailed, match='AccessDenied'):
        ports(quotas=Quotas(refused('AccessDenied'))).session_quota()
    with pytest.raises(ReadFailed):
        ports(quotas=Quotas({'Quota': {}})).session_quota()


def test_the_issues_source_reads_the_repositorys_watermark() -> None:
    watermarks = Table({f'{ISSUES_WATERMARK_PREFIX}example-org/shop': {'source': 'x'}})
    assert ports(watermarks=watermarks).issues_source_reads('example-org/shop') is True
    assert ports(watermarks=watermarks).issues_source_reads('example-org/other') is False
    with pytest.raises(ReadFailed):
        ports(watermarks=Table(error=refused('AccessDenied'))).issues_source_reads('example-org/shop')
    with pytest.raises(ReadFailed, match='no watermarks table'):
        ports().issues_source_reads('example-org/shop')


def test_an_installation_is_read_only_for_a_connection_through_a_deployments_app() -> None:
    from engineering.connectors.connections import ConnectionRefused
    asked: list[dict[str, Any]] = []

    def inspect(request: dict[str, Any]) -> dict[str, Any]:
        asked.append(request)
        return {'repositories': [{'repository': 'example-org/shop'}], 'truncated': False}

    row = {'credential_kind': 'app_reference', 'app_id': '123', 'installation_id': '456'}
    assert ports(inspect=inspect).installation_repositories(row) == (frozenset({'example-org/shop'}), False)
    assert asked == [{'action': 'inspect_installation', 'app_id': '123', 'installation_id': 456}]
    assert ports(inspect=inspect).installation_repositories({**row, 'credential_kind': 'app'}) is None

    def conflict(_request: dict[str, Any]) -> dict[str, Any]:
        raise ConnectionRefused('conflict', 'suspended')

    def busy(_request: dict[str, Any]) -> dict[str, Any]:
        raise ConnectionRefused('unavailable', 'try again')

    assert ports(inspect=conflict).installation_repositories(row) == (frozenset(), False)
    with pytest.raises(ReadFailed):
        ports(inspect=busy).installation_repositories(row)


def test_the_attestation_hard_cap_and_spend_reads_fail_as_read_failed() -> None:
    broken = Table(error=refused('ProvisionedThroughputExceededException'))
    for read in (lambda p: p.attested('shop', 'example-org/shop'), lambda p: p.hard_cap_on(),
                 lambda p: p.month_spend_usd('wf_1')):
        with pytest.raises(ReadFailed):
            read(ports(agents=broken, engineering=broken))
    attested = Table({'x': {'state': 'attested', 'repository': 'example-org/shop', 'version': 2}})
    assert ports(agents=attested).attested('shop', 'example-org/shop') is True
    assert ports(agents=attested).attested('shop', 'example-org/other') is False
    spent = Table({'WS#default#SPEND#2026-11#FLOW#wf_1': {'usd': Decimal('7.5')}})
    from datetime import UTC, datetime
    fixed = AwsReadinessPorts(**{**ports(engineering=spent).__dict__,
                                 'now': lambda: datetime(2026, 11, 16, tzinfo=UTC)})
    assert fixed.month_spend_usd('wf_1') == Decimal('7.5')


@dataclass
class ItemClient:
    """The engineering table's low-level client for one row's reads: every GetItem answers ``item``, each recorded."""

    item: dict[str, Any]
    asked: list[dict[str, Any]] = field(default_factory=list)

    def get_item(self, **request: Any) -> dict[str, Any]:
        self.asked.append(request)
        return {'Item': self.item}


def test_the_knowledge_pack_counter_is_read_by_its_key() -> None:
    client = ItemClient({'approved_version': {'N': '4'}})
    assert ports(client=client).knowledge_approved('shop') == 4
    assert client.asked[0]['Key'] == {'pk': {'S': 'WS#default#REPO#shop'}, 'sk': {'S': 'KPACK#=2E'}}
    assert ports(client=client).knowledge_approved('not a connection') == 0


def test_the_accepted_tenets_and_the_docs_rendering_are_read_by_their_keys() -> None:
    client = ItemClient({'accepted_version': {'N': '2'}, 'version': {'N': '5'}})
    assert ports(client=client).tenets_accepted('shop') == 2
    assert ports(client=client).knowledge_rendering('shop') == 5
    assert [ask['Key']['sk']['S'] for ask in client.asked] == ['TENETS', 'KDOCS']
    assert {ask['Key']['pk']['S'] for ask in client.asked} == {'WS#default#REPO#shop'}
    assert ports(client=client).tenets_accepted('not a connection') == 0


def test_the_settings_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('ENGINEERING_IMAGE_LANGUAGES', 'python,node')
    monkeypatch.setenv('ENGINEERING_AGENT_NETWORK', 'vpc')
    monkeypatch.setenv('ENGINEERING_BUILD_MEMORY_MIB', '8192')
    monkeypatch.setenv('ENGINEERING_MAX_SESSIONS', '200')
    settings = settings_from_environment({'fixer': 'm'}, 'us-west-2')
    assert (settings.image_languages, settings.network, settings.build_memory_mib, settings.max_sessions,
            settings.region) == (frozenset({'python', 'node'}), True, 8192, 200, 'us-west-2')
    monkeypatch.setenv('ENGINEERING_AGENT_NETWORK', 'none')
    monkeypatch.delenv('ENGINEERING_MAX_SESSIONS')
    settings = settings_from_environment({}, 'us-east-1')
    assert (settings.network, settings.max_sessions) == (False, 5000)


def test_an_agents_subject_follows_its_enabler_and_a_templates_the_asker() -> None:
    agent = {'agent_id': 'agent_1', 'name': 'Bug fixer', 'enabled': True, 'owner_sub': 'enabler',
             'owner_username': 'erin', 'engineering': {'connection': 'shop', 'language': 'python'},
             'triggers': [{'kind': 'new_reviews'}, {'kind': 'github_issue', 'label': 'voc-agent'}]}
    workflow = {'workflow_id': 'wf_1', 'definition': '{"schema": "voc-workflow/2", "budget": {"monthly_usd": 50}, '
                                                     '"nodes": [{"id": "c", "type": "agent", '
                                                     '"data": {"params": {"role": "committer"}}}]}'}
    subject = agent_subject(agent, workflow, 'asker', 'alice')
    assert (subject.person, subject.person_name, subject.connection, subject.workflow_id, subject.budget_usd) == (
        'enabler', 'erin', 'shop', 'wf_1', Decimal(50))
    assert subject.trigger == {'kind': 'github_issue', 'label': 'voc-agent'}
    assert subject.requires['ci_attestation'] is True   # (it pushes)
    disabled = agent_subject({**agent, 'enabled': False}, workflow, 'asker', 'alice')
    assert (disabled.person, disabled.person_name) == ('asker', 'alice')
    template = {'template_id': 'issue-triage', 'name': 'Issue triage', 'budget': {'monthly_usd': 50},
                'requires': {'dial': ['human_driven'], 'issues_source': True}, 'definition': {'nodes': []}}
    flow = template_subject(template, 'asker', 'alice')
    assert (flow.kind, flow.person, flow.person_name, flow.budget_usd, flow.requires) == (
        'flow', 'asker', 'alice', Decimal(50), {'dial': ['human_driven'], 'issues_source': True})
    assert (flow.connection, flow.language) == ('', '')   # (readiness.preview names them)


def test_the_issues_source_lists_a_repository_as_the_settings_function_answers() -> None:
    """7.50.02: the source's settings come from voc-engineering-issues-config (``status``), never the secret here."""
    from engineering.connectors.issues_sync import IssuesFollow
    from engineering.connectors.test.issues_fakes import FakeConfigFunction, FakeEvents, FakeSecrets

    secrets = FakeSecrets({'github_issues_repos': 'example-org/shop', 'github_issues_github_app_id': '4242'})
    config = FakeConfigFunction(secrets, FakeEvents())
    found = AwsReadinessPorts(**{**vars(ports()), 'issues': IssuesFollow(config, None, lambda _request: {})})
    assert found.issues_source_lists('example-org/shop') is True
    assert found.issues_source_lists('example-org/other') is False
    assert [request['action'] for request in config.requests] == ['status', 'status']
    assert ports().issues_source_lists('example-org/shop') is None   # (not deployed here)
    secrets.fail = True
    with pytest.raises(ReadFailed):
        found.issues_source_lists('example-org/shop')

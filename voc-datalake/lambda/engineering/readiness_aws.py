"""The readiness checks' ports on the Agents API's own clients (``GET /agents/engineering/readiness``, Enable's 409).

Only reads the Agents API's role already makes, and three of its own (``grantEngineeringReadiness`` in
lib/stacks/api-engineering-readiness.ts): ``bedrock:GetFoundationModelAvailability`` (the models' access, mapped by
``shared.model_access``), ``servicequotas:GetServiceQuota`` (AgentCore's active sessions quota) and GetItem of the
deployment-wide Issues source's repository watermarks (``github_issues#repo#*`` in voc-watermarks); and one write, the
workspace bucket's create-only probe (``PROBE_KEY``: one object, ever, since every later put of it is refused by its
own If-None-Match, which is the answer the probe wants). Since 7.50.02 the Issues source's settings too (as
voc-engineering-issues-config answers them: connectors/issues_sync.py ``status``, never a secret) and each
connection's label row in voc-agents. The sessions' walls (7.50.03) are one GetItem of voc-engineering's
``WS#default#SANDBOX`` row of the language, which the runtime writes. Every failed call raises ``ReadFailed``, which
the check answers ``unknown``; nothing here raises anything else of AWS's.
"""
from __future__ import annotations

import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from engineering.readiness import ReadFailed, SandboxSeen, Settings, Subject, flow_requires
from engineering.runtime.harness.kiro_pin import KIRO_CLI_VERSION
from engineering.runtime.harness_switch import HARNESS_ENV, KEY_PARAMETER_ENV, kiro_roles
from engineering.runtime.interface import RuntimeRefused

#: AgentCore Runtime's "Active Session Workloads per Account" (its service code is bedrock-agentcore; 5,000 in
#: us-east-1 and us-west-2, read 2026-11-16 with service-quotas list-service-quotas).
SESSIONS_QUOTA_CODE: Final = 'L-3E5722B2'
#: The probe's one object in voc-eng-workspace (no run's key: ``ws/<ws>/runs/`` is the runs').
PROBE_KEY: Final = 'ws/default/_readiness/probe.json'
#: The deployment-wide Issues source's watermark of a repository (plugins/github_issues: ``repo#<owner/name>``, under
#: the plugin's id, base_ingestor.py ``_watermark_source``).
ISSUES_WATERMARK_PREFIX: Final = 'github_issues#repo#'
#: The Agents API's environment for the checks (api-assistant-lambdas.ts).
IMAGE_LANGUAGES_ENV: Final = 'ENGINEERING_IMAGE_LANGUAGES'
NETWORK_ENV: Final = 'ENGINEERING_AGENT_NETWORK'
BUILD_MEMORY_ENV: Final = 'ENGINEERING_BUILD_MEMORY_MIB'
MAX_SESSIONS_ENV: Final = 'ENGINEERING_MAX_SESSIONS'
WATERMARKS_TABLE_ENV: Final = 'ENGINEERING_WATERMARKS_TABLE'
#: The agent sessions a deployment runs at once when it names none (engineering-agentcore.ts SESSION_QUOTA).
DEFAULT_MAX_SESSIONS: Final = 5000
#: How long the models' access reads may take in all (the Agents API answers within API Gateway's 29 s).
MODELS_BUDGET_SECONDS: Final = 10.0
_AWS_ERRORS: Final = (ClientError, BotoCoreError)


def _failed(what: str, error: Exception) -> ReadFailed:
    code = error.response.get('Error', {}).get('Code', '') if isinstance(error, ClientError) else ''
    return ReadFailed(f'{what}: {code or type(error).__name__}')


def settings_from_environment(card_models: Mapping[str, str], region: str) -> Settings:
    """The deployment's settings the checks read, from the Agents API's environment."""
    raw_mib = os.environ.get(BUILD_MEMORY_ENV, '0').strip() or '0'
    raw_sessions = os.environ.get(MAX_SESSIONS_ENV, '').strip()
    return Settings(
        image_languages=frozenset(filter(None, os.environ.get(IMAGE_LANGUAGES_ENV, '').split(','))),
        network=os.environ.get(NETWORK_ENV) == 'vpc',
        build_memory_mib=int(raw_mib) if raw_mib.isdigit() else -1,
        region=region,
        max_sessions=int(raw_sessions) if raw_sessions.isdigit() else DEFAULT_MAX_SESSIONS,
        card_models=dict(card_models), kiro_roles=_kiro_roles(os.environ.get(HARNESS_ENV)),
        kiro_key_parameter=os.environ.get(KEY_PARAMETER_ENV, ''), kiro_version=KIRO_CLI_VERSION)


def _kiro_roles(value: str | None) -> frozenset[str]:
    """The roles the switch runs on Kiro (runtime/harness_switch.py); none for a switch off its shape (the stack
    refuses one at synth, so it is never deployed)."""
    try:
        return kiro_roles(value)
    except RuntimeRefused:
        return frozenset()


@dataclass(frozen=True)
class AwsReadinessPorts:
    """``ReadinessPorts`` on the Agents API's clients: voc-agents (connections, attestations, the hard cap), the
    aggregates table (the dial), voc-engineering (the knowledge pack's counter, a flow's month total), voc-watermarks
    (the Issues source), the workspace bucket (the probe), Bedrock's and Service Quotas' control planes, and the
    GitHub Apps' token function (``inspect``: an installation's repositories, never a token)."""

    agents: Any
    aggregates: Any
    engineering: Any
    engineering_client: Any
    engineering_table: str
    s3: Any
    workspace_bucket: str
    quotas: Callable[[], Any]
    #: Bedrock's control plane (``get_foundation_model_availability``), built at the first read.
    bedrock: Callable[[], Any]
    inspect: Callable[[dict[str, Any]], dict[str, Any]]
    watermarks: Any = None
    #: SSM's client (7.53.00: the Kiro key's metadata, ``kiro_key``), built at the first read; None: not wired.
    ssm: Callable[[], Any] | None = None
    #: The connections' follow of the GitHub Issues source (connectors/issues_sync.py ``IssuesFollow``: its ``status``
    #: through voc-engineering-issues-config; None, or not ``deployed``: not deployed here).
    issues: Any = None
    now: Callable[[], datetime] = lambda: datetime.now(UTC)
    clock: Callable[[], float] = time.monotonic

    def connection(self, connection_id: str) -> Mapping[str, Any] | None:
        from shared import engineering_agent_runs as eng_runs
        from shared.exceptions import ServiceUnavailableError
        try:
            return eng_runs.connection_row(self.agents, connection_id)
        except ServiceUnavailableError as error:
            raise ReadFailed('the connection could not be read') from error

    def installation_repositories(self, connection: Mapping[str, Any]) -> tuple[frozenset[str], bool] | None:
        from engineering.connectors.connections import ConnectionRefused
        from engineering.connectors.transport import dig
        app_id, installation_id = str(connection.get('app_id') or ''), str(connection.get('installation_id') or '')
        if connection.get('credential_kind') != 'app_reference' or not (app_id.isdigit() and installation_id.isdigit()):
            return None
        try:
            inspected = self.inspect({'action': 'inspect_installation', 'app_id': app_id,
                                      'installation_id': int(installation_id)})
        except ConnectionRefused as refused:
            if refused.kind == 'conflict':   # (another App's installation, suspended or gone: it covers nothing)
                return frozenset(), False
            raise ReadFailed(str(refused)) from refused
        listed = dig(inspected, 'repositories')
        names = frozenset(str(dig(item, 'repository')) for item in (listed if isinstance(listed, list) else []))
        return names, dig(inspected, 'truncated') is True

    def attested(self, connection_id: str, repository: str) -> bool:
        from engineering.connectors.attestations import is_attested, newest
        try:
            return is_attested(newest(self.agents, connection_id), repository)
        except _AWS_ERRORS as error:
            raise _failed('the CI attestation', error) from error

    def ci_protection(self, connection: Mapping[str, Any]) -> bool | None:
        del connection   # (the broker's read, with the connection's own token: this role holds none)
        return None

    def knowledge_approved(self, connection_id: str) -> int:
        from engineering.knowledge.workspaces import ROOT
        from engineering.rows import get_row
        from engineering.workspace.layout import CONNECTION, encode_package
        if not CONNECTION.fullmatch(connection_id):
            return 0
        key = {'pk': {'S': f'WS#default#REPO#{connection_id}'}, 'sk': {'S': f'KPACK#{encode_package(ROOT)}'}}
        try:
            counter = get_row(self.engineering_client, self.engineering_table, key) or {}
        except _AWS_ERRORS as error:
            raise _failed('the knowledge pack', error) from error
        return int(counter.get('approved_version', {}).get('N', '0'))

    def _repo_row(self, connection_id: str, sk: str, attribute: str, what: str) -> int:
        """A whole number of one of the connection's ``WS#default#REPO#`` rows (0 for none, or an id off its shape)."""
        from engineering.rows import get_row
        from engineering.workspace.layout import CONNECTION
        if not CONNECTION.fullmatch(connection_id):
            return 0
        key = {'pk': {'S': f'WS#default#REPO#{connection_id}'}, 'sk': {'S': sk}}
        try:
            row = get_row(self.engineering_client, self.engineering_table, key) or {}
        except _AWS_ERRORS as error:
            raise _failed(what, error) from error
        return int(row.get(attribute, {}).get('N', '0'))

    def knowledge_rendering(self, connection_id: str) -> int:
        return self._repo_row(connection_id, 'KDOCS', 'version', 'the knowledge docs')

    def tenets_accepted(self, connection_id: str) -> int:
        return self._repo_row(connection_id, 'TENETS', 'accepted_version', 'the accepted tenets')

    def issues_source_reads(self, repository: str) -> bool:
        if self.watermarks is None:
            raise ReadFailed('this deployment names no watermarks table to the Agents API')
        try:
            item = self.watermarks.get_item(Key={'source': f'{ISSUES_WATERMARK_PREFIX}{repository}'},
                                            ProjectionExpression='#s', ExpressionAttributeNames={'#s': 'source'})
        except _AWS_ERRORS as error:
            raise _failed('the Issues source', error) from error
        return 'Item' in item

    def issues_source_lists(self, repository: str) -> bool | None:
        from engineering.connectors.connections import ConnectionRefused
        if self.issues is None or not self.issues.deployed:
            return None
        try:
            state = self.issues.status().state
        except ConnectionRefused as refused:
            raise ReadFailed(f'the Issues source: {refused}') from refused
        return state.signs_in != 'none' and state.lists(repository)

    def label_state(self, connection_id: str) -> str:
        from engineering.connectors.connections import PARTITION, ConnectionRefused, check_connection_id
        from engineering.connectors.issues_sync import LABEL_STATES, ROW_PREFIX
        try:
            check_connection_id(connection_id)
        except ConnectionRefused:
            return ''
        try:
            row = self.agents.get_item(Key={'pk': PARTITION, 'sk': f'{ROW_PREFIX}{connection_id}'},
                                       ConsistentRead=True).get('Item') or {}
        except _AWS_ERRORS as error:
            raise _failed('the label', error) from error
        state = row.get('label_state')
        return state if state in LABEL_STATES and row.get('removed') is not True else ''

    def mode(self, person: str) -> str:
        from engineering.connectors.dial import WaysOfWorking
        from engineering.connectors.hosts import Unavailable
        try:
            return WaysOfWorking(self.aggregates).stored(person)
        except Unavailable as error:
            raise ReadFailed('the way of working') from error

    def hard_cap_on(self) -> bool:
        from engineering.settings import read_hard_cap
        try:
            return read_hard_cap(self.agents).on
        except _AWS_ERRORS as error:
            raise _failed('the hard cap', error) from error

    def month_spend_usd(self, workflow_id: str) -> Decimal:
        from engineering.spend import flow_month_usd, keyable, month_of
        if not keyable(workflow_id):
            return Decimal(0)
        try:
            return flow_month_usd(self.engineering, month_of(self.now()), workflow_id)
        except _AWS_ERRORS as error:
            raise _failed('the month\'s spend', error) from error

    def models_access(self, model_ids: list[str]) -> Mapping[str, str]:
        """Each model's access (``shared.model_access``), read in turn until ``MODELS_BUDGET_SECONDS`` have passed: a
        model not read by then, or whose read failed, is left out (``unknown``), so the answer always comes in time."""
        from shared.model_access import access_status
        from shared.model_config import GLOBAL_PROFILE_PREFIX
        found: dict[str, str] = {}
        deadline = self.clock() + MODELS_BUDGET_SECONDS
        for model in model_ids:
            if self.clock() >= deadline:
                break
            try:
                answer = self.bedrock().get_foundation_model_availability(
                    modelId=model.removeprefix(GLOBAL_PROFILE_PREFIX))
            except _AWS_ERRORS:
                continue
            found[model] = access_status(answer)
        return found

    def session_quota(self) -> float:
        try:
            answer = self.quotas().get_service_quota(ServiceCode='bedrock-agentcore', QuotaCode=SESSIONS_QUOTA_CODE)
        except _AWS_ERRORS as error:
            raise _failed('the AgentCore sessions quota', error) from error
        value = answer.get('Quota', {}).get('Value')
        if not isinstance(value, int | float) or isinstance(value, bool):
            raise ReadFailed('the AgentCore sessions quota has no value')
        return float(value)

    def sandbox_walls(self, language: str) -> SandboxSeen | None:
        """The runtime's record of the language's last session's walls (``runtime/sandbox.py``: one GetItem of
        voc-engineering, which this role reads already), None for none yet."""
        from engineering.runtime.sandbox import read_record
        try:
            found = read_record(self.engineering_client, self.engineering_table, language)
        except _AWS_ERRORS as error:
            raise _failed('the sessions\' walls', error) from error
        except ValueError as error:   # (a language off its shape names no record)
            raise ReadFailed('the sessions\' walls: not a language') from error
        if found is None:
            return None
        walls = found.walls
        return SandboxSeen(walls.egress, walls.code, walls.hardlink_guard, found.at, walls.kiro_cli)

    def kiro_key(self, parameter: str) -> str | None:
        """The key parameter's type (``ssm:DescribeParameters`` filtered to its exact name: metadata, never the value),
        None when it is not stored."""
        if self.ssm is None:
            raise ReadFailed('the Kiro API key: SSM is not wired here')
        try:
            answer = self.ssm().describe_parameters(
                ParameterFilters=[{'Key': 'Name', 'Option': 'Equals', 'Values': [parameter]}], MaxResults=1)
        except _AWS_ERRORS as error:
            raise _failed('the Kiro API key', error) from error
        found = [item for item in answer.get('Parameters', []) if item.get('Name') == parameter]
        return str(found[0].get('Type', '')) if found else None

    def probe_storage(self) -> bool:
        """A create-only put of ``PROBE_KEY`` (answered, or refused as already there: either is a create-only put
        the bucket took), then the same put without If-None-Match, which the bucket's own policy must refuse."""
        try:
            self.s3.put_object(Bucket=self.workspace_bucket, Key=PROBE_KEY, Body=b'{}', IfNoneMatch='*',
                               ContentType='application/json')
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') not in ('PreconditionFailed', 'ConditionalRequestConflict'):
                raise _failed('the workspace bucket', error) from error
        except BotoCoreError as error:
            raise _failed('the workspace bucket', error) from error
        try:
            self.s3.put_object(Bucket=self.workspace_bucket, Key=PROBE_KEY, Body=b'{}', ContentType='application/json')
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') == 'AccessDenied':
                return True
            raise _failed('the workspace bucket', error) from error
        except BotoCoreError as error:
            raise _failed('the workspace bucket', error) from error
        return False


# ── the subjects ───────────────────────────────────────────────────────────────────────────────────────────────


def _budget(definition: Mapping[str, Any]) -> Decimal | None:
    from shared.workflow_engineering import budget_of
    budget, broken = budget_of(definition.get('budget'))
    return None if budget is None or broken else Decimal(str(budget['monthly_usd']))


def agent_subject(agent: Mapping[str, Any], workflow: Mapping[str, Any] | None, asker: str,
                  asker_name: str = '') -> Subject:
    """An engineering agent as readiness reads it: its connection, language, flow and ``github_issue`` trigger, and
    whose way of working its runs follow (the administrator who enabled it, else the one asking: who would enable
    it), by their username."""
    from shared import workflow_schema
    engineering = agent.get('engineering')
    settings: Mapping[str, Any] = engineering if isinstance(engineering, Mapping) else {}
    definition = workflow_schema.decode_definition((workflow or {}).get('definition')) or {}
    trigger = next((trigger for trigger in agent.get('triggers') or []
                    if isinstance(trigger, Mapping) and trigger.get('kind') == 'github_issue'), None)
    owner = str(agent.get('owner_sub') or '') if agent.get('enabled') is True else ''
    name = str(agent.get('owner_username') or '') if owner else asker_name
    return Subject(kind='automation', id=str(agent.get('agent_id', '')), name=str(agent.get('name', '')),
                   definition=definition, person=owner or asker, person_name=name, requires=flow_requires(definition),
                   workflow_id=str((workflow or {}).get('workflow_id') or ''),
                   connection=str(settings.get('connection') or ''), language=str(settings.get('language') or ''),
                   budget_usd=_budget(definition), trigger=trigger)


def template_subject(template: Mapping[str, Any], asker: str, asker_name: str = '') -> Subject:
    """A flow template as readiness reads it, on no connection nor language (``readiness.preview`` names them)."""
    declared = template.get('definition')
    definition: Mapping[str, Any] = declared if isinstance(declared, Mapping) else {}
    budget = _budget(definition) if 'budget' in definition else _budget({'budget': template.get('budget')})
    return Subject(kind='flow', id=str(template.get('template_id', '')), name=str(template.get('name', '')),
                   definition=definition, person=asker, person_name=asker_name,
                   requires=flow_requires(definition, template.get('requires')), budget_usd=budget)

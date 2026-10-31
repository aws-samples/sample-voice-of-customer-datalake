"""Where one deployment keeps its project data, read from its CloudFormation outputs.

A deployment is named by its stack prefix (`-c deploymentPrefix`, empty for an unprefixed
deployment) and its region; `bin/voc-datalake.ts` names the stacks `<prefix>-VocCoreStack` /
`<prefix>-VocApiStack`. Nothing here is hard-coded to an account, region or profile: boto3's
own credential chain (`AWS_PROFILE`, env vars, SSO) decides who runs it.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Any

CORE_STACK = 'VocCoreStack'
API_STACK = 'VocApiStack'


@dataclass(frozen=True)
class Deployment:
    """The resources a project lives in on one deployment."""

    projects_table: str
    aggregates_table: str
    bucket: str
    user_pool_id: str
    api_base: str | None  # e.g. https://abc.execute-api.<region>.amazonaws.com/v1, no trailing slash


def stack_name(prefix: str, base: str) -> str:
    return f'{prefix}-{base}' if prefix else base


def add_deployment_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--prefix', default='', help='deployment prefix (-c deploymentPrefix); omit for none')
    parser.add_argument('--region', required=True, help='AWS region the deployment runs in')


def _outputs(cloudformation: Any, stack: str) -> dict[str, str]:
    stacks = cloudformation.describe_stacks(StackName=stack)['Stacks']
    return {o['OutputKey']: o['OutputValue'] for o in stacks[0].get('Outputs', []) if 'OutputKey' in o}


def _required(outputs: dict[str, str], stack: str, key: str) -> str:
    value = outputs.get(key)
    if not value:
        raise SystemExit(f'{stack} has no {key} output; is this the right --prefix / --region?')
    return value


def _api_base(cloudformation: Any, stack: str) -> str | None:
    """The API's base URL, or None when the API stack (or its output) is absent."""
    from botocore.exceptions import ClientError

    try:
        endpoint = _outputs(cloudformation, stack).get('ApiEndpoint')
    except ClientError:  # a missing API stack only disables the prototype URL rewrite
        return None
    return endpoint.rstrip('/') if endpoint else None


def resolve(session: Any, prefix: str) -> Deployment:
    cloudformation = session.client('cloudformation')
    core = stack_name(prefix, CORE_STACK)
    outputs = _outputs(cloudformation, core)
    return Deployment(
        projects_table=_required(outputs, core, 'ProjectsTableName'),
        aggregates_table=_required(outputs, core, 'AggregatesTableName'),
        bucket=_required(outputs, core, 'RawDataBucketName'),
        user_pool_id=_required(outputs, core, 'UserPoolId'),
        api_base=_api_base(cloudformation, stack_name(prefix, API_STACK)),
    )


def session_for(region: str) -> Any:
    import boto3  # deferred so the scripts import (and their tests load) without AWS config

    return boto3.session.Session(region_name=region)

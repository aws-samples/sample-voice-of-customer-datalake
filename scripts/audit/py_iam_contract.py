#!/usr/bin/env python3
# audit-detector: run by scripts/audit/run-all.sh
"""py_iam_contract: IAM grants on a Python Lambda's role that no code path of the role's functions uses.

PATTERN (deadpy.md section 3a, the 5.28 clean-up removed the ChatApi feedback/aggregates grants and the
processor's projects-table grant): a role is granted actions on a DynamoDB table, S3 bucket, SQS queue,
SNS topic, secret, Lambda function, state machine or user pool, yet none of the functions running as
that role can name the resource: no env var whose value points at it is read by their live code, and
its physical name does not occur as a live string. Dead privilege, and usually over-privilege.

HOW: from the synthesized templates (py_assembly), every ``AWS::IAM::Policy`` attached to a role (and
the role's inline policies) is resolved to the resources its statements point at (``Ref``, ``GetAtt``,
``Fn::Join`` around them, ``Fn::ImportValue`` through the exporting stack's outputs). A grant is USED
when, for some function with that role: an env var resolving to the resource (or carrying its name) is a
live string of the function's code (py_reachability); or the resource's literal physical name is; or
the resource is the function itself and its code reads ``context.function_name`` (self re-invoke).
Grants for WIRING, not for code, are never findings: event-source mappings (the poller consumes the
queue / stream) and their on-failure destinations, dead-letter and async destinations, S3 bucket
notifications to the function, and resources a custom resource passes its handler as properties.
KMS keys, logs, X-Ray, Bedrock models and other unnamed services are out of scope (no resource to name).

WHY THE REFERENCE TOOLS MISS IT: cdk-nag judges a statement's SHAPE (wildcards), never whether the code
needs it; the CDK unit tests assert grants exist. Only joining the template with the bundled code
answers "who uses this?".

FALSE POSITIVES: a resource reached through a name the code builds at run time (a pattern env var such
as ``*_NAME_PATTERN`` that resolves to a wildcard ARN is skipped, not judged); a grant kept for a
documented operational reason. Silence with ``{"key": "<role id>::<resource id>", "reason": ...}`` in
``scripts/audit/allowlists/py_iam_contract.json``.

Run: ``voc-datalake/.venv/bin/python scripts/audit/py_iam_contract.py [--json] [--refresh]``.
"""
from __future__ import annotations

import argparse
from collections.abc import Iterator
from dataclasses import dataclass, field

from audit_common import Finding, detector_main, guard, run_main
from py_assembly import Assembly, literal_strings, load_assembly, refs
from py_reachability import FunctionReach, analyse

TOOL = 'py_iam_contract'
NAMED_TYPES = frozenset({
    'AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable', 'AWS::S3::Bucket', 'AWS::SQS::Queue',
    'AWS::SNS::Topic', 'AWS::SecretsManager::Secret', 'AWS::Lambda::Function',
    'AWS::StepFunctions::StateMachine', 'AWS::Cognito::UserPool',
})
NAME_PROPERTIES = ('TableName', 'BucketName', 'QueueName', 'TopicName', 'Name', 'FunctionName',
                   'StateMachineName', 'UserPoolName')


@dataclass
class Grant:
    role: str
    resource: str
    actions: set[str] = field(default_factory=set)


def _statements(policy: dict) -> Iterator[dict]:
    statements = policy.get('PolicyDocument', {}).get('Statement', [])
    yield from (statements if isinstance(statements, list) else [statements])


def role_grants(assembly: Assembly, role: str) -> dict[str, Grant]:
    """resource id -> the Allow actions ``role`` holds on it (named resource types only)."""
    exports = assembly.exports()
    stack = role.split('/', 1)[0]
    policies: list[dict] = []
    for logical, resource in assembly.templates.get(stack, {}).get('Resources', {}).items():
        props = resource.get('Properties', {})
        if resource.get('Type') == 'AWS::IAM::Policy' and f'{stack}/{logical}' != role and \
                role in set(refs(props.get('Roles'), stack, exports)):
            policies.append(props)
    policies += assembly.resource(role).get('Properties', {}).get('Policies', [])
    grants: dict[str, Grant] = {}
    for policy in policies:
        for statement in _statements(policy):
            if statement.get('Effect') != 'Allow':
                continue
            actions = statement.get('Action', [])
            for target in set(refs(statement.get('Resource'), stack, exports)):
                if assembly.resource(target).get('Type') in NAMED_TYPES:
                    grant = grants.setdefault(target, Grant(role, target))
                    grant.actions.update(actions if isinstance(actions, list) else [actions])
    return grants


def _invokers(assembly: Assembly, fid: str) -> set[str]:
    """``fid`` itself plus any provider-framework function that forwards events to it."""
    exports = assembly.exports()
    stack = fid.split('/', 1)[0]
    found = {fid}
    for other, fn in assembly.functions.items():
        if other.startswith(f'{stack}/') and fid in set(refs(fn.env, stack, exports)):
            found.add(other)
    return found


def _wired_by(resource: dict, fid: str, invokers: set[str], stack: str, exports: dict[str, str]) -> set[str]:
    """What one template resource hands ``fid`` through its event instead of through code."""
    body = resource.get('Properties', {})
    kind = str(resource.get('Type'))
    if kind in ('AWS::Lambda::EventSourceMapping', 'AWS::Lambda::EventInvokeConfig'):
        if fid not in set(refs(body.get('FunctionName'), stack, exports)):
            return set()
        # the poller consumes the source; failures go to the destination
        return set(refs(body.get('EventSourceArn'), stack, exports)) | set(refs(body.get('DestinationConfig'), stack, exports))
    if kind == 'Custom::S3BucketNotifications':
        delivers = fid in set(refs(body.get('NotificationConfiguration'), stack, exports))
        return set(refs(body.get('BucketName'), stack, exports)) if delivers else set()
    is_custom = kind.startswith('Custom::') or kind == 'AWS::CloudFormation::CustomResource'
    if is_custom and invokers & set(refs(body.get('ServiceToken'), stack, exports)):
        # a custom resource's handler receives these as event['ResourceProperties']
        return set(refs({k: v for k, v in body.items() if k != 'ServiceToken'}, stack, exports))
    return set()


def wiring_targets(assembly: Assembly, fid: str) -> set[str]:
    """Resources CDK grants on for the function's WIRING: event sources, failure destinations, bucket
    notifications, and the properties a custom resource passes its handler."""
    exports = assembly.exports()
    stack = fid.split('/', 1)[0]
    found = set(refs(assembly.resource(fid).get('Properties', {}).get('DeadLetterConfig'), stack, exports))
    invokers = _invokers(assembly, fid)
    for resource in assembly.templates.get(stack, {}).get('Resources', {}).values():
        found |= _wired_by(resource, fid, invokers, stack, exports)
    return found


def physical_names(assembly: Assembly, rid: str) -> set[str]:
    props = assembly.resource(rid).get('Properties', {})
    return {name for key in NAME_PROPERTIES for name in literal_strings(props.get(key)) if len(name) > 3}


def _used(assembly: Assembly, fr: FunctionReach, grant: Grant) -> bool:
    exports = assembly.exports()
    stack = fr.fn.stack
    names = physical_names(assembly, grant.resource)
    for var, value in fr.fn.env.items():
        if var not in fr.reach.strings:
            continue
        if grant.resource in set(refs(value, stack, exports)) or names & set(literal_strings(value)):
            return True
    if names & fr.reach.strings:
        return True
    return grant.resource == fr.fn.fid and 'function_name' in fr.reach.attrs


def findings(assembly: Assembly, functions: dict[str, FunctionReach]) -> tuple[list[Finding], int]:
    by_role: dict[str, list[FunctionReach]] = {}
    for fr in functions.values():
        if fr.fn.role:
            by_role.setdefault(fr.fn.role, []).append(fr)
    out: list[Finding] = []
    judged = 0
    for role, frs in sorted(by_role.items()):
        wiring = set().union(*(wiring_targets(assembly, fr.fn.fid) for fr in frs))
        for rid, grant in sorted(role_grants(assembly, role).items()):
            if rid in wiring:
                continue
            judged += 1
            if not any(_used(assembly, fr, grant) for fr in frs):
                kind = assembly.resource(rid).get('Type', '').split('::')[-1]
                out.append(Finding('grant-unused', f'{role}::{rid}',
                                   f'{kind} {", ".join(sorted(grant.actions))[:160]} -- used by none of '
                                   + ', '.join(fr.fn.handler for fr in frs)))
    return out, judged


def scan(args: argparse.Namespace) -> tuple[list[Finding], str]:
    assembly = load_assembly(args.cdk_dir, refresh=args.refresh)
    program = analyse(args.cdk_dir, assembly)
    found, judged = findings(assembly, program.functions)
    guard(judged >= 100, f'only {judged} named-resource grants judged')
    return found, f'{judged} named-resource grants judged'


main = detector_main(TOOL, __doc__, scan)


if __name__ == '__main__':
    run_main(main)

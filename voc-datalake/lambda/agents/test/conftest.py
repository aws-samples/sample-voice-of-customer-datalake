"""Fixtures for the agents runtime: a moto ``voc-agents`` table, an in-memory
"world" behind the domain routes (projects / metrics / memory Lambdas), a scripted
model, and a driver that plays the Step Functions state machine in Python.

The world answers ``shared.mcp_delegate.call_domain`` — the exact seam the
runtime uses — so every node is exercised through the same request shapes it
sends in production, and every request's claims are recorded for the
principal assertions.
"""
from __future__ import annotations

import io
import itertools
import json
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from shared.indexes import AGENTS_LISTING_INDEX
from shared.mcp_delegate import DomainResult

# The shared document-node cases (agents/test/document_node_cases.py) assert from a
# non-test module; conftest loads before any test module imports it.
pytest.register_assert_rewrite('agents.test.document_node_cases')

os.environ.setdefault('AGENTS_TABLE', 'test-agents')
os.environ.setdefault('PROJECTS_FUNCTION', 'voc-projects-api')
os.environ.setdefault('METRICS_FUNCTION', 'voc-metrics-api')
os.environ.setdefault('MEMORY_FUNCTION', 'voc-memory-api')

AGENT_ID = 'ag_1'
RUN_ID = 'ar_000000000001'
OWNER = 'owner-sub'


def _create_table(name: str):
    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName=name,
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': a, 'AttributeType': 'S'} for a in ('pk', 'sk', 'gsi1pk', 'gsi1sk')],
        GlobalSecondaryIndexes=[{
            'IndexName': AGENTS_LISTING_INDEX,
            'KeySchema': [{'AttributeName': 'gsi1pk', 'KeyType': 'HASH'},
                          {'AttributeName': 'gsi1sk', 'KeyType': 'RANGE'}],
            'Projection': {'ProjectionType': 'ALL'},
        }],
        BillingMode='PAY_PER_REQUEST',
    )


@pytest.fixture
def tables():
    import shared.aws
    with mock_aws():
        shared.aws._dynamodb_resource = None
        agents = _create_table(os.environ['AGENTS_TABLE'])
        aggregates = _create_table('test-agents-aggregates')
        yield agents, aggregates
    shared.aws._dynamodb_resource = None


def seed_agent(table, **overrides: Any) -> dict:
    agent = {
        'pk': f'AGENT#{AGENT_ID}', 'sk': 'META', 'agent_id': AGENT_ID, 'name': 'Checkout agent',
        'enabled': True, 'owner_sub': OWNER, 'workflow_id': 'wf_default',
        'scope': {'all': False, 'categories': ['checkout']},
        'instructions': 'Focus on checkout friction.',
        'personas': {'fixed': [], 'allow_generate': True},
        'budget': {'max_scheduled_runs_per_day': 2, 'max_model_calls_per_run': 150},
        'output': {'visibility': 'private'},
        **overrides,
    }
    table.put_item(Item=agent)
    return agent


def seed_run(table, status: str = 'queued') -> None:
    table.put_item(Item={
        'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}', 'run_id': RUN_ID, 'agent_id': AGENT_ID,
        'status': status, 'trigger': 'manual', 'model_calls': 0,
    })


def run_row(table) -> dict:
    return table.get_item(Key={'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}'})['Item']


def partition(table, prefix: str) -> list[dict]:
    items = table.query(
        KeyConditionExpression=Key('pk').eq(f'RUN#{RUN_ID}') & Key('sk').begins_with(prefix),
    )['Items']
    return sorted(items, key=lambda i: i['sk'])


# ---------------------------------------------------------------------------
# The fake world behind call_domain
# ---------------------------------------------------------------------------

@dataclass
class World:
    feedback: list[dict] = field(default_factory=list)
    projects: dict[str, dict] = field(default_factory=dict)
    jobs: dict[str, dict] = field(default_factory=dict)
    html: dict[tuple[str, str], str] = field(default_factory=dict)
    calls: list[tuple[str, str, str, dict]] = field(default_factory=list)  # (function, method, path, claims)
    pins: dict[str, list[dict]] = field(default_factory=dict)               # prototype document id → pins
    pins_on_first_prototype: list[dict] = field(default_factory=list)       # attached when it is built
    job_polls_before_done: int = 1
    lie_about_document: bool = False
    _ids: Any = field(default_factory=lambda: itertools.count(1))

    def new_id(self, prefix: str) -> str:
        return f'{prefix}_{next(self._ids)}'

    def add_project(self, project_id: str, **meta: Any) -> dict:
        self.projects[project_id] = {
            'meta': {'project_id': project_id, 'name': project_id, 'description': '', 'purpose': '',
                     'access': {'role': 'editor', 'can_view': True, 'can_edit': True, 'can_manage': False},
                     **meta},
            'personas': [], 'documents': [],
        }
        return self.projects[project_id]

    # -- dispatch ---------------------------------------------------------
    def __call__(self, call, *, claims) -> DomainResult:
        self.calls.append((call.function_name, call.method, call.path, dict(claims)))
        for pattern, handler in self._routes():
            match = re.fullmatch(pattern, f'{call.function_name} {call.method} {call.path}')
            if match:
                status, payload = handler(call, claims, *match.groups())
                return DomainResult(status_code=status, payload=payload)
        return DomainResult(status_code=404, payload={'message': 'no route'})

    def _routes(self) -> list[tuple[str, Callable]]:
        p = r'voc-projects-api'
        return [
            (r'voc-metrics-api GET /feedback', self._feedback),
            (r'voc-memory-api POST /memory/retrieve', self._memory),
            (rf'{p} GET /projects', self._list),
            (rf'{p} POST /projects', self._create),
            (rf'{p} PUT /projects/([^/]+)', self._update),
            (rf'{p} GET /projects/([^/]+)', self._get),
            (rf'{p} POST /projects/([^/]+)/chat-context', self._chat_context),
            (rf'{p} POST /projects/([^/]+)/personas/generate', self._job('generate_personas')),
            (rf'{p} POST /projects/([^/]+)/research', self._job('research')),
            (rf'{p} POST /projects/([^/]+)/document', self._job('document')),
            (rf'{p} POST /projects/([^/]+)/build-prototype', self._job('prototype')),
            (rf'{p} POST /projects/([^/]+)/documents', self._custom_doc),
            (rf'{p} GET /projects/([^/]+)/jobs/([^/]+)', self._job_status),
            (rf'{p} GET /projects/([^/]+)/prototypes/([^/]+)/pins', self._pins_list),
            (rf'{p} POST /projects/([^/]+)/prototypes/([^/]+)/pins/(addressed|resolve)', self._pins_move),
        ]

    # -- prototype pins (§6.2) ----------------------------------------------
    def _pins_list(self, call, _claims, _project_id, document_id):
        status = call.query.get('status')
        pins = [p for p in self.pins.get(document_id, []) if not status or p['status'] == status]
        return 200, {'form_id': f'pf_{document_id}', 'document_id': document_id, 'pins': pins}

    def _pins_move(self, call, _claims, _project_id, document_id, action):
        source, target = ('open', 'addressed') if action == 'addressed' else ('addressed', 'resolved')
        changed = []
        for pin in self.pins.get(document_id, []):
            if pin['pin_id'] in (call.body or {}).get('pin_ids', []) and pin['status'] == source:
                pin['status'] = target
                if action == 'addressed':
                    pin['addressed_by'] = call.body.get('revision_document_id')
                changed.append(pin['pin_id'])
        return 200, {'success': True, 'changed': changed, 'skipped': []}

    def _feedback(self, call, _claims):
        category = call.query.get('category')
        items = [f for f in self.feedback if not category or f.get('category') == category]
        return 200, {'count': len(items), 'items': items}

    def _memory(self, _call, _claims):
        return 200, {'items': [{'memory_id': 'm1', 'scope': 'company', 'kind': 'customer',
                                'statement': 'Customers abandon carts when shipping is shown late.',
                                'supporters': 3}]}

    def _list(self, _call, _claims):
        return 200, {'projects': [p['meta'] for p in self.projects.values()]}

    def _create(self, call, claims):
        project_id = self.new_id('proj')
        project = self.add_project(project_id, name=call.body.get('name'), purpose=call.body.get('purpose', ''),
                                   visibility=call.body.get('visibility'))
        project['claims'] = dict(claims)
        return 200, {'success': True, 'project': project['meta']}

    def _update(self, call, _claims, project_id):
        if project_id not in self.projects:
            return 404, {'message': 'Project not found'}
        self.projects[project_id]['meta'].update(call.body or {})
        return 200, {'success': True}

    def _get(self, _call, _claims, project_id):
        project = self.projects.get(project_id)
        if not project:
            return 404, {'message': 'Project not found'}
        return 200, {'project': project['meta'], 'personas': project['personas'],
                     'documents': [{k: v for k, v in d.items() if k != 'content'} for d in project['documents']]}

    def _chat_context(self, call, _claims, project_id):
        project = self.projects.get(project_id)
        if not project:
            return 404, {'message': 'Project not found'}
        selected = set(call.body.get('selected_document_ids') or [])
        documents = []
        for document in project['documents']:
            summary = {k: v for k, v in document.items() if k != 'content'}
            if document['document_id'] in selected and document['document_type'] != 'prototype':
                summary['content'] = document.get('content', '')
            documents.append(summary)
        return 200, {'project': {'sk': 'META', 'name': project['meta']['name']},
                     'personas': project['personas'], 'documents': documents, 'access': project['meta']['access']}

    def _job(self, kind: str):
        def start(call, _claims, project_id):
            if project_id not in self.projects:
                return 404, {'message': 'Project not found'}
            job_id = self.new_id('job')
            self.jobs[job_id] = {'kind': kind, 'project_id': project_id, 'body': call.body, 'polls': 0}
            return 200, {'success': True, 'job_id': job_id, 'status': 'pending'}
        return start

    def _complete(self, job: dict) -> dict:
        project = self.projects[job['project_id']]
        kind, body = job['kind'], job['body'] or {}
        if kind == 'generate_personas':
            personas = [{'sk': 'PERSONA#x', 'persona_id': self.new_id('persona'), 'name': f'Persona {i}',
                         'tagline': 'shopper', 'goals_motivations': {'primary_goal': 'pay fast'},
                         'pain_points': {'current_challenges': ['slow checkout']}, 'quotes': []}
                        for i in range(body.get('persona_count', 3))]
            project['personas'].extend(personas)
            return {'success': True, 'personas': personas}
        doc_type = {'research': 'research', 'prototype': 'prototype'}.get(kind) or body.get('doc_type')
        assert isinstance(doc_type, str), f'fake job {kind} names no document type'
        document_id = self.new_id(doc_type)
        project['documents'].append({'sk': f'{doc_type.upper()}#{document_id}', 'document_id': document_id,
                                     'document_type': doc_type, 'title': body.get('title', ''),
                                     'content': f'# {doc_type} content'})
        if doc_type == 'prototype':
            self.html[(job['project_id'], document_id)] = (
                '<html><body><h1>One-tap checkout</h1><button aria-label="Pay">Pay now</button>'
                '<script>secret()</script></body></html>')
            if self.pins_on_first_prototype and not self.pins:
                self.pins[document_id] = [dict(p) for p in self.pins_on_first_prototype]
        if self.lie_about_document:
            document_id = 'doc_that_does_not_exist'
        return {'document_id': document_id, 'title': body.get('title', '')}

    def _job_status(self, _call, _claims, _project_id, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return 404, {'message': 'Job not found'}
        job['polls'] += 1
        if job['polls'] <= self.job_polls_before_done:
            return 200, {'job_id': job_id, 'status': 'running', 'current_step': 'working'}
        if 'result' not in job:
            job['result'] = self._complete(job)
        return 200, {'job_id': job_id, 'status': 'completed', 'result': job['result']}

    def _custom_doc(self, call, _claims, project_id):
        document_id = self.new_id('doc')
        self.projects[project_id]['documents'].append({
            'sk': f'DOC#{document_id}', 'document_id': document_id, 'document_type': 'custom',
            'title': call.body.get('title'), 'content': call.body.get('content')})
        return 200, {'success': True, 'document': {'document_id': document_id}}


class FakeS3:
    def __init__(self, world: World):
        self.world = world

    def get_object(self, **kwargs):
        Key = kwargs['Key']
        _, project_id, name = Key.split('/')
        html = self.world.html[(project_id, name.removesuffix('.html'))]
        return {'Body': io.BytesIO(html.encode())}


# ---------------------------------------------------------------------------
# The scripted model
# ---------------------------------------------------------------------------

@dataclass
class Model:
    persona_scores: list[int] = field(default_factory=lambda: [5])  # per persona round (cycled per call batch)
    persona_blocking: bool = False
    final_pass: bool = True
    calls: list[dict] = field(default_factory=list)
    _persona_round: int = 0
    _persona_calls_in_round: int = 0

    def __call__(self, prompt: str, system_prompt: str = '', **kwargs: Any) -> str:
        self.calls.append({'step': kwargs.get('step_name'), 'surface': kwargs.get('surface'),
                           'model_id': kwargs.get('model_id'), 'prompt': prompt, 'system': system_prompt})
        step = kwargs.get('step_name')
        if step == 'agent_aggregate_reviews':
            ids = re.findall(r'\[(fb_\d+)\]', prompt)
            return json.dumps({'title': 'Checkout is slow', 'problem_summary': 'Users wait at payment.',
                               'research_question': 'Why is checkout slow?',
                               'top_problems': [{'title': 'Slow payment', 'category': 'checkout',
                                                 'review_ids': ids[:3], 'evidence_count': 3}]})
        if step == 'agent_decide_project':
            return json.dumps({'action': 'create', 'name': 'Checkout speed', 'description': 'd',
                               'purpose': 'Checkout friction', 'reason': 'new topic'})
        if step == 'agent_persona_review':
            score = self.persona_scores[min(self._persona_round, len(self.persona_scores) - 1)]
            return json.dumps({'score': score, 'objections': [] if score >= 4 else ['Too many steps'],
                               'blocking': self.persona_blocking, 'would_use': score >= 4})
        if step == 'agent_revision_brief':
            return '- Remove a step'
        if step == 'agent_final_review':
            return json.dumps({'pass': self.final_pass, 'summary': 'ok', 'checklist': []})
        return 'Markdown answer'

    def next_persona_round(self) -> None:
        self._persona_round += 1


@pytest.fixture
def world():
    w = World()
    w.feedback = [
        {'feedback_id': f'fb_{i}', 'category': 'checkout', 'subcategory': 'payment', 'urgency': 'high',
         'sentiment_label': 'negative', 'sentiment_score': -0.8, 'original_text': f'Checkout took forever {i}'}
        for i in range(5)
    ]
    return w


@pytest.fixture
def model():
    return Model()


@pytest.fixture
def runtime_env(tables, world, model):
    """Everything patched; yields (agents_table, aggregates_table)."""
    agents_table, aggregates = tables
    with (
        patch('agents.principal.call_domain', world),
        patch('agents.llm.converse', model),
        patch('agents.artifacts.get_s3_client', return_value=FakeS3(world)),
        patch('agents.nodes.select_or_create_project.get_aggregates_table', return_value=aggregates),
    ):
        yield agents_table, aggregates


def drive(model: Model | None = None, max_steps: int = 300) -> dict:
    """Play the voc-agent-run state machine: Init → Route → task → Advance → … ."""
    from agents.conductor import handler as conductor
    from agents.nodes import handler as nodes
    from agents.persona_panel import handler as panel

    ids = {'agent_id': AGENT_ID, 'run_id': RUN_ID}
    step = conductor.handle({'action': 'init', **ids})
    for _ in range(max_steps):
        if step['kind'] == 'finish':
            return step
        if step['kind'] == 'execute' and step['node_type'] == 'persona_review':
            result = panel.execute({'action': 'start', **ids, 'node_id': step['node_id'],
                                    'mate_seq': step['mate_seq']})
            if model is not None:
                model.next_persona_round()
        elif step['kind'] == 'execute':
            result = nodes.execute({'action': 'start', **ids, 'node_id': step['node_id'],
                                    'mate_seq': step['mate_seq']})
        else:
            assert step['kind'] == 'wait', step
            result = nodes.execute({'action': 'poll', **ids, 'node_id': step['node_id'],
                                    'pending': step['pending']})
        json.dumps(result)  # must be JSON-serialisable for Step Functions
        step = conductor.handle({'action': 'advance', **ids, 'node': result})
    raise AssertionError('the run did not finish')

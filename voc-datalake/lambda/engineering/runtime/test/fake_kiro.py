"""A scripted fake ``kiro-cli`` for the Kiro adapter's tests (7.53.00): ``--version``, and ``acp --agent-engine=v3``
speaking ACP over stdio the way kiro-cli 3.4.0 did in the 2026-11-17 probe (``initialize``, ``session/new``,
``session/load`` replaying its stored history, ``session/set_config_option`` selecting a ``.kiro/agents`` agent,
``session/prompt`` turns, a second prompt mid-turn cancelling the first, ``session/cancel``,
``session/request_permission`` for a call the agent's rules do not allow), from a scenario file::

    python -I fake_kiro.py <scenario.json> --version | acp --agent-engine=v3

The scenario: ``version``; ``log`` (a JSON Lines file of every frame read, every answer to its own requests, and what
it saw at start: its environment's names, whether the key was set, its working directory, the agents in its home);
``turns`` (one list of actions per prompt, in turn): ``say``/``think`` (chunks), ``tool`` (a ``tool_call`` and its
completion; ``finish: true`` writes the tool server's ``finished`` file, ``notes`` its ``checkpoint`` file), ``ask``
(a ``tool_call`` and a permission request with Kiro's four options, its outcome logged), ``fs`` (an ``fs/read_text_file``
request the client never offered), ``hold`` (until a cancel or the next prompt: ``cancelled``), ``stop`` (the stop
reason, ``end_turn`` by default), ``exit`` (ends the process mid-turn); ``refuse_mode`` (answers another agent);
``load_session`` (false: no ``loadSession`` capability); 7.58.00: ``model`` (the session's model at the start),
``models`` (the ones the account offers), ``model_groups`` (listed in a group), ``model_refuse`` (an error for a model
set) and ``model_answer`` (another model said to be current). Its sessions live in ``$HOME/.kiro/sessions/ws/<id>/``.
"""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
from typing import Any

SESSIONS = os.path.join('.kiro', 'sessions', 'ws')
#: The models a scenario's account offers unless it names its own (``models``), as kiro-cli 3.4.0 lists some of them.
DEFAULT_MODELS = ['auto', 'claude-opus-5.5', 'claude-sonnet-5.5', 'claude-haiku-5.5', 'claude-sonnet-4.5']


class Fake:
    def __init__(self, scenario: dict[str, Any]) -> None:
        self.scenario = scenario
        self.log = open(scenario['log'], 'a')  # noqa: SIM115 - the process's whole life
        self.frames: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self.turns = list(scenario.get('turns', []))
        self.next_id = 1000
        self.home = os.environ['HOME']
        self.session_id = ''
        self.mode = ''
        self.model = str(scenario.get('model', 'claude-sonnet-4.5'))
        self.configs: dict[str, dict[str, Any]] = {}
        agents = os.path.join(self.home, '.kiro', 'agents')
        for name in sorted(os.listdir(agents)) if os.path.isdir(agents) else []:
            with open(os.path.join(agents, name)) as stream:
                config = json.load(stream)
            self.configs[config['name']] = config
        self.note({'started': True, 'env': sorted(os.environ), 'key_set': bool(os.environ.get('KIRO_API_KEY')),
                   'cwd': os.getcwd(), 'agents': sorted(self.configs)})
        threading.Thread(target=self.read, daemon=True).start()

    def note(self, entry: dict[str, Any]) -> None:
        self.log.write(json.dumps(entry) + '\n')
        self.log.flush()

    def read(self) -> None:
        for line in sys.stdin:
            frame = json.loads(line)
            self.note({'in': frame})
            self.frames.put(frame)
        self.frames.put(None)

    def send(self, frame: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(frame) + '\n')
        sys.stdout.flush()

    def update(self, update: dict[str, Any]) -> None:
        self.send({'jsonrpc': '2.0', 'method': 'session/update',
                   'params': {'sessionId': self.session_id, 'update': update}})

    def answer(self, ident: Any, result: dict[str, Any]) -> None:
        self.send({'jsonrpc': '2.0', 'id': ident, 'result': result})

    def error(self, ident: Any, message: str, code: int = -32603) -> None:
        self.send({'jsonrpc': '2.0', 'id': ident, 'error': {'code': code, 'message': message}})

    def options(self) -> dict[str, Any]:
        """The session's config options as kiro-cli answers ``set_config_option``: the mode, and the model with the
        ones the account offers (7.58.00, ``models``; grouped as ACP allows when ``model_groups``)."""
        offered = [{'value': value, 'name': value} for value in self.scenario.get('models', DEFAULT_MODELS)]
        listed: list[dict[str, Any]] = ([{'group': 'claude', 'name': 'Claude', 'options': offered}]
                                        if self.scenario.get('model_groups') else offered)
        return {'configOptions': [{'id': 'mode', 'currentValue': self.mode},
                                  {'id': 'model', 'currentValue': self.model, 'options': listed}]}

    def set_option(self, ident: Any, params: dict[str, Any]) -> None:
        """``set_config_option``: the mode (a ``.kiro/agents`` agent; ``refuse_mode`` answers another), or the model."""
        wanted = params.get('value')
        if params.get('configId') == 'model':
            self.set_model(ident, str(wanted))
            return
        self.mode = 'vibe' if self.scenario.get('refuse_mode') or wanted not in self.configs else str(wanted)
        self.answer(ident, self.options())

    def set_model(self, ident: Any, wanted: str) -> None:
        """``set_config_option {configId: model}`` (7.58.00): ``model_refuse`` answers an error, ``model_answer`` says
        another model is current; else a model the account offers becomes the session's, one it does not is ignored
        (the current one stays, as kiro-cli keeps its model when it cannot set another)."""
        if self.scenario.get('model_refuse'):
            self.error(ident, str(self.scenario['model_refuse']))
            return
        if self.scenario.get('model_answer'):
            self.model = str(self.scenario['model_answer'])
        elif wanted in self.scenario.get('models', DEFAULT_MODELS):
            self.model = wanted
        self.answer(ident, self.options())

    def store(self, kind: str, text: str) -> None:
        folder = os.path.join(self.home, SESSIONS, self.session_id)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, 'messages.jsonl'), 'a') as stream:
            stream.write(json.dumps({'kind': kind, 'text': text}) + '\n')

    def files(self) -> str:
        config = next(iter(self.configs.values()), {})
        return str(config.get('mcpServers', {}).get('voc', {}).get('env', {}).get('VOC_SESSION_FILES', ''))

    def write_file(self, name: str, value: dict[str, Any]) -> None:
        folder = self.files()
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, f'{name}.json'), 'w') as stream:
            json.dump(value, stream)

    # -- the loop -----------------------------------------------------------------------------------------------

    def run(self) -> int:
        pending: list[dict[str, Any]] = []
        while True:
            frame = pending.pop(0) if pending else self.frames.get()
            if frame is None:
                return 0
            method, ident = frame.get('method'), frame.get('id')
            params = frame.get('params') or {}
            if method is None:
                continue   # (an answer to a request of ours, read where it was asked)
            if method == 'initialize':
                self.answer(ident, {'protocolVersion': 1, 'agentCapabilities': {
                    'loadSession': self.scenario.get('load_session', True)}})
            elif method == 'session/new':
                self.session_id = self.scenario.get('session_id', 'sess_fake-1')
                os.makedirs(os.path.join(self.home, SESSIONS, self.session_id), exist_ok=True)
                self.answer(ident, {'sessionId': self.session_id})
            elif method == 'session/load':
                self.load(ident, params)
            elif method == 'session/set_config_option':
                self.set_option(ident, params)
            elif method == 'session/prompt':
                ended = self.prompt(ident, params, pending)
                if ended == 'exit':
                    return 3
            elif method == 'session/cancel':
                continue
            elif ident is not None:
                self.error(ident, f'no method {method}', -32601)

    def load(self, ident: Any, params: dict[str, Any]) -> None:
        folder = os.path.join(self.home, SESSIONS, str(params.get('sessionId')))
        history = os.path.join(folder, 'messages.jsonl')
        if not os.path.isfile(history):
            self.error(ident, 'Session not found', -32002)
            return
        self.session_id = str(params['sessionId'])
        with open(history) as stream:
            for line in stream:
                item = json.loads(line)
                kind = 'user_message_chunk' if item['kind'] == 'user' else 'agent_message_chunk'
                self.update({'sessionUpdate': kind, 'content': {'type': 'text', 'text': item['text']}})
        self.answer(ident, {})

    def prompt(self, ident: Any, params: dict[str, Any], pending: list[dict[str, Any]]) -> str:
        text = ''.join(block.get('text', '') for block in params.get('prompt', []))
        self.store('user', text)
        actions = self.turns.pop(0) if self.turns else [{'say': 'nothing more'}]
        stop = 'end_turn'
        for action in actions:
            if 'say' in action or 'think' in action:
                kind = 'agent_message_chunk' if 'say' in action else 'agent_thought_chunk'
                said = action.get('say', action.get('think', ''))
                for part in (said[:len(said) // 2], said[len(said) // 2:]):
                    self.update({'sessionUpdate': kind, 'content': {'type': 'text', 'text': part}})
                if 'say' in action:
                    self.store('agent', said)
            elif 'tool' in action:
                self.tool(action)
            elif 'ask' in action:
                self.ask(action)
            elif 'fs' in action:
                self.request('fs/read_text_file', {'sessionId': self.session_id, 'path': action['fs']})
            elif 'plan' in action:
                self.update({'sessionUpdate': 'plan', 'entries': action['plan']})
            elif action.get('exit'):
                return 'exit'
            elif action.get('hold'):
                return self.hold(ident, pending)
            elif 'stop' in action:
                stop = action['stop']
        self.answer(ident, {'stopReason': stop})
        return stop

    def hold(self, ident: Any, pending: list[dict[str, Any]]) -> str:
        """Until a cancel (this turn answers cancelled) or a new prompt (this one cancelled, then that one runs)."""
        while True:
            frame = self.frames.get()
            if frame is None:
                return 'exit'
            if frame.get('method') == 'session/cancel':
                self.answer(ident, {'stopReason': 'cancelled'})
                return 'cancelled'
            if frame.get('method') == 'session/prompt':
                self.answer(ident, {'stopReason': 'cancelled'})
                pending.append(frame)
                return 'cancelled'
            pending.append(frame)

    def tool(self, action: dict[str, Any]) -> None:
        self.next_id += 1
        call = f'tooluse_{self.next_id}'
        self.update({'sessionUpdate': 'tool_call', 'toolCallId': call, 'title': action['tool'], 'kind': 'other',
                     'status': 'pending', 'rawInput': action.get('input', {})})
        if action.get('notes') is not None:
            self.write_file('checkpoint', {'notes': action['notes'], 'plan': [], 'save': str(self.next_id)})
        if action.get('finish'):
            self.write_file('finished', {'summary': 'done by the fake'})
        self.update({'sessionUpdate': 'tool_call_update', 'toolCallId': call, 'status': action.get('status', 'completed'),
                     'content': [{'type': 'content', 'content': {'type': 'text', 'text': action.get('output', 'ok')}}]})

    def ask(self, action: dict[str, Any]) -> None:
        self.next_id += 1
        call = f'tooluse_{self.next_id}'
        self.update({'sessionUpdate': 'tool_call', 'toolCallId': call, 'title': action['ask'], 'kind': 'other',
                     'status': 'pending', 'rawInput': {}})
        options = [{'optionId': f'{kind}-{self.next_id}', 'name': kind, 'kind': kind}
                   for kind in ('allow_once', 'allow_always', 'reject_once', 'reject_always')]
        answer = self.request('session/request_permission', {
            'sessionId': self.session_id, 'toolCall': {'toolCallId': call, 'status': 'pending', 'title': action['ask']},
            'options': options})
        outcome = (answer.get('result') or {}).get('outcome', {})
        allowed = outcome.get('outcome') == 'selected' and str(outcome.get('optionId', '')).startswith('allow')
        self.update({'sessionUpdate': 'tool_call_update', 'toolCallId': call,
                     'status': 'completed' if allowed else 'failed',
                     'content': [{'type': 'content', 'content': {
                         'type': 'text', 'text': 'ran' if allowed else 'The user rejected this tool call.'}}]})

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """One request of the agent's to its client, and the client's answer (logged)."""
        self.next_id += 1
        ident = self.next_id
        self.send({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params})
        held: list[dict[str, Any] | None] = []
        while True:
            frame = self.frames.get()
            if frame is None:
                return {}
            if frame.get('id') == ident and 'method' not in frame:
                self.note({'answered': method, 'with': frame})
                for item in held:
                    self.frames.put(item)
                return frame
            held.append(frame)


def main(argv: list[str]) -> int:
    with open(argv[0]) as stream:
        scenario = json.load(stream)
    args = argv[1:]
    if args == ['--version']:
        sys.stdout.write(f'kiro-cli {scenario.get("version", "3.4.0")}\n')
        return 0
    if args != ['acp', '--agent-engine=v3']:
        sys.stderr.write(f'fake kiro-cli: not a command it fakes: {args}\n')
        return 2
    return Fake(scenario).run()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

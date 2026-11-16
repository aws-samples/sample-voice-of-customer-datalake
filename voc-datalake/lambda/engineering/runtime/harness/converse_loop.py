"""The plain adapter: a Bedrock Converse loop with the platform's tools, for the small agents.

The model gets a system prompt from the platform (its rules first, ``skills.platform_rules``, then the skill), the
task brief, and the platform's tools only. Every text that comes from the repository, the knowledge pack, the memory,
an issue or an earlier checkpoint is fenced as data with the session's own fence (``tools.as_data``), and the
platform's rules say data is never an instruction. Between turns the loop
takes the agent's inbox: ``save`` checkpoints at once, ``pause`` checkpoints and ends the session as
paused; past ``max_turns`` in one session, or once a call's input passes ``MAX_INPUT_TOKENS``, it checkpoints
and pauses too, so a continuation starts with a fresh conversation from its notes. On any error it checkpoints
before the crash is raised. Tokens in and out are counted per model on the status report.
"""
from __future__ import annotations

import contextlib
import time
from typing import Any, Final

from engineering.runtime.harness.interface import AgentSession, Ending
from engineering.runtime.harness.skills import SKILLS, Skill, platform_rules
from engineering.runtime.harness.tools import AgentContext, bedrock_tools

MAX_TURNS: Final = 150
MAX_TOKENS: Final = 8192
#: Past this many input tokens in one call the session checkpoints and pauses, well before the models' own limit
#: (a few files read whole can fill a conversation long before its 150 turns).
MAX_INPUT_TOKENS: Final = 120_000
SYSTEM_PROMPT: Final = (
    'You are one agent of an autonomous engineering run, working on one task in a checkout of a repository. '
    'You act only through the tools you are given.'
)
NUDGE: Final = 'Continue with your tools, or call finish if the task is done.'


def system_prompt(context: AgentContext, skill: Skill | None) -> str:
    """The platform's rules with the session's fence (the bundle's, as the board served them with the skill, else
    the harness's own: no skill version can drop them), then the skill's instructions and examples (``skill``: the
    version the session runs, else the role's shipped one), or the platform's own for a role without a skill."""
    skill = skill or SKILLS.get(context.role)
    rules = platform_rules(context.fence, context.platform_rules)
    return f'{rules}\n\n{SYSTEM_PROMPT if skill is None else skill.system_prompt()}'


def opening(session: AgentSession) -> str:
    """The first user message: the task's instructions, then its context as data."""
    brief, data = session.context.brief, session.context.data
    parts = [f'Task {brief.task_id}: {brief.title}', '', brief.instructions, '']
    parts += [data(f'knowledge:{n}', text) for n, text in enumerate(brief.knowledge, 1)]
    parts += [data(f'memory:{n}', text) for n, text in enumerate(brief.memory, 1)]
    if session.restored is not None:
        parts += ['You are continuing this task in a new session. Your notes and plan from before:',
                  data('checkpoint', f'{session.notes}\nplan: {session.plan}')]
        if session.patch_refused:
            parts += [('Your last checkpoint could not save your working tree, so the checkout holds an older one '
                       '(check what is there before you go on). Why:'),
                      data('patch_refused', session.patch_refused)]
    return '\n'.join(parts)


class ConverseAdapter:
    """``Adapter`` on Bedrock's Converse API (``client`` is a ``bedrock-runtime`` client)."""

    def __init__(self, client: Any, model_id: str, *, max_turns: int = MAX_TURNS) -> None:
        self._client = client
        self._model_id = model_id
        self._max_turns = max_turns

    def run(self, session: AgentSession) -> Ending:
        turn = [0]
        try:
            return self._run(session, turn)
        except Exception:
            # A crash (a model call refused, a port failing): its work so far is saved first, so the continuation
            # starts from it; the error is raised on (the supervisor continues the crash).
            with contextlib.suppress(Exception):
                session.checkpoint(turn=turn[0])
            raise

    def _run(self, session: AgentSession, at: list[int]) -> Ending:
        tools = bedrock_tools(session.tools.specs)
        messages: list[dict[str, Any]] = [{'role': 'user', 'content': [{'text': opening(session)}]}]
        _said(session, 'user', messages[0]['content'])
        nudged = False
        for turn in range(self._max_turns):
            at[0] = turn
            notes, pause = session.take_messages()
            if pause:
                session.checkpoint(turn=turn)
                return 'paused'
            if notes:
                messages[-1]['content'].append({'text': '\n'.join(
                    session.context.data(f'message:{note.kind}', note.summary) for note in notes)})
                _said(session, 'user', [messages[-1]['content'][-1]])
            usage, message = self._converse(session, messages, tools, turn)
            messages.append(message)
            calls = [block['toolUse'] for block in message.get('content', []) if 'toolUse' in block]
            if not calls:
                if nudged:
                    # Two answers in a row without a tool: the model is done, whether or not it said so.
                    return 'done'
                nudged = True
                messages.append({'role': 'user', 'content': [{'text': NUDGE}]})
                continue
            nudged = False
            results, finished = [], False
            for call in calls:
                result = session.tools.call(str(call['name']), call.get('input') or {})
                if result.checkpoint is not None:
                    session.remember(result.checkpoint)
                    session.checkpoint(turn=turn)
                finished = finished or result.finished is not None
                results.append({'toolResult': {'toolUseId': call['toolUseId'], 'content': [{'text': result.text}],
                                               'status': 'error' if result.error else 'success'}})
            if finished:
                return 'done'
            messages.append({'role': 'user', 'content': results})
            if int(usage.get('inputTokens', 0)) >= MAX_INPUT_TOKENS:
                # The conversation nears what the model takes: checkpoint, and a continuation starts afresh from
                # the notes (a pause, never a crash for a model's input limit).
                session.checkpoint(turn=turn)
                return 'paused'
        session.checkpoint(turn=self._max_turns)
        return 'paused'

    def _converse(self, session: AgentSession, messages: list[dict[str, Any]], tools: dict[str, Any],
                  turn: int) -> tuple[dict[str, Any], dict[str, Any]]:
        """One model call: its usage (counted on the status report) and its message, both in the transcript."""
        started = time.monotonic()
        answer = self._client.converse(modelId=self._model_id, messages=messages,
                                       system=[{'text': system_prompt(session.context, session.tools.skill)}],
                                       toolConfig=tools, inferenceConfig={'maxTokens': MAX_TOKENS})
        usage = answer.get('usage', {})
        tokens_in, tokens_out = int(usage.get('inputTokens', 0)), int(usage.get('outputTokens', 0))
        session.context.status.add_tokens(self._model_id, tokens_in, tokens_out)
        message = answer['output']['message']
        transcript = session.context.transcript
        if transcript is not None:
            transcript.record('model_call', model=self._model_id, turn=turn, tokens_in=tokens_in,
                              tokens_out=tokens_out, stop_reason=str(answer.get('stopReason', '')),
                              ms=int((time.monotonic() - started) * 1000))
        _said(session, 'assistant', message.get('content', []))
        return usage, message


def _said(session: AgentSession, role: str, content: Any) -> None:
    """A message to or from the model, in the session's transcript (when it keeps one)."""
    if session.context.transcript is not None:
        session.context.transcript.record('message', role=role, content=content)

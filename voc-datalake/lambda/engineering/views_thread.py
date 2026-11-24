"""One agent's thread in the run workspace (7.51.00): its transcript and the run's messages about it, in time order.

``GET /agents/engineering/<run>/agents/<agent>/thread?after=&limit=`` answers ``{items, next, done}``: thread items
(engineering/thread_items.py) made of

- the agent's transcript (runtime/harness/transcript.py: ``…/<agent>/commits/<sha>/_transcripts/attempt-<n>/
  <chunk:04d>.jsonl``, one redacted JSON event a line, its chunks create-only): its words (``said``), its reasoning
  (``thought``, when the model returned its text: an empty reasoning block is not an item), what the harness told it
  (``message`` from the platform), each tool call with its result as one ``tool`` item, its checkpoints and session
  starts (``checkpoint``), a crash and its end; a model call's numbers are not an item. (7.54.00) A call of a tool
  whose input is the agent's reply (``REPLY_TOOLS``: ``report_progress``, ``submit_work``, ``finish``) is also its
  words, a ``said`` item just before the call (its ref with ``.1``; a page takes both or neither);
- the run's conversation (conversation/store.py) where it is about the agent: what it sent, what was sent to it (a
  relayed steer, an answer), a signal or a board change of its task at its attempt, steering relayed to its role; for
  the run's coordinator (the orchestrator) also what went to or came from the conductor, and the signals and events of
  the whole run.

A page reads forward from its cursor (``after``, opaque: where it stopped in the transcript, by chunk and byte, and
the conversation's last number), at most ``limit`` new items. The transcript is flushed every 15 s while it holds
events (and at each checkpoint), so a later page can hold items older than an earlier page's: the reader places each
by its ``at``. The conversation is re-read ``rows.TAIL_WINDOW`` messages below its cursor on every page (two writers
may commit their numbers out of order), so a page can repeat a conversation item: the reader keeps each by its
``ref``. A tool call whose result is not read yet is ``in_progress``; its result, when a later page reads it, comes as
an item with the call's own ``ref`` (ACP's ``tool_call_update``), which replaces it. ``done``: the agent's session
has ended and both sources are read to their end.

A cursor of ``TAIL`` (the run overview's ``transcript_cursor`` for each agent) opens a long attempt at its end: a
range read of its last chunks only (``parse_tail``), the last ``limit`` items, and the cursor from there.

``GET …/thread/<ref>`` answers one item's whole event: ``<attempt>.<chunk>.<offset>`` (the byte its line starts at in
its chunk; a second item of the same event, an answer's words after its reasoning or a reply's words before its call,
adds ``.1``) or ``c<seq>``, a tool call with its result. Every text is redacted again, its NUL and control characters taken out, and the DATA fences the
harness put around what it handed the model (quality_gate/text.data_block) unwrapped to their name and body; a page
reads at most ``PAGE_BYTES`` of transcript, an event answer at most ``MAX_EVENT_BYTES``.

The tail parsing is adapted from aws-samples/sample-kiro-flock, kiro-flock-cluster/lambda/tailParser.ts
(its parseTail function: a range read that drops a partial leading line and skips the lines that do not parse).
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any, Final

from engineering.board.store import COORDINATOR
from engineering.connectors.identity import WORKSPACE
from engineering.conversation.store import ConversationStore
from engineering.quality_gate.text import redact
from engineering.rows import TAIL_WINDOW, amount_attr, get_row, next_after, run_pk, string_attr, window_start
from engineering.run_objects import Read, RunObjects
from engineering.runtime.checkpoints import artifact_prefix
from engineering.runtime.harness.transcript import MAX_TEXT as MAX_EVENT_TEXT
from engineering.runtime.interface import RuntimeRefused
from engineering.thread_items import thread_item

MAX_PAGE: Final = 200
#: The transcript bytes one page reads at most (its chunks are flushed at 512 KB, so two or more of them).
PAGE_BYTES: Final = 2 * 1024 * 1024
#: The bytes a tail read takes from the end of an attempt's transcript, over at most ``TAIL_CHUNKS`` chunks.
TAIL_BYTES: Final = 256 * 1024
TAIL_CHUNKS: Final = 3
#: The conversation messages a tail read goes back over.
TAIL_MESSAGES: Final = 200
#: The conversation messages one page reads at most (with the window below its cursor).
CONVERSATION_READ: Final = 400
#: The longest line read as one event (a longer one is skipped, its chunk read on after it).
MAX_LINE_BYTES: Final = 4 * 1024 * 1024
#: What one event's answer holds at most, and how far past a tool call its result is looked for.
MAX_EVENT_BYTES: Final = 1024 * 1024
#: What a tab's scan of a whole attempt (its files, its gate runs, its memory) reads at most.
SCAN_BYTES: Final = 16 * 1024 * 1024
#: A tool item's one line of result.
MAX_RESULT_LINE: Final = 300
#: The session statuses after which an agent writes nothing more (runtime/sessions.py).
ENDED: Final = frozenset({'done', 'failed', 'stopped', 'reposted', 'needs_human'})
HARNESS: Final = {'kind': 'system', 'id': 'harness'}
#: (7.54.00) The tools whose input is the agent's reply in its own words, by the field that holds it
#: (runtime/harness/tools.py): what it did and is doing now, what it hands in, what it did and found. Most of what a
#: model on the Converse loop says reaches a person here, not as text beside its calls.
REPLY_TOOLS: Final = {'report_progress': 'step', 'submit_work': 'summary', 'finish': 'summary'}
_CHUNK: Final = re.compile(r'([0-9]{4})\.jsonl\Z')
_REF: Final = re.compile(r'(?:([1-9][0-9]{0,3})\.([0-9]{1,4})\.([0-9]{1,10})(?:\.([1-9]))?|c([1-9][0-9]{0,7}))\Z')
DATA_FENCE: Final = re.compile(r'<<<DATA (\S+) (\S+)>>>\n?(.*?)\n?<<<END DATA \1 \2>>>', re.DOTALL)
_CONTROL: Final = re.compile(r'[\x00-\x08\x0b-\x1f\x7f]')
_CURSOR_VERSION: Final = 1


class CursorError(ValueError):
    """A cursor that is not one this view gave (the route answers 400)."""


def display(text: str) -> str:
    """Transcript text as a person reads it: the DATA fences unwrapped to ``[name]`` and their body, no NUL or control
    character (but new lines and tabs), redacted again."""
    unwrapped = DATA_FENCE.sub(lambda match: f'[{match.group(1)}]\n{match.group(3)}', text)
    return redact(_CONTROL.sub('', unwrapped))


def cleaned(value: Any, limit: int = MAX_EVENT_TEXT) -> Any:
    """``value`` with every text in it ``display``-ed and cut to ``limit`` characters (an event's whole answer)."""
    if isinstance(value, str):
        shown = display(value)
        return shown if len(shown) <= limit else f'{shown[:limit]}…'
    if isinstance(value, Mapping):
        return {str(key)[:200]: cleaned(item, limit) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [cleaned(item, limit) for item in value]
    return value if value is None or isinstance(value, bool | int | float) else cleaned(str(value), limit)


@dataclass(frozen=True)
class Subject:
    """The agent a thread is of, as its session row names it."""

    run_id: str
    agent: str
    role: str
    task_id: str
    attempt: int
    commit: str
    status: str

    @property
    def ended(self) -> bool:
        return self.status in ENDED

    @property
    def coordinator(self) -> bool:
        return self.role == COORDINATOR

    def prefix(self, kind: str) -> str:
        """Its attempt's prefix of an artifact kind ('' for a row off the layout, with no commit yet: none to read)."""
        try:
            return artifact_prefix(self.run_id, self.agent, self.commit, self.attempt, kind)
        except RuntimeRefused:   # (a session row off the layout, with no commit yet, names no object)
            return ''

    @property
    def transcripts(self) -> str:
        return self.prefix('transcripts')


def subject_of(run_id: str, row: Mapping[str, Any]) -> Subject | None:
    """The agent of an ``AGENT#`` row (a low-level item), None for a launch's hold with no session yet."""
    if 'seq' not in row:
        return None
    return Subject(run_id=run_id, agent=string_attr(row, 'sk').removeprefix('AGENT#'), role=string_attr(row, 'role'),
                   task_id=string_attr(row, 'task_id'), attempt=int(amount_attr(row, 'task_attempt')) or 1,
                   commit=string_attr(row, 'commit'), status=string_attr(row, 'status'))


@dataclass(frozen=True)
class Cursor:
    """Where a page stopped: the transcript's chunk and the next byte in it, the conversation's last number, and a
    tool call read whose result is not (its ref). ``tail``: start at the end (no page read yet)."""

    chunk: int = 0
    offset: int = 0
    seq: int = 0
    call: str = ''
    tail: bool = False

    def encode(self) -> str:
        raw: dict[str, int | str] = {'v': _CURSOR_VERSION, 'k': self.chunk, 'o': self.offset, 's': self.seq}
        if self.call:
            raw['p'] = self.call
        if self.tail:
            raw = {'v': _CURSOR_VERSION, 't': 1}
        text = json.dumps(raw, separators=(',', ':'), sort_keys=True)
        return base64.urlsafe_b64encode(text.encode()).decode().rstrip('=')


TAIL: Final = Cursor(tail=True).encode()


def decode_cursor(text: str | None) -> Cursor:
    """A cursor this view gave (none: the thread's start); ``CursorError`` for anything else."""
    if not text:
        return Cursor()
    if len(text) > 400:
        raise CursorError('after is a cursor this thread gave')
    try:
        raw = json.loads(base64.urlsafe_b64decode(text + '=' * (-len(text) % 4)))
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise CursorError('after is a cursor this thread gave') from exc
    if not isinstance(raw, dict) or raw.get('v') != _CURSOR_VERSION:
        raise CursorError('after is a cursor this thread gave')
    if raw.get('t') == 1:
        return Cursor(tail=True)
    numbers = [number for number in (raw.get(name) for name in ('k', 'o', 's'))
               if type(number) is int and 0 <= number < 10 ** 12]
    if len(numbers) != 3:
        raise CursorError('after is a cursor this thread gave')
    call = raw.get('p', '')
    if not isinstance(call, str) or (call and _REF.fullmatch(call) is None):
        raise CursorError('after is a cursor this thread gave')
    return Cursor(chunk=numbers[0], offset=numbers[1], seq=numbers[2], call=call)


@dataclass(frozen=True)
class Event:
    """One transcript line: its chunk, where its line starts and ends in it, and the event."""

    chunk: int
    offset: int
    end: int
    data: dict[str, Any]

    def ref(self, attempt: int) -> str:
        return f'{attempt}.{self.chunk}.{self.offset}'


def _events_in(read: Read, chunk: int, *, complete: bool) -> tuple[list[Event], int]:
    """The events of the lines ``read`` holds whole, and the offset after the last line it holds whole. ``complete``:
    the read reached the object's end, so its last line counts even without its new line. A line that is not JSON or
    not an object is skipped (its bytes consumed)."""
    events: list[Event] = []
    position, body = read.start, read.body
    index = 0
    while index < len(body):
        newline = body.find(b'\n', index)
        if newline < 0 and not complete:
            break
        stop = len(body) if newline < 0 else newline
        line, after = body[index:stop], (len(body) if newline < 0 else newline + 1)
        event = _parsed(line)
        if event is not None:
            events.append(Event(chunk, position + index, position + after, event))
        index = after
    return events, position + index


def _parsed(line: bytes) -> dict[str, Any] | None:
    text = line.strip()
    if not text:
        return None
    try:
        event = json.loads(text)
    except ValueError:
        return None
    return event if isinstance(event, dict) else None


def parse_tail(read: Read, chunk: int) -> list[Event]:
    """The events of a range read from an object's end: its first line dropped when the read starts inside the object
    (it may begin mid-line), every line that does not parse skipped (kiro-flock's parseTail)."""
    body, start = read.body, read.start
    if start > 0:
        newline = body.find(b'\n')
        if newline < 0:
            return []
        body, start = body[newline + 1:], start + newline + 1
    return _events_in(Read(body, start, read.total), chunk, complete=True)[0]


@dataclass(frozen=True)
class Chunk:
    number: int
    key: str
    size: int


def _chunks(objects: RunObjects, prefix: str) -> list[Chunk]:
    if not prefix:
        return []
    found = []
    for listed in objects.listed(prefix):
        match = _CHUNK.fullmatch(listed.key.removeprefix(prefix))
        if match:
            found.append(Chunk(int(match.group(1)), listed.key, listed.size))
    return sorted(found, key=lambda chunk: chunk.number)


@dataclass(frozen=True)
class Built:
    """One item made from transcript events: where the read stands after the event that made it, and the tool call
    still waiting for its result there (its ref, '' for none)."""

    item: dict[str, Any]
    position: tuple[int, int]
    pending: str
    #: The next item is made from the same event (an answer's words after its reasoning): a page takes both or neither.
    joined: bool = False


def _text_blocks(content: object, key: str) -> str:
    """The text of a message's blocks of one kind: ``text``, or the reasoning text of ``reasoningContent``."""
    parts: list[str] = []
    for block in content if isinstance(content, list) else ():
        if not isinstance(block, Mapping):
            continue
        if key == 'text' and isinstance(block.get('text'), str):
            parts.append(block['text'])
        reasoning = block.get('reasoningContent')
        if key == 'reasoning' and isinstance(reasoning, Mapping):
            said = reasoning.get('reasoningText')
            if isinstance(said, Mapping) and isinstance(said.get('text'), str):
                parts.append(said['text'])
    return '\n\n'.join(part for part in parts if part.strip())


def _first_line(text: str) -> tuple[str, bool]:
    """A result's first line that says something (at most ``MAX_RESULT_LINE`` characters, a DATA block's body's), and
    whether there is more."""
    shown = display(DATA_FENCE.sub(lambda match: match.group(3), text)).strip()
    line = next((part.strip() for part in shown.splitlines() if part.strip()), '')
    if len(line) > MAX_RESULT_LINE:
        return f'{line[:MAX_RESULT_LINE - 1]}…', True
    return line, line != shown


def _tool_input(event: Mapping[str, Any]) -> str:
    raw = event.get('input')
    return raw if isinstance(raw, str) else json.dumps(raw, sort_keys=True, ensure_ascii=False, default=str)


def _reply(event: Mapping[str, Any]) -> str:
    """What a call of one of ``REPLY_TOOLS`` says in the agent's own words ('' for any other call, or none said)."""
    field = REPLY_TOOLS.get(str(event.get('tool', '')))
    raw = event.get('input')
    said = raw.get(field) if field is not None and isinstance(raw, Mapping) else None
    return display(said).strip() if isinstance(said, str) else ''


def _call_key(event: Mapping[str, Any]) -> str:
    """How a result names its call: its ``call_id`` when the harness recorded one, else the tool's name."""
    call_id = event.get('call_id')
    return f'id:{call_id}' if isinstance(call_id, str) and call_id else f'tool:{event.get("tool", "")}'


def _answers(result: Mapping[str, Any], call_key: str, tool: str) -> bool:
    key = _call_key(result)
    return key == call_key or (key.startswith('tool:') and result.get('tool') == tool)


def _with_result(call: Mapping[str, Any], result: Mapping[str, Any]) -> dict[str, Any]:
    """The call's item with its result: ok or failed, and the result's first line."""
    text, more = _first_line(str(result.get('text', '')))
    tool = call.get('tool', {})
    item = thread_item(ref=str(call['ref']), at=str(call['at']), kind='tool', sender=call['from'], text=text,
                       tool={'name': tool.get('name', ''), 'ok': not result.get('error'), 'input': tool.get('input', '')})
    item['cut'] = item['cut'] or more
    return item


class _Transcript:
    """One attempt's transcript: its chunks read by range, its events made into items in order."""

    def __init__(self, subject: Subject, objects: RunObjects) -> None:
        self.subject = subject
        self.objects = objects
        self.prefix = subject.transcripts
        self.agent = {'kind': 'agent', 'id': subject.agent}

    def chunks(self) -> list[Chunk]:
        return _chunks(self.objects, self.prefix)

    def build(self, events: Sequence[Event], pending: str = '') -> tuple[list[Built], str]:
        """The items of ``events`` in order, and the call waiting for its result after the last. ``pending``: the call
        an earlier page read with no result (its result here comes as an item with the call's ref).

        A call answered in the same read is shown with its result, but stays where the call was: a page cut after it
        reads the events in between again, and its result too, as an update of the call."""
        built: list[Built] = []
        #: The calls with no result yet: their item's index, call key and tool name.
        open_calls: list[tuple[int, str, str]] = []
        for event in events:
            data, ref, at = event.data, event.ref(self.subject.attempt), str(event.data.get('at', ''))
            position = (event.chunk, event.end)
            if data.get('kind') == 'tool_call':
                name = str(data.get('tool', ''))
                pending = ref
                reply = _reply(data)
                if reply:   # (7.54.00: the agent's reply first, as its words, then the call that carries it: one event)
                    built.append(Built(thread_item(ref=f'{ref}.1', at=at, kind='said', sender=self.agent, text=reply),
                                       position, pending, joined=True))
                open_calls.append((len(built), _call_key(data), name))
                built.append(Built(thread_item(ref=ref, at=at, kind='tool', sender=self.agent,
                                               tool={'name': name, 'input': _tool_input(data)}), position, pending))
            elif data.get('kind') == 'tool_result':
                match = next((entry for entry in reversed(open_calls) if _answers(data, entry[1], entry[2])), None)
                if match is not None:
                    open_calls.remove(match)
                    earlier = built[match[0]]
                    built[match[0]] = replace(earlier, item=_with_result(earlier.item, data))
                    pending = str(built[open_calls[-1][0]].item['ref']) if open_calls else ''
                    continue
                call = self.call_item(pending) if pending else None
                pending = ''
                if call is None:   # (a result whose call this transcript does not hold: shown as it is)
                    call = thread_item(ref=ref, at=at, kind='tool', sender=self.agent,
                                       tool={'name': str(data.get('tool', ''))})
                built.append(Built(_with_result(call, data), position, pending))
            else:
                items = self._items(data, ref, at)
                for index, item in enumerate(items):
                    built.append(Built(item if index == 0 else {**item, 'ref': f'{ref}.{index}'}, position, pending,
                                       joined=index < len(items) - 1))
        return built, pending

    def _items(self, data: Mapping[str, Any], ref: str, at: str) -> list[dict[str, Any]]:
        """The items of an event that is not a tool's (a model call's numbers, and an event this view does not know,
        make none)."""
        kind = data.get('kind')
        if kind in ('message', 'agent_message_chunk', 'agent_thought_chunk'):
            return self._message_items(data, ref, at)
        if kind == 'session':
            how = 'continuing from its checkpoint' if data.get('continuation') else 'from the start of its task'
            text = (f'Session started, {how}: {data.get("role", "")} on {data.get("model", "")}'
                    + (f', skill {data["skill"]}' if data.get('skill') else ''))
            return [thread_item(ref=ref, at=at, kind='checkpoint', sender=HARNESS, text=text)]
        if kind == 'checkpoint':
            return [thread_item(ref=ref, at=at, kind='checkpoint', sender=HARNESS,
                                text=f'Checkpoint saved at turn {data.get("turn", "?")}')]
        if kind == 'crash':
            return [thread_item(ref=ref, at=at, kind='crash', sender=HARNESS, text=display(str(data.get('error', ''))))]
        if kind == 'end':
            return [thread_item(ref=ref, at=at, kind='end', sender=HARNESS, text=f'Session ended: {data.get("ending", "")}')]
        if kind == 'steer':   # (the steering the harness rendered for the model: relayed by the orchestrator)
            return [thread_item(ref=ref, at=at, kind='steer', sender={'kind': 'conductor', 'id': str(data.get('by', ''))},
                                text=display(str(data.get('text', ''))))]
        return []

    def _message_items(self, data: Mapping[str, Any], ref: str, at: str) -> list[dict[str, Any]]:
        kind = data.get('kind')
        if kind in ('agent_message_chunk', 'agent_thought_chunk'):   # (7.53.00's ACP stream, as it came)
            return [thread_item(ref=ref, at=at, kind='said' if kind == 'agent_message_chunk' else 'thought',
                                sender=self.agent, text=display(str(data.get('text', ''))))]
        content = data.get('content')
        if data.get('role') == 'assistant':
            thought, said = _text_blocks(content, 'reasoning'), _text_blocks(content, 'text')
            return ([thread_item(ref=ref, at=at, kind='thought', sender=self.agent, text=display(thought))] * bool(thought)
                    + [thread_item(ref=ref, at=at, kind='said', sender=self.agent, text=display(said))] * bool(said))
        told = _text_blocks(content, 'text')   # (what the harness told the model; tool results are the tool items')
        return [thread_item(ref=ref, at=at, kind='message', sender=HARNESS, text=display(told))] if told else []

    def call_item(self, ref: str) -> dict[str, Any] | None:
        """The item of the tool call at ``ref`` (read again by its offset), None when it is not one."""
        found = self.event_at(ref)
        if found is None or found.data.get('kind') != 'tool_call':
            return None
        return thread_item(ref=ref, at=str(found.data.get('at', '')), kind='tool', sender=self.agent,
                           tool={'name': str(found.data.get('tool', '')), 'input': _tool_input(found.data)})

    def event_at(self, ref: str) -> Event | None:
        """The event whose line starts at the ref's offset of its chunk (its attempt must be this one)."""
        match = _REF.fullmatch(ref)
        if match is None or match.group(5) or int(match.group(1)) != self.subject.attempt or not self.prefix:
            return None
        chunk, offset = int(match.group(2)), int(match.group(3))
        read = self.objects.read(f'{self.prefix}{chunk:04d}.jsonl', offset, MAX_EVENT_BYTES)
        if read is None or read.start != offset:
            return None
        events, _ = _events_in(read, chunk, complete=read.end >= read.total)
        return events[0] if events and events[0].offset == offset else None

    def events_after(self, chunks: Sequence[Chunk], chunk: int, offset: int,
                     budget: int = PAGE_BYTES) -> tuple[list[Event], tuple[int, int]]:
        """The events after ``(chunk, offset)``, reading about ``budget`` bytes; where the read stopped. A line longer
        than the budget is read whole up to ``MAX_LINE_BYTES``; a longer one is skipped with the rest of its chunk."""
        events: list[Event] = []
        position = (chunk, offset)
        for each in (c for c in chunks if c.number >= chunk):
            start = offset if each.number == chunk else 0
            while start < each.size and budget > 0:
                read = self.objects.read(each.key, start, min(each.size - start, budget))
                if read is not None and _no_line(read, each.size):
                    read = self.objects.read(each.key, start, min(each.size - start, MAX_LINE_BYTES))
                if read is None:   # (gone since the listing, an erased transcript: read on after it)
                    start = each.size
                    break
                budget -= len(read.body)
                found, stop = _events_in(read, each.number, complete=read.end >= each.size)
                events += found
                start = each.size if stop == start else stop   # (a line too long to be an event: the chunk's rest)
            position = (each.number, start)
            if start < each.size:
                break
        return events, position

    def tail_events(self, chunks: Sequence[Chunk]) -> list[Event]:
        """The attempt's last events: range reads from the end of its last chunks, at most ``TAIL_BYTES`` in all."""
        events: list[Event] = []
        budget = TAIL_BYTES
        for each in list(reversed(chunks))[:TAIL_CHUNKS]:
            read = self.objects.tail(each.key, budget)
            if read is None:
                continue
            events = parse_tail(read, each.number) + events
            budget -= len(read.body)
            if read.start > 0 or budget <= 0:
                break
        return events


def _no_line(read: Read, size: int) -> bool:
    """The read holds no whole line and stops before the object's end (one line is longer than it)."""
    return read.end < size and b'\n' not in read.body


def _message_kind(message_type: str) -> str:
    if message_type == 'msg.steer':
        return 'steer'
    if message_type.startswith('signal.'):
        return 'signal'
    if message_type.startswith(('gate.', 'review.')):
        return 'gate'
    return 'finding' if message_type == 'msg.finding' else 'message'


def _party(raw: object) -> tuple[str, str]:
    return (str(raw.get('kind', '')), str(raw.get('id', ''))) if isinstance(raw, Mapping) else ('', '')


def about(subject: Subject, message: Mapping[str, Any]) -> bool:
    """Whether a conversation message (voc-msg/1) belongs in the agent's thread."""
    sender, to = _party(message.get('from')), _party(message.get('to'))
    if ('agent', subject.agent) in (sender, to):
        return True
    if subject.task_id and message.get('task_id') == subject.task_id and message.get('attempt') in (0, subject.attempt):
        return True
    if message.get('type') == 'msg.steer' and to == ('role', subject.role):
        return True
    if subject.coordinator:
        return 'conductor' in (sender[0], to[0]) or (to[0] == 'run' and not message.get('task_id'))
    return False


def _conversation_item(row: Mapping[str, Any]) -> dict[str, Any] | None:
    message = row.get('message')
    if not isinstance(message, Mapping):
        return None
    kind, sender = _party(message.get('from'))
    try:
        return thread_item(ref=f'c{row["seq"]}', at=str(row.get('at', '')), kind=_message_kind(str(row.get('type', ''))),
                           sender={'kind': kind, 'id': sender}, text=str(message.get('summary', '')))
    except ValueError:   # (a sender kind off voc-msg/1's: not an item)
        return None


def _merged(first: Sequence[Built], second: Sequence[dict[str, Any]],
            limit: int) -> tuple[list[dict[str, Any]], int, int]:
    """The two sources' items in time order, each kept in its own order (so what is taken of each is a prefix of it),
    at most ``limit`` (but the items of one event, taken together); and how many of each were taken."""
    items: list[dict[str, Any]] = []
    left = right = 0
    while (len(items) < limit or (left and first[left - 1].joined)) and (left < len(first) or right < len(second)):
        if right >= len(second) or (left < len(first) and first[left].item['at'] <= second[right]['at']) \
                or (left and first[left - 1].joined):
            items.append(first[left].item)
            left += 1
        else:
            items.append(second[right])
            right += 1
    return items, left, right


class ThreadView:
    """The thread of one agent of a run: its transcript (``objects``) and the conversation (``client``, the
    voc-engineering table's low-level client)."""

    def __init__(self, client: Any, table: str, objects: RunObjects) -> None:
        self.client, self.table = client, table
        self.objects = objects
        self.conversation = ConversationStore(client, table)

    def subject(self, run_id: str, agent: str) -> Subject | None:
        """The run's agent by its id, None when the run has no such agent."""
        row = get_row(self.client, self.table, {'pk': {'S': run_pk(WORKSPACE, run_id)}, 'sk': {'S': f'AGENT#{agent}'}})
        return None if row is None else subject_of(run_id, row)

    def _conversation_rows(self, run_id: str, after: int, read: int) -> list[dict[str, Any]]:
        return self.conversation.page(WORKSPACE, run_id, after=window_start(after), limit=read + TAIL_WINDOW)

    def page(self, run_id: str, subject: Subject, cursor: Cursor, limit: int) -> dict[str, Any]:
        """A page of the thread from ``cursor`` (``{items, next, done}``)."""
        transcript = _Transcript(subject, self.objects)
        chunks = transcript.chunks()
        if cursor.tail:
            return self._tail(run_id, subject, transcript, chunks, limit)
        events, read_to = transcript.events_after(chunks, cursor.chunk, cursor.offset)
        built, pending = transcript.build(events, cursor.call)
        rows = self._conversation_rows(run_id, cursor.seq, CONVERSATION_READ)
        said = [(item, int(row['seq'])) for row in rows if about(subject, row.get('message') or {})
                for item in [_conversation_item(row)] if item is not None]
        fresh = [(item, seq) for item, seq in said if seq > cursor.seq]
        items, took, told = _merged(built, [item for item, _ in fresh], limit)
        position, call = read_to, pending
        if took < len(built):   # (cut: the next page reads on after the last item taken)
            position, call = ((built[took - 1].position, built[took - 1].pending) if took
                              else ((cursor.chunk, cursor.offset), cursor.call))
        conversation_end = len(rows) < CONVERSATION_READ + TAIL_WINDOW
        seq = (next_after(cursor.seq, [int(row['seq']) for row in rows]) if told == len(fresh)
               else fresh[told - 1][1] if told else cursor.seq)
        done = (subject.ended and not call and took == len(built) and position >= _end_of(chunks)
                and conversation_end and told == len(fresh))
        window = [item for item, item_seq in said if item_seq <= cursor.seq]
        return {'items': window + items, 'done': done,
                'next': Cursor(chunk=position[0], offset=position[1], seq=seq, call=call).encode()}

    def _tail(self, run_id: str, subject: Subject, transcript: _Transcript, chunks: Sequence[Chunk],
              limit: int) -> dict[str, Any]:
        """The thread's last ``limit`` items: its transcript's tail, and the conversation's last messages."""
        built, pending = transcript.build(transcript.tail_events(chunks))
        meta = get_row(self.client, self.table, {'pk': {'S': run_pk(WORKSPACE, run_id)}, 'sk': {'S': 'META'}})
        after = max(0, int(amount_attr(meta or {}, 'msg_seq')) - TAIL_MESSAGES)
        rows = self._conversation_rows(run_id, after, TAIL_MESSAGES + CONVERSATION_READ)
        said = [item for row in rows if about(subject, row.get('message') or {})
                for item in [_conversation_item(row)] if item is not None]
        items, _, _ = _merged(built, said, len(built) + len(said))
        position = _end_of(chunks)
        seq = next_after(after, [int(row['seq']) for row in rows])
        return {'items': items[-limit:], 'done': subject.ended and not pending,
                'next': Cursor(chunk=position[0], offset=position[1], seq=seq, call=pending).encode()}

    def event(self, run_id: str, subject: Subject, ref: str) -> dict[str, Any] | None:
        """One item's whole event (``{ref, at, kind, event, result?}`` or ``{ref, at, kind, message}``), None for a
        ref this thread does not hold."""
        match = _REF.fullmatch(ref)
        if match is None:
            return None
        if match.group(5):
            seq = int(match.group(5))
            rows = self.conversation.page(WORKSPACE, run_id, after=seq - 1, limit=1)
            row = rows[0] if rows and rows[0]['seq'] == seq else None
            if row is None or not about(subject, row.get('message') or {}):
                return None
            return {'ref': ref, 'at': row['at'], 'kind': _message_kind(row['type']), 'message': cleaned(row['message'])}
        transcript = _Transcript(subject, self.objects)
        found = transcript.event_at(f'{match.group(1)}.{match.group(2)}.{match.group(3)}')
        if found is None:
            return None
        answer: dict[str, Any] = {'ref': ref, 'at': str(found.data.get('at', '')), 'kind': str(found.data.get('kind', '')),
                                  'event': cleaned(found.data)}
        if found.data.get('kind') == 'tool_call':
            result = self._result_of(transcript, found)
            answer['result'] = None if result is None else cleaned(result.data)
        return answer

    def _result_of(self, transcript: _Transcript, call: Event) -> Event | None:
        """The call's result: the first ``tool_result`` for it within ``MAX_EVENT_BYTES`` after it."""
        events, _ = transcript.events_after(transcript.chunks(), call.chunk, call.end, MAX_EVENT_BYTES)
        key, tool = _call_key(call.data), str(call.data.get('tool', ''))
        return next((event for event in events if event.data.get('kind') == 'tool_result'
                     and _answers(event.data, key, tool)), None)

    def events(self, subject: Subject, budget: int = SCAN_BYTES) -> Iterator[Event]:
        """Every event of the agent's attempt in order, reading at most about ``budget`` bytes (the files, gate and
        memory tabs' scans)."""
        transcript = _Transcript(subject, self.objects)
        chunks = transcript.chunks()
        position = (0, 0)
        while budget > 0 and position < _end_of(chunks):
            step = min(budget, PAGE_BYTES)
            events, reached = transcript.events_after(chunks, *position, budget=step)
            if reached <= position:
                return
            budget -= step
            position = reached
            yield from events


def _end_of(chunks: Sequence[Chunk]) -> tuple[int, int]:
    """The position past the last chunk's last byte ((0, 0) with none)."""
    return (chunks[-1].number, chunks[-1].size) if chunks else (0, 0)

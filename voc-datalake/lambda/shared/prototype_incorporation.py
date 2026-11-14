"""Incorporate: tester feedback into a prototype draft, and its pins marked on Apply (docs/prototype-builder.md, Part 3).

A feedback draft is part 2's draft made from ``{pin_ids}`` instead of an instruction:

* **Selecting (the drafts POST).** Pin ids only, never text: the server reads those pins itself from the
  series' forms (``prototype_feedback.series_pins``, what the Feedback view lists), refuses an id that is
  no pin of this series, and WITHHOLDS a flagged pin (fail closed: a pin is sent only when marked clean).
  The job config keeps the accepted pins (with each one's form) and the withheld ids; the instruction is
  ``INCORPORATE_INSTRUCTION``, written by the server.
* **Drafting (the document generator).** The accepted pins reach the model only inside
  ``incorporation_pins_block`` (a ``<prototype_pins>`` DATA block, flagged pins left out again), and the
  model answers per pin id in a ``<pin_outcomes>`` block (``parse_pin_outcomes``): Done and what changed,
  or Not done and why. Only accepted ids are kept; any other id is ``ignored``; an accepted pin without
  an answer is Not done with ``NO_ANSWER_NOTE``.
* **Apply.** After the version (part 2), on every call, replays included so a retry finishes the set
  (``incorporate``): each Done pin is marked addressed by the new version (from open, once per draft: a
  replay never re-marks a pin an editor reopened, it reports it ``reopened``), each
  Not done pin gets ONE reply (an id derived from the draft and the pin, written once) marked as the
  AI's, with the draft's ``llm_metadata`` and the applier as ``approved_by``. A mark or reply that
  cannot be written is reported (``not_written``), never failed: the version stands. Nothing is marked
  before Apply, and only the accepted ids are ever touched.
"""
from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from typing import Any, Final

from botocore.exceptions import ClientError

from shared import prototype_pins
from shared.aws import is_conditional_check_failure
from shared.exceptions import ValidationError
from shared.prompt_safety import injection_findings
from shared.prototype_feedback import series_pins

INCORPORATE_INSTRUCTION: Final = 'Incorporate the selected tester feedback'
OUTCOME_DONE: Final = 'done'
OUTCOME_NOT_DONE: Final = 'not_done'
MAX_NOTE_CHARS: Final = 500
MAX_IGNORED: Final = 50
NO_ANSWER_NOTE: Final = 'The AI gave no answer for this pin.'
NO_REASON_NOTE: Final = 'The AI gave no reason.'
# Why a mark or a reply was not written (the Apply answer's ``not_written[].reason``).
REASON_PIN_GONE: Final = 'pin_gone'
REASON_ALREADY_ADDRESSED: Final = 'already_addressed'
REASON_ALREADY_RESOLVED: Final = 'already_resolved'
REASON_THREAD_FULL: Final = 'thread_full'
REASON_NOTE_WITHHELD: Final = 'note_withheld'
# This draft marked the pin addressed on an earlier Apply and an editor reopened it since: a replay never re-marks it.
REASON_REOPENED: Final = 'reopened'
AI_REPLY_NAME: Final = 'AI'

_OUTCOMES_BLOCK_RE: Final = re.compile(r'<pin_outcomes>(.*?)</pin_outcomes>', re.IGNORECASE | re.DOTALL)
# A separator is a colon, a hyphen, an en dash or an em dash (models write all four).
_SEPARATOR: Final = r'[:\-\N{EN DASH}\N{EM DASH}]'
# An optional list marker before the id: "-", "*", "1." or "1)"; and an optional word "Pin".
_LIST_MARKER: Final = r'(?:[-*]|\d{1,3}[.)])'
_OUTCOME_LINE_RE: Final = re.compile(
    r'^\s*(?:' + _LIST_MARKER + r'\s*)?(?:pin\s+)?`?(?P<pin>pin_[A-Za-z0-9]+)`?\s*' + _SEPARATOR
    + r'\s*(?P<outcome>not\s+done|done)\b\s*(?:' + _SEPARATOR + r'|\.)?\s*(?P<note>.*)\Z', re.IGNORECASE)
#: Any markup tag in model text (dropped from a summary or a note before it is stored as plain text).
TAG_RE: Final = re.compile(r'<[^>]*>')


def selected_pins(projects_table: Any, pins_table: Any, project_id: str, document: Mapping[str, Any],
                  pin_ids: Sequence[str]) -> tuple[list[dict[str, Any]], list[str]]:
    """``(accepted [{pin_id, form_id, document_id, version}], withheld ids)`` of the ids, in their order; else a 400.

    Every id must be a pin of ``document``'s series as the Feedback view lists it (the count is named,
    never a pin's text); a flagged pin is withheld; a request whose every pin is withheld is refused.
    """
    by_id = {str(pin.get('pin_id')): pin for pin in series_pins(projects_table, pins_table, project_id, document)}
    unknown = [pin_id for pin_id in pin_ids if pin_id not in by_id]
    if unknown:
        raise ValidationError(f'{len(unknown)} of the selected pins are not pins of this prototype')
    withheld = [pin_id for pin_id in pin_ids if by_id[pin_id].get('flagged') is not False]
    accepted = [{
        'pin_id': pin_id, 'form_id': prototype_pins.pin_form_id(str(by_id[pin_id]['document_id'])),
        'document_id': str(by_id[pin_id]['document_id']), 'version': by_id[pin_id].get('version'),
    } for pin_id in pin_ids if pin_id not in withheld]
    if not accepted:
        raise ValidationError('Every selected pin was withheld: its text reads like an instruction to the AI')
    return accepted, withheld


def _plain(text: str, limit: int) -> str:
    """Model text as one plain line: tags and angle brackets dropped, whitespace collapsed, within ``limit``."""
    flat = ' '.join(TAG_RE.sub('', text).replace('<', '').replace('>', '').split())
    return flat if len(flat) <= limit else f'{flat[:limit - 1].rstrip()}…'


def parse_pin_outcomes(raw: str, accepted_ids: Sequence[str]) -> tuple[list[dict[str, str]], list[str], str]:
    """``(outcomes for every accepted id in their order, ignored ids, the answer without the block)``.

    The first answer for an id wins; an id not accepted (made up, withheld, another series') is dropped
    and listed in ``ignored`` (at most ``MAX_IGNORED``); an accepted id without an answer is Not done
    with ``NO_ANSWER_NOTE``. Notes are plain text within ``MAX_NOTE_CHARS``.
    """
    match = _OUTCOMES_BLOCK_RE.search(raw or '')
    answered: dict[str, dict[str, str]] = {}
    ignored: list[str] = []
    accepted = set(accepted_ids)
    for line in (match.group(1).splitlines() if match else []):
        parsed = _OUTCOME_LINE_RE.match(line)
        if parsed is None:
            continue
        pin_id = parsed['pin']
        if pin_id not in accepted:
            if pin_id not in ignored and len(ignored) < MAX_IGNORED:
                ignored.append(pin_id)
            continue
        if pin_id in answered:
            continue
        done = parsed['outcome'].lower() == 'done'
        note = _plain(parsed['note'], MAX_NOTE_CHARS)
        answered[pin_id] = {'pin_id': pin_id, 'outcome': OUTCOME_DONE if done else OUTCOME_NOT_DONE,
                            'note': note if note or done else NO_REASON_NOTE}
    outcomes = [answered.get(pin_id) or {'pin_id': pin_id, 'outcome': OUTCOME_NOT_DONE, 'note': NO_ANSWER_NOTE}
                for pin_id in accepted_ids]
    rest = raw if match is None else raw[:match.start()] + raw[match.end():]
    return outcomes, ignored, rest


def revision_feedback(outcomes: Sequence[Mapping[str, Any]]) -> str:
    """The applied version's ``revision_feedback``: "Incorporated N pins (k done)", no pin text and no model note."""
    count = len(outcomes)
    done = sum(1 for outcome in outcomes if outcome.get('outcome') == OUTCOME_DONE)
    return f"Incorporated {count} pin{'' if count == 1 else 's'} ({done} done)"


def reply_id(draft_id: str, pin_id: str) -> str:
    """The id of a draft's Not done reply on one pin: the same on every Apply, so it is written once."""
    return 'ai_' + hashlib.sha256(f'{draft_id}|{pin_id}'.encode()).hexdigest()[:16]


def mark_id(draft_id: str, pin_id: str) -> str:
    """The id of a draft's mark on one Done pin: the same on every Apply, so it is written once."""
    return 'mk_' + hashlib.sha256(f'mark|{draft_id}|{pin_id}'.encode()).hexdigest()[:16]


def _mark(pins_table: Any, form_id: str, pin_id: str, mid: str, new_document_id: str,
          actor: Mapping[str, str], now: str) -> str | None:
    """Mark one Done pin addressed by the new version, once; None when this draft's mark stands, else the reason.

    Write-once per draft (``mid``): a replayed Apply never marks again a pin an editor reopened since.
    """
    try:
        prototype_pins.mark_addressed_once(pins_table, form_id, pin_id, mid, addressed_by=new_document_id,
                                           actor=str(actor.get('sub') or ''), now=now)
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise
        pin = prototype_pins.get_pin(pins_table, form_id, pin_id)
        if pin is None:
            return REASON_PIN_GONE
        if mid in (pin.get(prototype_pins.MARK_IDS_FIELD) or set()):
            # This draft marked it on an earlier Apply: still its mark unless an editor reopened it since.
            return REASON_REOPENED if pin.get('status') == prototype_pins.STATUS_OPEN else None
        return REASON_ALREADY_RESOLVED if pin.get('status') == prototype_pins.STATUS_RESOLVED else REASON_ALREADY_ADDRESSED
    return None


def _reply(pins_table: Any, form_id: str, pin_id: str, rid: str, reply: dict) -> str | None:
    """Write one Not done reply once; None when it is on the thread (now or already), else the reason."""
    if injection_findings(reply['text']):
        return REASON_NOTE_WITHHELD
    try:
        prototype_pins.append_reply_once(pins_table, form_id, pin_id, rid, reply)
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise
        pin = prototype_pins.get_pin(pins_table, form_id, pin_id)
        if pin is None:
            return REASON_PIN_GONE
        if rid in (pin.get(prototype_pins.REPLY_IDS_FIELD) or set()):
            return None  # an earlier Apply of this draft wrote it
        return REASON_THREAD_FULL
    return None


def incorporate(pins_table: Any, *, draft_id: str, accepted: Sequence[Mapping[str, Any]],
                outcomes: Sequence[Mapping[str, Any]], new_document_id: str, actor: Mapping[str, str],
                llm_metadata: Mapping[str, Any] | None, now: str) -> dict[str, list]:
    """Apply's marks and replies, after the version: ``{marked, replied, not_written: [{pin_id, reason}]}``.

    Only the outcomes of ``accepted`` pins (the job's stored set) are acted on; marks first, then replies.
    """
    forms = {str(pin['pin_id']): str(pin['form_id']) for pin in accepted}
    chosen = [outcome for outcome in outcomes if str(outcome.get('pin_id')) in forms]
    answer: dict[str, list] = {'marked': [], 'replied': [], 'not_written': []}
    for outcome in (o for o in chosen if o.get('outcome') == OUTCOME_DONE):
        pin_id = str(outcome['pin_id'])
        reason = _mark(pins_table, forms[pin_id], pin_id, mark_id(draft_id, pin_id), new_document_id, actor, now)
        answer['marked' if reason is None else 'not_written'].append(
            pin_id if reason is None else {'pin_id': pin_id, 'reason': reason})
    for outcome in (o for o in chosen if o.get('outcome') != OUTCOME_DONE):
        pin_id = str(outcome['pin_id'])
        reply = {
            'by': prototype_pins.REPLY_KIND_AI, 'name': AI_REPLY_NAME,
            # parse_pin_outcomes gives every Not done outcome a note.
            'text': str(outcome.get('note'))[:prototype_pins.MAX_REPLY_CHARS], 'at': now,
            'kind': prototype_pins.REPLY_KIND_AI, 'approved_by': dict(actor),
            **({'llm_metadata': dict(llm_metadata)} if llm_metadata else {}),
        }
        reason = _reply(pins_table, forms[pin_id], pin_id, reply_id(draft_id, pin_id), reply)
        answer['replied' if reason is None else 'not_written'].append(
            pin_id if reason is None else {'pin_id': pin_id, 'reason': reason})
    return answer

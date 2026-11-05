"""Feedback-board requests in persona, research and document generation (docs/project-workspace.md).

The request bodies of ``POST /projects/{id}/personas/generate`` and ``.../research`` carry
``include_feature_requests`` (default false) and ``feature_request_board_ids`` (≤ 20 board ids;
absent = every non-archived board); ``POST /projects/{id}/document`` carries the flag as
``data_sources.feature_requests``. ``evidence_options`` validates them at the API (400), and
``feature_request_context`` re-reads them from the job input (an unvalidated boundary: a malformed
value reads as "not asked") and builds the prompt block.

The block is its own DATA section, ``<feature_requests>``, after the reviews and never mixed into
them: each request is cited ``[FR:<request_id>]``, distinct from a review citation. Its text is a
customer's or an employee's, so it is fenced (``shared.prompt_safety``) like every stored prose
block. The ids that reached the prompt are stored on the artefact as ``input_feature_request_ids``
(≤ 200, ids only).
"""
from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from shared.api import validate_bool
from shared.exceptions import ValidationError
from shared.feature_boards_store import is_board_id
from shared.feature_request_evidence import load_feature_request_evidence
from shared.feedback_sampling import INPUT_FEATURE_REQUEST_IDS_FIELD
from shared.prompt_safety import data_block

INCLUDE_FIELD: Final = 'include_feature_requests'
BOARD_IDS_FIELD: Final = 'feature_request_board_ids'
DATA_SOURCE_KEY: Final = 'feature_requests'
MAX_BOARD_IDS: Final = 20
MAX_INPUT_FEATURE_REQUEST_IDS: Final = 200
# Characters the block may take in one prompt: about 8k tokens, beside a review corpus that takes
# the rest of the window. Requests are added most-supported first until the next would not fit.
BLOCK_CHAR_BUDGET: Final = 30_000
SECTION_HEADING: Final = (
    '## FEATURE REQUESTS FROM THE FEEDBACK BOARDS\n'
    'Requests filed on the feedback boards: a SEPARATE source from the customer reviews. '
    'Cite one as [FR:<request_id>] (never as a review), and weigh it by its supporters.'
)
BOARD_IDS_MESSAGE: Final = f'{BOARD_IDS_FIELD} must be a list of at most {MAX_BOARD_IDS} board ids'
_SEPARATOR: Final = '\n\n'


@dataclass(frozen=True)
class FeatureRequestContext:
    """The prompt section ('' when none was asked for or none matched) and the ids in it."""

    section: str = ''
    ids: tuple[str, ...] = ()


NO_FEATURE_REQUESTS: Final = FeatureRequestContext()


def validate_board_ids(value: object) -> list[str] | None:
    """``feature_request_board_ids`` from a request body: None when absent, else ≤ 20 board ids (400)."""
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > MAX_BOARD_IDS or not all(is_board_id(v) for v in value):
        raise ValidationError(BOARD_IDS_MESSAGE)
    return list(dict.fromkeys(value))


def evidence_options(body: Mapping[str, Any]) -> dict[str, Any]:
    """The two job-config fields of a persona / research body (400 on a non-boolean flag or bad ids)."""
    return {
        INCLUDE_FIELD: validate_bool(body.get(INCLUDE_FIELD), default=False, field=INCLUDE_FIELD),
        BOARD_IDS_FIELD: validate_board_ids(body.get(BOARD_IDS_FIELD)),
    }


def document_options(body: Mapping[str, Any]) -> dict[str, Any]:
    """A document body's ``data_sources`` (with ``feature_requests`` a real bool) and board ids.

    ``data_sources`` keeps every other key as sent: the generator reads those itself."""
    raw = body.get('data_sources')
    if raw is not None and not isinstance(raw, Mapping):
        raise ValidationError('data_sources must be an object')
    sources = dict(raw or {})
    sources[DATA_SOURCE_KEY] = validate_bool(sources.get(DATA_SOURCE_KEY), default=False,
                                             field=f'data_sources.{DATA_SOURCE_KEY}')
    return {'data_sources': sources, BOARD_IDS_FIELD: validate_board_ids(body.get(BOARD_IDS_FIELD))}


def received_board_ids(value: object) -> list[str] | None:
    """Board ids read back from a job input: the valid ones (≤ 20), None when not a list."""
    if not isinstance(value, list):
        return None
    return [v for v in value if is_board_id(v)][:MAX_BOARD_IDS]


def wants_feature_requests(config: Mapping[str, Any]) -> bool:
    """A persona / research job config asked for them (strictly ``True``)."""
    return config.get(INCLUDE_FIELD) is True


def document_wants_feature_requests(doc_config: Mapping[str, Any]) -> bool:
    sources = doc_config.get('data_sources')
    return isinstance(sources, Mapping) and sources.get(DATA_SOURCE_KEY) is True


def _window(days: object) -> int | None:
    return days if isinstance(days, int) and not isinstance(days, bool) and days > 0 else None


def _line(label: str, value: object) -> str:
    return f'{label}: {value}' if value not in (None, '') else ''


def format_request(item: Mapping[str, Any]) -> str:
    """One request as the model reads it (no email, no name: the loader never returns them)."""
    meta = ', '.join(part for part in (
        _line('status', item.get('status')), _line('supporters', item.get('supporters')),
        _line('category', item.get('category')), _line('sentiment', item.get('sentiment')),
    ) if part)
    lines = [f"[FR:{item.get('request_id')}] {item.get('title') or '(untitled)'} ({meta})",
             _line('Problem', item.get('problem_summary')), _line('Description', item.get('description'))]
    return '\n'.join(line for line in lines if line)


def _budgeted(items: Sequence[Mapping[str, Any]], budget: int) -> tuple[list[str], list[str]]:
    """The formatted requests that fit ``budget`` characters, and their ids, in order."""
    parts: list[str] = []
    ids: list[str] = []
    used = 0
    for item in items[:MAX_INPUT_FEATURE_REQUEST_IDS]:
        text = format_request(item)
        cost = len(text) + len(_SEPARATOR)
        if used + cost > budget:
            break
        parts.append(text)
        ids.append(str(item.get('request_id')))
        used += cost
    return parts, ids


def build_context(items: Sequence[Mapping[str, Any]], budget: int = BLOCK_CHAR_BUDGET) -> FeatureRequestContext:
    """The fenced section for ``items`` (slim requests, best first), cut to ``budget`` characters."""
    parts, ids = _budgeted(items, budget)
    if not parts:
        return NO_FEATURE_REQUESTS
    block = data_block('feature_requests', _SEPARATOR.join(parts))
    return FeatureRequestContext(f'\n\n{SECTION_HEADING}\n\n{block}\n', tuple(ids))


def feature_request_context(*, asked: bool, board_ids: object, days: object) -> FeatureRequestContext:
    """The prompt section for one generation. App users see every non-archived board, so no
    visibility narrowing: ``board_ids`` (from the job input) only narrows to the chosen boards."""
    if not asked:
        return NO_FEATURE_REQUESTS
    evidence = load_feature_request_evidence(board_ids=received_board_ids(board_ids), days=_window(days),
                                             limit=MAX_INPUT_FEATURE_REQUEST_IDS)
    return build_context(evidence.items)


def config_context(config: Mapping[str, Any]) -> FeatureRequestContext:
    """``feature_request_context`` for a persona / research job config."""
    return feature_request_context(asked=wants_feature_requests(config), board_ids=config.get(BOARD_IDS_FIELD),
                                   days=config.get('days'))


def document_context(doc_config: Mapping[str, Any]) -> FeatureRequestContext:
    """``feature_request_context`` for a document job's ``doc_config``."""
    return feature_request_context(asked=document_wants_feature_requests(doc_config),
                                   board_ids=doc_config.get(BOARD_IDS_FIELD), days=doc_config.get('days'))


def with_feature_requests(steps: Sequence[dict], context: FeatureRequestContext,
                          step_names: Collection[str]) -> list[dict]:
    """The chain steps with ``context.section`` appended to the user prompt of the named steps."""
    if not context.section:
        return list(steps)
    return [{**step, 'user': str(step.get('user') or '') + context.section}
            if step.get('step_name') in step_names else step for step in steps]


def input_feature_request_fields(ids: Sequence[str]) -> dict[str, list[str]]:
    """``{'input_feature_request_ids': [...]}`` for an artefact, or ``{}`` when none reached its prompt."""
    return {INPUT_FEATURE_REQUEST_IDS_FIELD: list(ids)[:MAX_INPUT_FEATURE_REQUEST_IDS]} if ids else {}


def received_feature_request_ids(value: object) -> list[str]:
    """An id list read back across a boundary (Step Functions state, a scratch object); [] when malformed."""
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        return []
    return value[:MAX_INPUT_FEATURE_REQUEST_IDS]

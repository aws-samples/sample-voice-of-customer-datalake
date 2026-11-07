"""The methodology check (TENETS.md tenet 2): which upstream steps a generation skips.

The platform teaches one path: customer evidence → personas → PR/FAQ → PRD →
prototype. Nothing refuses a step done out of order (the steps are the same in
every way of working, and a document without its upstream still has value), but
no client may skip a step SILENTLY. This module is the one place that says, for a
project and a requested step, which upstream steps and evidence are missing or not
used. Every route that starts a step returns its answer as ``methodology``, the
generator stores the final one on the produced document, and ``GET /projects/{id}``
carries the per-step overview the SPA's Overview cards render
(docs/project-workspace.md → Methodology).

Shape of one assessment (every key always present, lists may be empty)::

    {'step': 'prd',
     'skipped': [{'step': 'prfaq', 'reason': 'missing' | 'not_selected'}],
     'warnings': [{'code': ..., 'message': ..., **details}],
     'evidence': <int> | None}

``evidence`` is the number of customer-feedback items that reached the prompt
(None before the job ran; 0 for a hand-written document). ``warnings`` messages are
English for headless clients; the SPA renders them by ``code``.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

#: The methodology steps that produce an artifact, in order.
STEPS: Final = ('personas', 'research', 'prfaq', 'prd', 'prototype')

#: The upstream steps each step should read, in methodology order. ``feedback`` is
#: the customer evidence itself; research is an optional extra (no step requires it).
UPSTREAM: Final[Mapping[str, tuple[str, ...]]] = {
    'personas': (),
    'research': ('personas',),
    'prfaq': ('feedback', 'personas'),
    'prd': ('feedback', 'personas', 'prfaq'),
    'prototype': ('prd', 'prfaq'),
}

#: The project-partition sort-key prefix of each artifact-producing upstream step.
_STEP_PREFIX: Final[Mapping[str, str]] = {
    'personas': 'PERSONA#',
    'research': 'RESEARCH#',
    'prfaq': 'PRFAQ#',
    'prd': 'PRD#',
    'prototype': 'PROTOTYPE#',
}

REASON_MISSING: Final = 'missing'
REASON_NOT_SELECTED: Final = 'not_selected'

_STEP_LABEL: Final[Mapping[str, str]] = {
    'feedback': 'customer feedback',
    'personas': 'personas',
    'research': 'research',
    'prfaq': 'a PR/FAQ',
    'prd': 'a PRD',
    'prototype': 'a prototype',
}

#: Warning codes (the SPA keys its copy on these).
W_MISSING_UPSTREAM: Final = 'missing_upstream'
W_NOT_SELECTED: Final = 'upstream_not_selected'
W_NO_EVIDENCE: Final = 'no_evidence'
W_DOCUMENTS_SKIPPED: Final = 'reference_documents_skipped'
W_NO_SOURCE: Final = 'no_source_document'


def _ids_with_prefix(items: Iterable[Mapping[str, Any]], prefix: str) -> list[str]:
    """The ``document_id`` / ``persona_id`` (else the sk suffix) of every item under ``prefix``."""
    ids: list[str] = []
    for item in items:
        sk = str(item.get('sk', ''))
        if sk.startswith(prefix):
            ids.append(str(item.get('document_id') or item.get('persona_id') or sk[len(prefix):]))
    return ids


def present_steps(project_items: Iterable[Mapping[str, Any]]) -> dict[str, list[str]]:
    """Per artifact step, the ids of the artifacts the project holds."""
    items = list(project_items)
    return {step: _ids_with_prefix(items, prefix) for step, prefix in _STEP_PREFIX.items()}


def _skip_warning(step: str, upstream: str, reason: str) -> dict[str, str]:
    lead = f'This {_STEP_LABEL[step].removeprefix("a ")} is made without {_STEP_LABEL[upstream]}'
    if reason == REASON_MISSING:
        return {'code': W_MISSING_UPSTREAM, 'step': upstream, 'message': f'{lead}: the project has none yet.'}
    return {'code': W_NOT_SELECTED, 'step': upstream, 'message': f'{lead}: it was not selected.'}


def build(step: str, skipped: list[dict[str, str]], *, evidence: int | None = None,
          extra_warnings: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
    """An assessment from its parts: one warning per skipped step, then ``extra_warnings``."""
    warnings: list[dict[str, Any]] = [_skip_warning(step, s['step'], s['reason']) for s in skipped]
    warnings.extend(extra_warnings)
    if evidence == 0 and not any(w.get('code') == W_NO_EVIDENCE for w in warnings):
        warnings.append({'code': W_NO_EVIDENCE,
                         'message': 'No customer feedback reached this document: it cites no evidence.'})
    return {'step': step, 'skipped': skipped, 'warnings': warnings, 'evidence': evidence}


def assess(step: str, project_items: Iterable[Mapping[str, Any]], *,
           used: Mapping[str, bool] | None = None, evidence: int | None = None,
           extra_warnings: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
    """The methodology assessment of ``step`` for a project.

    ``used`` says, per upstream step, whether the request reads it (absent = it would
    read it when present). An upstream step the project lacks is ``missing``; one it
    has but the request does not read is ``not_selected``. ``feedback`` is never
    ``missing`` here (whether feedback matches is only known once the job read it):
    its gap is reported through ``evidence == 0``.
    """
    if step not in UPSTREAM:
        raise ValueError(f'unknown methodology step: {step}')
    present = present_steps(project_items)
    used = used or {}
    skipped: list[dict[str, str]] = []
    for upstream in UPSTREAM[step]:
        exists = upstream == 'feedback' or bool(present.get(upstream))
        if not exists:
            skipped.append({'step': upstream, 'reason': REASON_MISSING})
        elif used.get(upstream, True) is False:
            skipped.append({'step': upstream, 'reason': REASON_NOT_SELECTED})
    return build(step, skipped, evidence=evidence, extra_warnings=extra_warnings)


def human_document(step: str) -> dict[str, Any]:
    """A hand-written PR/FAQ / PRD: it cites no evidence (``evidence: 0``), said on the artifact."""
    return {
        'step': step,
        'skipped': [],
        'warnings': [{'code': W_NO_EVIDENCE,
                      'message': 'Written by hand: this document cites no customer feedback yet.'}],
        'evidence': 0,
    }


def documents_skipped_warning(skipped_ids: list[str], cap: int) -> dict[str, Any]:
    """The warning for reference documents the generator's cap left out (M7)."""
    return {
        'code': W_DOCUMENTS_SKIPPED,
        'message': f'Only the first {cap} reference documents are read; {len(skipped_ids)} were left out.',
        'document_ids': skipped_ids,
        'cap': cap,
    }


def overview(project_items: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Per methodology step, the upstream steps the project has not produced yet.

    ``GET /projects/{id}`` returns it as ``methodology``. ``prototype.blocked`` is the
    one hard refusal (no PRD and no PR/FAQ: ``POST /build-prototype`` answers 409).
    """
    present = present_steps(project_items)
    steps: dict[str, Any] = {}
    for step in STEPS:
        missing = [u for u in UPSTREAM[step] if u != 'feedback' and not present.get(u)]
        steps[step] = {'missing': missing, 'count': len(present.get(step, []))}
    steps['prototype']['blocked'] = not present['prd'] and not present['prfaq']
    return {'order': list(STEPS), 'steps': steps}


def data_source_use(data_sources: Mapping[str, Any], selected_document_ids: list[str],
                    present: Mapping[str, list[str]]) -> dict[str, bool]:
    """What a PR/FAQ / PRD request reads, from its ``data_sources`` and document selection.

    ``data_sources.feedback`` defaults ON (absent = read feedback); personas and
    documents are read only when asked for, as the generator does. A PR/FAQ counts as
    used when documents are read and the selection is empty (all) or names one.
    """
    reads_documents = bool(data_sources.get('documents') or data_sources.get('research'))
    selected = set(selected_document_ids)
    prfaq_ids = set(present.get('prfaq', []))
    return {
        'feedback': data_sources.get('feedback', True) is not False,
        'personas': bool(data_sources.get('personas')),
        'prfaq': reads_documents and (not selected or bool(selected & prfaq_ids)),
    }


def data_sources_with_defaults(data_sources: object) -> dict[str, Any]:
    """A PR/FAQ / PRD request's ``data_sources`` with ``feedback`` ON when absent (M1).

    An explicit ``feedback: false`` is honoured (the gap is then reported). A
    non-object value is read as ``{}`` (it used to fail inside the job).
    """
    sources = dict(data_sources) if isinstance(data_sources, Mapping) else {}
    sources.setdefault('feedback', True)
    return sources


def for_document_request(doc_type: str, project_items: Iterable[Mapping[str, Any]],
                         doc_config: Mapping[str, Any]) -> dict[str, Any]:
    """The forecast assessment of a PR/FAQ / PRD request, before its job reads anything."""
    items = list(project_items)
    data_sources = doc_config.get('data_sources')
    selected = doc_config.get('selected_document_ids')
    use = data_source_use(
        data_sources if isinstance(data_sources, Mapping) else {},
        [str(i) for i in selected] if isinstance(selected, list) else [],
        present_steps(items),
    )
    return assess(doc_type, items, used=use)


def for_prototype_request(project_items: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The assessment of a prototype build; ``skipped`` names a missing PRD or PR/FAQ.

    The caller refuses the build (409) when both are missing: ``is_blocked``.
    """
    items = list(project_items)
    present = present_steps(items)
    extra: list[dict[str, Any]] = []
    if not present['prd'] and not present['prfaq']:
        extra.append({'code': W_NO_SOURCE,
                      'message': 'No PRD or PR/FAQ found for this project. Generate at least one first.'})
    # The build reads the named document of each type, else the newest one: every
    # PRD / PR/FAQ the project holds is used, so only a missing one is skipped.
    return assess('prototype', items, extra_warnings=extra)


def is_blocked(assessment: Mapping[str, Any]) -> bool:
    """True when the assessment carries the one hard refusal (a prototype with no source)."""
    return any(w.get('code') == W_NO_SOURCE for w in assessment.get('warnings', []))

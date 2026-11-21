"""A version 2 form's report (7.63.00, docs/feedback-forms.md "Report"): ``GET /feedback-forms/{id}/report``.

What the report holds, over the view's responses (the caller's category and source access and the Results filters
already applied by the handler):

- the KPIs: per rating, NPS, CSAT and CES question its average and score; each matrix as a heatmap (counts per row and
  column, each row's average);
- the segments, when the view groups its responses (shared/forms_v2_segments.py, at least 5 responses each);
- the themes, deterministic first (TENETS.md tenet 3): per open-text question, its answers grouped by the processed
  item's category and subcategory, each theme with its count, its sentiment mix and two or three real quotes, newest
  first and preferring the theme's dominant sentiment, linked by ``response_id``. Only free-text answers are quoted:
  an open text that asks for an email or a phone number is contact detail and never shown here;
- the latest AI summary, when someone asked for one (``POST /settings/form-reports``, shared/forms_v2_report_ai.py):
  stored as a ``FORMREPORT#{form_id}#{report_id}`` row in the form's forms partition, it keeps the model's theme labels
  and the response ids it picked, never a respondent's text, and the filters of the view it was made under. Its quotes
  are joined against the reader's own rows under the summary's own filters when the report is read (whatever the
  view's: a summary made for ``hidden.customer=A`` quotes A's responses only), an id the reader has no row for
  dropped; a summary that read any response the reader cannot see is withheld from them (``withheld: 'access'``: its
  labels could describe it). It is ``stale`` once a response newer than the newest it read exists under its filters.
  The app shows (and prints) it only on the view it was made for, and names its filters on any other.

Pure, but for ``latest_report`` (one Query of the form's own rows). The row is deleted with the form, is in the
workspace's export (the forms partition) and is swept with it.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Final

from shared.forms_v2 import CES, CSAT, MATRIX, NPS, OPEN_TEXT, RATING, plain
from shared.forms_v2_responses import headline_of
from shared.forms_v2_results import ResultRow, filter_rows, questions_where
from shared.item_facets import SENTIMENT_VALUES
from shared.scoped_query import SortRange, query_partition

__all__ = ['REPORT_PREFIX', 'ai_view', 'latest_report', 'report_key', 'report_sections', 'themes']

#: The sort-key prefix of a form's stored AI reports: ``FORMREPORT#{form_id}#{report_id}``.
REPORT_PREFIX: Final = 'FORMREPORT#'
#: Themes per open-text question, and quotes per theme.
MAX_THEMES: Final = 8
MAX_QUOTES: Final = 3
#: A quote is cut to this many characters.
MAX_QUOTE_CHARS: Final = 280
#: The open-text input types whose answers are free text (an email or a phone answer is a contact detail).
_FREE_TEXT_INPUTS: Final = frozenset({'text'})


def report_key(partition: str, form_id: str, report_id: str) -> dict[str, str]:
    """The key of one stored report in the form's forms partition ``partition``."""
    return {'pk': partition, 'sk': f'{REPORT_PREFIX}{form_id}#{report_id}'}


def _primary(definition: Mapping[str, Any]) -> str:
    return str(definition.get('language') or 'en')


def _free_text_questions(definition: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return questions_where(definition, lambda question: question.get('type') == OPEN_TEXT
                           and question.get('input_type', 'text') in _FREE_TEXT_INPUTS)


def _answer(row: ResultRow, question_id: str) -> str:
    value = row.answers.get(question_id)
    return value.strip() if isinstance(value, str) else ''


def _sentiment(row: ResultRow) -> str:
    label = (row.sentiment or '').lower()
    # (a response with no processed sentiment: a test response, or one not processed yet)
    return label if label in SENTIMENT_VALUES else 'unknown'


def _quote(row: ResultRow, text: str) -> dict[str, Any]:
    return {'response_id': row.response_id, 'text': text[:MAX_QUOTE_CHARS], 'created_at': row.created_at,
            'sentiment': _sentiment(row)}


def _theme(category: str, subcategory: str, members: Sequence[tuple[ResultRow, str]]) -> dict[str, Any]:
    mix: dict[str, int] = {}
    for row, _text in members:
        mix[_sentiment(row)] = mix.get(_sentiment(row), 0) + 1
    dominant = max(sorted(mix), key=lambda label: mix[label])
    newest = sorted(members, key=lambda pair: (pair[0].created_at, pair[0].response_id), reverse=True)
    picked = [pair for pair in newest if _sentiment(pair[0]) == dominant][:MAX_QUOTES]
    picked += [pair for pair in newest if pair not in picked][:MAX_QUOTES - len(picked)]
    return {'category': category, 'subcategory': subcategory, 'count': len(members), 'sentiment': mix,
            'quotes': [_quote(row, text) for row, text in picked]}


def themes(definition: Mapping[str, Any], rows: Iterable[ResultRow]) -> list[dict[str, Any]]:
    """Per free-text question: ``{question_id, headline, answered, themes: [{category, subcategory, count, sentiment:
    {label: n}, quotes: [{response_id, text, created_at, sentiment}]}]}``, the largest theme first (at most
    ``MAX_THEMES``; a response not processed yet is the ``''`` category)."""
    kept = list(rows)
    primary = _primary(definition)
    out = []
    for question in _free_text_questions(definition):
        qid = str(question['id'])
        groups: dict[tuple[str, str], list[tuple[ResultRow, str]]] = {}
        for row in kept:
            text = _answer(row, qid)
            if text:
                groups.setdefault((row.category or '', row.subcategory or ''), []).append((row, text))
        ordered = sorted(groups.items(), key=lambda pair: (-len(pair[1]), pair[0]))[:MAX_THEMES]
        out.append({'question_id': qid, 'headline': headline_of(question, primary),
                    'answered': sum(len(members) for members in groups.values()),
                    'themes': [_theme(category, sub, members) for (category, sub), members in ordered]})
    return out


def _kpi(result: Mapping[str, Any]) -> dict[str, Any]:
    out = {key: result.get(key) for key in ('id', 'type', 'headline', 'answered', 'skipped', 'average', 'scale_max')}
    out.update({kind: result[kind] for kind in (NPS, CSAT, CES) if kind in result})
    return out


def _matrix(question: Mapping[str, Any], result: Mapping[str, Any]) -> dict[str, Any]:
    columns = [str(entry['code']) for entry in question.get('columns') or [] if isinstance(entry, Mapping)]
    return {'id': result['id'], 'headline': result['headline'], 'answered': result['answered'],
            'scored': result.get('scored', False), 'columns': columns, 'rows': result.get('rows') or []}


def report_sections(definition: Mapping[str, Any], results: Mapping[str, Any]) -> dict[str, Any]:
    """The report's KPIs and heatmaps out of ``results`` (shared/forms_v2_results.py ``tally_results`` over the
    view): ``{kpis: [...], matrices: [...]}``, in the form's question order."""
    by_id = {str(question.get('id')): question for question in definition.get('questions') or []
             if isinstance(question, Mapping)}
    kpis, matrices = [], []
    for result in results.get('questions') or []:
        question = by_id.get(str(result.get('id')))
        if question is None:
            continue
        if question.get('type') in (RATING, NPS, CSAT, CES):
            kpis.append(_kpi(result))
        elif question.get('type') == MATRIX:
            matrices.append(_matrix(question, result))
    return {'kpis': kpis, 'matrices': matrices}


# ── The stored AI summary ────────────────────────────────────────────────────────────────────────────────────────

def latest_report(scope: Any, table: Any, partition: str, form_id: str) -> dict[str, Any] | None:
    """The form's newest stored report (report ids sort by their time), or None."""
    page = query_partition(scope, table, 'pk', partition, sort=SortRange('sk', 'begins_with',
                                                                         f'{REPORT_PREFIX}{form_id}#'),
                           ScanIndexForward=False, Limit=1)
    items = page.get('Items') or []
    return plain(dict(items[0])) if items else None


def _quote_text(definition: Mapping[str, Any], row: ResultRow) -> str:
    """A response's free-text answers, in the form's order, as one quote."""
    texts = [_answer(row, str(question['id'])) for question in _free_text_questions(definition)]
    return ' · '.join(text for text in texts if text)[:MAX_QUOTE_CHARS]


def _text_filters(stored: Mapping[str, Any]) -> dict[str, str]:
    """A stored summary's ``filters`` (the query's own names, shared/forms_v2_report_ai.py), text values only."""
    raw = stored.get('filters')
    return {str(key): value for key, value in raw.items() if isinstance(value, str)} if isinstance(raw, Mapping) else {}


def _under(filters: Mapping[str, str], rows: Sequence[ResultRow]) -> list[ResultRow]:
    """``rows`` under a summary's filters (``from``, ``to``, ``language``, ``ending``, ``hidden.<id>``; any other name,
    like the app's ``days``, only describes the view)."""
    hidden = {key.removeprefix('hidden.'): value for key, value in filters.items() if key.startswith('hidden.')}
    return filter_rows(rows, date_from=filters.get('from', ''), date_to=filters.get('to', ''),
                       language=filters.get('language', ''), ending=filters.get('ending', ''), hidden=hidden)


def ai_view(stored: Mapping[str, Any] | None, definition: Mapping[str, Any],
            visible: Sequence[ResultRow]) -> dict[str, Any] | None:
    """The stored report as this reader may see it, under the filters it was made with (``filters``, whatever the
    view's): its themes' quotes joined against ``visible`` (every real response the reader's access admits) under
    those filters, an unknown id dropped; ``stale`` when a visible response under them is newer than the newest it
    read. Withheld (``{report_id, created_at, withheld: 'access'}``) when it read a response the reader cannot see.
    None when the form has no stored report."""
    if not stored:
        return None
    filters = _text_filters(stored)
    rows = {row.response_id: row for row in visible if row.response_id}
    read = [str(rid) for rid in stored.get('response_ids') or []]
    base = {'report_id': stored.get('report_id'), 'created_at': stored.get('created_at'),
            'created_by': stored.get('created_by')}
    if any(rid not in rows for rid in read):
        return {**base, 'withheld': 'access'}
    scoped = _under(filters, list(rows.values()))
    rows = {row.response_id: row for row in scoped}
    newest = max((row.created_at for row in scoped), default='')
    last = str(stored.get('last_response_at') or '')
    stored_ai = stored.get('ai')
    ai: Mapping[str, Any] = stored_ai if isinstance(stored_ai, Mapping) else {}
    joined = []
    for theme in stored.get('themes') or []:
        if not isinstance(theme, Mapping):
            continue
        quotes = [{'response_id': rid, 'text': _quote_text(definition, rows[rid])}
                  for rid in (str(q) for q in theme.get('quote_ids') or []) if rid in rows]
        joined.append({'label': theme.get('label'), 'count': theme.get('count'), 'sentiment': theme.get('sentiment'),
                       'quotes': [quote for quote in quotes if quote['text']]})
    return {**base, 'responses_counted': stored.get('responses_counted'), 'last_response_at': last or None,
            'filters': filters, 'model': ai.get('model'), 'prompt_version': ai.get('prompt_version'),
            'summary': ai.get('summary') or '', 'themes': joined, 'stale': bool(newest) and newest > last}

"""Company context, personal objectives and the company design system.

Storage (aggregates table):

    SETTINGS#company_context / config   vision (markdown) + objectives — admins edit, everyone reads
    USERCTX#{sub}            / config   one user's own objectives + KPIs (self only)
    SETTINGS#design_system   / config   tokens + guidelines + logo_url — admins edit, everyone reads
    SETTINGS#design_system   / REF#{id} one design reference (screenshot | html | figma | github)

References are sibling ROWS rather than a list on the config item so the async
Figma/GitHub refresh can update one reference without a read-modify-write
racing an admin saving tokens. A design-system read is therefore one Query on
the partition.

This module owns validation (every write path calls `validate_*`), the read
helpers every Lambda may use, and the DATA-block builders injected into model
prompts (`company_context_block`, `design_system_block`). The builders never
raise and return '' when nothing is configured, so a prompt built for an
unconfigured deployment is byte-identical to one built before this existed.

Owners of the routes: `api/settings_handler.py`. Consumers of the blocks: the
document generator (PRD / PR-FAQ / prototype), the agents runtime and the
stream assistant's company tools.
"""
from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Any

from boto3.dynamodb.conditions import Key

from shared.exceptions import ValidationError
from shared.logging import logger
from shared.prompt_safety import data_block, injection_findings

COMPANY_CONTEXT_PK = 'SETTINGS#company_context'
DESIGN_SYSTEM_PK = 'SETTINGS#design_system'
CONFIG_SK = 'config'
REFERENCE_SK_PREFIX = 'REF#'


def user_context_pk(sub: str) -> str:
    return f'USERCTX#{sub}'


# ── Limits ───────────────────────────────────────────────────────────────────
MAX_VISION_CHARS = 20_000
MAX_COMPANY_OBJECTIVES = 50
MAX_PERSONAL_OBJECTIVES = 20
MAX_KPIS_PER_OBJECTIVE = 10
MAX_TITLE_CHARS = 200
MAX_DESCRIPTION_CHARS = 2_000
MAX_KPI_FIELD_CHARS = 120
MAX_GUIDELINES_CHARS = 20_000
MAX_TOKEN_ENTRIES = 40
MAX_TOKEN_NAME_CHARS = 60
MAX_TOKEN_VALUE_CHARS = 120
MAX_URL_CHARS = 2_048
MAX_REFERENCES = 50
MAX_SUMMARY_CHARS = 4_000

# Prompt budgets for the two blocks (characters). Sized so both together stay
# well under a single PER_DOC_CAP-sized spec document in the prototype prompt.
COMPANY_BLOCK_CAP = 12_000
DESIGN_BLOCK_CAP = 12_000

HORIZONS = ('long', 'quarter', 'date')
REFERENCE_KINDS = ('screenshot', 'html', 'figma', 'github')
UPLOAD_KINDS = ('screenshot', 'html')
LINK_KINDS = ('figma', 'github')

_ID_RE = re.compile(r'^[a-z]{2,4}_[0-9a-f]{12}$')
_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
# CSS colour values a prompt can rely on: hex, rgb()/rgba()/hsl()/hsla(), or a
# bare keyword. Anything else (url(), expressions, braces) is refused.
_COLOR_RE = re.compile(
    r'^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}'
    r'|(rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/+-]+\)'
    r'|[a-zA-Z]{3,30})$'
)
# Lengths: 12px, 1.25rem, 0, 50%, 9999px.
_LENGTH_RE = re.compile(r'^(0|\d{1,4}(\.\d{1,3})?(px|rem|em|%|pt|vh|vw))$')
_FONT_FAMILY_RE = re.compile(r'^[\w\s,"\'.-]{1,200}$', re.UNICODE)
_WEIGHT_RE = re.compile(r'^([1-9]00|normal|bold|lighter|bolder)$')


def new_id(prefix: str) -> str:
    """``{prefix}_`` + 12 hex — the id shape every row in this module uses."""
    return f'{prefix}_{uuid.uuid4().hex[:12]}'


# ── Field validators ─────────────────────────────────────────────────────────

def _text(value: object, field: str, limit: int, *, required: bool = False) -> str:
    raw = '' if value is None else value
    if not isinstance(raw, str):
        raise ValidationError(f'{field} must be a string')
    text = raw.strip()
    if required and not text:
        raise ValidationError(f'{field} is required')
    if len(text) > limit:
        raise ValidationError(f'{field} must be at most {limit} characters')
    findings = injection_findings(text)
    if findings:
        raise ValidationError(
            f'{field} contains text that looks like instructions to the AI '
            f'({", ".join(findings)}); rephrase it as plain content'
        )
    return text


def _list(value: object, field: str, limit: int) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationError(f'{field} must be a list')
    if len(value) > limit:
        raise ValidationError(f'{field} may hold at most {limit} entries')
    return value


def _object(value: object, field: str) -> dict:
    if not isinstance(value, dict):
        raise ValidationError(f'{field} must be an object')
    return value


def _due(value: object, field: str) -> str | None:
    if value in (None, ''):
        return None
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        raise ValidationError(f'{field} must be a date (YYYY-MM-DD)')
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError(f'{field} is not a real date') from exc
    return value


def _item_id(value: object, prefix: str) -> str:
    """Keep a client-supplied id of the right shape (so edits keep identity), else mint one."""
    if isinstance(value, str) and _ID_RE.fullmatch(value) and value.startswith(f'{prefix}_'):
        return value
    return new_id(prefix)


def _unique_ids(items: list[dict], field: str) -> None:
    ids = [i['id'] for i in items]
    if len(ids) != len(set(ids)):
        raise ValidationError(f'{field} ids must be unique')


def https_url(value: object, field: str) -> str | None:
    """An https URL (≤ 2048 chars) or None. Other schemes are refused."""
    if value in (None, ''):
        return None
    if not isinstance(value, str) or len(value) > MAX_URL_CHARS:
        raise ValidationError(f'{field} must be a URL of at most {MAX_URL_CHARS} characters')
    url = value.strip()
    if not re.fullmatch(r'https://[^\s/$.?#][^\s]*', url, re.IGNORECASE):
        raise ValidationError(f'{field} must be an https:// URL')
    return url


# ── Company context ──────────────────────────────────────────────────────────

def _company_objective(raw: object, index: int) -> dict:
    field = f'objectives[{index}]'
    obj = _object(raw, field)
    horizon = obj.get('horizon', 'long')
    if horizon not in HORIZONS:
        raise ValidationError(f'{field}.horizon must be one of: {", ".join(HORIZONS)}')
    due = _due(obj.get('due'), f'{field}.due')
    if horizon == 'date' and not due:
        raise ValidationError(f'{field}.due is required when horizon is "date"')
    out = {
        'id': _item_id(obj.get('id'), 'obj'),
        'title': _text(obj.get('title'), f'{field}.title', MAX_TITLE_CHARS, required=True),
        'description': _text(obj.get('description'), f'{field}.description', MAX_DESCRIPTION_CHARS),
        'horizon': horizon,
    }
    if due:
        out['due'] = due
    return out


def validate_company_context(body: dict) -> dict:
    """``{vision, objectives}`` from a PUT body, validated and normalised."""
    objectives = [
        _company_objective(o, i)
        for i, o in enumerate(_list(body.get('objectives'), 'objectives', MAX_COMPANY_OBJECTIVES))
    ]
    _unique_ids(objectives, 'objectives')
    return {
        'vision': _text(body.get('vision'), 'vision', MAX_VISION_CHARS),
        'objectives': objectives,
    }


def _kpi(raw: object, field: str) -> dict:
    kpi = _object(raw, field)
    target = kpi.get('target')
    if isinstance(target, bool) or not isinstance(target, (str, int, float)):
        raise ValidationError(f'{field}.target must be a number or a string')
    out: dict[str, Any] = {
        'name': _text(kpi.get('name'), f'{field}.name', MAX_KPI_FIELD_CHARS, required=True),
        # Strings stay strings ("< 2 s"); numbers are stored as their string
        # form too, so DynamoDB never sees a float and the wire type is stable.
        'target': _text(str(target), f'{field}.target', MAX_KPI_FIELD_CHARS, required=True),
    }
    unit = _text(kpi.get('unit'), f'{field}.unit', MAX_KPI_FIELD_CHARS)
    if unit:
        out['unit'] = unit
    return out


def _personal_objective(raw: object, index: int) -> dict:
    field = f'objectives[{index}]'
    obj = _object(raw, field)
    out: dict[str, Any] = {
        'id': _item_id(obj.get('id'), 'obj'),
        'title': _text(obj.get('title'), f'{field}.title', MAX_TITLE_CHARS, required=True),
        'description': _text(obj.get('description'), f'{field}.description', MAX_DESCRIPTION_CHARS),
        'kpis': [
            _kpi(k, f'{field}.kpis[{j}]')
            for j, k in enumerate(_list(obj.get('kpis'), f'{field}.kpis', MAX_KPIS_PER_OBJECTIVE))
        ],
    }
    due = _due(obj.get('due'), f'{field}.due')
    if due:
        out['due'] = due
    return out


def validate_my_context(body: dict) -> dict:
    """``{objectives}`` for one user's personal context."""
    objectives = [
        _personal_objective(o, i)
        for i, o in enumerate(_list(body.get('objectives'), 'objectives', MAX_PERSONAL_OBJECTIVES))
    ]
    _unique_ids(objectives, 'objectives')
    return {'objectives': objectives}


# ── Design system ────────────────────────────────────────────────────────────

def _token_name(raw: object, field: str) -> str:
    return _text(raw, field, MAX_TOKEN_NAME_CHARS, required=True)


def _named_values(value: object, field: str, value_re: re.Pattern[str], what: str) -> list[dict]:
    out = []
    for i, raw in enumerate(_list(value, field, MAX_TOKEN_ENTRIES)):
        entry = _object(raw, f'{field}[{i}]')
        token_value = entry.get('value')
        if (not isinstance(token_value, str) or len(token_value) > MAX_TOKEN_VALUE_CHARS
                or not value_re.match(token_value.strip())):
            raise ValidationError(f'{field}[{i}].value must be {what}')
        out.append({'name': _token_name(entry.get('name'), f'{field}[{i}].name'), 'value': token_value.strip()})
    return out


def _typography(value: object) -> list[dict]:
    out = []
    for i, raw in enumerate(_list(value, 'tokens.typography', MAX_TOKEN_ENTRIES)):
        field = f'tokens.typography[{i}]'
        entry = _object(raw, field)
        family = entry.get('family')
        if not isinstance(family, str) or not _FONT_FAMILY_RE.match(family.strip()):
            raise ValidationError(f'{field}.family must be a font-family list (letters, digits, spaces, commas, quotes)')
        row: dict[str, Any] = {'role': _token_name(entry.get('role'), f'{field}.role'), 'family': family.strip()}
        size = entry.get('size')
        if size not in (None, ''):
            if not isinstance(size, str) or not _LENGTH_RE.match(size.strip()):
                raise ValidationError(f'{field}.size must be a CSS length such as 16px or 1rem')
            row['size'] = size.strip()
        weight = entry.get('weight')
        if weight not in (None, ''):
            weight_text = str(weight).strip()
            if (isinstance(weight, bool) or not isinstance(weight, (str, int))
                    or not _WEIGHT_RE.match(weight_text)):
                raise ValidationError(f'{field}.weight must be 100-900 or normal/bold')
            row['weight'] = weight_text
        out.append(row)
    return out


def validate_design_system(body: dict) -> dict:
    """``{tokens, guidelines, logo_url}`` from a PUT body, validated and normalised."""
    tokens_raw = body.get('tokens') if body.get('tokens') is not None else {}
    tokens = _object(tokens_raw, 'tokens')
    out_tokens: dict[str, list] = {
        'colors': _named_values(tokens.get('colors'), 'tokens.colors', _COLOR_RE, 'a CSS colour (#hex, rgb(), hsl() or a keyword)'),
        'typography': _typography(tokens.get('typography')),
    }
    for optional in ('spacing', 'radius'):
        if tokens.get(optional) is not None:
            out_tokens[optional] = _named_values(
                tokens.get(optional), f'tokens.{optional}', _LENGTH_RE, 'a CSS length such as 8px or 0.5rem')
    result: dict[str, Any] = {
        'tokens': out_tokens,
        'guidelines': _text(body.get('guidelines'), 'guidelines', MAX_GUIDELINES_CHARS),
    }
    logo_url = https_url(body.get('logo_url'), 'logo_url')
    if logo_url:
        result['logo_url'] = logo_url
    return result


def validate_reference_request(body: dict) -> dict:
    """``{kind, title, url?}`` for a new design reference."""
    kind = body.get('kind')
    if kind not in REFERENCE_KINDS:
        raise ValidationError(f'kind must be one of: {", ".join(REFERENCE_KINDS)}')
    out: dict[str, Any] = {
        'kind': kind,
        'title': _text(body.get('title'), 'title', MAX_TITLE_CHARS, required=True),
    }
    url = https_url(body.get('url'), 'url')
    if kind in LINK_KINDS and not url:
        raise ValidationError(f'url is required for a {kind} reference')
    if url:
        out['url'] = url
    return out


# ── Reads ────────────────────────────────────────────────────────────────────

def _get(table: Any, pk: str, sk: str = CONFIG_SK) -> dict:
    item = table.get_item(Key={'pk': pk, 'sk': sk}).get('Item')
    return item if isinstance(item, dict) else {}


def _clean_list(value: object) -> list:
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def get_company_context(table: Any) -> dict:
    """Public view ``{vision, objectives, updated_at, updated_by_username}``."""
    item = _get(table, COMPANY_CONTEXT_PK)
    return {
        'vision': item.get('vision') if isinstance(item.get('vision'), str) else '',
        'objectives': _clean_list(item.get('objectives')),
        'updated_at': item.get('updated_at'),
        'updated_by_username': item.get('updated_by_username'),
    }


def get_my_context(table: Any, sub: str) -> dict:
    """One user's ``{objectives, updated_at}`` (the row is keyed by their sub)."""
    item = _get(table, user_context_pk(sub))
    return {'objectives': _clean_list(item.get('objectives')), 'updated_at': item.get('updated_at')}


def reference_view(item: dict) -> dict:
    """The public shape of one reference row (no keys, no internal fields)."""
    view = {
        'id': item.get('id'),
        'kind': item.get('kind'),
        'title': item.get('title', ''),
        'status': item.get('status', 'pending'),
        'created_at': item.get('created_at'),
        'updated_at': item.get('updated_at'),
    }
    for optional in ('url', 's3_key', 'extracted_summary', 'error', 'fetched_at', 'content_type'):
        if item.get(optional):
            view[optional] = item[optional]
    return view


def list_references(table: Any, *, include_archived: bool = False) -> list[dict]:
    """Every reference row, oldest first (ids are random, so sort on created_at)."""
    items: list[dict] = []
    params: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(DESIGN_SYSTEM_PK) & Key('sk').begins_with(REFERENCE_SK_PREFIX),
    }
    while True:
        response = table.query(**params)
        items.extend(i for i in response.get('Items', []) if isinstance(i, dict))
        start_key = response.get('LastEvaluatedKey')
        if not isinstance(start_key, dict) or not start_key:
            break
        params['ExclusiveStartKey'] = start_key
    if not include_archived:
        items = [i for i in items if i.get('status') != 'archived']
    items.sort(key=lambda i: str(i.get('created_at') or ''))
    return [reference_view(i) for i in items]


def get_reference(table: Any, ref_id: object) -> dict | None:
    """The stored reference, or None — ``ref_id`` may come straight off a request path."""
    if not isinstance(ref_id, str) or not _ID_RE.fullmatch(ref_id):
        return None
    item = _get(table, DESIGN_SYSTEM_PK, f'{REFERENCE_SK_PREFIX}{ref_id}')
    return item or None


def get_design_system(table: Any, *, include_archived: bool = False) -> dict:
    """Public view without ``integrations`` (the handler adds those from the secret)."""
    item = _get(table, DESIGN_SYSTEM_PK)
    raw_tokens = item.get('tokens')
    tokens = raw_tokens if isinstance(raw_tokens, dict) else {}
    view: dict[str, Any] = {
        'tokens': {
            'colors': _clean_list(tokens.get('colors')),
            'typography': _clean_list(tokens.get('typography')),
            **{k: _clean_list(tokens.get(k)) for k in ('spacing', 'radius') if k in tokens},
        },
        'guidelines': item.get('guidelines') if isinstance(item.get('guidelines'), str) else '',
        'references': list_references(table, include_archived=include_archived),
        'updated_at': item.get('updated_at'),
    }
    if item.get('logo_url'):
        view['logo_url'] = item['logo_url']
    return view


# ── Prompt blocks ────────────────────────────────────────────────────────────

_HORIZON_LABELS = {'long': 'long-term', 'quarter': 'this quarter', 'date': 'dated'}


def _objective_line(obj: dict) -> str:
    qualifiers = [q for q in (
        _HORIZON_LABELS.get(str(obj.get('horizon')), ''),
        f'due {obj["due"]}' if obj.get('due') else '',
    ) if q]
    head = f'- {str(obj.get("title") or "").strip()}'
    if qualifiers:
        head += f' ({", ".join(qualifiers)})'
    description = str(obj.get('description') or '').strip()
    return f'{head}: {description}' if description else head


def _kpi_line(kpi: dict) -> str:
    unit = f' {kpi["unit"]}' if kpi.get('unit') else ''
    return f'    - KPI {kpi.get("name", "")}: target {kpi.get("target", "")}{unit}'


def company_context_text(company: dict, personal: dict | None = None) -> str:
    """The plain-text body of the company-context block ('' when empty)."""
    parts: list[str] = []
    vision = str(company.get('vision') or '').strip()
    if vision:
        parts.append(f'Company vision:\n{vision}')
    objectives = _clean_list(company.get('objectives'))
    if objectives:
        parts.append('Company objectives:\n' + '\n'.join(_objective_line(o) for o in objectives))
    own = _clean_list((personal or {}).get('objectives'))
    if own:
        lines = []
        for obj in own:
            lines.append(_objective_line(obj))
            lines.extend(_kpi_line(k) for k in _clean_list(obj.get('kpis')))
        parts.append("The requesting user's own objectives:\n" + '\n'.join(lines))
    return '\n\n'.join(parts)[:COMPANY_BLOCK_CAP]


def _token_lines(tokens: dict) -> list[str]:
    lines: list[str] = []
    colors = _clean_list(tokens.get('colors'))
    if colors:
        lines.append('Colours: ' + '; '.join(f'{c.get("name")} = {c.get("value")}' for c in colors))
    typography = _clean_list(tokens.get('typography'))
    if typography:
        rows = []
        for t in typography:
            extras = ', '.join(str(t[k]) for k in ('size', 'weight') if t.get(k))
            rows.append(f'{t.get("role")} = {t.get("family")}' + (f' ({extras})' if extras else ''))
        lines.append('Typography: ' + '; '.join(rows))
    for key, label in (('spacing', 'Spacing'), ('radius', 'Corner radius')):
        entries = _clean_list(tokens.get(key))
        if entries:
            lines.append(f'{label}: ' + '; '.join(f'{e.get("name")} = {e.get("value")}' for e in entries))
    return lines


def design_system_text(design: dict) -> str:
    """The plain-text body of the design-system block ('' when empty).

    Only READY references with a summary are included; archived, pending and
    failed ones contribute nothing.
    """
    parts: list[str] = []
    raw_tokens = design.get('tokens')
    tokens = raw_tokens if isinstance(raw_tokens, dict) else {}
    token_lines = _token_lines(tokens)
    if token_lines:
        parts.append('Design tokens:\n' + '\n'.join(token_lines))
    guidelines = str(design.get('guidelines') or '').strip()
    if guidelines:
        parts.append(f'Guidelines:\n{guidelines}')
    summaries = [
        f'- {r.get("title")} ({r.get("kind")}): {str(r.get("extracted_summary")).strip()[:MAX_SUMMARY_CHARS]}'
        for r in _clean_list(design.get('references'))
        if r.get('status') == 'ready' and r.get('extracted_summary')
    ]
    if summaries:
        parts.append('Reference summaries (extracted from the company\'s designs):\n' + '\n'.join(summaries))
    return '\n\n'.join(parts)[:DESIGN_BLOCK_CAP]


def company_context_block(table: Any, sub: str | None = None) -> str:
    """``<company_context>`` DATA block (company vision/objectives + the user's own) or ''.

    Never raises: a missing table or a failed read costs the prompt this block,
    never the generation.
    """
    if table is None:
        return ''
    try:
        company = get_company_context(table)
        personal = get_my_context(table, sub) if sub else None
    except Exception as e:  # noqa: BLE001 - optional prompt context must never fail a generation
        logger.warning(f'Company context unavailable for prompt: {type(e).__name__}')
        return ''
    return data_block('company_context', company_context_text(company, personal))


def design_system_block(table: Any) -> str:
    """``<design_system>`` DATA block (tokens + guidelines + ready reference summaries) or ''."""
    if table is None:
        return ''
    try:
        design = get_design_system(table)
    except Exception as e:  # noqa: BLE001 - optional prompt context must never fail a generation
        logger.warning(f'Design system unavailable for prompt: {type(e).__name__}')
        return ''
    return data_block('design_system', design_system_text(design))

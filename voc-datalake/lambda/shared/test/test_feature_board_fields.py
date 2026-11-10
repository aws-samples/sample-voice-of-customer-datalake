"""The board field catalogue and its checks (shared/feature_board_fields.py).

The SPA's ``frontend/src/api/boardFields.ts`` lockstep test reads the module's constants as TEXT,
so the first test pins that every shared constant is a plain literal assignment.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from shared import feature_board_fields as fields
from shared.exceptions import ValidationError

SOURCE = Path(fields.__file__).read_text(encoding='utf-8')
SHARED_CONSTANTS = (
    'TEMPLATES', 'LEVELS', 'REQUEST_FIELD_KEYS', 'SUPPORT_FIELD_KEYS', 'TEXT_FIELD_LIMITS', 'CHOICE_FIELD_OPTIONS',
    'NUMBER_FIELD_RANGES', 'EMAIL_FIELDS', 'URL_FIELDS', 'MAX_LINK_CHARS', 'MAX_STATUSES', 'MAX_STATUS_LABEL',
    'STATUS_KEY_PATTERN', 'TEMPLATE_FIELDS', 'TEMPLATE_STATUSES', 'TEMPLATE_TOTALS',
)


def _literal_assignments() -> dict[str, object]:
    found: dict[str, object] = {}
    for node in ast.parse(SOURCE).body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            try:
                found[node.target.id] = ast.literal_eval(node.value)
            except ValueError:
                continue
    return found


def test_the_shared_constants_are_plain_literals_the_spa_can_read():
    literals = _literal_assignments()
    for name in SHARED_CONSTANTS:
        assert name in literals, name
        assert literals[name] == getattr(fields, name), name


def test_every_template_names_catalogue_fields_only():
    assert set(fields.TEMPLATE_FIELDS) == set(fields.TEMPLATES) == set(fields.TEMPLATE_STATUSES)
    assert set(fields.TEMPLATE_TOTALS) == set(fields.TEMPLATES)
    for template in fields.TEMPLATES:
        config = fields.template_fields(template)
        assert set(config['request']) == set(fields.REQUEST_FIELD_KEYS)
        assert set(config['support']) == set(fields.SUPPORT_FIELD_KEYS)
        assert fields.validate_statuses(fields.template_statuses(template))[0]['key'] == 'new'
    catalogue = set(fields.REQUEST_FIELD_KEYS) | set(fields.SUPPORT_FIELD_KEYS)
    typed = (set(fields.TEXT_FIELD_LIMITS) | set(fields.CHOICE_FIELD_OPTIONS) | set(fields.NUMBER_FIELD_RANGES)
             | set(fields.EMAIL_FIELDS) | set(fields.URL_FIELDS))
    assert typed == catalogue


@pytest.mark.parametrize(('key', 'raw', 'expected'), [
    ('customer', '  Acme ', 'Acme'), ('impact', 'none', 'none'), ('amount_usd', 0, 0),
    ('contact_email', 'CIO@Acme.example', 'cio@acme.example'), ('rating', 5, 5),
    ('link', 'https://example.com/a?b=1', 'https://example.com/a?b=1'), ('affected_count', 1, 1),
])
def test_field_values_are_normalised(key, raw, expected):
    assert fields.field_value(key, raw) == expected


@pytest.mark.parametrize(('key', 'raw'), [
    ('customer', 5), ('customer', 'x' * 161), ('impact', 'maybe'), ('amount_usd', -1), ('amount_usd', True),
    ('amount_usd', 1.5), ('rating', '5'), ('link', 'ftp://example.com'), ('link', 'https://exa mple.com'),
    ('contact_email', 'nope'), ('affected_count', 1_000_001),
])
def test_bad_field_values_are_refused(key, raw):
    with pytest.raises(ValidationError):
        fields.field_value(key, raw)


def test_a_stored_board_with_unreadable_config_reads_as_its_template():
    board = {'template': 'service', 'fields': 'garbage', 'statuses': [{'key': 'BAD'}]}
    assert fields.fields_of(board) == fields.template_fields('service')
    assert fields.status_keys(board) == ['new', 'confirmed', 'fixed', 'wont_fix']
    assert fields.template_of('nope') == 'blank'


def test_legacy_bodies_are_read_leniently_and_fields_strictly():
    board = {'template': 'sales'}
    legacy = {'title': 'T', 'customer': 'Acme', 'impact': 'none', 'amount_usd': 7, 'note': 'ignored here'}
    assert fields.field_values(board, 'request', legacy) == {'customer': 'Acme', 'impact': 'none', 'amount_usd': 0}
    with pytest.raises(ValidationError, match='note is not a field'):
        fields.field_values(board, 'request', {'fields': {'customer': 'A', 'impact': 'none', 'note': 'x'}})
    with pytest.raises(ValidationError, match='fields must be an object'):
        fields.field_values(board, 'request', {'fields': []})

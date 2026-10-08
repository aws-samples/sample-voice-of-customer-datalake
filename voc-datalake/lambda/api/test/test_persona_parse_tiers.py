"""Persona synthesis output is parsed in tiers, keeping every persona that survives (#235).

The old parse was one greedy regex plus `json.loads`, and ANY failure raised —
so a trailing comma or a truncated last object discarded a multi-minute,
already-billed generation. Tiers: strict JSON → fenced block → first balanced
top-level array → per-object salvage. Only zero survivors is an error.
"""
import json

import pytest

from shared.exceptions import ServiceError

A, B = {'name': 'Ada'}, {'name': 'Bo'}


def _parse(text: str):
    from projects import _parse_personas

    return _parse_personas(text)


def _outcome(text: str) -> tuple[list[str], str, int]:
    parsed = _parse(text)
    return [p['name'] for p in parsed.personas], parsed.tier, parsed.dropped


def test_strict_json_is_taken_as_is():
    assert _outcome(json.dumps([A, B])) == (['Ada', 'Bo'], 'strict', 0)


def test_a_fenced_block_inside_prose_is_found():
    text = f"Here you go:\n```json\n{json.dumps([A, B])}\n```\nHope that helps [1]."

    assert _outcome(text) == (['Ada', 'Bo'], 'fenced', 0)


def test_the_first_balanced_array_ignores_brackets_in_strings_and_trailing_junk():
    """A greedy `[...]` regex runs to the LAST `}]` — here inside the trailing
    junk — and the decode fails. Bracket-matching stops at the array's own end."""
    first = {'name': 'Ada', 'quotes': ['it ] broke {badly}']}
    text = f'Personas: {json.dumps([first, B])} and also {{"x": [1]}}]'

    assert _outcome(text) == (['Ada', 'Bo'], 'array', 0)


def test_salvage_keeps_the_valid_personas_around_a_malformed_one():
    text = '[{"name": "Ada"}, {"name": "Bo",}, {"name": "Cy"}]'

    assert _outcome(text) == (['Ada', 'Cy'], 'salvage', 1)


def test_salvage_counts_a_truncated_final_persona_as_dropped():
    text = '[{"name": "Ada"}, {"name": "Bo"}, {"name": "Cy", "bio": "cut off mid'

    assert _outcome(text) == (['Ada', 'Bo'], 'salvage', 1)


def test_salvage_is_not_fooled_by_braces_inside_strings():
    text = '[{"name": "Ada {the first}"}, {"name": "Bo" "oops"}]'

    assert _outcome(text) == (['Ada {the first}'], 'salvage', 1)


@pytest.mark.parametrize('text', [
    pytest.param('I was unable to produce the profiles.', id='no array'),
    pytest.param('[{"name": "Ada",}, {"name": }]', id='every object malformed'),
    pytest.param('[]', id='empty array'),
    pytest.param('["Ada", "Bo"]', id='array of non-objects'),
])
def test_zero_surviving_personas_is_still_an_error(text):
    with pytest.raises(ServiceError):
        _parse(text)

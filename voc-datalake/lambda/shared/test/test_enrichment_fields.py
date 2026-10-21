"""Tests for shared/enrichment_fields.py — the enrichment-field registry."""
import json
import re
from pathlib import Path

import pytest

from shared.enrichment_fields import (
    ENRICHMENT_FIELDS,
    UNSCORED,
    USEFULNESS,
    build_single_field_prompt,
    extract_enrichment_values,
    field_names,
    get_field,
    item_value,
    normalize_value,
    prompt_guides,
    prompt_schema_fragment,
)

REPO_ROOT = Path(__file__).resolve().parents[3]  # voc-datalake/
FRONTEND_REGISTRY = REPO_ROOT / 'frontend' / 'src' / 'api' / 'enrichmentFields.ts'


class TestRegistryShape:
    # Collision with the processor's own item attributes is pinned against the
    # parsed item literal in processor/test/test_enrichment_registry.py.

    def test_names_are_unique(self):
        names = field_names()
        assert len(names) == len(set(names))

    @pytest.mark.parametrize('field', ENRICHMENT_FIELDS, ids=lambda f: f.name)
    def test_values_are_lowercase_unique_and_never_the_unscored_sentinel(self, field):
        assert field.values
        assert len(field.values) == len(set(field.values))
        assert all(v == v.strip().lower() for v in field.values)
        assert UNSCORED not in field.values

    @pytest.mark.parametrize('field', ENRICHMENT_FIELDS, ids=lambda f: f.name)
    def test_names_are_safe_query_params_and_dynamodb_attributes(self, field):
        assert re.fullmatch(r'[a-z][a-z0-9_]*', field.name)

    @pytest.mark.parametrize('field', ENRICHMENT_FIELDS, ids=lambda f: f.name)
    def test_guides_contain_no_braces_that_would_break_str_format(self, field):
        # The processor escapes braces, but a brace-free guide is the contract the
        # fragment docstring promises; keeping it means no escaping surprises.
        assert '{' not in field.guide and '}' not in field.guide

    def test_get_field_finds_registered_fields_only(self):
        assert get_field('usefulness') is USEFULNESS
        assert get_field('category') is None


class TestNormalizeValue:
    @pytest.mark.parametrize('raw,expected', [
        ('high', 'high'), (' High ', 'high'), ('LOW', 'low'), ('medium', 'medium'),
    ])
    def test_accepts_declared_values_after_trim_and_lowercase(self, raw, expected):
        assert normalize_value(USEFULNESS, raw) == expected

    @pytest.mark.parametrize('raw', ['n/a', '', 'very high', None, 3, ['high'], UNSCORED])
    def test_rejects_anything_outside_the_enum(self, raw):
        assert normalize_value(USEFULNESS, raw) is None


class TestExtractEnrichmentValues:
    def test_keeps_valid_values(self):
        assert extract_enrichment_values({'usefulness': 'High', 'category': 'x'}) == {'usefulness': 'high'}

    def test_omits_missing_and_invalid_values_instead_of_defaulting(self):
        assert extract_enrichment_values({}) == {}
        assert extract_enrichment_values({'usefulness': 'sort of'}) == {}

    def test_tolerates_a_non_dict_response(self):
        assert extract_enrichment_values(None) == {}  # type: ignore[arg-type]
        assert extract_enrichment_values(['usefulness']) == {}  # type: ignore[arg-type]


class TestPromptPieces:
    def test_schema_fragment_is_valid_json_object_content(self):
        parsed = json.loads('{' + prompt_schema_fragment() + '}')
        assert parsed == {f.name: '|'.join(f.values) for f in ENRICHMENT_FIELDS}

    def test_guides_name_every_field(self):
        guides = prompt_guides()
        for field in ENRICHMENT_FIELDS:
            assert f'{field.name} rating guide:' in guides

    def test_single_field_prompt_asks_for_exactly_that_key_and_clips_text(self):
        prompt = build_single_field_prompt(USEFULNESS, 'x' * 5000, max_chars=100)
        assert '{"usefulness":"high|medium|low"}' in prompt
        assert 'x' * 100 in prompt
        assert 'x' * 101 not in prompt


class TestItemValue:
    def test_reads_stored_value(self):
        assert item_value({'usefulness': 'low'}, USEFULNESS) == 'low'

    def test_missing_or_invalid_reads_as_unscored(self):
        assert item_value({}, USEFULNESS) == UNSCORED
        assert item_value({'usefulness': 'bogus'}, USEFULNESS) == UNSCORED


class TestFrontendRegistryLockstep:
    """frontend/src/api/enrichmentFields.ts must declare the same fields and values.

    The frontend cannot import this module, so it restates the registry; a drift
    would render filter options the backend ignores, or hide ones it accepts.
    """

    def _frontend_fields(self) -> dict[str, tuple[str, ...]]:
        source = FRONTEND_REGISTRY.read_text(encoding='utf-8')
        entries = re.findall(
            r"name:\s*'([a-z0-9_]+)'\s*,\s*values:\s*\[([^\]]*)\]", source,
        )
        assert entries, f'No registry entries parsed from {FRONTEND_REGISTRY}'
        return {
            name: tuple(re.findall(r"'([^']+)'", values))
            for name, values in entries
        }

    def test_frontend_declares_the_same_fields_in_the_same_order(self):
        frontend = self._frontend_fields()
        assert list(frontend) == list(field_names())
        for field in ENRICHMENT_FIELDS:
            assert frontend[field.name] == field.values, field.name

    def test_frontend_unscored_sentinel_matches(self):
        source = FRONTEND_REGISTRY.read_text(encoding='utf-8')
        assert re.search(rf"UNSCORED\s*=\s*'{UNSCORED}'", source)

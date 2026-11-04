"""The server's theme ids mirror the SPA's catalogue, and the view/parse helpers hold their rules."""
import re

import pytest

from shared.appearance import DEFAULT_THEME, THEME_IDS, appearance_view, parse_default_theme
from shared.test.repo_paths import repo_root

FRONTEND_CATALOG = 'frontend/src/theme/themeCatalog.ts'


def _frontend_constant(pattern: str) -> str:
    source = (repo_root() / FRONTEND_CATALOG).read_text(encoding='utf-8')
    match = re.search(pattern, source)
    assert match, f'{pattern} not found in {FRONTEND_CATALOG}'
    return match.group(1)


def _frontend_theme_ids() -> tuple[str, ...]:
    body = _frontend_constant(r'export const COLOR_THEME_IDS = \[([^\]]*)\] as const')
    return tuple(re.findall(r"'([^']+)'", body))


def test_the_frontend_catalogue_parses():
    """Positive control: the mirrored constant is really read (see repo_paths.py)."""
    assert len(_frontend_theme_ids()) >= 2


def test_theme_ids_mirror_the_frontend_catalogue():
    assert _frontend_theme_ids() == THEME_IDS


def test_the_default_theme_mirrors_the_frontend():
    assert _frontend_constant(r"export const DEFAULT_COLOR_THEME: ColorThemeId = '([^']+)'") == DEFAULT_THEME
    assert DEFAULT_THEME in THEME_IDS


@pytest.mark.parametrize('item', [None, {}, {'default_theme': 'retired'}, {'default_theme': 3}])
def test_no_row_or_an_unknown_stored_id_answers_the_default(item):
    assert appearance_view(item) == {'default_theme': DEFAULT_THEME}


def test_a_stored_theme_is_answered():
    assert appearance_view({'default_theme': 'nord', 'updated_at': 'x'}) == {'default_theme': 'nord'}


@pytest.mark.parametrize('body', [{}, {'default_theme': ''}, {'default_theme': 'NORD'}, {'default_theme': ['nord']}])
def test_parse_refuses_anything_but_a_shipped_id(body):
    with pytest.raises(ValueError, match='default_theme must be one of'):
        parse_default_theme(body)


def test_parse_accepts_every_shipped_id():
    assert [parse_default_theme({'default_theme': theme}) for theme in THEME_IDS] == list(THEME_IDS)

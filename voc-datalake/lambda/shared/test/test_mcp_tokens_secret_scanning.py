"""The repository's secret-scanning rule for MCP tokens (``/.gitleaks.toml``) stays in step
with the credential format (``shared/mcp_tokens.py``).

A minted ``voc_tok_<16 hex>_<64 hex>`` token pasted into a commit, a document or a
ticket acts as its minter until it expires (up to 90 days), so a scanner must recognise
it. Nothing else would notice if the format changed and the rule silently stopped
matching. Python's ``re`` and gitleaks' RE2 agree on this pattern (anchors, classes
and counted repetition only), so a match here is a match there.
"""
from __future__ import annotations

import re
import tomllib

from shared.mcp_tokens import mint_token, parse_token
from shared.test.repo_paths import repo_root

RULE_ID = 'voc-mcp-token'


def _config() -> dict:
    return tomllib.loads((repo_root().parent / '.gitleaks.toml').read_text(encoding='utf-8'))


def _rule() -> dict:
    rules = [rule for rule in _config().get('rules', []) if rule.get('id') == RULE_ID]
    assert len(rules) == 1, f'.gitleaks.toml must define exactly one {RULE_ID!r} rule'
    return rules[0]


def _pattern() -> re.Pattern[str]:
    return re.compile(_rule()['regex'])


def test_the_default_rules_are_kept_alongside_ours():
    assert _config()['extend'] == {'useDefault': True}


def test_a_freshly_minted_token_is_caught_in_running_text():
    raw = mint_token().raw
    found = _pattern().findall(f'curl -H "Authorization: Bearer {raw}" https://api.example.com/v1/mcp/global')
    assert found == [raw]


def test_the_keyword_prefilter_is_part_of_every_token():
    raw = mint_token().raw
    assert all(keyword in raw for keyword in _rule()['keywords'])


def test_lookalikes_that_are_not_credentials_are_not_flagged():
    raw = mint_token().raw
    parsed = parse_token(raw)
    assert parsed is not None
    token_id, _secret = parsed
    assert _pattern().search(raw[:-1]) is None          # a truncated secret
    assert _pattern().search(f'{raw}0') is None         # longer than a secret
    assert _pattern().search(token_id) is None          # the public id alone (shown in the UI and logs)
    assert _pattern().search(raw.upper()) is None       # not our lowercase hex

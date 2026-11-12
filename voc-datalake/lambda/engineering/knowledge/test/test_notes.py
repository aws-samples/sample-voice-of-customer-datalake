"""``voc-note/1``: citations checked one by one, a note without one dropped and counted, claims redacted and bounded."""
from __future__ import annotations

import json
from typing import Any

import pytest

from engineering.knowledge.notes import MAX_CITATIONS, MAX_CLAIM, CitationRules, Note, parse_notes, safe_text
from engineering.knowledge.test.fixtures import PACKAGES, SHA_A, SHA_B, WEB_URL, rules


def line(**changes: Any) -> str:
    return json.dumps({'schema': 'voc-note/1', 'kind': 'convention', 'subject': 'Error   Handling',
                       'claim': 'Errors are returned as typed results, never thrown.',
                       'citations': ['packages/web/src/app.ts:12'], **changes})


def test_a_well_formed_note_is_kept_with_its_package_defaulted_to_the_shards() -> None:
    batch = parse_notes(line(), 'packages/web', rules(), PACKAGES)
    assert batch.notes == (Note('convention', 'packages/web', 'Errors are returned as typed results, never thrown.',
                                ('packages/web/src/app.ts:12',), 'error handling'),)
    assert batch.dropped == {}
    assert batch.citations_removed == 0


@pytest.mark.parametrize('citation', [
    'packages/web/src/app.ts:12', SHA_A, f'{WEB_URL}/pull/7#discussion_r1234', f'{WEB_URL}/pull/7#issuecomment-99',
    f'{WEB_URL}/pull/7#pullrequestreview-5'])
def test_each_citation_shape_is_accepted(citation: str) -> None:
    assert rules().valid(citation)


@pytest.mark.parametrize('citation', [
    'packages/web/src/app.ts:0', 'packages/web/src/app.ts', 'packages/web/src/app.ts:x', 'src/unlisted.ts:3',
    '../etc/passwd:1', 'a//b:1', 'someone@example.com:1', 'a' * 39, 'f' * 40, 'A' * 40,
    'https://github.com/other-org/harbor/pull/7#discussion_r1', 'https://evil.test/lumen-fixtures/harbor/pull/7#issuecomment-1',
    f'{WEB_URL}/pull/7', f'{WEB_URL}/pull/7?x=1#issuecomment-1', f'{WEB_URL}/issues/7#issuecomment-1',
    f'{WEB_URL}/-/merge_requests/7#note_1', f'{WEB_URL}harbor2/pull/7#issuecomment-1', 'http://github.com/x:1'])
def test_a_citation_off_its_shape_or_outside_the_connection_is_refused(citation: str) -> None:
    assert not rules().valid(citation)


def test_without_a_listing_any_well_formed_path_or_sha_is_accepted() -> None:
    open_rules = rules(paths=None, shas=None)
    assert open_rules.valid('src/unlisted.ts:3')
    assert open_rules.valid('f' * 40)
    assert not open_rules.valid('src/../x:3')


def test_gitlab_cites_merge_request_notes() -> None:
    gitlab = CitationRules('gitlab', 'https://gitlab.example.test/harbor/group/app')
    assert gitlab.valid('https://gitlab.example.test/harbor/group/app/-/merge_requests/3#note_77')
    assert not gitlab.valid('https://gitlab.example.test/harbor/group/app/pull/3#issuecomment-77')


@pytest.mark.parametrize('url', ['http://github.com/x/y', 'https://github.com/x/y/', 'https://github.com',
                                 'https://github.com/x y'])
def test_the_repository_address_is_https_with_a_path(url: str) -> None:
    with pytest.raises(ValueError, match='web address'):
        CitationRules('github', url)


def test_invalid_citations_are_removed_and_a_note_left_without_one_is_dropped() -> None:
    text = '\n'.join([
        line(citations=['packages/web/src/app.ts:12', 'nowhere.ts:1', SHA_B, SHA_B]),
        line(claim='Every handler logs its request id.', citations=['src/unlisted.ts:4', 'not a citation']),
        line(claim='Uncited.', citations=[]),
    ])
    batch = parse_notes(text, 'packages/web', rules(), PACKAGES)
    assert [n.citations for n in batch.notes] == [(SHA_B, 'packages/web/src/app.ts:12')]
    assert batch.dropped == {'citation': 2}
    assert batch.citations_removed == 2   # the unlisted path and the repeated sha


def test_citations_are_capped() -> None:
    paths = [f'packages/web/f{n}.ts' for n in range(MAX_CITATIONS + 3)]
    batch = parse_notes(line(citations=[f'{p}:1' for p in paths]), 'packages/web', rules(paths=paths), PACKAGES)
    assert len(batch.notes[0].citations) == MAX_CITATIONS
    assert batch.citations_removed == 3


@pytest.mark.parametrize(('raw', 'reason'), [
    ('not json', 'schema'), ('[1]', 'schema'), (line(schema='voc-note/2'), 'schema'), (line(kind='opinion'), 'schema'),
    (line(claim=''), 'schema'), (line(claim='   '), 'schema'), (line(claim=5), 'schema'),
    (line(citations='packages/web/src/app.ts:12'), 'schema'), (line(package='packages/other'), 'package'),
    (line(package=['packages/web']), 'package'), (line(claim='x' * 9000), 'schema')])
def test_a_line_off_the_schema_is_dropped_and_counted(raw: str, reason: str) -> None:
    batch = parse_notes(f'{raw}\n\n', 'packages/web', rules(), PACKAGES)
    assert batch.notes == ()
    assert batch.dropped == {reason: 1}


def test_a_note_may_name_another_known_package() -> None:
    batch = parse_notes(line(package='.'), 'packages/web', rules(), PACKAGES)
    assert batch.notes[0].package == '.'


def test_notes_per_shard_are_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    from engineering.knowledge import notes as notes_module

    monkeypatch.setattr(notes_module, 'MAX_NOTES', 2)
    batch = parse_notes('\n'.join(line(claim=f'Claim {n}.') for n in range(4)), 'packages/web', rules(), PACKAGES)
    assert len(batch.notes) == 2
    assert batch.dropped == {'cap': 2}


def test_claims_are_redacted_flattened_and_bounded() -> None:
    claim = ('Deploys read\u200b the token ghp_' + 'A' * 36 + '\nfrom  CI; ask ops-lead@example.com or call '
             '+1 415 555 0100. ' + 'x' * 600)
    note = parse_notes(line(claim=claim), 'packages/web', rules(), PACKAGES).notes[0]
    assert 'ghp_' not in note.claim
    assert '<redacted>' in note.claim
    assert 'example.com' not in note.claim
    assert '[EMAIL]' in note.claim
    assert '415' not in note.claim
    assert '[PHONE]' in note.claim
    assert '\n' not in note.claim
    assert '\u200b' not in note.claim
    assert 'read the token' in note.claim
    assert len(note.claim) == MAX_CLAIM
    assert note.claim.endswith('…')


def test_a_subject_off_its_shape_is_left_empty_not_trusted() -> None:
    for subject in ['<b>x</b>', 5, 'ops@example.com', '-leading']:
        assert parse_notes(line(subject=subject), 'packages/web', rules(), PACKAGES).notes[0].subject == ''
    assert parse_notes(line(subject='x' * 100), 'packages/web', rules(), PACKAGES).notes[0].subject == 'x' * 80


def test_a_note_round_trips_through_its_line_and_has_a_stable_id() -> None:
    note = parse_notes(line(), 'packages/web', rules(), PACKAGES).notes[0]
    again = parse_notes(note.to_line(), 'packages/web', rules(), PACKAGES).notes[0]
    assert again == note
    assert Note('convention', 'packages/web', 'errors are RETURNED as typed results, never thrown', ()).id == note.id
    assert Note('glossary', 'packages/web', note.claim, ()).id != note.id


def test_safe_text_keeps_ordinary_text() -> None:
    assert safe_text('  Tests live   beside the code.  ', 100) == 'Tests live beside the code.'

"""The reduce: notes merged per document with their citations, human edits kept, contradictions flagged, stable bytes."""
from __future__ import annotations

import re

import pytest

from engineering.knowledge.notes import KINDS, Note
from engineering.knowledge.reduce import (
    PACK_SCHEMA,
    Edit,
    Flagged,
    apply_edits,
    from_json,
    reduce_package,
    render,
    to_json,
)
from engineering.knowledge.test.fixtures import MANIFESTS, PATHS, SHA_A, SHA_B, WEB_URL, rules
from engineering.knowledge.workspaces import detect

WEB = 'packages/web'
COMMENT = f'{WEB_URL}/pull/7#discussion_r42'


def note(claim: str, *citations: str, kind: str = 'convention', subject: str = '', author: str = '',
         package: str = WEB) -> Note:
    return Note(kind, package, claim, tuple(citations), subject, author)


def test_notes_making_one_claim_merge_with_the_union_of_their_citations() -> None:
    pack = reduce_package(WEB, [
        note('Errors are typed results.', 'packages/web/src/app.ts:12', subject='errors'),
        note('errors are   TYPED results', SHA_A, subject='errors'),
        note('Tests sit beside the code.', 'packages/web/test/app.test.ts:1', kind='test-strategy'),
        note('Billing rounds half up.', SHA_B, package='services/billing'),   # another package's note
    ])
    assert set(pack.documents) == set(KINDS)
    assert pack.documents['convention'] == (
        note('Errors are typed results.', SHA_A, 'packages/web/src/app.ts:12', subject='errors'),)
    assert [n.claim for n in pack.documents['test-strategy']] == ['Tests sit beside the code.']
    assert all(not pack.documents[k] for k in ('architecture', 'review-guide', 'ci', 'glossary', 'how-we-work'))
    assert pack.flagged == ()
    assert pack.packages == ()


def test_claims_are_ordered_by_subject_then_text_whatever_the_note_order() -> None:
    notes = [note('Zeta.', SHA_A), note('Alpha.', SHA_A), note('Logging uses one logger.', SHA_A, subject='logging'),
             note('Errors are wrapped.', SHA_A, subject='errors')]
    shuffled = [notes[2], notes[0], notes[3], notes[1]]
    first, again = reduce_package(WEB, notes), reduce_package(WEB, shuffled)
    assert [n.claim for n in first.documents['convention']] == [
        'Errors are wrapped.', 'Logging uses one logger.', 'Alpha.', 'Zeta.']
    assert all(render(first, kind) == render(again, kind) for kind in KINDS)


def test_a_human_edit_wins_and_a_contradicting_refresh_is_flagged_not_applied() -> None:
    edit = note('Errors are raised as exceptions.', subject='errors', author='admin-1')
    previous = reduce_package(WEB, [])
    previous = apply_edits(previous, [Edit(edit)], rules=rules())
    refreshed = reduce_package(WEB, [
        note('Errors are returned as typed results.', 'packages/web/src/app.ts:12', subject='errors'),
        note('Errors are raised as exceptions', SHA_A, subject='errors'),   # agrees: adds its citation to the edit
        note('Errors are logged once.', SHA_B),                             # no subject: contradicts nothing
    ], previous)
    convention = refreshed.documents['convention']
    assert [(n.claim, n.citations, n.author) for n in convention] == [
        ('Errors are raised as exceptions.', (SHA_A,), 'admin-1'), ('Errors are logged once.', (SHA_B,), '')]
    assert refreshed.flagged == (
        Flagged(note('Errors are returned as typed results.', 'packages/web/src/app.ts:12', subject='errors'),
                convention[0]),)
    markdown = render(refreshed, 'convention')
    assert '## Flagged for review: contradicts an edit, not applied' in markdown
    assert markdown.index('typed results') > markdown.index('## Flagged')
    assert '(edited by a person)' in markdown
    assert 'admin-1' not in markdown


def test_without_a_previous_version_nothing_is_flagged() -> None:
    pack = reduce_package(WEB, [note('A.', SHA_A, subject='s'), note('B.', SHA_B, subject='s')])
    assert len(pack.documents['convention']) == 2
    assert pack.flagged == ()


def test_an_edit_replaces_a_claim_by_id_and_resolves_the_flag_it_answers() -> None:
    mapped = note('Branches are named feature/x.', SHA_A, kind='how-we-work', subject='branch names')
    pack = reduce_package(WEB, [mapped])
    edit = note('Branches are named after their issue.', kind='how-we-work', subject='branch names', author='admin-1')
    edited = apply_edits(pack, [Edit(edit, replaces=mapped.id)], rules=rules())
    assert edited.documents['how-we-work'] == (edit,)
    flagged = reduce_package(WEB, [mapped], edited)
    assert [f.claim.claim for f in flagged.flagged] == ['Branches are named feature/x.']
    agreeing = note('Branches are named feature/x.', kind='how-we-work', subject='branch names', author='admin-2')
    resolved = apply_edits(flagged, [Edit(agreeing, replaces=edit.id)], rules=rules())
    assert resolved.flagged == ()
    assert [n.author for n in resolved.documents['how-we-work']] == ['admin-2']


@pytest.mark.parametrize('bad', [note('No author.'), note('Other package.', author='a', package='.'),
                                 note('Unknown kind.', author='a', kind='gossip')])
def test_an_edit_is_a_persons_claim_for_this_pack(bad: Note) -> None:
    with pytest.raises(ValueError, match="person's claim"):
        apply_edits(reduce_package(WEB, []), [Edit(bad)], rules=rules())


def test_markdown_numbers_footnotes_by_first_use_and_escapes_repository_text() -> None:
    pack = reduce_package(WEB, [
        note('Use [the docs](javascript:alert(1)) and <img src=x>.', 'packages/web/src/app.ts:3', COMMENT,
             kind='review-guide', subject='links'),
        note('Reviewers ask for tests.', COMMENT, SHA_A, kind='review-guide'),
    ])
    markdown = render(pack, 'review-guide')
    assert markdown.startswith('# Review guide: `packages/web`\n')
    assert '\\[the docs\\](javascript:alert(1)) and \\<img src=x\\>.' in markdown
    assert not re.search(r'(?<!\\)\]\(|(?<!\\)<img', markdown)   # no live link or tag
    assert markdown.count('[^2]') == 3   # COMMENT is cited twice, one footnote
    assert markdown.endswith(f'[^1]: `packages/web/src/app.ts:3`\n[^2]: <{COMMENT}>\n[^3]: commit `{SHA_A}`\n')
    assert render(pack, 'glossary') == '# Glossary: `packages/web`\n\nNothing is known about this yet.\n'


def test_the_overview_is_the_root_pack_with_the_package_table() -> None:
    packages = detect(PATHS, MANIFESTS).packages
    overview = reduce_package('.', [note('CI runs on every push.', '.github/workflows/ci.yml:1', kind='ci',
                                         package='.')], packages=packages)
    architecture = render(overview, 'architecture')
    assert architecture.startswith('# Architecture: the repository\n\n## Packages\n')
    assert '| `packages/web` | @harbor/web | npm | @harbor/frontend |' in architecture
    assert '| `services/billing` | harbor-billing | python | @harbor/billing |' in architecture
    assert '## Packages' not in render(reduce_package(WEB, [], packages=packages), 'architecture')
    assert 'CI runs on every push.' in render(overview, 'ci')
    # Read back from its pack.json and edited, the overview keeps its table (an edit starts from the stored pack).
    again = from_json(to_json(overview))
    assert again.packages == overview.packages
    edited = apply_edits(again, [Edit(note('CI runs nightly too.', kind='ci', package='.', author='admin-1'))], rules=rules())
    assert render(edited, 'architecture') == architecture


def test_a_stored_package_table_off_its_shape_is_skipped() -> None:
    data = to_json(reduce_package('.', [], packages=detect(PATHS, MANIFESTS).packages))
    data['packages'] = [data['packages'][0], 'x', {'path': 'a', 'name': 'a', 'kinds': ['cobol'], 'owners': []},
                        {'path': 'b', 'name': 2, 'kinds': [], 'owners': []}, {'path': 'c', 'name': 'c', 'kinds': []}]
    assert [p.path for p in from_json(data).packages] == ['.']
    data['package'] = WEB   # only the overview lists packages
    assert from_json(data).packages == ()


def test_a_pack_round_trips_through_its_json_with_its_flags() -> None:
    edit = note('Errors are raised.', subject='errors', author='admin-1')
    pack = reduce_package(WEB, [note('Errors are returned.', SHA_A, subject='errors'), note('Logs are JSON.', SHA_B)],
                          apply_edits(reduce_package(WEB, []), [Edit(edit)], rules=rules()))
    data = to_json(pack)
    assert data['schema'] == PACK_SCHEMA
    assert len(data['flagged']) == 1
    again = from_json(data)
    assert again.documents == pack.documents
    assert again.flagged == pack.flagged
    assert again.human_claims() == [edit]


def test_from_json_refuses_another_schema_and_skips_malformed_claims() -> None:
    with pytest.raises(ValueError, match='voc-kpack/1'):
        from_json({'schema': 'voc-kpack/0', 'package': WEB, 'documents': {}})
    pack = from_json({'schema': PACK_SCHEMA, 'package': WEB, 'flagged': [{'kind': 'ci'}, 'x', {'kind': 'nope'}],
                      'documents': {'convention': ['x', {'claim': 3, 'citations': []}, {'claim': 'Kept.', 'citations': [
                          SHA_A], 'author': 7}, {'claim': 'Good.', 'citations': [SHA_A]}], 'ci': 'not a list'}})
    assert [n.claim for n in pack.documents['convention']] == ['Good.']
    assert pack.documents['ci'] == ()
    assert pack.flagged == ()

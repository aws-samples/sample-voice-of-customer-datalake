"""The CHANGELOG reader: which headings are this line's releases, their sections and inferred kinds."""
from __future__ import annotations

import planted
import pytest
from feature_gate import items


def test_the_line_is_the_unsuffixed_run_from_the_top_down_to_the_floor():
    versions = [r.version for r in items.line_releases(planted.CHANGELOG)]
    # [Unreleased] is no release; 6.04.08 is below the floor; the first suffixed heading ends the line, so main's
    # unsuffixed 7.00.01 below it is not this line's.
    assert versions == ['7.76.00', '7.75.01', '6.05.00']


def test_a_release_carries_its_whole_section():
    release = items.line_releases(planted.CHANGELOG)[0]
    assert release.intro == 'Multi-workspace: the widget counts per workspace ([docs/widget.md](docs/widget.md)).'
    assert release.subsections == ['Added']
    assert items.section(planted.CHANGELOG, '7.76.00').startswith('## [7.76.00] - 2026-11-26\n')
    assert '- The count.' in items.section(planted.CHANGELOG, '7.76.00')
    assert '## [7.75.01]' not in items.section(planted.CHANGELOG, '7.76.00')


def test_an_unknown_version_has_no_section():
    with pytest.raises(KeyError):
        items.section(planted.CHANGELOG, '9.99.00')


def release(version: str, intro: str, subs: list[str]) -> items.Release:
    return items.Release(version=version, date='2026-11-27', intro=intro, subsections=subs, line=1)


def test_a_duplicate_heading_is_found_and_the_first_copy_is_read():
    doubled = planted.CHANGELOG.replace(
        '## [6.05.00] - 2026-11-11',
        '## [7.76.00] - 2026-11-26\n\nTooling only: a planted copy.\n\n## [6.05.00] - 2026-11-11')
    assert items.duplicates(doubled) == ['7.76.00']
    assert [r.version for r in items.line_releases(doubled)] == ['7.76.00', '7.75.01', '6.05.00']
    first = items.line_releases(doubled)[0]
    assert first.intro.startswith('Multi-workspace: the widget counts')
    assert 'planted copy' not in items.section(doubled, '7.76.00')
    assert items.duplicates(planted.CHANGELOG) == []


def test_a_heading_inside_a_code_fence_is_no_release():
    fenced = planted.CHANGELOG.replace(
        '- The count.', '- The count.\n\n```markdown\n## [7.80.00] - 2026-11-30\n\nTooling only: an example.\n```')
    assert [r.version for r in items.line_releases(fenced)] == ['7.76.00', '7.75.01', '6.05.00']
    assert '## [7.80.00]' in items.section(fenced, '7.76.00')
    assert items.duplicates(fenced.replace('7.80.00', '7.76.00')) == []


def test_an_indented_fence_line_is_no_fence_and_hides_nothing():
    # Four spaces of indent: CommonMark reads an indented code line, never a fence, so the heading below still counts.
    hiding = planted.CHANGELOG.replace('## [7.75.01]', '    ```\n\n## [7.75.01]')
    assert [r.version for r in items.line_releases(hiding)] == ['7.76.00', '7.75.01', '6.05.00']
    assert items.duplicates(hiding.replace('## [6.05.00]', '## [7.75.01]')) == ['7.75.01']


def test_a_fence_closes_only_with_its_own_character_at_its_length_or_more():
    nested = planted.CHANGELOG.replace(
        '- The count.', '- The count.\n\n````\n```\n## [7.80.00] - 2026-11-30\n```\n## [7.81.00] - 2026-11-30\n````')
    assert [r.version for r in items.line_releases(nested)] == ['7.76.00', '7.75.01', '6.05.00']
    tilde = planted.CHANGELOG.replace('- The count.', '- The count.\n\n~~~\n```\n## [7.80.00] - 2026-11-30\n~~~~')
    assert [r.version for r in items.line_releases(tilde)] == ['7.76.00', '7.75.01', '6.05.00']
    opened_by_three_spaces = planted.CHANGELOG.replace('- The count.', '- The count.\n\n   ```\n## [7.80.00] - x\n```')
    assert [r.version for r in items.line_releases(opened_by_three_spaces)] == ['7.76.00', '7.75.01', '6.05.00']


def test_the_two_digit_form_of_a_package_version():
    assert items.two_digit('7.104.0') == '7.104.00'
    assert items.two_digit('6.5.12') == '6.05.12'
    assert items.two_digit('7.104') is None


@pytest.mark.parametrize(('version', 'intro', 'subs', 'kind'), [
    ('7.103.00', 'The seam (slice 3h-S3a; no production behaviour change).', ['Changed'], 'plumbing'),
    ('7.102.00', 'The stores (plumbing, no behaviour change).', ['Changed'], 'plumbing'),
    ('7.90.01', 'Tooling only: a test run by hand keeps to its share.', ['Added', 'Changed'], 'no-behaviour'),
    ('7.77.00', 'A trust fix (TENETS.md D4): the clear is recorded.', ['Fixed', 'Upgrade notes'], 'fix'),
    ('7.71.02', 'The findings the review deferred.', ['Fixed', 'Upgrade notes'], 'fix'),
    ('7.58.01', 'Deferred findings, fixed.', ['Changed', 'Fixed'], 'fix'),
    ('7.92.00', 'Multi-workspace: an account added is told so.', ['Added', 'Changed'], 'feature'),
])
def test_kind_is_read_from_the_intro_and_the_subsections(version: str, intro: str, subs: list[str], kind: str):
    assert items.classify(release(version, intro, subs)) == (kind, None)


@pytest.mark.parametrize(('version', 'intro', 'subs', 'kind'), [
    ('7.35.00', 'Merge of voc-autonomous into voc-multiplayer.', ['Changed'], 'feature'),
    ('7.51.01', 'Hover hints are instant.', ['Added', 'Changed'], 'feature'),
])
def test_unclear_kinds_are_marked_uncertain(version: str, intro: str, subs: list[str], kind: str):
    got, why = items.classify(release(version, intro, subs))
    assert got == kind
    assert why


@pytest.mark.parametrize(('intro', 'proposed', 'words'), [
    ('Phase 3b. Internal only: nothing changes for anyone.', 'plumbing', 'internal only'),
    ('Readers merged; nothing changes yet, since no caller passes one.', 'plumbing', 'nothing changes yet'),
    ("Tests only: the scrapers' routes leave the list.", 'no-behaviour', 'tests only'),
    ('Tenets settled. Docs and tenets only: the platform does not change.', 'no-behaviour', 'docs and tenets only'),
    ('Nothing to deploy: the guide moves.', 'no-behaviour', 'nothing to deploy'),
    ('The tooling only reads the tree.', 'no-behaviour', 'tooling only'),   # not the explicit "Tooling only:"
])
def test_a_keyword_seeds_a_feature_and_proposes_the_lower_kind(intro: str, proposed: str, words: str):
    assert items.classify(release('7.27.00', intro, ['Changed'])) == (
        'feature', f'the words "{words}" suggest {proposed}: a reviewed decision lets it stand')


def test_aliases_are_the_semver_and_the_plan_slice_named_in_the_intro():
    r = release('7.103.00', 'The seam (slice 3h-S3a of the plan, phase 1, before 3h-S12).', [])
    assert items.aliases(r) == ['7.103.0', '3h-S3a']


def test_the_seed_title_is_the_first_sentence_without_markup():
    r = release('7.70.00', '**The leadership view**: one [page](docs/x.md). Then more.', [])
    assert items.title(r) == 'The leadership view: one page.'
    assert items.doc_link(r) == 'docs/x.md'
    assert items.doc_link(release('7.76.00', 'See [the doc](docs/widget.md#a).', [])) == 'docs/widget.md'
    assert items.doc_link(release('7.76.00', 'No link here.', [])) is None
    assert items.doc_link(release('7.99.00', "Slice 3h-S1 of docs/multi-workspace.md's plan.", [])) == (
        'docs/multi-workspace.md')
    assert items.doc_link(release('7.99.00', 'See frontend/docs/x.md.', [])) is None


def test_seed_item_has_the_registry_shape():
    seeded = items.seed_item(items.line_releases(planted.CHANGELOG)[1])
    assert seeded == {
        'id': '7.75.01', 'aliases': ['7.75.1'], 'title': "Tooling only: the widget's routes leave the pending list.",
        'source': {'changelog': '7.75.01', 'doc': None}, 'kind': 'no-behaviour', 'status': 'done',
        'unit': [], 'e2e': [], 'exemption': None,
    }

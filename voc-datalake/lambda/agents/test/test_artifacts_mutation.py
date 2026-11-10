"""Mutation hardening for ``agents.artifacts`` (prototype text, document text, personas).

The earlier suites patch ``load_text`` / ``personas_of`` away, and the one direct
test only checked that a few words were ``in`` the output, so the mutation run
found nothing pinning:

* the exact layout ``visible_text`` produces: one line per block tag, single
  spaces inside a line, no blank lines, the ``[button]`` / ``[input]`` control
  hints (placeholder before aria-label), nested and stray skipped tags,
  decoded character references and the 30,000-character clip;
* ``load_text``'s refusals (each message literal), the S3 bucket/key it reads,
  the ``PROTOTYPE#`` sort-key fallback, lossy UTF-8 decoding, the ``document``
  default type and the content clip;
* ``personas_of``'s filtering of malformed personas and its ``research project``
  default name.
"""
from __future__ import annotations

import io
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest

from agents import artifacts

CLAIMS = {'sub': 'agent:ag_1'}
LIMIT = 30000


class TestVisibleTextLayout:
    @pytest.mark.parametrize('tag', ['h1', 'h2', 'h3', 'h4', 'a', 'label', 'li', 'p', 'section',
                                     'nav', 'header', 'footer', 'form', 'div'])
    def test_every_block_tag_starts_a_new_line(self, tag):
        assert artifacts.visible_text(f'one  two<{tag}>three</{tag}>') == 'one two\nthree'

    def test_inline_tags_join_with_one_space(self):
        assert artifacts.visible_text('a<span>b</span><em>c</em>') == 'a b c'

    def test_empty_blocks_leave_no_blank_lines(self):
        assert artifacts.visible_text('<div><p><p>x</p></p></div><div></div>y') == 'x\ny'

    def test_a_newline_inside_text_starts_a_line_but_surrounding_whitespace_does_not(self):
        assert artifacts.visible_text('<span>one\ntwo\n</span><span>\n</span><span>three</span>') == (
            'one\ntwo three')

    def test_character_references_are_decoded(self):
        assert artifacts.visible_text('Fish &amp; Chips &lt;3') == 'Fish & Chips <3'

    def test_the_text_is_clipped_to_the_limit(self):
        text = artifacts.visible_text('x' * (LIMIT + 5))
        assert len(text) == LIMIT

    def test_text_at_the_limit_is_kept_whole(self):
        assert artifacts.visible_text('y' * LIMIT) == 'y' * LIMIT


class TestControlsAreLabelled:
    @pytest.mark.parametrize(('html', 'expected'), [
        ('<button placeholder="P" aria-label="A">Go</button>', '[button] P Go'),
        ('<button aria-label="Close">x</button>', '[button] Close x'),
        ('<button>Go</button>', '[button] Go'),
        ('<input placeholder="Email">', '[input] Email'),
        ('<input aria-label="Search">', '[input] Search'),
        ('<input>', '[input]'),
        ('<a aria-label="Home">Start</a>', 'Start'),
    ])
    def test_a_control_carries_its_kind_and_best_label(self, html, expected):
        assert artifacts.visible_text('before' + html) == 'before\n' + expected


class TestSkippedTagsHideTheirText:
    @pytest.mark.parametrize('tag', ['script', 'style', 'noscript', 'svg'])
    def test_each_skipped_tag_hides_its_content(self, tag):
        assert artifacts.visible_text(f'a<{tag}>hidden</{tag}>b') == 'a b'

    def test_nested_skipped_tags_hide_until_the_outer_one_closes(self):
        assert artifacts.visible_text('<svg><style>s</style>hidden</svg>shown') == 'shown'

    def test_a_stray_closing_skipped_tag_hides_nothing(self):
        assert artifacts.visible_text('</script>visible<p>more') == 'visible\nmore'

    def test_a_closing_ordinary_tag_does_not_end_a_skipped_block(self):
        assert artifacts.visible_text('<script>a</p>b</script>c') == 'c'


@pytest.fixture
def chat_context() -> Iterator[MagicMock]:
    with patch('agents.principal.chat_context') as mock:
        yield mock


@pytest.fixture
def s3() -> Iterator[MagicMock]:
    client = MagicMock()
    with patch('agents.artifacts.get_s3_client', return_value=client):
        yield client


def _html(client: MagicMock, payload: bytes) -> None:
    client.get_object.return_value = {'Body': io.BytesIO(payload)}


class TestLoadTextRefusals:
    @pytest.mark.parametrize('context', [
        {},
        {'documents': None},
        {'documents': ['d1', {'document_id': 'other', 'content': 'x'}]},
    ])
    def test_an_unlisted_document_is_not_found(self, chat_context, context):
        chat_context.return_value = context
        with pytest.raises(artifacts.ArtifactUnavailable) as info:
            artifacts.load_text('p1', 'd1', CLAIMS)
        assert str(info.value) == 'document not found in the project'
        chat_context.assert_called_once_with('p1', CLAIMS, ['d1'])

    @pytest.mark.parametrize('content', [None, 7, '', '   \n'])
    def test_a_document_without_text_has_no_content(self, chat_context, content):
        chat_context.return_value = {'documents': [{'document_id': 'd1', 'document_type': 'prd',
                                                    'content': content}]}
        with pytest.raises(artifacts.ArtifactUnavailable) as info:
            artifacts.load_text('p1', 'd1', CLAIMS)
        assert str(info.value) == 'document has no content'

    def test_an_unreadable_prototype_names_its_cause(self, chat_context, s3):
        chat_context.return_value = {'documents': [{'document_id': 'd1', 'document_type': 'prototype'}]}
        failure = RuntimeError('NoSuchKey')
        s3.get_object.side_effect = failure
        with pytest.raises(artifacts.ArtifactUnavailable) as info:
            artifacts.load_text('p1', 'd1', CLAIMS)
        assert str(info.value) == 'prototype HTML could not be read'
        assert info.value.__cause__ is failure


class TestLoadTextDocuments:
    def test_the_first_listed_match_is_returned_clipped(self, chat_context):
        chat_context.return_value = {'documents': [
            {'document_id': 'd1', 'document_type': 'prfaq', 'content': 'z' * (LIMIT + 1)},
            {'document_id': 'd1', 'document_type': 'prd', 'content': 'second'},
        ]}
        assert artifacts.load_text('p1', 'd1', CLAIMS) == ('prfaq', 'z' * LIMIT)

    @pytest.mark.parametrize('document_type', [None, ''])
    def test_a_document_without_a_type_is_a_document(self, chat_context, document_type):
        chat_context.return_value = {'documents': [{'document_id': 'd1', 'document_type': document_type,
                                                    'sk': 'PRD#d1', 'content': 'Body'}]}
        assert artifacts.load_text('p1', 'd1', CLAIMS) == ('document', 'Body')


class TestLoadTextPrototypes:
    @pytest.mark.parametrize('document', [
        {'document_id': 'd1', 'document_type': 'prototype'},
        {'document_id': 'd1', 'document_type': 'custom', 'sk': 'PROTOTYPE#d1', 'content': 'stale'},
    ])
    def test_a_prototype_is_read_from_its_s3_key(self, chat_context, s3, monkeypatch, document):
        monkeypatch.setenv('RAW_DATA_BUCKET', 'raw-bkt')
        chat_context.return_value = {'documents': [document]}
        _html(s3, b'<h1>Checkout</h1><button>Pay</button>')

        assert artifacts.load_text('p1', 'd1', CLAIMS) == ('prototype', 'Checkout\n[button] Pay')
        s3.get_object.assert_called_once_with(Bucket='raw-bkt', Key='prototypes/p1/d1.html')

    def test_without_a_bucket_setting_the_bucket_is_empty(self, chat_context, s3, monkeypatch):
        monkeypatch.delenv('RAW_DATA_BUCKET', raising=False)
        chat_context.return_value = {'documents': [{'document_id': 'd1', 'document_type': 'prototype'}]}
        _html(s3, b'ok')

        artifacts.load_text('p1', 'd1', CLAIMS)
        s3.get_object.assert_called_once_with(Bucket='', Key='prototypes/p1/d1.html')

    def test_undecodable_bytes_are_replaced(self, chat_context, s3):
        chat_context.return_value = {'documents': [{'document_id': 'd1', 'document_type': 'prototype'}]}
        _html(s3, 'caf\u00e9 '.encode() + b'\xff')

        assert artifacts.load_text('p1', 'd1', CLAIMS) == ('prototype', 'caf\u00e9 \ufffd')


class TestPersonasOf:
    def test_only_well_formed_personas_are_returned_with_the_project_name(self, chat_context):
        keep = {'persona_id': 'per_1', 'name': 'Ana'}
        chat_context.return_value = {'project': {'name': 'Checkout'}, 'personas': [
            keep, 'per_2', {'name': 'No id'}, {'persona_id': ''}]}

        assert artifacts.personas_of('p1', CLAIMS) == ('Checkout', [keep])
        chat_context.assert_called_once_with('p1', CLAIMS, [])

    @pytest.mark.parametrize('context', [{}, {'project': 'x', 'personas': None}, {'project': {'name': ''}}])
    def test_a_nameless_project_is_a_research_project(self, chat_context, context):
        chat_context.return_value = context
        assert artifacts.personas_of('p1', CLAIMS) == ('research project', [])

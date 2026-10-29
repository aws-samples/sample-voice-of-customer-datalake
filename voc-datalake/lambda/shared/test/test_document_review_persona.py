"""Persona review of a PR/FAQ / PRD (shared/document_review.py, docs/document-review.md).

The model is stubbed through ``run_review``'s ``invoke`` seam (and ``converse`` itself for
the default seam); the threads land in a moto table. The point of most tests is the
VERBATIM-QUOTE FILTER: only a comment whose quote is in the document's plain text is filed,
anchored by that quote, and the document is never written.
"""
import json
import threading

import pytest
from moto import mock_aws

from shared import document_comments as dc
from shared import document_review as dr
from shared.document_series import plain_text
from shared.exceptions import ValidationError
from shared.test.moto_tables import create_pk_sk_table

SERIES_ID = 'ser_' + 'b' * 24
CONTENT = ('# Press release\n\nToday we launch **Acme Sync**, which keeps every file in step.\n\n'
           '## FAQ\n\nHow much does it cost? It costs ten dollars a month.')
DOCUMENT = {'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d1', 'document_id': 'd1', 'document_type': 'prfaq', 'version': 1,
            'title': 'Launch (v1)', 'base_title': 'Launch', 'content': CONTENT}
PERSONAS = [{'persona_id': f'per{n}', 'name': f'Persona {n}'} for n in range(1, 4)]
TEXT = plain_text(CONTENT)


@pytest.fixture
def table():
    with mock_aws():
        projects = create_pk_sk_table('projects')
        projects.put_item(Item=DOCUMENT)
        yield projects


def _reply(*comments, stance='mixed', verdict='Useful, but pricey.'):
    return json.dumps({'stance': stance, 'verdict': verdict,
                       'comments': [{'quote': q, 'comment': c} for q, c in comments]})


def _always(reply):
    """A model seam answering ``reply`` to every persona."""
    return lambda _prompt, _system: reply


def _run(table, invoke, personas=PERSONAS[:1], document=DOCUMENT):
    return dr.run_review(table, project_id='p1', series_id=SERIES_ID, document=document, document_type='prfaq',
                         personas=personas, invoke=invoke)


def _anchored(table):
    return [t for t in dc.list_threads(table, 'p1', SERIES_ID) if t.get('anchor')]


# ── locate_quote: the anchoring of a persona's quote ────────────────────────

@pytest.mark.parametrize(('quote', 'exact'), [
    ('keeps every file in step', 'keeps every file in step'),
    ('Today we launch Acme Sync', 'Today we launch Acme Sync'),
    ('  It costs\nten   dollars a month.  ', 'It costs ten dollars a month.'),
    ('"It costs ten dollars a month."', 'It costs ten dollars a month.'),
    ('\u201cIt costs ten dollars\u201d', 'It costs ten dollars'),
])
def test_a_verbatim_quote_is_located_after_whitespace_and_quote_marks(quote, exact):
    anchor = dr.locate_quote(quote, TEXT)
    assert anchor is not None
    assert anchor['exact'] == exact
    assert anchor['prefix'] + anchor['exact'] + anchor['suffix'] in TEXT


@pytest.mark.parametrize('quote', [
    'Today we launch **Acme Sync**',  # markdown symbols are not in the reader's text
    'It costs twelve dollars a month.',  # paraphrase
    'keeps every FILE in step',  # case differs
    'short',  # below MIN_QUOTE_CHARS
    'x' * (dr.MAX_QUOTE_CHARS + 1),
    None, 42, ['keeps every file in step'],
])
def test_a_quote_not_found_verbatim_or_out_of_bounds_is_not_located(quote):
    assert dr.locate_quote(quote, TEXT) is None


def test_the_anchor_carries_32_characters_of_context_each_side():
    text = 'a' * 50 + 'THE QUOTE HERE' + 'b' * 50
    anchor = dr.locate_quote('THE QUOTE HERE', text)
    assert anchor == {'exact': 'THE QUOTE HERE', 'prefix': 'a' * 32, 'suffix': 'b' * 32, 'heading': ''}


def test_a_quote_at_the_very_start_or_end_has_short_context():
    anchor = dr.locate_quote('Press release Today', TEXT)
    assert anchor is not None
    assert anchor['prefix'] == ''
    end = dr.locate_quote('ten dollars a month.', TEXT)
    assert end is not None
    assert end['suffix'] == ''


def test_a_repeated_quote_anchors_on_its_first_occurrence_with_that_context():
    text = 'first: the same words here. second: the same words here.'
    anchor = dr.locate_quote('the same words here', text)
    assert anchor is not None
    assert anchor['prefix'] == 'first: '
    assert anchor['suffix'].startswith('. second')


# ── parse_review ────────────────────────────────────────────────────────────

def test_parse_review_keeps_verbatim_quotes_and_counts_the_rest_as_dropped():
    review = dr.parse_review(_reply(('keeps every file in step', 'Nice'), ('invented sentence here', 'Hmm'),
                                    ('It costs ten dollars a month.', '   ')), TEXT)
    assert review is not None
    assert [c['anchor']['exact'] for c in review['comments']] == ['keeps every file in step']
    assert review['dropped'] == 2


def test_parse_review_reads_json_inside_prose_and_defaults_an_unknown_stance():
    review = dr.parse_review('Sure! ```json\n' + _reply(stance='ecstatic') + '\n```', TEXT)
    assert review is not None
    assert review['stance'] == 'mixed'
    assert review['verdict'] == 'Useful, but pricey.'


@pytest.mark.parametrize('reply', ['no json at all', '[1, 2]', '', '{broken'])
def test_an_unreadable_reply_is_none(reply):
    assert dr.parse_review(reply, TEXT) is None


def test_only_the_first_eight_comments_are_considered_and_bodies_are_capped():
    many = [('keeps every file in step', 'c' * 2000)] * 12
    review = dr.parse_review(_reply(*many), TEXT)
    assert review is not None
    assert len(review['comments']) + review['dropped'] == dr.MAX_COMMENTS_PER_PERSONA == 8
    assert len(review['comments'][0]['text']) == dr.MAX_PERSONA_COMMENT_CHARS


@pytest.mark.parametrize('entry', ['a string', 7, {'quote': 'keeps every file in step'}])
def test_a_malformed_comment_entry_is_dropped(entry):
    review = dr.parse_review(json.dumps({'stance': 'positive', 'verdict': 'ok', 'comments': [entry]}), TEXT)
    assert review is not None
    assert review['comments'] == []
    assert review['dropped'] == 1


# ── run_review ──────────────────────────────────────────────────────────────

def test_only_verbatim_comments_are_filed_anchored_by_their_quote(table):
    result = _run(table, _always(_reply(('keeps every file in step', 'I like this'),
                                        ('It is free forever.', 'Made up'))))
    anchored = _anchored(table)
    assert [t['anchor']['exact'] for t in anchored] == ['keeps every file in step']
    assert anchored[0]['text'] == 'I like this'
    assert anchored[0]['author'] == {'kind': 'persona', 'persona_id': 'per1', 'name': 'Persona 1'}
    assert (anchored[0]['document_id'], anchored[0]['version']) == ('d1', 1)
    outcome = result['personas'][0]
    assert (outcome['ok'], outcome['stance'], outcome['filed'], outcome['dropped']) == (True, 'mixed', 2, 1)


def test_the_verdict_is_a_whole_document_comment_carrying_the_stance(table):
    _run(table, _always(_reply(stance='negative', verdict='Too expensive.')))
    threads = dc.list_threads(table, 'p1', SERIES_ID)
    assert len(threads) == 1
    assert (threads[0]['anchor'], threads[0]['text'], threads[0]['verdict']) == (None, 'Too expensive.', 'negative')


def test_the_document_is_never_edited(table):
    before = table.get_item(Key={'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d1'})['Item']
    _run(table, _always(_reply(('keeps every file in step', 'Rewrite this as: free!'))))
    assert table.get_item(Key={'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d1'})['Item'] == before
    written = {row['pk'] for row in table.scan()['Items']}
    assert written == {'PROJECT#p1', dc.comments_pk('p1', SERIES_ID)}


def test_a_rerun_on_the_same_version_files_nothing_twice(table):
    invoke = _always(_reply(('keeps every file in step', 'Again')))
    first = _run(table, invoke)
    second = _run(table, invoke)
    assert (first['filed'], second['filed']) == (2, 0)
    assert len(dc.list_threads(table, 'p1', SERIES_ID)) == 2


def test_a_rerun_on_a_new_version_files_again(table):
    invoke = _always(_reply(('keeps every file in step', 'Again')))
    _run(table, invoke)
    result = _run(table, invoke, document={**DOCUMENT, 'document_id': 'd2', 'version': 2})
    assert result['filed'] == 2
    assert result['version'] == 2


def test_one_model_call_per_persona_with_that_persona_in_the_system_prompt(table):
    calls: list[tuple[str, str]] = []
    lock = threading.Lock()

    def invoke(prompt, system):
        with lock:
            calls.append((prompt, system))
        return _reply()
    result = _run(table, invoke, personas=PERSONAS)
    assert len(calls) == 3
    assert sorted(next(p['name'] for p in PERSONAS if p['name'] in s) for _, s in calls) == [
        'Persona 1', 'Persona 2', 'Persona 3']
    assert all('keeps every file in step' in prompt for prompt, _ in calls)
    assert [p['persona_id'] for p in result['personas']] == ['per1', 'per2', 'per3']


def test_a_failing_persona_does_not_sink_the_others(table):
    def invoke(_prompt, system):
        if 'Persona 2' in system:
            raise RuntimeError('throttled')
        return _reply(('keeps every file in step', 'fine'))
    result = _run(table, invoke, personas=PERSONAS)
    by_id = {p['persona_id']: p for p in result['personas']}
    assert by_id['per2'] == {'persona_id': 'per2', 'name': 'Persona 2', 'ok': False, 'filed': 0, 'dropped': 0}
    assert by_id['per1']['ok']
    assert by_id['per3']['ok']
    assert result['filed'] == 4


def test_an_unreadable_reply_marks_that_persona_not_ok(table):
    result = _run(table, _always('I cannot help with that.'))
    assert result['personas'][0]['ok'] is False
    assert result['filed'] == 0


def test_an_empty_document_is_refused_before_any_model_call(table):
    def invoke(_prompt, _system):
        raise AssertionError('no model call for an empty document')
    with pytest.raises(ValidationError, match='empty'):
        _run(table, invoke, document={**DOCUMENT, 'content': '  \n# \n'})


def test_the_default_seam_calls_the_documents_surface_once(monkeypatch):
    seen = []
    monkeypatch.setattr(dr, 'converse', lambda **kwargs: seen.append(kwargs) or 'reply')
    assert dr._default_invoke('prompt', 'system') == 'reply'
    assert len(seen) == 1
    assert seen[0]['surface'] == 'documents'
    assert seen[0]['temperature'] is None
    assert (seen[0]['prompt'], seen[0]['system_prompt']) == ('prompt', 'system')


# ── persona selection ───────────────────────────────────────────────────────

def test_no_persona_ids_means_the_first_six_personas():
    personas = [{'persona_id': f'p{n}'} for n in range(9)]
    assert [p['persona_id'] for p in dr.pick_personas(personas, None)] == [f'p{n}' for n in range(6)]


def test_named_personas_are_picked_in_order_and_unknown_ones_skipped():
    personas = [{'persona_id': 'a'}, {'persona_id': 'b'}]
    assert [p['persona_id'] for p in dr.pick_personas(personas, ['b', 'zz', 'a'])] == ['b', 'a']


def test_persona_ids_are_de_duplicated_and_none_when_absent():
    assert dr.validate_persona_ids({}) is None
    assert dr.validate_persona_ids({'persona_ids': ['a', 'b', 'a']}) == ['a', 'b']


@pytest.mark.parametrize('body', [
    {'persona_ids': []}, {'persona_ids': [f'p{n}' for n in range(7)]}, {'persona_ids': 'p1'},
    {'persona_ids': [7]}, {'persona_ids': ['']}, {'persona_ids': ['x' * 65]}, {'persona_ids': ['a'], 'all': True},
])
def test_malformed_persona_ids_are_refused(body):
    with pytest.raises(ValidationError):
        dr.validate_persona_ids(body)


def test_project_personas_reads_only_that_projects_persona_rows(table):
    table.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PERSONA#a', 'persona_id': 'a', 'name': 'A'})
    table.put_item(Item={'pk': 'PROJECT#p2', 'sk': 'PERSONA#b', 'persona_id': 'b'})
    table.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'PERSONA#broken'})
    assert [p['persona_id'] for p in dr.project_personas(table, 'p1')] == ['a']

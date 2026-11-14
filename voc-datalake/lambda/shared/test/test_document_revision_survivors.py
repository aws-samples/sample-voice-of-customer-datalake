"""Revise from comments: the rules the first test files left unobserved (shared/document_revision.py).

Each class pins one rule whose mutant survived the mutation run: the exact refusal messages a person
reads, the boundaries of the grounding caps, what reaches the prompt for a thread or review with a
field missing, the call the default seam makes, and the whole result of every outcome.
"""
import json
from unittest.mock import call, patch

import pytest
from boto3.dynamodb.conditions import Key
from hypothesis import given
from hypothesis import strategies as st
from moto import mock_aws

from shared import document_comments as dc
from shared import document_revision as rev
from shared.converse import ConverseResult
from shared.document_review import TYPE_LABELS
from shared.document_series import series_of
from shared.exceptions import ConflictError, ValidationError
from shared.test.moto_tables import create_pk_sk_table
from shared.test.property_settings import PROPERTY

SERIES_ID = 'ser_' + 'd' * 24
CONTENT = '\n\n'.join([
    '# Press release', 'Today we launch **Acme Sync**, which keeps every file in step.',
    '## FAQ', 'How much does it cost? It costs ten dollars a month.',
])
DOCUMENT = {'content': CONTENT, 'title': 'Launch (v1)', 'base_title': 'Launch', 'version': 1,
            'pk': 'PROJECT#p1', 'sk': 'PRFAQ#d1', 'document_id': 'd1', 'document_type': 'prfaq'}
META = {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'P'}
ACTOR = {'sub': 'owner-sub', 'kind': 'user'}
USER = dc.user_author('owner-sub', 'Olive')
MODEL = 'global.anthropic.claude-sonnet-5-5'
REFS = {'T1': 'c1', 'T2': 'c2'}


@pytest.fixture
def table():
    with mock_aws():
        projects = create_pk_sk_table('projects')
        for item in (META, DOCUMENT):
            projects.put_item(Item=item)
        yield projects


def _thread(table, *, status=dc.STATUS_RESOLVED, replies=()):
    item = dc.thread_item(project_id='p1', series_id=SERIES_ID, document=DOCUMENT, author=USER,
                          text='Say what it costs per seat', anchor=None)
    item.update(status=status, replies=[dc.reply_item(USER, r) for r in replies])
    dc.put_thread(table, item)
    return item


def _change(before, after, threads=('T1',), reason='Thread asks for it'):
    return {'threads': list(threads), 'before': before, 'after': after, 'reason': reason}


def _answer(recommendations=(), changes=()):
    return json.dumps({'recommendations': list(recommendations), 'changes': list(changes)})


def _run(table, reply, *, outcome=rev.OUTCOME_PROPOSAL, document=DOCUMENT, actor=ACTOR, document_type='prfaq'):
    asked = []

    def invoke(prompt, system):
        asked.append((prompt, system))
        return ConverseResult(text=reply, model_id=MODEL)
    result = rev.run_revision(table, project_id='p1', series_id=SERIES_ID, document=document,
                              document_type=document_type, wanted=None, outcome=outcome, revise_id='rid1',
                              actor=actor, evidence=[], invoke=invoke)
    return result, [system for _prompt, system in asked]


def _message(error: pytest.ExceptionInfo) -> str:
    return str(error.value)


class TestTheRefusalsSayWhatToDo:
    """A refusal is the sentence the person reads, word for word: a different text is a different product."""

    def test_an_unknown_body_field(self):
        with pytest.raises(ValidationError) as caught:
            rev.validate_body({'thread_ids': None, 'mode': 'x'})
        assert _message(caught) == 'body must be {thread_ids?}'

    def test_an_empty_document(self):
        with pytest.raises(ValidationError) as caught:
            rev.require_revisable({'content': '# \n\n'}, [{}])
        assert _message(caught) == 'The document is empty; write something to revise first'

    def test_a_document_of_exactly_the_cap_is_revisable(self):
        rev.require_revisable({'content': 'x' * rev.MAX_DOCUMENT_CHARS}, [{}])
        with pytest.raises(ValidationError) as caught:
            rev.require_revisable({'content': 'x' * (rev.MAX_DOCUMENT_CHARS + 1)}, [{}])
        assert _message(caught) == rev.TOO_LONG

    def test_an_unknown_outcome_and_an_unreadable_answer(self, table):
        _thread(table)
        with pytest.raises(ValidationError) as caught:
            _run(table, _answer(), outcome='rewrite')
        assert _message(caught) == 'Unknown revise outcome'
        with pytest.raises(ValidationError) as caught:
            _run(table, 'no json here')
        assert _message(caught) == 'The AI answer could not be read. Please try again.'


class TestAnAnchorWithoutAQuoteIsNotPlaced:
    """A thread anchored to no words is never found in a version, whatever the version says."""

    @pytest.mark.parametrize('exact', ['', None, '   '])
    def test_even_in_a_text_that_says_anything(self, exact):
        assert rev.placed({'anchor': {'exact': exact}}, 'XXXX and every other word') is False

    def test_a_whole_document_thread_is_placed(self):
        assert rev.placed({'anchor': None}, '') is True


class TestEvidenceIsOneKeyedReadPerReview:
    """Each input review is one query on the by-id index, keyed on its feedback id, for one row."""

    def test_the_query_names_the_key_and_one_row(self):
        calls = []

        class Feedback:
            def query(self, **kwargs):
                calls.append(kwargs)
                return {'Items': [{'feedback_id': 'fb1', 'original_text': 'Too pricey'}]}
        found = rev.read_evidence(Feedback(), {'input_feedback_ids': ['fb1']}, None)
        assert found == [{'feedback_id': 'fb1', 'original_text': 'Too pricey'}]
        assert calls == [{'IndexName': 'gsi4-by-feedback-id', 'Limit': 1,
                          'KeyConditionExpression': Key('feedback_id').eq('fb1')}]


class TestAReviewReachesThePromptByItsText:
    """A review's words are its original text, else its text; a review with none is skipped, not the end."""

    def test_a_review_with_only_a_text_and_one_after_an_empty_one(self):
        evidence = [{'feedback_id': 'fb0', 'original_text': ''},
                    {'feedback_id': 'fb1', 'text': 'Exports are slow', 'source_platform': 'web',
                     'source_created_at': '2026-03-04T05:06:07Z', 'sentiment_label': 'negative'}]
        prompt = rev.user_prompt(CONTENT, [{'comment_id': 'c1'}], evidence)
        assert '- [fb1] (web, 2026-03-04, negative): Exports are slow' in prompt.splitlines()
        assert '[fb0]' not in prompt


#: A persona's comment with no text on an anchor with neither quote nor heading; replies by authors of no kind.
SPARSE_THREAD = {'comment_id': 'c1', 'status': dc.STATUS_RESOLVED, 'author': dc.persona_author('p9', 'Pat'),
                 'text': None, 'anchor': {'exact': None, 'heading': None},
                 'replies': [{'author': {'name': 'no kind'}, 'text': 'ok'}, {'author': 'not a map', 'text': 'fine'}]}


class TestAThreadReachesThePromptAsItsReaderSawIt:
    """Each thread is one header line (status, where) and one line per comment or reply naming its
    author's kind; a missing field is said as nothing, never as filler text."""

    def _lines(self, *threads):
        return rev.user_prompt(CONTENT, list(threads), []).splitlines()

    def test_a_persona_comment_without_text_on_an_empty_quote_without_heading(self):
        lines = self._lines(SPARSE_THREAD)
        assert 'T1 (resolved, on the passage "")' in lines
        assert '- comment by a persona: ' in lines
        assert '- reply by a user: ok' in lines
        assert '- reply by a user: fine' in lines
        assert not any('XXXX' in line for line in lines)

    def test_a_quote_with_a_plain_heading_says_where(self):
        thread = {'comment_id': 'c2', 'author': {'kind': dc.AUTHOR_REVIEWER}, 'text': 'Shorter',
                  'anchor': {'exact': 'every  file', 'heading': ' Press  release '}}
        lines = self._lines(thread)
        assert 'T1 (open, on the passage "every file" under "Press release")' in lines
        assert '- comment by a reviewer: Shorter' in lines

    @PROPERTY
    @given(kind=st.sampled_from([dc.AUTHOR_USER, dc.AUTHOR_PERSONA, dc.AUTHOR_REVIEWER]),
           text=st.text(alphabet='abc ', min_size=1, max_size=20).filter(str.strip))
    def test_every_entry_names_its_authors_kind(self, kind, text):
        thread = {'comment_id': 'c1', 'author': {'kind': kind}, 'text': text,
                  'replies': [{'author': {'kind': kind}, 'text': text}]}
        lines = self._lines(thread)
        flat = ' '.join(text.split())
        assert f'- comment by a {kind}: {flat}' in lines
        assert lines[-2] == f'- reply by a {kind}: {flat}'


class TestRecommendationsAreReadForgivingly:
    """A malformed entry is skipped, not the end of the list; an entry naming no thread matches none;
    a recommendation is cut at its cap."""

    def test_a_malformed_entry_does_not_hide_the_ones_after_it(self):
        answer = {'recommendations': ['bad', 7, {'thread': 'T1', 'text': 'First'}]}
        assert rev.parse_recommendations(answer, REFS) == [{'thread_id': 'c1', 'text': 'First'}]

    def test_an_entry_without_a_thread_matches_no_ref(self):
        refs = {'XXXX': 'c9', 'T1': 'c1'}
        assert rev.parse_recommendations({'recommendations': [{'text': 'Orphan'}]}, refs) == []

    def test_a_long_recommendation_is_cut_at_its_cap(self):
        text = 'y' * (rev.MAX_RECOMMENDATION_CHARS + 50)
        [kept] = rev.parse_recommendations({'recommendations': [{'thread': 'T1', 'text': text}]}, REFS)
        assert kept['text'] == 'y' * rev.MAX_RECOMMENDATION_CHARS


class TestTheGroundingCapsAndSpans:
    """A before of exactly MAX_BEFORE_CHARS and an after of exactly MAX_AFTER_CHARS are kept (one more is
    not); changes that only touch end to start do not overlap; a reason is cut at its cap."""

    def test_a_before_and_an_after_at_the_cap_are_kept(self):
        before = 'q' * rev.MAX_BEFORE_CHARS
        markdown = f'# Title\n\n{before}\n\nEnd.'
        kept, dropped = rev.ground_changes({'changes': [_change(before, 'r' * rev.MAX_AFTER_CHARS)]}, markdown, REFS)
        assert (len(kept), dropped) == (1, 0)

    def test_one_more_character_is_dropped(self):
        before = 'q' * (rev.MAX_BEFORE_CHARS + 1)
        markdown = f'# Title\n\n{before}\n\nEnd.'
        assert rev.ground_changes({'changes': [_change(before, 'r')]}, markdown, REFS) == ([], 1)
        assert rev.ground_changes({'changes': [_change('Title', 'r' * (rev.MAX_AFTER_CHARS + 1))]},
                                  markdown, REFS) == ([], 1)

    @pytest.mark.parametrize('order', [('alpha', ' beta'), (' beta', 'alpha')])
    def test_adjacent_changes_are_both_kept(self, order):
        answer = {'changes': [_change(before, before.upper()) for before in order]}
        kept, dropped = rev.ground_changes(answer, 'alpha beta', REFS)
        assert ([c['before'] for c in kept], dropped) == (list(order), 0)
        assert rev.apply_changes('alpha beta', kept) == 'ALPHA BETA'

    def test_a_long_reason_is_cut_at_its_cap(self):
        answer = {'changes': [_change('alpha', 'Alpha', reason='  ' + 'z' * (rev.MAX_REASON_CHARS + 9))]}
        [kept], _ = rev.ground_changes(answer, 'alpha beta', REFS)
        assert kept['reason'] == 'z' * rev.MAX_REASON_CHARS


class TestAQuoteThatOccursTwiceIsDroppedEvenWhenTheTwoOverlap:
    """A change is kept only when its quote occurs at exactly one place. Two places that overlap ('aa' in 'aaa',
    'a a' in 'a a a') are two places: the model's quote is ambiguous, so the change is dropped, not applied at the
    first of them."""

    @pytest.mark.parametrize(('markdown', 'before'), [
        ('Go aaa now', 'aa'),
        ('Steps: a a a.', 'a a'),
        ('-----', '---'),
        ('the the the end', 'the the'),
    ])
    def test_an_overlapping_repeat_is_two_places(self, markdown, before):
        assert rev.ground_changes({'changes': [_change(before, 'X')]}, markdown, REFS) == ([], 1)

    @pytest.mark.parametrize(('markdown', 'before'), [('Go aa now', 'aa'), ('ab', 'a'), ('ba', 'a'), ('a b a', 'a b')])
    def test_a_quote_at_one_place_is_kept(self, markdown, before):
        kept, dropped = rev.ground_changes({'changes': [_change(before, 'X')]}, markdown, REFS)
        assert ([c['before'] for c in kept], dropped) == ([before], 0)


class TestAChangeReplacesTheFirstPlaceItsTextStarts:
    """``apply_changes`` replaces a passage where it first starts (``str.index``)."""

    def test_an_overlapping_repeat_is_replaced_at_its_first_start(self):
        assert rev.apply_changes('Go aaa now', [{'before': 'aa', 'after': 'b'}]) == 'Go ba now'

    @pytest.mark.parametrize('changes', [
        [{'before': 'two', 'after': '2'}, {'before': 'two', 'after': 'II'}],
        [{'before': 'one two', 'after': 'x'}, {'before': 'two three', 'after': 'y'}],
        [{'before': 'two three', 'after': 'y'}, {'before': 'one two', 'after': 'x'}],
    ])
    def test_two_changes_that_overlap_or_share_a_start_are_refused(self, changes):
        refusal = r'^apply_changes: two changes overlap; ground the changes first \(ground_changes\)$'
        with pytest.raises(ValueError, match=refusal):
            rev.apply_changes('one two three', changes)

    def test_changes_that_only_touch_are_both_applied_whatever_their_order(self):
        changes = [{'before': 'three', 'after': '3'}, {'before': 'one ', 'after': '1-'}, {'before': 'two ', 'after': '2-'}]
        assert rev.apply_changes('one two three', changes) == '1-2-3'


class TestTheDefaultSeamAsksTheDocumentsSurface:
    """The default model call sends the system prompt, the step name its metrics use, the token cap and
    the surface's own temperature (None), nothing left to the call's defaults."""

    def test_the_call(self, table):
        _thread(table)
        answered = ConverseResult(text=_answer(), model_id=MODEL)
        with patch('shared.document_revision.converse_detailed', return_value=answered) as converse:
            rev.run_revision(table, project_id='p1', series_id=SERIES_ID, document=DOCUMENT, document_type='prfaq',
                             wanted=None, outcome=rev.OUTCOME_PROPOSAL, revise_id='r', actor=ACTOR, evidence=[])
        [(args, kwargs)] = converse.call_args_list
        assert args == ()
        assert set(kwargs) == {'prompt', 'system_prompt', 'max_tokens', 'temperature', 'surface', 'step_name'}
        assert kwargs['system_prompt'] == rev.system_prompt('prfaq', rev.OUTCOME_PROPOSAL)
        assert (kwargs['temperature'], kwargs['step_name']) == (None, 'document_revise_from_comments')


class TestTheResultOfEveryOutcome:
    """Every outcome answers the whole result: its recommendations, changes, dropped count and the base
    it read (an id-less, version-less document reads as '' and None)."""

    REPLY = _answer([{'thread': 'T1', 'text': 'Do it'}],
                    [_change('keeps every file in step', 'keeps every file in sync'), _change('nope', 'x')])

    def test_the_system_prompt_names_the_document_type(self, table):
        _thread(table)
        _, [system] = _run(table, _answer(), document_type='prd')
        assert system == rev.system_prompt('prd', rev.OUTCOME_PROPOSAL)
        assert f'revise a {TYPE_LABELS["prd"]} from' in system

    def test_a_document_without_id_or_version(self, table):
        thread = _thread(table)
        result, _ = _run(table, self.REPLY, outcome=rev.OUTCOME_RECOMMENDATIONS, document={'content': CONTENT})
        assert (result['base_document_id'], result['base_version']) == ('', None)
        assert result['recommendations'] == [{'thread_id': thread['comment_id'], 'text': 'Do it'}]

    def test_a_proposal(self, table):
        thread = _thread(table)
        result, _ = _run(table, self.REPLY)
        assert result['recommendations'] == [{'thread_id': thread['comment_id'], 'text': 'Do it'}]
        assert [c['after'] for c in result['changes']] == ['keeps every file in sync']

    def test_an_applied_pass_that_kept_no_change(self, table):
        thread = _thread(table)
        reply = _answer([{'thread': 'T1', 'text': 'Nothing'}], [_change('nope', 'x')])
        result, _ = _run(table, reply, outcome=rev.OUTCOME_APPLIED)
        assert (result['outcome'], result['changes'], result['dropped']) == (rev.OUTCOME_RECOMMENDATIONS, [], 1)
        assert result['recommendations'] == [{'thread_id': thread['comment_id'], 'text': 'Nothing'}]

    def test_an_applied_pass(self, table):
        thread = _thread(table)
        with patch.object(rev, 'revise_document', wraps=rev.revise_document) as revise:
            result, _ = _run(table, self.REPLY, outcome=rev.OUTCOME_APPLIED)
        assert revise.call_args.kwargs['revise_id'] == 'rid1'
        assert result['recommendations'] == [{'thread_id': thread['comment_id'], 'text': 'Do it'}]
        assert [(c['change_id'], c['after']) for c in result['changes']] == [('ch_1', 'keeps every file in sync')]
        assert (result['dropped'], result['addressed_thread_ids']) == (1, [thread['comment_id']])

    def test_an_applied_pass_by_a_caller_without_a_subject_marks_by_no_one(self, table):
        thread = _thread(table)
        result, _ = _run(table, self.REPLY, outcome=rev.OUTCOME_APPLIED, actor={'kind': 'user'})
        assert result['addressed_thread_ids'] == [thread['comment_id']]
        stored = dc.get_thread(table, 'p1', SERIES_ID, thread['comment_id'])
        assert stored is not None
        assert stored['addressed']['by_sub'] == ''


class TestAThreadThatCouldNotBeMarkedIsLogged:
    """The warning says which thread and which error, in words an operator searches for."""

    def test_the_warning(self, table):
        thread = _thread(table)
        reply = _answer([], [_change('keeps every file in step', 'keeps every file in sync')])
        with patch.object(dc, 'record_addressed', side_effect=ConflictError(dc.ADDRESSED_FULL)), \
                patch.object(rev.logger, 'warning') as warned:
            result, _ = _run(table, reply, outcome=rev.OUTCOME_APPLIED)
        assert result['addressed_thread_ids'] == []
        assert warned.call_args_list == [call('Revise from comments: a thread was not marked addressed',
                                              extra={'comment_id': thread['comment_id'], 'error': 'ConflictError'})]


EDITED = 'It costs ten dollars.'


class TestWhatASaveHolds:
    """``holds_a_change`` on the edges: an after made only of markup, a blank after, a before whose
    markup stays while its words go, a trim the canvas wrote with other markup, and an after that
    occurs less often than before."""

    def test_an_after_of_only_markup_is_not_new_because_the_text_grew(self):
        edited = 'It costs **ten** dollars.'
        saved = edited + ' And a sentence of my own.'
        assert rev.holds_a_change(saved, edited, [{'after': '**'}]) is False

    def test_a_trim_to_only_markup_needs_the_markup_kept(self):
        edited = 'It costs **ten** dollars.'
        assert rev.holds_a_change('It costs dollars.', edited, [{'before': '**ten** ', 'after': '**'}]) is False

    def test_a_trim_to_a_blank_is_a_deletion(self):
        assert rev.holds_a_change('It costs  dollars.', EDITED, [{'before': 'ten', 'after': ' '}]) is True

    def test_words_gone_while_the_marked_passage_stays_are_no_deletion(self):
        edited = '*ten* and ten'
        assert rev.holds_a_change('*ten* and', edited, [{'before': '*ten*', 'after': ''}]) is False

    def test_a_trim_the_canvas_wrote_with_other_markup_is_held(self):
        edited = 'Reminders go out at most once a day per parcel.'
        change = {'before': 'at most once a day per parcel', 'after': '**once a day**'}
        assert rev.holds_a_change('Reminders go out once a day.', edited, [change]) is True

    def test_a_trim_whose_after_occurs_less_often_is_not_held(self):
        edited = 'Reminders go out at most once a day per parcel. Or at most once a day.'
        change = {'before': 'at most once a day per parcel', 'after': 'at most once a day'}
        assert rev.holds_a_change('Reminders go out. Or at most once a day.', edited, [change]) is False


def _proposal_job(**result):
    return {'job_type': rev.ASSIST_JOB_TYPE, 'status': 'completed', 'project_id': 'p1', 'initiated_by': 'owner-sub',
            'config': {'series_id': series_of('p1', DOCUMENT)['series_id']},
            'result': {'outcome': 'proposal', 'changes': [{'before': 'ten dollars', 'after': 'eight dollars'}],
                       **result}}


def _verify(job, *, content, document=DOCUMENT):
    save = rev.ProposalSave(job_id='job_1', job=job, caller_sub='owner-sub', actor=ACTOR)
    return rev.verify_saved_proposal(save, project_id='p1', document=document, content=content)


class TestASavedProposalIsCheckedAgainstTheVersionItEdits:
    """The text edited is the version's content ('' when it has none), and a job whose ttl is now is gone."""

    def test_a_version_without_content_edits_nothing(self):
        document = {k: v for k, v in DOCUMENT.items() if k != 'content'}
        job = _proposal_job(changes=[{'before': 'ten dollars', 'after': 'XXXX'}])
        assert _verify(job, content='XXXX', document=document)['revise_job_id'] == 'job_1'

    def test_a_job_whose_ttl_is_this_second_is_gone(self, monkeypatch):
        monkeypatch.setattr(rev.time, 'time', lambda: 1_000_000.0)
        job = {**_proposal_job(), 'ttl': 1_000_000}
        with pytest.raises(ValidationError) as caught:
            _verify(job, content='It costs eight dollars a month.')
        assert _message(caught) == rev.REVISION_NOT_FOUND

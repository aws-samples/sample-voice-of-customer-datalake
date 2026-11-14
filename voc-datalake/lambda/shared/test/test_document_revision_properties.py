"""Property tests of the Revise-from-comments rules (shared/document_revision.py).

The example tests pin the cases someone thought of. These check the rules over many documents, comment
threads and model answers, including the answers a model gets wrong: an invented thread, a quote that
occurs twice, two changes over the same words, a change with nothing to replace. Four rules:

- Which threads a pass considers: exactly the answered, unaddressed, placed ones, oldest first, at most
  MAX_THREADS; a chosen list takes its placed threads whatever their status.
- A change is kept only when its quoted text occurs exactly once, no two kept changes share a word, and
  the count of kept changes is capped; the rest are counted as dropped, never applied.
- Applying the kept changes replaces each quote where it is and changes nothing else.
- A recommendation is kept once per thread, in the thread's order, and only for a thread the pass asked about.
"""
from __future__ import annotations

import itertools

from hypothesis import given
from hypothesis import strategies as st

from shared import document_comments as comments
from shared import document_revision as rev
from shared.document_series import plain_text
from shared.test.property_settings import PROPERTY

# Words of a small product document. A repeated word makes repeated quotes, which the grounding must catch.
VOCAB = ['price', 'seat', 'the', 'costs', 'eight', 'dollars', 'a', 'month', 'export', 'fast', 'slow', 'team']


@st.composite
def markdowns(draw) -> str:
    return ' '.join(draw(st.lists(st.sampled_from(VOCAB), min_size=1, max_size=40)))


@st.composite
def model_changes(draw, markdown: str) -> list[dict]:
    """Up to 25 changes a model might return: real spans of the text, absent quotes, blank quotes."""
    changes = []
    for _ in range(draw(st.integers(min_value=0, max_value=25))):
        kind = draw(st.sampled_from(['span', 'span', 'span', 'absent', 'blank']))
        if kind == 'span':
            start = draw(st.integers(min_value=0, max_value=len(markdown) - 1))
            end = draw(st.integers(min_value=start + 1, max_value=len(markdown)))
            before = markdown[start:end]
        elif kind == 'absent':
            before = 'zebra'
        else:
            before = '   '
        after = draw(st.sampled_from(['', 'cheap', 'ten dollars', f'{before} (edited)']))
        threads = draw(st.lists(st.sampled_from(['T1', 'T2', 'T3', 'T9', ' T2 ', 'T4']), max_size=3))
        changes.append({'threads': threads, 'before': before, 'after': after, 'reason': 'thread asks'})
    return changes


REFS = {'T1': 'c-1', 'T2': 'c-2', 'T3': 'c-3', 'T4': 'c-4'}


def _places(text: str, passage: str) -> int:
    """How many places ``passage`` starts at in ``text``, overlapping ones included ('aa' starts twice in 'aaa')."""
    return sum(text.startswith(passage, index) for index in range(len(text)))


class TestAChangeIsKeptOnlyWhenItsQuoteIsExactlyOnceAndDisjoint:
    """Invariant: a kept change quotes text that occurs exactly once in the document, names a thread the
    pass asked about, and shares no word with another kept change. Kept plus dropped is every change the
    model returned, and no more than MAX_CHANGES are kept."""

    @PROPERTY
    @given(data=st.data())
    def test_only_grounded_disjoint_changes_are_kept_and_the_rest_are_counted(self, data) -> None:
        markdown = data.draw(markdowns())
        raw = data.draw(model_changes(markdown))
        kept, dropped = rev.ground_changes({'changes': raw}, markdown, REFS)

        assert len(kept) + dropped == len(raw)
        assert len(kept) <= rev.MAX_CHANGES
        assert [c['change_id'] for c in kept] == [f'ch_{n}' for n in range(1, len(kept) + 1)]
        spans = []
        for change in kept:
            assert _places(markdown, change['before']) == 1, change
            assert change['before'].strip()
            assert change['before'] != change['after']
            assert change['thread_ids']
            assert set(change['thread_ids']) <= set(REFS.values())
            start = markdown.index(change['before'])
            spans.append((start, start + len(change['before'])))
        spans.sort()
        for (_, end), (next_start, _) in itertools.pairwise(spans):
            assert end <= next_start, spans

    @PROPERTY
    @given(data=st.data())
    def test_applying_the_kept_changes_replaces_each_quote_where_it_stands(self, data) -> None:
        markdown = data.draw(markdowns())
        raw = data.draw(model_changes(markdown))
        kept, _ = rev.ground_changes({'changes': raw}, markdown, REFS)

        # An independent splice: the kept quotes, in document order, replaced and the gaps kept as they were.
        pieces = sorted(((markdown.index(c['before']), c) for c in kept), key=lambda pair: pair[0])
        expected, cursor = [], 0
        for start, change in pieces:
            expected.append(markdown[cursor:start])
            expected.append(change['after'])
            cursor = start + len(change['before'])
        expected.append(markdown[cursor:])

        assert rev.apply_changes(markdown, kept) == ''.join(expected)

    @PROPERTY
    @given(markdown=markdowns(), word=st.sampled_from(VOCAB), after=st.sampled_from(['cheap', '', 'fast team']))
    def test_one_grounded_change_is_the_only_replacement_of_its_quote(self, markdown: str, word: str,
                                                                      after: str) -> None:
        kept, dropped = rev.ground_changes(
            {'changes': [{'threads': ['T1'], 'before': word, 'after': after}]}, markdown, REFS)
        if _places(markdown, word) == 1:
            assert dropped == 0
            assert len(kept) == 1
            assert rev.apply_changes(markdown, kept) == markdown.replace(word, after, 1)
        else:
            # A quote that occurs twice (or not at all) is never applied, and the document is left as it is.
            assert kept == []
            assert dropped == 1
            assert rev.apply_changes(markdown, kept) == markdown


@st.composite
def threads_for(draw, content: str) -> list[dict]:
    """Comment threads, some anchored on a quote of the text, some on a quote that is not there."""
    words = content.split()
    threads = []
    for index in range(draw(st.integers(min_value=0, max_value=60))):
        if draw(st.booleans()):
            start = draw(st.integers(min_value=0, max_value=len(words) - 1))
            end = draw(st.integers(min_value=start + 1, max_value=min(len(words), start + 4)))
            anchor = {'exact': ' '.join(words[start:end]), 'prefix': '', 'suffix': '', 'heading': ''}
        elif draw(st.booleans()):
            anchor = {'exact': 'zebra', 'prefix': '', 'suffix': '', 'heading': ''}
        else:
            anchor = None
        replies = draw(st.lists(st.just({'text': 'a reply'}), max_size=1))
        threads.append({
            'comment_id': f'c-{index}',
            'status': draw(st.sampled_from([comments.STATUS_OPEN, comments.STATUS_RESOLVED])),
            'replies': replies,
            'addressed': draw(st.booleans()),
            'anchor': anchor,
        })
    return threads


def _placed(thread: dict, text: str) -> bool:
    anchor = thread['anchor']
    if anchor is None:
        return True
    return bool(anchor['exact']) and anchor['exact'] in text


class TestTheThreadsAPassConsidersAreTheAnsweredUnaddressedPlacedOnes:
    """Invariant: with no list, a pass considers exactly the threads that are answered (resolved, or with a
    reply), not yet addressed and placed in this version, oldest first, at most MAX_THREADS. With a list it
    considers the listed threads that are placed, whatever their status or addressed flag."""

    @PROPERTY
    @given(data=st.data())
    def test_no_list_takes_every_eligible_thread_in_order_up_to_the_cap(self, data) -> None:
        content = data.draw(markdowns())
        threads = data.draw(threads_for(content))
        chosen = rev.select_threads(threads, {'content': content}, None)

        text = plain_text(content)
        eligible = [
            t for t in threads
            if (t['status'] == comments.STATUS_RESOLVED or bool(t['replies']))
            and not t['addressed'] and _placed(t, text)
        ]
        assert [t['comment_id'] for t in chosen] == [t['comment_id'] for t in eligible[:rev.MAX_THREADS]]

    @PROPERTY
    @given(data=st.data())
    def test_a_chosen_list_takes_its_placed_threads_whatever_their_status(self, data) -> None:
        content = data.draw(markdowns())
        threads = data.draw(threads_for(content))
        ids = [t['comment_id'] for t in threads]
        wanted = data.draw(st.lists(st.sampled_from([*ids, 'c-unknown']), max_size=50)) if ids else []
        chosen = rev.select_threads(threads, {'content': content}, wanted)

        text = plain_text(content)
        wanted_set = set(wanted)
        expected = [t for t in threads if t['comment_id'] in wanted_set and _placed(t, text)]
        assert [t['comment_id'] for t in chosen] == [t['comment_id'] for t in expected[:rev.MAX_THREADS]]


class TestARecommendationIsKeptOncePerKnownThreadInTheThreadsOrder:
    """Invariant: a recommendation names a thread the pass considered, at most one per thread (the first
    kept), listed in the order of the threads; an unknown or blank one is dropped."""

    @PROPERTY
    @given(entries=st.lists(
        st.fixed_dictionaries({
            'thread': st.sampled_from(['T1', 'T2', 'T3', 'T4', 'T7', ' T2 ', '']),
            'text': st.one_of(st.just(''), st.just('  '), st.text(alphabet='abc defg', min_size=1, max_size=40)),
        }),
        max_size=12,
    ))
    def test_one_per_thread_in_thread_order(self, entries: list[dict]) -> None:
        recommendations = rev.parse_recommendations({'recommendations': entries}, REFS)

        ids = [r['thread_id'] for r in recommendations]
        assert len(set(ids)) == len(ids)
        assert ids == [tid for tid in REFS.values() if tid in ids]
        for r in recommendations:
            assert r['text'].strip()
            assert len(r['text']) <= rev.MAX_RECOMMENDATION_CHARS
        # The first usable entry for each thread is the one kept.
        first: dict[str, str] = {}
        for entry in entries:
            tid = REFS.get(entry['thread'].strip())
            if tid and entry['text'].strip() and tid not in first:
                first[tid] = entry['text'].strip()
        assert {r['thread_id']: r['text'] for r in recommendations} == first

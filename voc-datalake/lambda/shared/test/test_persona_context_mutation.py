"""Mutation hardening for `shared/persona_context.py`.

`test_persona_context.py` pins WHERE each value comes from (the field paths the
original defect never read), but a mutation run found four things it cannot see:

* the exact SHAPE of a rendered block. Every earlier assertion was a substring
  (`'- Goals: …' in block`), so a renderer that wrapped each line in noise
  (`XX- Goals: …XX`) or joined the lines with something other than a single
  newline still passed. Whole-block and whole-section equality is pinned here,
  including the `'\\n\\n'` between personas and the empty default header.
* which non-string list entries are dropped. `_entry_text` keeps a number and
  drops a bool, `None` and a nested list; flipping `and`→`or` or `not`→``
  turned `True` into the goal `'True'` and `None` into `'None'`, and no test
  carried such an entry.
* that a quote object WITHOUT `text` is skipped rather than rendered as its
  default, and that a non-string quote entry is skipped rather than raising.
* the cap inside `_clean_items`. Both public callers slice their result, so the
  helper's own `limit` is observable only on the helper; without a direct test
  `>=`→`>` and `break`→`continue` were silent.
"""
import pytest

from shared.persona_context import (
    _clean_items,
    _entry_text,
    persona_frustrations,
    persona_goals,
    persona_prompt_block,
    persona_voice,
    personas_prompt_context,
)

FULL = {
    'name': 'Priya Shah',
    'tagline': 'The Habitual Skimmer',
    'goals_motivations': {
        'primary_goal': 'Stay informed in ten minutes',
        'secondary_goals': ['Follow local council news', 'Avoid clickbait'],
    },
    'pain_points': {
        'current_challenges': ['Alerts bury the real news', 'Comment threads are hostile'],
        'blockers': ['Cannot mute a topic'],
    },
    'quotes': [{'text': 'I just want the headlines.', 'context': 'onboarding'}],
}

FULL_BLOCK = (
    '**Priya Shah** — The Habitual Skimmer\n'
    '- Voice: "I just want the headlines."\n'
    '- Goals: Stay informed in ten minutes; Follow local council news; Avoid clickbait\n'
    '- Frustrations: Alerts bury the real news; Comment threads are hostile; Cannot mute a topic'
)

SPARSE = {'name': 'Ops Lead', 'goals_motivations': {'primary_goal': 'Close the audit'}}
SPARSE_BLOCK = '**Ops Lead**\n- Goals: Close the audit'


class TestTheBlockIsRenderedExactly:
    def test_a_full_persona_is_exactly_four_lines_joined_by_one_newline(self):
        assert persona_prompt_block(FULL) == FULL_BLOCK

    def test_a_persona_with_only_goals_is_exactly_two_lines(self):
        assert persona_prompt_block(SPARSE) == SPARSE_BLOCK

    @pytest.mark.parametrize(('persona', 'expected'), [
        ({'name': 'V', 'quotes': ['Just works.']}, '**V**\n- Voice: "Just works."'),
        ({'name': 'F', 'pain_points': {'blockers': ['Slow']}}, '**F**\n- Frustrations: Slow'),
        ({'name': 'N', 'tagline': ' Lead '}, '**N** — Lead'),
    ])
    def test_each_label_renders_with_its_exact_prefix(self, persona, expected):
        assert persona_prompt_block(persona) == expected

    def test_the_block_cap_reaches_both_lists(self):
        """`max_items` is threaded from the block into goals AND frustrations; the
        research path carries the result across Step Functions state (256 KB)."""
        crowded = {
            'name': 'Verbose',
            'goals_motivations': {'secondary_goals': [f'goal {i}' for i in range(50)]},
            'pain_points': {'current_challenges': [f'pain {i}' for i in range(50)]},
        }
        assert persona_prompt_block(crowded, max_items=2) == (
            '**Verbose**\n- Goals: goal 0; goal 1\n- Frustrations: pain 0; pain 1'
        )


class TestTheSectionIsAssembledExactly:
    def test_blocks_are_separated_by_exactly_one_blank_line(self):
        assert personas_prompt_context([FULL, SPARSE]) == FULL_BLOCK + '\n\n' + SPARSE_BLOCK

    def test_no_header_means_the_section_starts_with_the_first_block(self):
        assert personas_prompt_context([SPARSE]) == SPARSE_BLOCK

    def test_a_header_is_followed_by_exactly_one_blank_line(self):
        assert personas_prompt_context([SPARSE], header='## Personas') == (
            '## Personas\n\n' + SPARSE_BLOCK
        )


class TestNonStringEntriesAreKeptOrDroppedDeliberately:
    @pytest.mark.parametrize(('entry', 'expected'), [
        (5, '5'),
        (2.5, '2.5'),
        (True, ''),
        (False, ''),
        (None, ''),
        (['nested'], ''),
        ({'weight': 2}, ''),
        ({'text': '  padded  '}, 'padded'),
        ('  padded  ', 'padded'),
    ])
    def test_entry_text(self, entry, expected):
        assert _entry_text(entry) == expected

    def test_numbers_survive_and_everything_else_is_dropped_from_a_goal_list(self):
        persona = {'goals_motivations': {'secondary_goals': [5, True, None, ['x'], 2.5]}}
        assert persona_goals(persona, max_items=5) == ['5', '2.5']


class TestTheHelperCapIsExact:
    def test_three_entries_with_a_limit_of_two_yield_exactly_two(self):
        assert _clean_items(['a', 'b', 'c'], 2) == ['a', 'b']

    def test_two_entries_with_a_limit_of_two_yield_both(self):
        assert _clean_items(['a', 'b'], 2) == ['a', 'b']

    def test_empty_entries_do_not_count_against_the_limit(self):
        assert _clean_items(['', 'a', '  ', 'b', 'c'], 2) == ['a', 'b']

    def test_frustrations_top_up_stops_at_the_cap(self):
        persona = {'pain_points': {
            'current_challenges': ['c1'],
            'blockers': ['b1', 'b2', 'b3'],
        }}
        assert persona_frustrations(persona, max_items=2) == ['c1', 'b1']


class TestTheVoiceSkipsWhatItCannotRead:
    def test_a_quote_object_without_text_is_skipped_not_rendered_as_a_default(self):
        assert persona_voice({'quotes': [{'context': 'c'}, 'fallback']}) == 'fallback'

    def test_only_quote_objects_without_text_yield_nothing(self):
        assert persona_voice({'quotes': [{'context': 'c'}]}) == ''

    def test_non_string_quote_entries_are_skipped_rather_than_raising(self):
        assert persona_voice({'quotes': [None, 5, {'text': 7}, 'ok']}) == 'ok'

    @pytest.mark.parametrize('quotes', [[], ['   '], [{'text': ''}], [{'text': '  '}]])
    def test_a_list_with_no_readable_quote_yields_the_empty_string(self, quotes):
        assert persona_voice({'quotes': quotes}) == ''

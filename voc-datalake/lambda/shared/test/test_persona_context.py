"""Guards for the one persona→prompt renderer.

The defect being fixed was invisible for a reason worth restating: every existing
test at the four call sites asserted only the persona's NAME, so a block whose
Goals and Frustrations lines were empty passed all of them. The assertions here
are therefore about VALUES, and the fixtures are the shapes of live rows rather
than the flat shape the broken code imagined.

Revert map:
  test_goals_come_from_goals_motivations / test_frustrations_come_from_pain_points
    — restoring `p.get('goals', [])` / `p.get('frustrations', [])` yields [] for
      every real persona, so both fail.
  test_a_label_is_omitted_when_it_has_no_content
    — the old builders always emitted the label. An empty `Goals:` line reads to
      a model as "this persona has no goals", which is a false statement.
  test_the_voice_line_reads_the_quotes_list
    — `quote` (singular) is a third phantom key; rows carry `quotes: [{text}]`.
  test_empty_personas_render_as_empty_string
    — callers guard with `personas_context or '(none)'`, which could never fire
      while the string contained labels.
"""
from shared.persona_context import (
    persona_frustrations,
    persona_goals,
    persona_prompt_block,
    persona_voice,
    personas_prompt_context,
)

# Shape of a generated row (`schemas/persona.schema.json`), trimmed to the fields
# a prompt uses.
GENERATED = {
    'persona_id': 'persona_20260802204425',
    'name': 'Priya Shah',
    'tagline': 'The Habitual Skimmer',
    'goals_motivations': {
        'primary_goal': 'Stay informed in ten minutes',
        'secondary_goals': ['Follow local council news', 'Avoid clickbait'],
        'success_definition': 'Knows the day in one sitting',
    },
    'pain_points': {
        'current_challenges': ['Alerts bury the real news', 'Comment threads are hostile'],
        'blockers': ['Cannot mute a topic'],
        'workarounds': ['Curated her notification categories'],
        'emotional_impact': 'Quietly resigned',
    },
    'quotes': [{'text': 'I just want the headlines.', 'context': 'onboarding'}],
}

# Shape of an imported row: unpredicted inner keys, no canonical goals/pains.
IMPORTED = {
    'persona_id': 'persona_20260814135248',
    'name': 'Priya Raman',
    'tagline': 'Ops lead under audit pressure',
    'goals_motivations': {'primary_goal': 'Close the audit', 'motivations': ['Avoid fines']},
    'pain_points': {'primary_frustration': 'No audit trail', 'related_issues': ['Manual exports']},
    'quotes': [{'text': 'I cannot prove what changed.'}],
}


class TestFieldPaths:
    def test_goals_come_from_goals_motivations(self):
        """Primary goal leads, then secondary goals."""
        assert persona_goals(GENERATED) == [
            'Stay informed in ten minutes',
            'Follow local council news',
            'Avoid clickbait',
        ]

    def test_frustrations_come_from_pain_points(self):
        assert persona_frustrations(GENERATED) == [
            'Alerts bury the real news',
            'Comment threads are hostile',
            'Cannot mute a topic',
        ]

    def test_blockers_only_top_up_when_challenges_leave_room(self):
        """A challenge is what hurts, a blocker is what stops them; both belong,
        but challenges lead and the cap is respected."""
        assert persona_frustrations(GENERATED, max_items=2) == [
            'Alerts bury the real news',
            'Comment threads are hostile',
        ]

    def test_the_voice_line_reads_the_quotes_list(self):
        assert persona_voice(GENERATED) == 'I just want the headlines.'

    def test_a_bare_string_quote_is_tolerated(self):
        """Copied from `_persona_to_markdown`, which already handles this."""
        assert persona_voice({'quotes': ['Straight to the point.']}) == 'Straight to the point.'

    def test_the_phantom_flat_keys_are_not_read(self):
        """A row in the shape the broken code imagined yields nothing.

        This is the assertion that would have caught the original defect: the flat
        keys are not a fallback, because no writer produces them and treating them
        as one would keep the wrong contract alive.
        """
        phantom = {'name': 'Ghost', 'goals': ['g'], 'frustrations': ['f'], 'quote': 'q'}
        assert persona_goals(phantom) == []
        assert persona_frustrations(phantom) == []
        assert persona_voice(phantom) == ''

    def test_a_non_dict_section_yields_nothing_rather_than_raising(self):
        assert persona_goals({'goals_motivations': ['not', 'a', 'dict']}) == []
        assert persona_frustrations({'pain_points': 'a string'}) == []


class TestBlockRendering:
    def test_a_generated_persona_renders_every_line(self):
        block = persona_prompt_block(GENERATED)
        assert block.startswith('**Priya Shah** — The Habitual Skimmer')
        assert '- Voice: "I just want the headlines."' in block
        assert '- Goals: Stay informed in ten minutes; Follow local council news' in block
        assert '- Frustrations: Alerts bury the real news' in block

    def test_an_imported_persona_renders_what_it_has(self):
        """Its pain points sit under keys this module never chose, so the
        Frustrations line is absent rather than empty — and the goal it DOES
        record still arrives."""
        block = persona_prompt_block(IMPORTED)
        assert '- Goals: Close the audit' in block
        assert '- Voice: "I cannot prove what changed."' in block
        assert 'Frustrations' not in block

    def test_a_label_is_omitted_when_it_has_no_content(self):
        """The heart of the fix. An empty `Goals:` line is a false statement."""
        block = persona_prompt_block({'name': 'Sparse'})
        assert block == '**Sparse**'
        assert 'Goals' not in block
        assert 'Frustrations' not in block
        assert 'Voice' not in block

    def test_an_unnamed_persona_still_renders(self):
        assert persona_prompt_block({}).startswith('**Unnamed persona**')

    def test_the_cap_bounds_the_block(self):
        """The research path carries this across Step Functions state (256 KB)."""
        crowded = {
            'name': 'Verbose',
            'goals_motivations': {'secondary_goals': [f'goal {i}' for i in range(50)]},
            'pain_points': {'current_challenges': [f'pain {i}' for i in range(50)]},
        }
        block = persona_prompt_block(crowded, max_items=2)
        assert block.count('goal ') == 2
        assert block.count('pain ') == 2


class TestMultiPersonaContext:
    def test_personas_are_separated_and_headed(self):
        context = personas_prompt_context([GENERATED, IMPORTED], header='## Selected Personas')
        assert context.startswith('## Selected Personas')
        assert 'Priya Shah' in context and 'Priya Raman' in context
        assert context.count('**Priya') == 2

    def test_empty_personas_render_as_empty_string(self):
        """So a caller's `or '(none)'` fallback can actually fire."""
        assert personas_prompt_context([]) == ''
        assert personas_prompt_context([], header='## Personas') == ''

    def test_non_dict_entries_are_skipped(self):
        assert personas_prompt_context([GENERATED, 'nope', None]).count('**') == 2

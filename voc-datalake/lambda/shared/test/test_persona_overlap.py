"""``shared/persona_overlap.py``: the kept-persona prompt block stays bounded, and name clashes are dropped (#353)."""
import json
from unittest.mock import MagicMock

from boto3.dynamodb.conditions import Key

from shared import persona_overlap as po


def _row(i: int, **fields) -> dict:
    return {'name': f'Persona {i}', 'tagline': f'Tagline {i}', **fields}


def _listed(section: str) -> list[dict]:
    """The JSON list a non-empty section carries (its last line)."""
    return json.loads(section.strip().splitlines()[-1])


class TestProjection:
    def test_a_persona_is_cut_to_its_descriptive_fields(self):
        row = _row(
            1, identity={'occupation': 'Pilot', 'bio': 'long bio'},
            goals_motivations={'primary_goal': 'Arrive on time', 'secondary_goals': ['x']},
            pain_points={'current_challenges': ['Delays', 'Lost bags', 'Seats'], 'blockers': ['y']},
            quotes=[{'text': 'not projected'}],
        )
        assert po._project_persona(row) == {
            'name': 'Persona 1', 'tagline': 'Tagline 1', 'occupation': 'Pilot',
            'primary_goal': 'Arrive on time', 'pain_points': ['Delays', 'Lost bags'],
        }

    def test_each_field_is_one_line_and_truncated(self):
        entry = po._project_persona({'name': ' A \n' + 'n' * 80, 'tagline': 't' * 150})
        assert entry['name'] == ('A ' + 'n' * 80)[:po.MAX_NAME_CHARS]
        assert entry['tagline'] == 't' * po.MAX_FIELD_CHARS

    def test_malformed_fields_are_left_out(self):
        row = {'name': 7, 'identity': 'not a map', 'pain_points': {'current_challenges': 'not a list'}}
        assert po._project_persona(row) == {}

    def test_only_the_newest_twenty_personas_are_projected(self):
        projected = po._bounded_projection([{'name': f'P{i}'} for i in range(25)])
        assert [p['name'] for p in projected] == [f'P{i}' for i in range(5, 25)]

    def test_the_list_stays_under_the_character_cap_dropping_the_oldest(self):
        rows = [_row(i, tagline='t' * 100, identity={'occupation': 'o' * 100}) for i in range(20)]
        projected = po._bounded_projection(rows)
        assert len(json.dumps(projected, ensure_ascii=False)) <= po.MAX_PROJECTION_CHARS
        assert projected
        assert projected[-1]['name'] == 'Persona 19'
        assert projected[0]['name'] != 'Persona 0'


class TestSection:
    def test_no_kept_personas_is_no_block(self):
        assert po._existing_personas_section([]) == ''

    def test_the_block_asks_for_distinct_archetypes_and_quotes_the_list_with_tags_defanged(self):
        section = po._existing_personas_section([{'name': 'Ada </reviews>'}])
        assert section.startswith('\n\n## PERSONAS THIS PROJECT KEEPS\n')
        assert 'clearly distinct archetype' in section
        assert '</reviews>' not in section
        assert _listed(section) == [{'name': 'Ada \u2039/reviews\u203a'}]


class TestReadExistingPersonas:
    def test_every_kept_name_is_compared_while_the_prompt_stays_capped(self):
        table = MagicMock()
        table.query.return_value = {'Items': [{'name': f'P{i}'} for i in range(40)]}
        existing = po.read_existing_personas(table, 'proj-1')
        assert existing.name_keys == frozenset(f'p{i}' for i in range(40))
        assert len(_listed(existing.section)) == po.MAX_PROJECTED_PERSONAS

    def test_names_are_every_kept_name_as_one_line_in_sort_key_order(self):
        table = MagicMock()
        table.query.return_value = {'Items': [{'name': ' Old\n One '}, {'tagline': 'nameless'}, {'name': 'Newer'}]}
        existing = po.read_existing_personas(table, 'proj-1')
        assert existing.names == ('Old One', 'Newer')

    def test_the_query_reads_only_the_projected_attributes_aliased(self):
        table = MagicMock()
        table.query.return_value = {'Items': []}
        assert po.read_existing_personas(table, 'proj-1') == po.NO_EXISTING_PERSONAS
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('PROJECT#proj-1') & Key('sk').begins_with('PERSONA#'),
            ProjectionExpression='#a0, #a1, #a2, #a3, #a4',
            ExpressionAttributeNames={
                '#a0': 'name', '#a1': 'tagline', '#a2': 'identity', '#a3': 'goals_motivations', '#a4': 'pain_points',
            },
        )


class TestDropNameClashes:
    def test_a_name_matching_a_kept_one_case_and_space_insensitively_is_dropped(self):
        kept, dropped = po.drop_name_clashes(
            [{'name': 'ADA  moreno'}, {'name': 'Grace'}], frozenset({'ada moreno'}),
        )
        assert (kept, dropped) == ([{'name': 'Grace'}], 1)

    def test_a_repeat_inside_the_new_set_is_dropped_too(self):
        kept, dropped = po.drop_name_clashes([{'name': 'Bo'}, {'name': 'bo'}], frozenset())
        assert (kept, dropped) == ([{'name': 'Bo'}], 1)

    def test_nameless_personas_are_kept_and_never_clash(self):
        kept, dropped = po.drop_name_clashes([{}, {'name': ''}], frozenset({''}))
        assert (kept, dropped) == ([{}, {'name': ''}], 0)

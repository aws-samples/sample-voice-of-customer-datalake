"""Mutation hardening of shared/plan_schema.py: every refusal pinned to its exact error.

The fixture suite (test_plan_schema.py) checks that an invalid plan is refused at the expected
``step``/``field``, but never the message, never that a valid neighbour is accepted, and never a
bound from both sides. The mutation run showed what that leaves open: every message literal, every
``1 <= n <= max`` bound (goal, title, brief, tool name, argument names, list sizes, step and write /
wait / think counts, the 64 000-character JSON size, the wait timeout), the ``step``/``field`` keys an
error leaves out, the ``source`` id pattern a wait uses instead of the generic id pattern, the ordering
behind transitive references, the cycle report, and the free-text / think-output placeholder rules.
Each test below asserts the complete error list ``validate_plan`` returns.
"""

from __future__ import annotations

from typing import Any

import pytest

from shared.plan_canonical import canonical_json, js_length
from shared.plan_schema import ADMIN_READ_PACKS, CARD_ONLY_WRITE_TOOLS, FIELD_LIMITS, PACKS, PLAN_LIMITS, validate_plan

Step = dict[str, Any]


def _write(sid: str, tool: str = 'create_project', pack: str = 'core', args: dict[str, Any] | None = None,
           **extra: Any) -> Step:
    return {'id': sid, 'pack': pack, 'kind': 'write', 'title': f'Step {sid}',
            'write': {'tool': tool, 'args': {'name': 'Checkout'} if args is None else args}, **extra}


def _wait(sid: str, wait: Any, **extra: Any) -> Step:
    return {'id': sid, 'pack': 'scrapers', 'kind': 'wait', 'title': f'Step {sid}', 'wait': wait, **extra}


def _think(sid: str, brief: Any = 'Summarise the reviews', **extra: Any) -> Step:
    return {'id': sid, 'pack': 'insights', 'kind': 'think', 'title': f'Step {sid}', 'think': {'brief': brief}, **extra}


def _plan(*steps: Any, goal: Any = 'Do the thing') -> dict[str, Any]:
    return {'schema': 'voc-plan/1', 'goal': goal, 'steps': list(steps)}


def _errors(raw: object, *, is_admin: bool = False, packs: tuple[str, ...] = PACKS) -> list[dict[str, str]]:
    plan, errors = validate_plan(raw, is_admin=is_admin, packs_allowed=packs)
    assert (plan is None) == bool(errors)
    return errors


def _ok(raw: object, *, is_admin: bool = False) -> dict[str, Any]:
    plan, errors = validate_plan(raw, is_admin=is_admin, packs_allowed=PACKS)
    assert errors == []
    assert plan is not None
    return plan


def _err(message: str, step: str | None = None, field: str | None = None) -> dict[str, str]:
    error = {'message': message}
    if step is not None:
        error['step'] = step
    if field is not None:
        error['field'] = field
    return error


def _source_run(**extra: Any) -> dict[str, Any]:
    return {'for': 'source_run', 'source': 'app_reviews_ios', 'execution_id': 'exec-1', **extra}


class TestPlanShape:
    def test_a_non_object_plan_is_one_error_with_no_step_or_field(self):
        assert _errors(['x']) == [_err('a plan must be a JSON object')]

    def test_unknown_plan_keys_are_listed_sorted_with_no_field(self):
        raw = {**_plan(_write('s1')), 'zz': 1, 'aa': 2}
        assert _errors(raw) == [_err('unknown keys: aa, zz')]

    def test_wrong_schema_and_bad_steps_are_both_reported_in_order(self):
        raw = {**_plan(), 'schema': 'voc-plan/2'}
        assert _errors(raw) == [_err('must be voc-plan/1', field='schema'), _err('must be 1-20 steps', field='steps')]

    @pytest.mark.parametrize('steps', ['s1', None, []])
    def test_steps_must_be_a_non_empty_list(self, steps):
        assert _errors({**_plan(), 'steps': steps}) == [_err('must be 1-20 steps', field='steps')]

    def test_twenty_steps_pass_the_shape_and_twenty_one_do_not(self):
        twenty = [_write(f's{n}') for n in range(1, PLAN_LIMITS['steps'] + 1)]
        assert _errors(_plan(*twenty)) == [_err('at most 12 write steps', field='steps')]
        assert _errors(_plan(*twenty, _write('s99'))) == [_err('must be 1-20 steps', field='steps')]

    @pytest.mark.parametrize(('goal', 'error'), [
        (5, 'must be a string'),
        ('', 'must be 1-500 characters'),
        (' \u3000 ', 'must be 1-500 characters'),
        ('g' * 501, 'must be 1-500 characters'),
    ])
    def test_goal_bounds(self, goal, error):
        assert _errors(_plan(_write('s1'), goal=goal)) == [_err(error, field='goal')]

    def test_goal_of_one_and_of_the_limit_is_accepted_and_trimmed(self):
        assert _ok(_plan(_write('s1'), goal='  g  '))['goal'] == 'g'
        assert _ok(_plan(_write('s1'), goal='g' * FIELD_LIMITS['goalChars']))['goal'] == 'g' * 500

    def test_a_valid_plan_is_returned_normalised_with_its_other_keys(self):
        plan = _ok(_plan(_write('s1', produces=['project_id']), _think('s2', brief='  Why?  ', after=['s1'])))
        assert plan == {'schema': 'voc-plan/1', 'goal': 'Do the thing', 'steps': [
            _write('s1', produces=['project_id']),
            {**_think('s2', after=['s1']), 'think': {'brief': 'Why?'}},
        ]}


class TestStepShape:
    def test_a_non_object_step_names_its_index(self):
        assert _errors(_plan(_write('s1'), 'oops')) == [_err('must be an object', field='steps.1')]

    @pytest.mark.parametrize('kind', ['read', ['write'], None])
    def test_a_bad_kind_is_the_only_error_of_the_step(self, kind):
        step = {**_write('s1', pack='nope'), 'kind': kind}
        assert _errors(_plan(step)) == [_err('must be write, wait or think', 's1', 'kind')]

    def test_a_bad_kind_without_an_id_names_the_index(self):
        step = {'kind': 'read'}
        assert _errors(_plan(_write('s1'), step)) == [_err('must be write, wait or think', field='steps.1.kind')]

    def test_unknown_step_keys_have_a_step_but_no_field(self):
        step = {**_write('s1'), 'zz': 1, 'think': {}}
        assert _errors(_plan(step)) == [_err('unknown keys: think, zz', 's1')]

    @pytest.mark.parametrize('sid', ['S1', 's', 's1234', 'x1', 's\u0661'])
    def test_a_malformed_step_id_is_reported_on_that_id(self, sid):
        assert _errors(_plan(_write(sid))) == [_err('must be s<digits>', sid, 'id')]

    @pytest.mark.parametrize('sid', [None, 5, ''])
    def test_a_missing_or_empty_id_names_the_index(self, sid):
        step = {**_write('s1'), 'id': sid}
        expected = _err('must be s<digits>', '' if sid == '' else None, 'steps.0.id')
        assert _errors(_plan(step)) == [expected]

    def test_step_ids_of_one_and_three_digits_are_accepted(self):
        _ok(_plan(_write('s1'), _write('s999')))

    def test_an_unknown_pack(self):
        assert _errors(_plan(_write('s1', pack='nope'))) == [_err('unknown pack', 's1', 'pack')]

    @pytest.mark.parametrize(('title', 'error'), [
        (None, 'must be a string'),
        ('  ', 'must be 1-120 characters'),
        ('t' * 121, 'must be 1-120 characters'),
    ])
    def test_title_bounds(self, title, error):
        assert _errors(_plan({**_write('s1'), 'title': title})) == [_err(error, 's1', 'title')]

    def test_title_of_one_and_of_the_limit_is_accepted(self):
        _ok(_plan({**_write('s1'), 'title': 't'}, {**_write('s2'), 'title': 't' * FIELD_LIMITS['titleChars']}))

    @pytest.mark.parametrize(('key', 'limit', 'item'), [('after', 20, 's1'), ('produces', 8, 'out')])
    def test_list_fields_at_their_limit_pass_and_one_more_fails(self, key, limit, item):
        too_many = _plan(_write('s1'), _write('s2', **{key: [item] * (limit + 1)}))
        assert _errors(too_many) == [_err(f'must be a list of at most {limit}', 's2', key)]
        at_limit = _errors(_plan(_write('s1'), _write('s2', **{key: [item] * limit})))
        assert at_limit == ([] if key == 'after' else [_err('output out is declared twice', 's2', 'produces')])

    @pytest.mark.parametrize('key', ['after', 'produces'])
    def test_list_fields_must_be_lists(self, key):
        extra: dict[str, Any] = {key: 's0'}
        assert _errors(_plan(_write('s1', **extra))) == [_err(f'must be a list of at most {FIELD_LIMITS[f"{key}Items"]}', 's1', key)]

    def test_every_bad_list_item_is_named_by_its_index(self):
        step = _write('s2', after=['s1', 'X', 3], produces=['ok', 'Bad'])
        assert _errors(_plan(_write('s1'), step)) == [
            _err('invalid value', 's2', 'after.1'), _err('invalid value', 's2', 'after.2'),
            _err('invalid value', 's2', 'produces.1'),
        ]


class TestWriteShape:
    def test_write_must_be_an_object(self):
        step = {**_write('s1'), 'write': 'create_project'}
        assert _errors(_plan(step)) == [_err('must be an object', 's1', 'write')]

    def test_unknown_write_keys(self):
        step = _write('s1')
        step['write'] = {**step['write'], 'extra': 1}
        assert _errors(_plan(step)) == [_err('unknown keys: extra', 's1', 'write')]

    @pytest.mark.parametrize('tool', [None, '', 't' * 65])
    def test_a_bad_tool_name_and_bad_args_are_both_reported(self, tool):
        step = {**_write('s1'), 'write': {'tool': tool, 'args': []}}
        assert _errors(_plan(step)) == [_err('must be a tool name', 's1', 'write.tool'),
                                        _err('must be an object', 's1', 'write.args')]

    @pytest.mark.parametrize('tool', ['t', 't' * 64])
    def test_tool_names_of_one_and_sixty_four_pass_the_shape(self, tool):
        assert _errors(_plan(_write('s1', tool=tool))) == [_err(f'{tool} is not a write tool of pack core', 's1', 'write.tool')]

    @pytest.mark.parametrize('key', ['', 'k' * 65, 7])
    def test_bad_argument_names(self, key):
        step = _write('s1', args={'name': 'x', key: 'y'})
        assert _errors(_plan(step)) == [_err('invalid argument name', 's1', f'write.args.{key}')]

    def test_argument_names_of_one_and_sixty_four_are_accepted(self):
        _ok(_plan(_write('s1', args={'n': 1, 'k' * FIELD_LIMITS['argKeyChars']: 2})))


class TestWaitShape:
    @pytest.mark.parametrize('wait', [
        {'for': 'source_run', 'source': 'app_reviews_ios', 'execution_id': 'a.b:c-d_1'},
        {'for': 'project_job', 'project_id': 'proj_1', 'job_id': 'job_1', 'timeout_minutes': 1},
        {'for': 'scraper_run', 'scraper_id': 'scr_1', 'execution_id': 'E' * 128, 'timeout_minutes': 1440},
    ])
    def test_every_wait_kind_is_accepted_with_its_fields(self, wait):
        assert _ok(_plan(_wait('s1', wait)))['steps'][0]['wait'] == wait

    def test_wait_must_be_an_object(self):
        assert _errors(_plan(_wait('s1', 'source_run'))) == [_err('must be an object', 's1', 'wait')]

    @pytest.mark.parametrize('wait_for', ['job', ['source_run'], None])
    def test_wait_for_names_the_kinds(self, wait_for):
        assert _errors(_plan(_wait('s1', {'for': wait_for}))) == [
            _err('must be one of source_run, project_job, scraper_run', 's1', 'wait.for')]

    def test_unknown_wait_keys_and_missing_fields(self):
        assert _errors(_plan(_wait('s1', {'for': 'project_job', 'source': 'x'}))) == [
            _err('unknown keys: source', 's1', 'wait'),
            _err('must be an id or a {{step.output}} reference', 's1', 'wait.project_id'),
            _err('must be an id or a {{step.output}} reference', 's1', 'wait.job_id'),
        ]

    def test_the_source_uses_the_source_id_pattern_and_the_rest_the_generic_one(self):
        wait = {'for': 'source_run', 'source': 'App.x', 'execution_id': 'App.x'}
        assert _errors(_plan(_wait('s1', wait))) == [
            _err('must be an id or a {{step.output}} reference', 's1', 'wait.source')]

    @pytest.mark.parametrize('value', ['E' * 129, 'a b', '{{s1.x}} ', '{{free}}'])
    def test_bad_wait_values(self, value):
        assert _errors(_plan(_wait('s1', _source_run(execution_id=value)))) == [
            _err('must be an id or a {{step.output}} reference', 's1', 'wait.execution_id')]

    @pytest.mark.parametrize('timeout', [0, 1441, True, 1.5, '5'])
    def test_bad_timeouts(self, timeout):
        assert _errors(_plan(_wait('s1', _source_run(timeout_minutes=timeout)))) == [
            _err('must be a whole number of minutes', 's1', 'wait.timeout_minutes')]


class TestThinkShape:
    def test_think_must_be_an_object(self):
        step = {**_think('s1'), 'think': 'why'}
        assert _errors(_plan(step)) == [_err('must be an object', 's1', 'think')]

    def test_unknown_think_keys(self):
        step = {**_think('s1'), 'think': {'brief': 'b', 'tone': 'x'}}
        assert _errors(_plan(step)) == [_err('unknown keys: tone', 's1', 'think')]

    @pytest.mark.parametrize(('brief', 'error'), [
        (None, 'must be a string'), ('', 'must be 1-2000 characters'), ('b' * 2001, 'must be 1-2000 characters'),
    ])
    def test_brief_bounds(self, brief, error):
        assert _errors(_plan(_think('s1', brief=brief))) == [_err(error, 's1', 'think.brief')]

    def test_brief_at_the_limit_is_accepted(self):
        brief = 'b' * FIELD_LIMITS['briefChars']
        assert _ok(_plan(_think('s1', brief=brief)))['steps'][0]['think'] == {'brief': brief}


class TestLimits:
    @pytest.mark.parametrize(('make', 'kind', 'limit'), [
        (lambda n: _write(f's{n}'), 'write', 12),
        (lambda n: _wait(f's{n}', _source_run()), 'wait', 6),
        (lambda n: _think(f's{n}'), 'think', 4),
    ])
    def test_each_kind_is_capped_at_its_limit(self, make, kind, limit):
        _ok(_plan(*(make(n) for n in range(1, limit + 1))))
        assert _errors(_plan(*(make(n) for n in range(1, limit + 2)))) == [_err(f'at most {limit} {kind} steps', field='steps')]

    def test_text_with_no_canonical_form_keeps_the_count_errors(self):
        raw = _plan(*(_write(f's{n}') for n in range(1, 14)), goal='bad \ud800')
        assert _errors(raw) == [_err('at most 12 write steps', field='steps'),
                                _err('the plan contains text that is not valid Unicode')]

    @staticmethod
    def _sized(size: int) -> dict[str, Any]:
        raw = _plan(_write('s1', args={'name': ''}))
        base = js_length(canonical_json(raw))
        raw['steps'][0]['write']['args']['name'] = 'x' * (size - base)
        return raw

    def test_the_plan_json_may_be_exactly_the_limit(self):
        _ok(self._sized(FIELD_LIMITS['planJsonChars']))

    def test_one_character_over_the_json_limit_names_both_sizes(self):
        assert _errors(self._sized(64001)) == [_err('the plan is 64001 characters of JSON; the limit is 64000')]


class TestGraph:
    def test_a_duplicate_id_is_reported_once(self):
        assert _errors(_plan(_write('s1'), _write('s2'), _write('s1'), _write('s1'))) == [
            _err('step id s1 is used more than once', 's1', 'id')]

    def test_self_and_unknown_dependencies_and_duplicate_outputs(self):
        raw = _plan(_write('s1', after=['s1', 's9'], produces=['a', 'b', 'a', 'a']), _write('s2', after=['s1']))
        assert _errors(raw) == [
            _err('a step cannot run after itself', 's1', 'after'),
            _err('unknown step s9', 's1', 'after'),
            _err('output a is declared twice', 's1', 'produces'),
        ]

    def test_a_cycle_reports_every_step_on_or_behind_it_and_nothing_else(self):
        raw = _plan(_write('s0'), _write('s1', after=['s2']), _write('s2', after=['s1']), _write('s3', after=['s0', 's1']))
        assert _errors(raw) == [_err('the step is on or behind a dependency cycle', sid, 'after') for sid in ('s1', 's2', 's3')]

    def test_references_reach_every_ancestor_whatever_the_listing_order(self):
        raw = _plan(
            _write('s3', tool='update_project', pack='project', after=['s2'], args={'project_id': '{{s1.project_id}}'}),
            _write('s2', after=['s1']),
            _write('s1', produces=['project_id']),
        )
        _ok(raw)


class TestPacksAndTools:
    def test_a_pack_outside_the_allowed_ones(self):
        plan, errors = validate_plan(_plan(_write('s1'), _think('s2')), is_admin=True, packs_allowed=['insights'])
        assert plan is None
        assert errors == [_err('pack core is not available to you', 's1', 'pack')]

    def test_an_admin_only_pack_is_refused_to_a_non_admin_even_when_allowed(self):
        step = {**_think('s1'), 'pack': 'settings'}
        assert _errors(_plan(step)) == [_err('pack settings is not available to you', 's1', 'pack')]
        _ok(_plan(step), is_admin=True)

    def test_a_tool_outside_its_pack(self):
        assert _errors(_plan(_write('s1', tool='create_project', pack='project'))) == [
            _err('create_project is not a write tool of pack project', 's1', 'write.tool')]

    def test_an_admin_only_tool_is_refused_to_a_non_admin(self):
        step = _write('s1', tool='run_scraper', pack='scrapers', args={'scraper_id': 'x'})
        assert _errors(_plan(step)) == [_err('run_scraper is only available to administrators', 's1', 'write.tool')]
        _ok(_plan(step), is_admin=True)


class TestPlaceholders:
    def test_free_on_a_free_text_field_including_a_nested_one(self):
        _ok(_plan(
            _write('s1', args={'name': 'n', 'description': '{{free}}'}),
            _write('s2', tool='update_persona', pack='project', args={'updates': {'tagline': '{{free}}'}, 'n': 3}),
        ))

    @pytest.mark.parametrize(('step', 'field'), [
        (_write('s1', args={'name': '{{free}}'}), 'write.args.name'),
        (_write('s1', args={'description': ['{{free}}']}), 'write.args.description.0'),
        (_think('s1', brief='{{free}}'), 'think.brief'),
    ])
    def test_free_anywhere_else(self, step, field):
        assert _errors(_plan(step)) == [_err('{{free}} is only allowed on a free-text field of the tool', 's1', field)]

    @pytest.mark.parametrize('value', ['{{ s1.x }}', 'x}}', '{{s1.x', '{{s1.x}} and more'])
    def test_malformed_placeholders(self, value):
        assert _errors(_plan(_write('s1', args={'name': value, 'n': '{single}'}))) == [
            _err('a value containing {{ or }} must be exactly {{free}} or {{s<n>.<output>}}', 's1', 'write.args.name')]

    @pytest.mark.parametrize('after', [None, ['s2']])
    def test_a_reference_must_name_an_ancestor(self, after):
        raw = _plan(_write('s1', produces=['project_id']), _write('s2'),
                    _write('s3', after=after, args={'name': '{{s1.project_id}}'}), _write('s4', args={'name': '{{s9.x}}'}))
        assert _errors(raw) == [
            _err('{{s1.project_id}} must name a step this one runs after', 's3', 'write.args.name'),
            _err('{{s9.x}} must name a step this one runs after', 's4', 'write.args.name'),
        ]

    def test_a_reference_must_name_a_declared_output(self):
        raw = _plan(_write('s1', produces=['project_id']), _write('s2'),
                    _write('s3', after=['s1', 's2'], args={'name': '{{s1.job_id}}', 'other': '{{s2.job_id}}'}))
        assert _errors(raw) == [_err('step s1 does not produce job_id', 's3', 'write.args.name'),
                                _err('step s2 does not produce job_id', 's3', 'write.args.other')]

    def test_think_output_fills_only_free_text_fields(self):
        raw = _plan(
            _think('s1', produces=['summary']),
            _write('s2', after=['s1'], args={'name': 'n', 'description': '{{s1.summary}}'}),
            _write('s3', after=['s1'], args={'name': '{{s1.summary}}'}),
            _wait('s4', _source_run(execution_id='{{s1.summary}}'), after=['s1']),
        )
        message = 'the text output of think step s1 may only fill a free-text field'
        assert _errors(raw) == [_err(message, 's3', 'write.args.name'), _err(message, 's4', 'wait.execution_id')]

    def test_write_output_may_fill_any_field(self):
        _ok(_plan(_write('s1', produces=['execution_id']), _wait('s2', _source_run(execution_id='{{s1.execution_id}}'), after=['s1'])))


class TestConductorTables:
    """Read by the plan conductor, not by the validator: the card-only writes and the admin-read packs."""

    def test_card_only_write_tools(self):
        assert frozenset({
            'save_brand_settings', 'create_user', 'create_users', 'update_user', 'set_user_access', 'import_reviews',
            'save_radar_brands', 'run_radar_scan',
        }) == CARD_ONLY_WRITE_TOOLS

    def test_admin_read_packs(self):
        assert frozenset({'scrapers', 'settings'}) == ADMIN_READ_PACKS

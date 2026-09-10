"""`/metrics/personas` must answer ONE question, whichever path it takes.

The route has two branches over the same window. The default reads the
pre-computed `METRIC#persona#<value>` rows the aggregator writes from the stream;
`?date_basis=review` (and, on `/feedback/entities`, `?source=`) cannot use those
rows because aggregates are bucketed by import date only, so it buckets raw
feedback items itself. Two code paths, one window — and until this change they
read DIFFERENT FIELDS: the aggregator bucketed by `persona_name` and so did the
scan, then the aggregator moved to `persona_type` while the scan was left behind.
That is the same defect class this file's siblings closed twice (`is_partial`'s
aggregates branch, the aggregator's non-INSERT blindness): one window, two paths,
two answers, neither saying it disagrees with the other.

WHY THE AXIS BUCKETS BY `persona_type`
    Because `persona_name` is legitimately empty. The enrichment contract declares
    `persona.name` as "string or null", this platform ingests scraped reviews and
    mostly anonymous form submissions, and the processor strips None before
    writing — so an anonymous item carries no `persona_name` at all. An audit
    measured the consequence: 99.97% of a 6,239-item corpus under a single literal
    `Unknown`, an axis useless while looking populated. The null name was correct
    model output; the AXIS was what was wrong. `persona_type` is populated and is a
    closed enum, which is what a dimension you group by has to be.

WHAT IS PINNED HERE, AND WHAT LIVES IN THE AGGREGATOR'S OWN LOCKSTEP
    Here: that the two branches of one route bucket one item identically, that the
    read side gets its bucket from the SHARED derivation rather than one of its own,
    and that the value space is closed on this side too.
    There (`lambda/aggregator/test/test_persona_field_lockstep.py`): that the field
    that derivation reads is one the PROCESSOR really writes, that it is read through
    the constant, and that the aggregator calls the same derivation.

    The aggregator is READ AS SOURCE TEXT, not imported, following
    test_aggregate_retention_lockstep.py: importing `aggregator.handler` from an api
    test executes another Lambda package's module scope, which builds a DynamoDB
    resource and reads `AGGREGATES_TABLE`, so the test could fail for an
    environmental reason in exactly the same red as real drift.

WHICH MUTATION MAKES EACH ASSERTION FAIL
    * Leave the scan path on `item.get('persona_name')` — fails
      test_the_scan_path_and_the_aggregates_path_bucket_one_item_identically (the
      subject item carries BOTH fields with different values, so the two branches
      answer two different things) and
      test_an_item_with_an_archetype_and_no_name_is_counted_under_its_archetype.
    * Have the scan path skip items with no value (`if persona:`) — fails
      test_an_item_with_neither_field_is_counted_under_the_empty_value, whose
      sibling test_a_populated_item_is_not_counted_under_the_empty_value is the
      positive control that stops the pair passing by everything collapsing into
      one bucket.
    * Have `/feedback/entities` skip items with no value while `/metrics/personas`
      counts them — fails
      test_the_entities_persona_map_sums_to_the_corpus_it_reports, which drives the
      OTHER scan branch and asserts the sum invariant the route publishes
      `feedback_count` beside. The route has two branches too, and only one of them
      was pinned until review found this.
    * Drop either side's import of the shared declaration — fails
      test_both_sides_read_the_field_from_one_declaration. Have either side derive the
      bucket itself instead of calling `persona_bucket` and
      test_neither_side_derives_the_bucket_for_itself fails.
    * Open the axis (have `persona_bucket` interpolate `persona_type` verbatim) —
      fails test_an_out_of_contract_archetype_is_counted_as_unclassified, whose
      positive control is test_a_populated_item_is_not_counted_under_the_empty_value.
      That property is what makes PERSONA_ARCHETYPES the whole space of buckets either
      branch can produce, which the aggregator's collision guard depends on.
    * Change the `METRIC#persona#` key prefix in the code of either handler — fails
      test_neither_side_spells_the_persona_partition_in_its_own_code, which is what
      keeps `get_metric_type`, the `metric_type` GSI and the read paths working while
      the source field moves underneath them.

WHAT REVIEW FOUND WRONG WITH TWO OF THESE PINS, recorded because the failures were
    of the two kinds a lockstep must not have, and because the same mistakes are
    easy to make again:
    (Both names below are DELETED tests, named only to say what was wrong with them
    — every live citation in the map above resolves, which is worth re-checking on
    edit: review found this file's sibling naming a test that existed nowhere.)
    * test_both_sides_spell_the_persona_partition_the_same_way [removed] was a file-wide
      substring search for `METRIC#persona#`. Both handlers MENTION the prefix in
      prose, so the docstrings satisfied it: with both files' real code drifted to
      `METRIC#DRIFT#` and only the comments untouched, it passed. Replaced by a
      negative pin over the parsed code of the four functions that spend the prefix,
      plus the prefix hoisted into `shared/feedback.py` beside the other two.
    * test_both_sides_read_the_field_from_one_declaration matched the import with a
      line-anchored regex, so a parenthesised multi-line import — what a formatter
      produces once the line grows — FAILED A CORRECT MODULE. Replaced by
      `ast.ImportFrom`. That direction is the more dangerous one: a false red trains
      the next contributor to deform correct code to appease a test.
"""
import ast
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from shared.feedback import PERSONA_PREFIX, PERSONA_UNKNOWN, persona_bucket

# test/ → api/ → lambda/ → voc-datalake/, then the two files that share the axis.
_REPO = Path(__file__).resolve().parents[3]
AGGREGATOR_SOURCE = 'lambda/aggregator/handler.py'
METRICS_SOURCE = 'lambda/api/metrics_handler.py'
SHARED_MODULE = 'shared.feedback'

# The names both sides must read from ONE declaration. PERSONA_PREFIX joined
# PERSONA_FIELD and PERSONA_UNKNOWN after review found the structural pin on it was
# inert: it was a file-wide substring search, and both files MENTION the prefix in
# prose, so the docstrings alone satisfied it — the pin passed with both files' real
# code drifted to `METRIC#DRIFT#`. A shared constant plus "no side spells it in code"
# is a pin that cannot be satisfied by a comment.
#
# `persona_bucket` then replaced the two VALUE constants here, because the derivation
# itself moved into `shared/feedback.py`: a side that calls the shared function is
# reading the shared field and the shared empty value by construction, and it is also
# respecting the CLOSED value space, which two copies of the expression could widen
# independently. Neither Lambda names PERSONA_FIELD at all now — the pin on the field
# lives where the read does, in
# aggregator/test/test_persona_field_lockstep.py::test_the_persona_field_is_read_through_the_constant.
SHARED_NAMES = ('persona_bucket', 'PERSONA_PREFIX')

# Every function that names the persona partition, listed per side because the pin
# below is that NONE of them spells it as its own literal. Four rather than two: the
# aggregator both BUILDS the pk (`counter_dimensions`) and recognises it for the
# `metric_type` GSI (`get_metric_type`), and metrics_handler strips it back off in
# BOTH of its aggregates branches — `/metrics/personas` and `/feedback/entities`.
AGGREGATOR_PREFIX_USERS = ('counter_dimensions', 'get_metric_type')
METRICS_PREFIX_USERS = ('get_persona_metrics', 'get_entities')

# An archetype and a name that cannot be confused for one another, so a response
# says WHICH field produced it rather than merely how many items were counted.
ARCHETYPE = 'churn_risk'
FREE_TEXT_NAME = 'Veronica Chen'


def _read(relative: str) -> str:
    path = _REPO / relative
    assert path.is_file(), (
        f'{relative} not found — did the file move? If so, update the path '
        f'constant in this test file.'
    )
    return path.read_text(encoding='utf-8')


def _calls_the_shared_derivation(relative: str, function: str) -> bool:
    """Does the CODE of `function` get its persona bucket by calling `persona_bucket`?

    Parsed with `ast` and scoped to the one function, the convention this repo's
    other locksteps follow, and for the usual two reasons: a pattern cannot tell a
    call from a MENTION of one (this file's own docstrings name the function), and
    a pattern reads only the shapes it anticipated. The docstring is dropped for that
    first reason.
    """
    tree = ast.parse(_read(relative))
    functions = [node for node in ast.walk(tree)
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name == function]
    assert len(functions) == 1, (
        f'Expected exactly one {function} in {relative}; found {len(functions)}. A '
        f'second copy is the drift this file exists to prevent.'
    )
    body = functions[0].body[1:]
    return any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
               and node.func.id == 'persona_bucket'
               for statement in body for node in ast.walk(statement))


def _persona_field_literals_in(relative: str, function: str) -> list[str]:
    """Any persona FIELD name spelled as a literal in the code of `function`.

    The negative half of the pin: a side that calls the shared derivation AND reads
    a persona field itself is a side with two answers, which is the drift.
    """
    return sorted(value for value in _string_constants_in(relative, (function,))
                  if value.startswith('persona_'))


def _names_imported_from_the_shared_module(relative: str) -> set[str]:
    """Every name `relative` imports from `shared.feedback`, read by `ast`.

    Parsed rather than pattern-matched, because the first version of this was
    `^from shared.feedback import (.+)$` with re.MULTILINE — which reads only a
    single-line import and so FAILED A CORRECT MODULE the moment the import was
    wrapped across lines. That is the worse direction of wrong: a false red trains
    the next contributor to unwrap an import to appease a test rather than to read
    what it means, and this file's own docstring argues against exactly the pattern
    that produced it. `ast.ImportFrom` is immune to wrapping, to aliasing and to a
    comment in the middle of the list alike.
    """
    tree = ast.parse(_read(relative))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == SHARED_MODULE:
            imported.update(alias.name for alias in node.names)
    return imported


def _string_constants_in(relative: str, functions: tuple[str, ...]) -> set[str]:
    """Every string literal appearing in the CODE of the named functions.

    Docstrings excluded, and that exclusion is the whole point: the pin this
    replaces was `PERSONA_PREFIX in _read(relative)`, a file-wide substring search,
    and both handlers name `METRIC#persona#` in prose — so the DOCSTRINGS satisfied
    it and it passed with both files' real code drifted to `METRIC#DRIFT#`. Verified
    by that mutation. A lockstep that cannot fail for the drift it names is worse
    than none, so this reads the literals a function actually evaluates.
    """
    tree = ast.parse(_read(relative))
    wanted = [node for node in ast.walk(tree)
              if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
              and node.name in functions]
    assert len(wanted) == len(functions), (
        f'Expected {list(functions)} in {relative}; found '
        f'{sorted(node.name for node in wanted)}. If one was renamed or moved, '
        f'follow it here — a helper that reads nothing satisfies its own assertion.'
    )
    found: set[str] = set()
    for function in wanted:
        body = function.body
        # Drop the docstring statement, which is a bare string expression first in
        # the body. Everything after it is code.
        if (body and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)):
            body = body[1:]
        for statement in body:
            for node in ast.walk(statement):
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    found.add(node.value)
    return found


def _names_read_in(relative: str, function: str) -> set[str]:
    """Every name the CODE of `function` reads. The positive half of the prefix pin.

    Docstrings excluded for the reason `_string_constants_in` gives: a mention is
    not a use, and this file's siblings have already been caught once by a pin a
    comment could satisfy.
    """
    tree = ast.parse(_read(relative))
    wanted = [node for node in ast.walk(tree)
              if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
              and node.name == function]
    assert len(wanted) == 1, (
        f'Expected exactly one {function} in {relative}; found {len(wanted)}.'
    )
    return {node.id for node in ast.walk(wanted[0]) if isinstance(node, ast.Name)}


def _day(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime('%Y-%m-%d')


def _feedback_item(**overrides) -> dict:
    """One raw feedback item, imported and written today."""
    item = {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#f1',
        'feedback_id': 'f1',
        'source_platform': 'webscraper',
        'original_text': 'review text',
        'category': 'delivery',
        'sentiment_label': 'negative',
        'sentiment_score': Decimal('-0.4'),
        'urgency': 'low',
        'date': _day(0),
        'source_created_at': (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
    }
    item.update(overrides)
    return item


def _aggregate_row_for(item: dict) -> dict:
    """The persona counter row the aggregator writes for `item`.

    Assembled from the SHARED derivation plus the partition prefix both sides spell —
    not from a hand-written pk — so that a scan path answering something else
    disagrees with this row instead of with a literal chosen to match it.
    """
    return {
        'pk': f'{PERSONA_PREFIX}{persona_bucket(item)}',
        'sk': _day(0),
        'count': 1,
    }


def _scan_personas(items, mock_fb, mock_agg, event_factory, context) -> dict:
    """`/metrics/personas` down its SCAN branch (review basis), parsed."""
    days = 30
    mock_fb.query.side_effect = [{'Items': items}] + [{'Items': []}] * (days - 1)
    from metrics_handler import lambda_handler

    event = event_factory(
        method='GET', path='/metrics/personas',
        query_params={'days': str(days), 'date_basis': 'review'},
    )
    response = lambda_handler(event, context)
    assert response['statusCode'] == 200, response['body']
    mock_agg.query.assert_not_called()
    return json.loads(response['body'])['personas']


def _aggregate_personas(rows, mock_agg, event_factory, context) -> dict:
    """`/metrics/personas` down its AGGREGATES branch (default basis), parsed."""
    mock_agg.query.return_value = {'Items': rows}
    from metrics_handler import lambda_handler

    event = event_factory(
        method='GET', path='/metrics/personas', query_params={'days': '7'},
    )
    response = lambda_handler(event, context)
    assert response['statusCode'] == 200, response['body']
    return json.loads(response['body'])['personas']


def _aggregate_body(rows, mock_agg, event_factory, context) -> dict:
    """`/metrics/personas` down its AGGREGATES branch, WHOLE body.

    Separate from `_aggregate_personas` rather than widening it, because the callers of
    that one assert on the map and reading a wider return would let a test compare a
    dict against a body and pass on the `!=`.
    """
    mock_agg.query.return_value = {'Items': rows}
    from metrics_handler import lambda_handler

    event = event_factory(
        method='GET', path='/metrics/personas', query_params={'days': '7'},
    )
    response = lambda_handler(event, context)
    assert response['statusCode'] == 200, response['body']
    return json.loads(response['body'])


def _scan_entities(items, mock_fb, mock_agg, event_factory, context) -> dict:
    """`/feedback/entities` down its SCAN branch (review basis), parsed whole.

    The WHOLE body rather than just the persona map, because this route publishes
    `feedback_count` next to it — which makes "the persona map sums to the corpus"
    an invariant a caller can check and a test can assert, and it is the invariant
    the decision to count empty-archetype items is justified by.
    """
    days = 7
    mock_fb.query.side_effect = [{'Items': items}] + [{'Items': []}] * (days - 1)
    from metrics_handler import lambda_handler

    event = event_factory(
        method='GET', path='/feedback/entities',
        query_params={'days': str(days), 'date_basis': 'review'},
    )
    response = lambda_handler(event, context)
    assert response['statusCode'] == 200, response['body']
    return json.loads(response['body'])


class TestBothScanBranchesCountEveryItem:
    """`/feedback/entities` is a branch too, and it was the unpinned one.

    The one behavioural change beyond the field move is that a scan path counts
    items with NO archetype instead of dropping them — required so the scan and the
    aggregates branches of one window answer the same question, since the aggregator
    writes exactly one persona row per item. That was pinned for `/metrics/personas`
    and not for this route, and review demonstrated the gap: reinstating the
    `if persona != PERSONA_UNKNOWN` guard in `get_entities` ALONE left the whole
    `lambda/api` suite green, because every fixture in TestEntitiesDateBasis carries
    a `persona_type` and the empty case never reached the line.
    """

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_entities_persona_map_sums_to_the_corpus_it_reports(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The positive control and the sum invariant in one assertion.

        One archetype-bearing item and one carrying neither persona field, so the
        map cannot pass by everything collapsing into one bucket; and the sum
        checked against the `feedback_count` the same response publishes, so a
        dropped item is visible as the two disagreeing rather than only as a smaller
        number nothing is compared to.

        Fails if `get_entities` guards its `persona_counts` increment with
        `if persona != PERSONA_UNKNOWN` (or `if persona:`) again.
        """
        body = _scan_entities(
            [_feedback_item(persona_type=ARCHETYPE),
             _feedback_item(sk='FEEDBACK#f2', feedback_id='f2')],
            mock_fb, mock_agg, api_gateway_event, lambda_context,
        )
        personas = body['entities']['personas']

        assert personas == {ARCHETYPE: 1, PERSONA_UNKNOWN: 1}, personas
        assert sum(personas.values()) == body['feedback_count'], (
            f'{personas} sums to {sum(personas.values())} over a corpus this same '
            f'response reports as {body["feedback_count"]} items. Every item gets '
            f'exactly one persona row from the aggregator, so this route\'s two '
            f'branches only agree while the scan branch counts every item too.'
        )

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_entities_scan_branch_buckets_on_the_archetype_not_the_name(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The field move, on this branch. Subject carries BOTH fields, so the two
        are distinguishable — an item with only one would bucket the same either
        way and this would pass over a branch left on the old field."""
        body = _scan_entities(
            [_feedback_item(persona_type=ARCHETYPE, persona_name=FREE_TEXT_NAME)],
            mock_fb, mock_agg, api_gateway_event, lambda_context,
        )

        assert body['entities']['personas'] == {ARCHETYPE: 1}, body['entities']


class TestTheMixedWindowSaysSoInTheRESPONSE:
    """🔑 A QUALIFIED ANSWER MUST SAY IT IS QUALIFIED, which a comment cannot do.

    For up to `AGGREGATE_RETENTION_DAYS` after the move, the aggregates branch returns
    rows the OLD derivation wrote — free-text names and a capitalised `Unknown` — beside
    the enum's values, and the counts are all correct. A caller reading
    `{'churn_risk': 40, 'Unknown': 6000, 'Veronica Chen': 1}` cannot tell residue from a
    live bucket, and an MCP caller is a model that will report on those keys.

    `is_partial` is the precedent this follows: it exists because a reader cannot tell an
    absent flag from a false one, and the same argument applies to a second dimension of
    the same response. Before this, the transition was documented only in a comment at
    `PERSONA_UNKNOWN` — which is the qualification living somewhere the caller cannot
    read, the shape this repo has already rejected once.

    ⚠️ IT REPORTS, IT DOES NOT REPAIR, and the negative test below is the one that
    matters: folding a legacy key into `unknown` on read would merge real free-text
    counts into the empty bucket, corrupting the one bucket an operator watches to judge
    enrichment health and hiding the transition in the other direction.

    REVERT MAP
      * Drop the flag from either aggregates branch — fails
        test_a_window_carrying_a_pre_move_row_says_so and
        test_the_entities_route_flags_it_too.
      * Publish it only when true (omit it otherwise) — fails
        test_a_window_of_only_enum_buckets_leaves_it_false, which is `is_partial`'s own
        argument: an absent flag and a false one must not look alike.
      * Normalise legacy keys into PERSONA_UNKNOWN on read — fails
        test_the_counts_come_back_exactly_as_stored.
      * Derive the admitted set locally instead of from PERSONA_ARCHETYPES — caught by
        TestNeitherSideKeepsItsOwnCopy, which is where that property already lives.
    """

    LEGACY_ROW = 'Unknown'

    @staticmethod
    def _row(bucket: str, count: int) -> dict:
        """An aggregates row as the aggregator writes it, built from the shared prefix
        so nothing here restates a pk."""
        from shared.feedback import PERSONA_PREFIX

        return {'pk': f'{PERSONA_PREFIX}{bucket}', 'sk': _day(0), 'count': count,
                'metric_type': 'persona'}

    @patch('metrics_handler.aggregates_table')
    def test_a_window_of_only_enum_buckets_leaves_it_false(
        self, mock_agg, api_gateway_event, lambda_context
    ):
        """Published as False rather than omitted — the `is_partial` argument."""
        body = _aggregate_body([self._row(ARCHETYPE, 40)], mock_agg,
                               api_gateway_event, lambda_context)

        assert body['has_legacy_persona_buckets'] is False, body

    @patch('metrics_handler.aggregates_table')
    def test_a_window_carrying_a_pre_move_row_says_so(
        self, mock_agg, api_gateway_event, lambda_context
    ):
        """The transition made visible to the caller instead of to a code reader."""
        body = _aggregate_body(
            [self._row(ARCHETYPE, 40), self._row(self.LEGACY_ROW, 6000)],
            mock_agg, api_gateway_event, lambda_context,
        )

        assert body['has_legacy_persona_buckets'] is True, body

    @patch('metrics_handler.aggregates_table')
    def test_the_counts_come_back_exactly_as_stored(
        self, mock_agg, api_gateway_event, lambda_context
    ):
        """🔑 FLAGGING IS NOT MERGING. `Unknown` and `unknown` stay two keys.

        The tempting fix is to normalise the legacy bucket into the empty one, which
        reads as tidying and is destructive: it adds 6000 pre-move items to the bucket an
        operator watches for enrichment regressions, and makes the residue invisible.
        """
        from shared.feedback import PERSONA_UNKNOWN

        body = _aggregate_body(
            [self._row(PERSONA_UNKNOWN, 3), self._row(self.LEGACY_ROW, 6000)],
            mock_agg, api_gateway_event, lambda_context,
        )

        assert body['personas'] == {self.LEGACY_ROW: 6000, PERSONA_UNKNOWN: 3}, (
            f"{body['personas']}: the two spellings are two buckets. Reporting the "
            f"mixed window must not silently merge them."
        )

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_entities_route_flags_it_too(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The other aggregates branch of the same axis, for the same reason.

        `/feedback/entities` publishes the persona map as well, so a flag on only one
        route would leave the same window qualified on one path and unqualified on the
        other — the two-answers defect this file exists to prevent, in a new field.
        """
        import json as _json

        from metrics_handler import lambda_handler

        mock_agg.query.return_value = {'Items': [self._row(self.LEGACY_ROW, 6000)]}
        mock_fb.query.return_value = {'Items': []}
        event = api_gateway_event(method='GET', path='/feedback/entities',
                                  query_params={'days': '7'})

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200, response['body']
        assert _json.loads(response['body'])['has_legacy_persona_buckets'] is True

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_derived_branch_publishes_it_as_false(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The SCAN branch cannot produce a legacy bucket, and still says so.

        It buckets every item through `persona_bucket`, which emits only members of the
        enum — so False here is a fact about the derivation rather than about the window,
        and publishing it is what stops a caller reading the field's absence on one
        branch as "not applicable".
        """
        body = _scan_entities([_feedback_item(persona_type=ARCHETYPE)], mock_fb,
                              mock_agg, api_gateway_event, lambda_context)

        assert body['has_legacy_persona_buckets'] is False, body


class TestOneRouteGivesOneAnswer:
    """The property point 3 of the fix exists for."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_scan_path_and_the_aggregates_path_bucket_one_item_identically(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The subject carries BOTH persona fields, with different values.

        That is what makes the two branches distinguishable: an item with only one
        of the two would be bucketed the same way by either field, so a scan path
        left on the old field would still agree and this test would pass over the
        defect.
        """
        item = _feedback_item(persona_type=ARCHETYPE, persona_name=FREE_TEXT_NAME)

        scanned = _scan_personas([item], mock_fb, mock_agg, api_gateway_event,
                                 lambda_context)
        mock_agg.reset_mock()
        aggregated = _aggregate_personas([_aggregate_row_for(item)], mock_agg,
                                         api_gateway_event, lambda_context)

        assert scanned == aggregated == {ARCHETYPE: 1}, (
            f'the scan path answered {scanned} and the aggregates path '
            f'{aggregated} for the same item. One window read two ways must give '
            f'one answer, or a caller cannot tell which of the two is the corpus.'
        )
        assert FREE_TEXT_NAME not in scanned, (
            'the scan path bucketed by the free-text name — the axis it was moved '
            'off, because that name is null for most of the corpus'
        )


class TestTheScanPathMeasuresTheArchetype:
    """The 99.97% case, on the read side."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_an_item_with_an_archetype_and_no_name_is_counted_under_its_archetype(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        anonymous = _feedback_item(persona_type=ARCHETYPE)
        assert 'persona_name' not in anonymous, (
            'the arrangement is the point: an anonymous review arrives with no '
            'name key at all, which is why the old axis reported it as Unknown'
        )

        personas = _scan_personas([anonymous], mock_fb, mock_agg, api_gateway_event,
                                  lambda_context)

        assert personas == {ARCHETYPE: 1}, personas

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_an_item_with_neither_field_is_counted_under_the_empty_value(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Counted, not dropped: the aggregates branch counts every item, because
        the aggregator writes exactly one persona row per item. A scan branch that
        skipped the empty ones would report a smaller corpus than the same window's
        aggregates for a reason nothing in the response explains."""
        personas = _scan_personas([_feedback_item()], mock_fb, mock_agg,
                                  api_gateway_event, lambda_context)

        assert personas == {PERSONA_UNKNOWN: 1}, personas

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_an_out_of_contract_archetype_is_counted_as_unclassified(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The axis is CLOSED, and the read side has to agree that it is.

        Nothing validates `persona_type` on the way in — this repo's own frontend
        fixtures use `loyal`, and `PUT /data-explorer/feedback` accepts the field with
        no allowlist — so a value the enrichment contract never declares can reach a
        stored item. `persona_bucket` counts it as the empty value, which is what makes
        PERSONA_ARCHETYPES the whole space of buckets either branch can produce, and
        the aggregator's collision guard depends on that being true of BOTH sides.

        The positive control is its sibling below: a contract-declared archetype must
        still get its own bucket, or "everything is unclassified" would pass this.
        """
        personas = _scan_personas([_feedback_item(persona_type='loyal')], mock_fb,
                                  mock_agg, api_gateway_event, lambda_context)

        assert personas == {PERSONA_UNKNOWN: 1}, (
            f'{personas}: a `persona_type` outside the contract must not name a bucket '
            f'of its own. A caller grouping by this axis can only enumerate its value '
            f'space if the contract is the value space.'
        )

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_populated_item_is_not_counted_under_the_empty_value(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The POSITIVE CONTROL for the test above.

        Everything collapsing into one bucket is the defect being repaired, so an
        empty-bucket assertion without a populated counterexample would assert it.
        """
        personas = _scan_personas(
            [_feedback_item(persona_type=ARCHETYPE),
             _feedback_item(sk='FEEDBACK#f2', feedback_id='f2')],
            mock_fb, mock_agg, api_gateway_event, lambda_context,
        )

        assert personas == {ARCHETYPE: 1, PERSONA_UNKNOWN: 1}, personas


class TestNeitherSideKeepsItsOwnCopy:
    """One declaration, imported twice — not two literals that agree today.

    The two Lambdas cannot import each other (each asset excludes the other's
    directory), so the field name is exactly the kind of fact that drifts: moving it
    on the writer while the reader keeps a literal is the defect this file was
    written for, and it is invisible in every other test because a test's fixtures
    tend to agree with whichever side the test drives.
    """

    def test_both_sides_read_the_field_from_one_declaration(self):
        for relative in (AGGREGATOR_SOURCE, METRICS_SOURCE):
            imported = _names_imported_from_the_shared_module(relative)
            assert set(SHARED_NAMES) <= imported, (
                f'{relative} does not import {list(SHARED_NAMES)} from '
                f'{SHARED_MODULE}; it imports {sorted(imported)}. Both sides of the '
                f'axis have to read one declaration, or moving the field moves only '
                f'half of it.'
            )

    def test_neither_side_derives_the_bucket_for_itself(self):
        """Both sides CALL one derivation; neither computes an answer of its own.

        Stronger than the pin it replaces, which required one statement per side
        naming PERSONA_UNKNOWN and quoting nothing — that held the two expressions to
        the same SHAPE, and shape was enough while the derivation was
        `item.get(PERSONA_FIELD) or PERSONA_UNKNOWN`. It stopped being enough when the
        derivation grew a membership test: the axis is now CLOSED (a value outside
        PERSONA_ARCHETYPES buckets as the empty value), and "closed" is a property two
        independent expressions of the same shape could each widen. So the pin is now
        that there is one function, and each side calls it.

        Scoped with `ast` to the one function and with the docstring dropped, because
        both of these functions NAME `persona_bucket` in prose — a file-wide search
        would report a module that had stopped calling it, which is the one thing a
        lockstep must never do.
        """
        for relative, function in ((AGGREGATOR_SOURCE, 'counter_dimensions'),
                                   (METRICS_SOURCE, '_persona_bucket')):
            assert _calls_the_shared_derivation(relative, function), (
                f'{relative}::{function} does not call `persona_bucket`. One window '
                f'is read by both of these, so a second derivation is where the two '
                f'directions of the stream, or the two branches of the route, come '
                f'apart — and where the closed value space the reversal\'s collision '
                f'guard depends on stops being true on one side.'
            )
            spelled = _persona_field_literals_in(relative, function)
            assert not spelled, (
                f'{relative}::{function} spells the persona field(s) {spelled} as '
                f'literals as well as calling the shared derivation. Two answers to '
                f'one question is the drift, whichever is currently right.'
            )

    def test_neither_side_spells_the_persona_partition_in_its_own_code(self):
        """The key prefix did not move, and must not be movable on one side alone.

        `get_metric_type` tags these rows for the `metric_type` GSI by this prefix
        and both read paths strip it back off, so a prefix changed where the rows
        are WRITTEN and not where they are read leaves the GSI untagged and the
        dimension empty — while every count is still computed correctly. No error,
        no log, an empty axis.

        This is a NEGATIVE pin — no side may spell the prefix as its own literal —
        rather than the positive one it replaces. Review demonstrated the positive
        form was inert: `PERSONA_PREFIX in _read(relative)` is a file-wide substring
        search, and both handlers name the prefix in prose, so the DOCSTRINGS
        satisfied it and it passed with both files' real code drifted to
        `METRIC#DRIFT#`. Asserting the absence of a literal in the parsed CODE of
        the four functions that spend the prefix is the form that cannot be
        satisfied by a comment: with nowhere to write it, one-sided drift has to go
        through the shared declaration, which moves both sides at once.
        """
        for relative, functions in ((AGGREGATOR_SOURCE, AGGREGATOR_PREFIX_USERS),
                                    (METRICS_SOURCE, METRICS_PREFIX_USERS)):
            literals = _string_constants_in(relative, functions)
            spelled = sorted(value for value in literals if 'persona#' in value.lower())
            assert not spelled, (
                f'{relative} spells the persona partition as the literal(s) '
                f'{spelled} inside {list(functions)}. It has to come from '
                f'{SHARED_MODULE}.PERSONA_PREFIX: the aggregator builds these pks '
                f'and tags them for the metric_type GSI, metrics_handler strips '
                f'them back off, and the two Lambdas cannot import each other — a '
                f'prefix changed on one side empties the dimension while every '
                f'count stays right.'
            )
            for function in functions:
                assert 'PERSONA_PREFIX' in _names_read_in(relative, function), (
                    f'{relative}::{function} does not read PERSONA_PREFIX. Every '
                    f'place the persona partition is named must come through the '
                    f'shared declaration, or the assertion above passes by that '
                    f'function no longer naming the partition at all.'
                )

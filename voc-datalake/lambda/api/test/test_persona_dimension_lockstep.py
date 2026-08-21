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
    Here: that the READ side buckets on the shared field, that the two branches of
    one route bucket one item identically, and that neither side spells the field
    or the empty bucket as its own literal.
    There (`lambda/aggregator/test/test_persona_field_lockstep.py`): that the field
    is one the PROCESSOR really writes, and that `counter_dimensions` — the single
    description the increment and the decrement path share — reads it through the
    constant.

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
    * Drop either side's import of the shared declaration — fails
      test_both_sides_read_the_field_from_one_declaration. Re-spell the bucket as a
      literal beside the constant, or derive it in a second statement, and
      test_neither_side_spells_the_bucket_out_beside_the_constant fails.
    * Change the `METRIC#persona#` key prefix on one side only — fails
      test_both_sides_spell_the_persona_partition_the_same_way, which is what keeps
      `get_metric_type`, the `metric_type` GSI and the read paths working while the
      source field moves underneath them.
"""
import ast
import json
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from shared.feedback import PERSONA_FIELD, PERSONA_UNKNOWN

# test/ → api/ → lambda/ → voc-datalake/, then the two files that share the axis.
_REPO = Path(__file__).resolve().parents[3]
AGGREGATOR_SOURCE = 'lambda/aggregator/handler.py'
METRICS_SOURCE = 'lambda/api/metrics_handler.py'
SHARED_MODULE = 'shared.feedback'

# The axis's key prefix, which deliberately did NOT move when the source field did:
# `get_metric_type`, the `metric_type` GSI and every read path key off it, and the
# axis is still "persona" — only where its value comes from changed.
PERSONA_PREFIX = 'METRIC#persona#'

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


def _statements_deriving_the_bucket(relative: str, function: str) -> list[str]:
    """Every statement inside `function` that reads PERSONA_FIELD, unparsed.

    Parsed with `ast` and scoped to the one function, the convention this repo's
    other locksteps follow, and for the usual two reasons: a pattern cannot tell a
    call from a MENTION of one (this file's own docstrings name both constants), and
    a pattern reads only the shapes it anticipated.
    """
    tree = ast.parse(_read(relative))
    functions = [node for node in ast.walk(tree)
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name == function]
    assert len(functions) == 1, (
        f'Expected exactly one {function} in {relative}; found {len(functions)}. A '
        f'second copy is the drift this file exists to prevent.'
    )
    found: list[str] = []
    for statement in functions[0].body:
        names = {node.id for node in ast.walk(statement) if isinstance(node, ast.Name)}
        if 'PERSONA_FIELD' in names:
            found.append(ast.unparse(statement))
    return found


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

    Assembled from the SHARED field constant plus the partition prefix both sides
    spell — not from a hand-written pk — so that a scan path reading some other
    field disagrees with this row instead of with a literal chosen to match it.
    """
    return {
        'pk': f'{PERSONA_PREFIX}{item.get(PERSONA_FIELD) or PERSONA_UNKNOWN}',
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
            source = _read(relative)
            imports = re.findall(
                rf'^from {re.escape(SHARED_MODULE)} import (.+)$', source, re.MULTILINE
            )
            imported = {name.strip() for line in imports for name in line.split(',')}
            assert {'PERSONA_FIELD', 'PERSONA_UNKNOWN'} <= imported, (
                f'{relative} does not import PERSONA_FIELD and PERSONA_UNKNOWN from '
                f'{SHARED_MODULE}; it imports {sorted(imported)}. Both sides of the '
                f'axis have to read one declaration, or moving the field moves only '
                f'half of it.'
            )

    def test_neither_side_spells_the_bucket_out_beside_the_constant(self):
        """The bucket is derived in ONE statement per side, and it quotes nothing.

        Scoped to that statement rather than searched for across the file, because
        `'unknown'` is also the `source_platform` default a few lines above the
        aggregator's persona line: a file-wide search for the value would report a
        correct module, which is the one thing a lockstep must never do.
        """
        for relative, function in ((AGGREGATOR_SOURCE, 'counter_dimensions'),
                                   (METRICS_SOURCE, '_persona_bucket')):
            statements = _statements_deriving_the_bucket(relative, function)
            assert len(statements) == 1, (
                f'{relative}::{function} derives the persona bucket in '
                f'{len(statements)} statements: {statements}. One statement, so that '
                f'moving the field is one edit — a second is where the two directions '
                f'of the stream, or the two branches of the route, come apart.'
            )
            statement = statements[0]
            assert 'PERSONA_UNKNOWN' in statement, (
                f'{relative}::{function} derives the persona bucket as `{statement}`, '
                f'which does not name PERSONA_UNKNOWN. The empty case has to come '
                f'from the shared declaration too, or one side keeps calling it '
                f'something the other does not recognise.'
            )
            assert not re.search(r"""['"]""", statement), (
                f'{relative}::{function} derives the persona bucket as '
                f'`{statement}`, which quotes a value alongside the constants. Two '
                f'spellings of one value is the drift, whichever is currently right.'
            )

    def test_both_sides_spell_the_persona_partition_the_same_way(self):
        """The key prefix did not move, and must not move on one side alone.

        `get_metric_type` tags these rows for the `metric_type` GSI by this prefix
        and both read paths strip it back off, so a prefix changed where the rows
        are WRITTEN and not where they are read leaves the GSI untagged and the
        dimension empty — while every count is still computed correctly.
        """
        for relative in (AGGREGATOR_SOURCE, METRICS_SOURCE):
            assert PERSONA_PREFIX in _read(relative), (
                f'{relative} no longer spells `{PERSONA_PREFIX}`. The axis is still '
                f'"persona"; only its source field moved. If the prefix really is '
                f'changing, it changes on both sides and here in the same commit.'
            )

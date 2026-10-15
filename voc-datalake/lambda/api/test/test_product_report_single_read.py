"""A product report is built from the document list its gate actually inspected.

`generate_report` used to read the document list TWICE: once as the gate
(`_injectable_docs`) and once inside `build_product_context_block`, which read it
again. The predicate agreed with itself; the DATA did not have to. A document
deleted between the two reads passed the gate and was then missing from the
block, so the report was synthesized from the "(No product context provided.)"
placeholder — and the saved record still claimed `product_context_included:
True`, because that flag was a literal.

Note WHERE the second read used to happen: the gate is
`not has_any and not _injectable_docs(...)`, and `and` short-circuits, so the
double read only occurred when the structured fields were empty — precisely the
project whose documents are its ONLY content. The race bit exactly where it
existed.

Two properties are pinned here, and neither is visible from a test that only
asserts "a report was produced":

1. the list is read ONCE (counted on the table's own `query`), and
2. the report is built from the documents that read returned.

AWS is mocked at the import boundary, as elsewhere in this directory: the module
resolves DynamoDB through `projects_table` and S3 through `_s3()`, so both are
patched by name and no client is constructed.
"""
import os
from unittest.mock import MagicMock, patch

import pytest

DOC_BODY = 'Onboarding takes three steps and the primary colour is #0F62FE.'
EXTRACTED_KEY = 'projects/proj-1/product_docs/extracted/notes.txt'

READY_DOC = {
    'doc_id': 'notes',
    'filename': 'notes.md',
    'content_type': 'text/markdown',
    'size_bytes': 2048,
    'status': 'ready',
    'error': None,
    'extracted_chars': len(DOC_BODY),
    's3_extracted_key': EXTRACTED_KEY,
    'created_at': '2026-08-13T10:00:00+00:00',
}

PLACEHOLDER = '(No product context provided.)'


def _context(**filled) -> dict:
    """A product context with every field blank except those named."""
    import product_context

    ctx = product_context._empty_context()
    ctx.update(filled)
    return {'context': ctx}


def _fake_s3(bodies: dict[str, str] | None = None) -> MagicMock:
    """An S3 stand-in keyed by object key, so a body cannot be misattributed."""
    contents = {EXTRACTED_KEY: DOC_BODY} if bodies is None else bodies
    s3 = MagicMock()
    # Capitalised parameter names are boto3's own kwargs.
    s3.get_object.side_effect = lambda Bucket, Key: {
        'Body': MagicMock(read=lambda: contents[Key].encode('utf-8'))
    }
    return s3


def _wire_transactions(table: MagicMock) -> None:
    table.name = 'test-projects'

    def transact_write_items(*, TransactItems):
        for action in TransactItems:
            put = action.get('Put')
            if put:
                table.put_item(Item=put['Item'])
            update = action.get('Update')
            if update:
                table.update_item(
                    Key=update['Key'],
                    UpdateExpression=update['UpdateExpression'],
                    ExpressionAttributeValues=update.get(
                        'ExpressionAttributeValues', {},
                    ),
                )
        return {}

    table.meta.client.transact_write_items.side_effect = transact_write_items


def _run_report(table: MagicMock, ctx: dict, s3: MagicMock | None = None) -> dict:
    """Run generate_report and return {'result', 'prompt', 'item'}.

    `converse` is patched on its own module because generate_report imports it
    INSIDE the function body, so there is no attribute on `product_context` to
    patch (the same reasoning as test_product_context_injection.py).
    """
    import product_context
    import shared.converse

    _wire_transactions(table)
    with patch.dict(os.environ, {'RAW_DATA_BUCKET': 'test-bucket'}), \
            patch.object(product_context, 'projects_table', table), \
            patch.object(product_context, 'get_context', return_value=ctx), \
            patch.object(product_context, '_s3', return_value=s3 or _fake_s3()), \
            patch.object(shared.converse, 'converse',
                         return_value='# Product description') as converse:
        result = product_context.generate_report('proj-1', {})

    return {
        'result': result,
        'prompt': converse.call_args.kwargs['prompt'],
        'item': table.put_item.call_args.kwargs['Item'],
    }


def _doc_query_count(table: MagicMock) -> int:
    """How many times the PRODUCT_DOC# list was read.

    Counted on `query` rather than by patching `_list_doc_items`, because a
    patched helper would hide a second read made by any other route to the same
    table.
    """
    return table.query.call_count


class TestTheDocumentListIsReadOnce:
    def test_exactly_one_query_on_the_field_less_path(self):
        """The path where the double read used to happen: no structured fields,
        so documents are the project's only content."""
        table = MagicMock()
        table.query.return_value = {'Items': [READY_DOC]}

        _run_report(table, _context())

        assert _doc_query_count(table) == 1

    def test_exactly_one_query_when_the_fields_are_filled_too(self):
        """The gate short-circuits when the fields are filled, so the block makes
        the only query. That has to stay at one — 'read once' must not have bought
        an extra query on the common path."""
        table = MagicMock()
        table.query.return_value = {'Items': [READY_DOC]}

        _run_report(table, _context(product_name='Acme'))

        assert _doc_query_count(table) == 1

    def test_a_project_with_fields_AND_documents_gets_both(self):
        """The trap in "read once, pass through": on the short-circuited path the
        list was never read, so what gets passed to the block must mean "read it
        yourself" (None) and not "there are none" ([]). Handing over an empty list
        there silently drops every document from a report whose fields are filled
        — no error, no missing section heading, just absent content."""
        table = MagicMock()
        table.query.return_value = {'Items': [READY_DOC]}

        run = _run_report(table, _context(product_name='Acme'))

        assert 'Acme' in run['prompt']
        assert DOC_BODY in run['prompt']

    def test_the_report_is_built_from_the_documents_the_gate_saw(self):
        """THE RACE, reproduced. The list returns the document on the first read
        and NOTHING on a second, which is what a delete between the two reads
        looked like.

        With one read there is no second answer to get, so the block carries the
        document. If someone reintroduces the second read this fails twice over:
        the block becomes the placeholder, and the report's derivation stops
        matching its content. A third read raises StopIteration, which is also a
        failure rather than a silent pass.
        """
        table = MagicMock()
        table.query.side_effect = [{'Items': [READY_DOC]}, {'Items': []}]

        run = _run_report(table, _context())

        assert DOC_BODY in run['prompt']
        assert PLACEHOLDER not in run['prompt']
        assert _doc_query_count(table) == 1

    def test_the_block_never_receives_the_placeholder_for_a_docs_only_project(self):
        """The consequence the race produced, asserted on the saved document
        rather than on the prompt: a report whose input was the placeholder is a
        report about nothing, saved as a report about a product."""
        table = MagicMock()
        table.query.side_effect = [{'Items': [READY_DOC]}, {'Items': []}]

        run = _run_report(table, _context())

        assert run['item']['content'] == '# Product description'
        assert run['item']['derivation']['product_context_included'] is True


class TestTheDerivationIsComputed:
    """`product_context_included` is derived from the data, not asserted.

    Its False case is UNREACHABLE end-to-end — the gate raises before a report
    exists — so the truth table is tested on the helper directly, and the call
    site is tested for actually consulting it.
    """

    @pytest.mark.parametrize('has_any, docs, expected', [
        ('Acme', None, True),        # fields only — the list was never read
        ('Acme', [], True),          # fields, and a read that found nothing
        ('', [READY_DOC], True),     # documents only
        ('Acme', [READY_DOC], True),  # both
        ('', [], False),             # neither — unreachable via generate_report
        ('', None, False),           # ditto, with the list unread
    ])
    def test_the_helper_answers_from_its_inputs(self, has_any, docs, expected):
        import product_context

        assert product_context._product_context_included(has_any, docs) is expected

    def test_the_saved_flag_comes_from_the_helper_and_not_from_a_literal(self):
        """The discriminating case for "computed rather than constant".

        The helper is made to answer False for a project that has fields — a lie,
        deliberately, because that is the only way to tell a call site that reads
        the helper from one that hardcodes `True`. Re-hardcoding it makes this
        fail; nothing else in this file would notice.
        """
        import product_context

        table = MagicMock()
        table.query.return_value = {'Items': []}

        with patch.object(product_context, '_product_context_included',
                          return_value=False):
            run = _run_report(table, _context(product_name='Acme'))

        assert run['item']['derivation']['product_context_included'] is False

    def test_a_fields_only_project_still_reports_true(self):
        """Vacuity guard for the test above: the flag is not merely False."""
        table = MagicMock()
        table.query.return_value = {'Items': []}

        run = _run_report(table, _context(product_name='Acme'))

        assert run['item']['derivation']['product_context_included'] is True
        # And the block it recorded really did carry the field.
        assert 'Acme' in run['prompt']


class TestTheHandedListIsStillFiltered:
    """A caller's list goes through `_is_injectable` too.

    Otherwise the new parameter would be a back door around the image filter that
    rung 3 owns — a fail-open the caller could not see.
    """

    def test_an_image_passed_in_directly_is_not_injected(self):
        import product_context

        image = {**READY_DOC, 'doc_id': 'shot', 'filename': 'shot.png',
                 'content_type': 'image/png',
                 's3_extracted_key': 'projects/proj-1/product_docs/extracted/shot.txt'}
        s3 = _fake_s3({image['s3_extracted_key']: 'a description no prompt should see'})
        with patch.dict(os.environ, {'RAW_DATA_BUCKET': 'test-bucket'}), \
                patch.object(product_context, 'get_context', return_value=_context()), \
                patch.object(product_context, '_s3', return_value=s3):
            block = product_context.build_product_context_block('proj-1', docs=[image])

        assert block == PLACEHOLDER

    def test_omitting_the_parameter_reads_the_table_exactly_as_before(self):
        """The other callers (projects.py, jobs/document_generator) pass no list.
        Their behaviour has to be untouched, so the read still happens here."""
        import product_context

        table = MagicMock()
        table.query.return_value = {'Items': [READY_DOC]}
        with patch.dict(os.environ, {'RAW_DATA_BUCKET': 'test-bucket'}), \
                patch.object(product_context, 'projects_table', table), \
                patch.object(product_context, 'get_context', return_value=_context()), \
                patch.object(product_context, '_s3', return_value=_fake_s3()):
            block = product_context.build_product_context_block('proj-1')

        assert DOC_BODY in block
        assert table.query.call_count == 1

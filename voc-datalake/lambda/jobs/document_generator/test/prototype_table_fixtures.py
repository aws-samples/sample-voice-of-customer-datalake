"""Projects-table wiring and run helpers shared by the prototype-build tests
(`test_prototype_sources`, `test_prototype_context_sources`).

Every fixture built on these holds at least TWO documents of a type with
different `created_at`, because a single-document fixture cannot distinguish
"picked the right PRD" from "picked the only PRD".
"""

HTML = '<!DOCTYPE html><html><body><h1>Demo</h1></body></html>'

# Ids deliberately NOT in creation order: the alphabetically last id is the
# OLDEST document. A read that ranks by id, or that trusts `sk` ordering, picks
# `zz_prd_old` here and builds against the stale spec.
PRD_OLD = {'document_id': 'zz_prd_old', 'content': 'OLD PRD body', 'created_at': '2026-01-01T00:00:00Z'}
PRD_NEW = {'document_id': 'aa_prd_new', 'content': 'NEW PRD body', 'created_at': '2026-06-01T00:00:00Z'}


def wire_projects_table(mock_dynamodb, *, prd_pages=(), prfaq_pages=(), documents=None,
                        project_name='My Project'):
    """
    Wire the projects table: newest-of-type query pages per type, plus items
    reachable by key.

    Pages are supplied PER TYPE, so the helper knows which `sk` prefix each item
    keys under. A flat list forced it to guess, and it guessed `PRD#` for
    everything — harmless while every PR/FAQ page was empty, but the first test to
    give the PR/FAQ query real items would have seen the id resolve and then
    `_document_by_id('PRFAQ#…')` return nothing: a silently source-less build that
    reads like a product bug (found in review round 2).

    `query.side_effect` is assembled PRD-then-PR/FAQ, matching the production call
    order. Order-dependence is deliberate — one shared `return_value` answers the
    PR/FAQ lookup with PRDs, which lets a test assert "the prompt holds the new
    PRD" and pass while the prompt is nonsense. It is also strict: an unexpected
    extra `query` runs the list out and fails, which is how the aimed tests show
    they never scan.

    Every document offered to `query` is ALSO reachable by key, because the
    newest-of-type read ranks over a projection and then fetches the winner via
    `_document_by_id`. Explicit `documents` entries win, which is what the aimed
    tests use.

    `documents` maps an `sk` to the item a keyed read returns.
    """
    table = mock_dynamodb['table']
    table.query.side_effect = [*prd_pages, *prfaq_pages]

    by_sk = {}
    for prefix, pages in (('PRD#', prd_pages), ('PRFAQ#', prfaq_pages)):
        for page in pages:
            for item in page.get('Items') or []:
                document_id = item.get('document_id')
                if document_id:
                    by_sk[f'{prefix}{document_id}'] = item
    by_sk.update(documents or {})

    def get_item(Key=None, **_kwargs):
        sk = (Key or {}).get('sk', '')
        if sk == 'META':
            return {'Item': {'name': project_name}}
        item = by_sk.get(sk)
        return {'Item': item} if item else {}

    table.get_item.side_effect = get_item
    return table


def run_prototype_build(sample_job_event, lambda_context, **config):
    """Invoke the document generator with a `build_prototype` job carrying *config*."""
    from jobs.document_generator.handler import lambda_handler
    return lambda_handler({
        **sample_job_event,
        'doc_config': {'doc_type': 'build_prototype', 'title': 'Test Prototype', **config},
    }, lambda_context)


def prompt_sent(mock_converse):
    """The user prompt the last model call carried."""
    return mock_converse.call_args.kwargs['prompt']


def saved_item(mock_dynamodb):
    """The item the last `put_item` persisted."""
    return mock_dynamodb['table'].put_item.call_args.kwargs['Item']

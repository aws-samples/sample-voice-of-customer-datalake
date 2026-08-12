"""
Which documents a prototype build reads (U25).

Two properties, both of which were previously unpinned:

1. **The newest document of a type is found regardless of id format.** The old
   read took a 20-item window ordered by `sk` and then re-sorted it by
   `created_at`. That agrees with creation order only while ids are
   timestamp-prefixed, and it silently drops anything outside the window — so a
   build could run against a stale spec and say nothing.

2. **A build can be aimed, and an id it cannot resolve is never quietly
   replaced.** `source_prd_id`/`source_prfaq_id` select the documents to read.
   An id that names nothing in this project fails the job; falling back to the
   newest would produce a prototype built from a document the user did not
   choose, which no part of the output would reveal.

Every fixture here holds at least TWO documents of a type with different
`created_at`, because a single-document fixture cannot distinguish "picked the
right PRD" from "picked the only PRD".
"""
import pytest

HTML = '<!DOCTYPE html><html><body><h1>Demo</h1></body></html>'

# Ids deliberately NOT in creation order: the alphabetically last id is the
# OLDEST document. A read that ranks by id, or that trusts `sk` ordering, picks
# `zz_prd_old` here and builds against the stale spec.
PRD_OLD = {'document_id': 'zz_prd_old', 'content': 'OLD PRD body', 'created_at': '2026-01-01T00:00:00Z'}
PRD_NEW = {'document_id': 'aa_prd_new', 'content': 'NEW PRD body', 'created_at': '2026-06-01T00:00:00Z'}

NO_DOCUMENTS = {'Items': []}


def _wire(mock_dynamodb, *, prd_pages=(), prfaq_pages=(), documents=None):
    """
    Wire the projects table.

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

    def get_item(Key=None, **kwargs):
        sk = (Key or {}).get('sk', '')
        if sk == 'META':
            return {'Item': {'name': 'My Project'}}
        item = by_sk.get(sk)
        return {'Item': item} if item else {}

    table.get_item.side_effect = get_item
    return table


def _run(sample_job_event, lambda_context, **config):
    from jobs.document_generator.handler import lambda_handler
    return lambda_handler({
        **sample_job_event,
        'doc_config': {'doc_type': 'build_prototype', 'title': 'Test Prototype', **config},
    }, lambda_context)


def _prompt(mock_converse):
    return mock_converse.call_args.kwargs['prompt']


def _saved(mock_dynamodb):
    return mock_dynamodb['table'].put_item.call_args.kwargs['Item']


class TestNewestDocumentOfAType:
    """`_latest_doc_by_prefix` — property 1."""

    def test_picks_the_newest_by_created_at_not_by_id(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The regression the old `sk`-ordered window hid: here the newest
        document has the alphabetically LOWEST id, so anything ranking by id or
        by `sk` reads the stale PRD instead."""
        _wire(mock_dynamodb, prd_pages=[{'Items': [PRD_OLD, PRD_NEW]}], prfaq_pages=[NO_DOCUMENTS])
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context)

        assert 'NEW PRD body' in _prompt(mock_converse)
        assert 'OLD PRD body' not in _prompt(mock_converse)
        assert _saved(mock_dynamodb)['source_prd_id'] == 'aa_prd_new'

    def test_reads_past_the_first_page(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The newest PRD is on page two. The previous `Limit=20` read stopped at
        one page, so this is the direct fail-on-revert for removing the cap: put
        the cap back and the build silently uses the older document."""
        _wire(
            mock_dynamodb,
            prd_pages=[
                {'Items': [PRD_OLD], 'LastEvaluatedKey': {'pk': 'PROJECT#p', 'sk': 'PRD#zz_prd_old'}},
                {'Items': [PRD_NEW]},
            ],
            prfaq_pages=[NO_DOCUMENTS],
        )
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context)

        assert 'NEW PRD body' in _prompt(mock_converse)
        assert _saved(mock_dynamodb)['source_prd_id'] == 'aa_prd_new'

    def test_a_tie_on_created_at_resolves_on_id_descending(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """Two documents saved in the same second must still resolve to one
        answer, and to the same one the `sk`-ordered read gave: highest id."""
        same_time = '2026-06-01T00:00:00Z'
        _wire(
            mock_dynamodb,
            prd_pages=[{'Items': [
                {'document_id': 'prd_a', 'content': 'A body', 'created_at': same_time},
                {'document_id': 'prd_b', 'content': 'B body', 'created_at': same_time},
            ]}],
            prfaq_pages=[NO_DOCUMENTS],
        )
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context)

        assert _saved(mock_dynamodb)['source_prd_id'] == 'prd_b'

    def test_the_lookup_sends_no_row_cap(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """Asserted on the request because it cannot be asserted on behaviour: a
        mocked table returns the items it was handed no matter what `Limit` says,
        so re-adding `Limit=20` passes every other test in this file. A cap is
        only observable against real DynamoDB — or here, on the call itself.

        `ScanIndexForward` goes with it. Ordering is decided on `created_at` after
        the read, so asking the database to sort by `sk` would only suggest the
        result depends on id format, which is the misreading that produced the bug.
        """
        _wire(mock_dynamodb, prd_pages=[{'Items': [PRD_OLD, PRD_NEW]}], prfaq_pages=[NO_DOCUMENTS])
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context)

        for call in mock_dynamodb['table'].query.call_args_list:
            assert 'Limit' not in call.kwargs
            assert 'ScanIndexForward' not in call.kwargs

    def test_no_documents_of_either_type_fails_the_job(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        _wire(mock_dynamodb, prd_pages=[NO_DOCUMENTS], prfaq_pages=[NO_DOCUMENTS])
        mock_converse.return_value = HTML

        with pytest.raises(Exception, match='Document generation failed'):
            _run(sample_job_event, lambda_context)

        mock_converse.assert_not_called()


class TestAimedBuild:
    """`source_prd_id`/`source_prfaq_id` — property 2."""

    def test_reads_the_named_document_even_when_it_is_not_the_newest(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The point of the feature: aim a build at an older spec. A fixture with
        one PRD could not tell this apart from ignoring the parameter.

        Only ONE query response is supplied — the PR/FAQ lookup — so this also
        pins that a named PRD is fetched by key rather than found by scanning.
        """
        _wire(
            mock_dynamodb,
            prfaq_pages=[NO_DOCUMENTS],
            documents={'PRD#zz_prd_old': PRD_OLD},
        )
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context, source_prd_id='zz_prd_old')

        assert 'OLD PRD body' in _prompt(mock_converse)
        assert 'NEW PRD body' not in _prompt(mock_converse)
        item = _saved(mock_dynamodb)
        assert item['source_prd_id'] == 'zz_prd_old'
        # The shared lineage shape records what was actually read, not the newest.
        assert item['derivation']['sources'] == [{'document_id': 'zz_prd_old', 'role': 'prototype_prd'}]

    def test_an_unresolvable_id_fails_instead_of_falling_back_to_the_newest(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The property worth the most. A named id that resolves to nothing must
        NOT quietly become "the newest": a reachable newer PRD is deliberately
        present, so a fallback would succeed and look entirely normal.

        The fixture is wired so a fallback would COMPLETE — enough query
        responses for both lookups to succeed. That is load-bearing and was got
        wrong once: with only the PRD response supplied, a fallback consumed it,
        the PR/FAQ lookup then ran the list out, and the job failed for that
        reason instead. The test passed under the mutation it exists to catch.
        """
        _wire(mock_dynamodb, prd_pages=[{'Items': [PRD_OLD, PRD_NEW]}], prfaq_pages=[NO_DOCUMENTS], documents={})
        mock_converse.return_value = HTML

        with pytest.raises(Exception, match='Document generation failed'):
            _run(sample_job_event, lambda_context, source_prd_id='prd_does_not_exist')

        # No prompt was built and no document was saved: the build did not happen
        # at all, rather than happening against the wrong source.
        mock_converse.assert_not_called()
        mock_dynamodb['table'].put_item.assert_not_called()

    def test_a_supplied_id_is_only_ever_read_under_this_project(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """The ownership half of the trust boundary, asserted on the key that is
        actually built rather than on an outcome.

        A supplied id reaches DynamoDB only inside `sk`, never inside `pk`, so no
        id can address another project's partition — which is why the aiming path
        needs no separate ownership check. Asserting this by outcome would be a
        tautology: one mocked table has no other project to reach, so "another
        project's id" and "no such id" would be the same fixture.
        """
        _wire(mock_dynamodb, documents={'PRD#prd_x': PRD_NEW})
        mock_converse.return_value = HTML

        with pytest.raises(Exception, match='Document generation failed'):
            _run(sample_job_event, lambda_context, source_prd_id='../PROJECT#victim/prd_x')

        keys = [call.kwargs.get('Key', {}) for call in mock_dynamodb['table'].get_item.call_args_list]
        assert keys, 'expected at least one keyed read'
        assert {k.get('pk') for k in keys} == {'PROJECT#proj_20250101120000'}
        # The whole supplied string lands in the sort key, where an id shaped like
        # a traversal is just an id that matches nothing.
        assert any(k.get('sk') == 'PRD#../PROJECT#victim/prd_x' for k in keys)

    def test_a_prfaq_id_offered_as_a_prd_does_not_resolve(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """Type isolation comes from the `sk` prefix: the id names a real
        document, but a PR/FAQ, so asking for it as a PRD finds nothing."""
        _wire(
            mock_dynamodb,
            documents={'PRFAQ#prfaq_1': {'document_id': 'prfaq_1', 'content': 'PRFAQ body'}},
        )
        mock_converse.return_value = HTML

        with pytest.raises(Exception, match='Document generation failed'):
            _run(sample_job_event, lambda_context, source_prd_id='prfaq_1')

        mock_converse.assert_not_called()

    def test_naming_neither_source_keeps_the_previous_latest_of_each_behaviour(
        self, mock_dynamodb, mock_jobs_table, mock_converse, mock_s3, sample_job_event, lambda_context,
    ):
        """Every caller that existed before this parameter sends nothing, and a
        blank field is not a choice, so both must stay exactly latest-of-each."""
        _wire(mock_dynamodb, prd_pages=[{'Items': [PRD_OLD, PRD_NEW]}], prfaq_pages=[NO_DOCUMENTS], documents={})
        mock_converse.return_value = HTML

        _run(sample_job_event, lambda_context, source_prd_id='', source_prfaq_id=None)

        assert 'NEW PRD body' in _prompt(mock_converse)
        assert _saved(mock_dynamodb)['source_prd_id'] == 'aa_prd_new'

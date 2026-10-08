"""Every id / key validator refuses a well-shaped value with one trailing newline.

`re.match(r'^…$')` accepts 'abc\\n': `$` also matches just before a final
newline. The validators use `fullmatch`, which does not, so a value such as
'rp_0123456789ab\\n' cannot pass as an id and reach a DynamoDB key, a log line
or an S3 path. Each case below fails if its call site goes back to `.match`.

Validators that strip their input first (ballot ids, `?ids=` project ids,
https URLs), receive input that cannot hold a newline (urlparse drops it from
GitHub links), or whose own pattern already admits a newline (the product-doc
extractor's S3 key) use `fullmatch` too, for consistency, but have no case
here: no input can tell the two apart.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

import chat_handler
import logs_handler
import projects_handler
import scrapers_handler
from shared import company_context, document_history, mcp_global_tokens, prototype_pins, reprocess_jobs
from shared.exceptions import NotFoundError, ValidationError
from shared.scraper_run_errors import SCRAPER_ERROR_WITHHELD, redact_scraper_error

NL = '\n'
JOB_ID = 'rp_0123456789ab'
FORM_ID = 'pf_0123456789abcdef'
PIN_ID = 'pin_' + '1' * 20 + 'abcdef'
REF_ID = 'ref_0123456789ab'


class TestSharedIdPredicates:
    @pytest.mark.parametrize(('predicate', 'valid'), [
        (mcp_global_tokens.is_path_id, 'tok_abc'),
        (reprocess_jobs.is_job_id, JOB_ID),
        (prototype_pins.is_pin_form_id, FORM_ID),
        (prototype_pins.is_pin_id, PIN_ID),
    ])
    def test_the_valid_id_passes_and_the_same_id_plus_newline_does_not(self, predicate, valid):
        assert predicate(valid) is True
        assert predicate(valid + NL) is False


class TestDocumentHistory:
    def test_an_edit_id_with_a_trailing_newline_is_refused(self):
        assert document_history.validated_edit_id('abc', 'text') == 'abc'
        with pytest.raises(ValidationError, match='edit_id'):
            document_history.validated_edit_id('abc' + NL, 'text')

    def test_an_unmanaged_version_id_with_a_trailing_newline_is_not_found(self):
        table = MagicMock()
        document = {'document_id': 'doc1', 'revision': 1}
        with pytest.raises(NotFoundError):
            document_history._restore_unmanaged(table, 'p1', document, 'r1' + NL, now='t')
        table.get_item.assert_not_called()


class TestCompanyContext:
    def test_a_due_date_with_a_trailing_newline_is_refused_as_not_a_date(self):
        assert company_context._due('2024-01-01', 'due') == '2024-01-01'
        with pytest.raises(ValidationError, match=r'must be a date \(YYYY-MM-DD\)'):
            company_context._due('2024-01-01' + NL, 'due')

    def test_an_item_id_with_a_trailing_newline_is_replaced_by_a_minted_one(self):
        assert company_context._item_id(REF_ID, 'ref') == REF_ID
        minted = company_context._item_id(REF_ID + NL, 'ref')
        assert minted != REF_ID + NL
        assert NL not in minted

    def test_a_reference_id_with_a_trailing_newline_reads_nothing(self):
        table = MagicMock()
        assert company_context.get_reference(table, REF_ID + NL) is None
        table.get_item.assert_not_called()


class TestChatConversationIds:
    def test_the_route_id_check_answers_not_found(self):
        chat_handler._require_valid_conversation_id('conv-1')
        with pytest.raises(chat_handler.NotFoundError):
            chat_handler._require_valid_conversation_id('conv-1' + NL)

    def test_the_body_id_check_answers_bad_request(self):
        assert chat_handler._valid_conversation_id('conv-1') == 'conv-1'
        with pytest.raises(ValidationError):
            chat_handler._valid_conversation_id('conv-1' + NL)


class TestLogsRedaction:
    def test_a_path_segment_with_a_trailing_newline_withholds_the_path(self):
        assert logs_handler._safe_path('a.b') == 'a.b'
        assert logs_handler._safe_path('a' + NL + '.b') is None

    def test_an_error_code_with_a_trailing_newline_is_shown_as_invalid(self):
        assert logs_handler._redact_validation_error('text: missing') == 'text: missing'
        assert logs_handler._redact_validation_error('text: missing' + NL) == 'text: invalid'

    def test_a_record_key_with_a_trailing_newline_is_masked(self):
        fields = logs_handler._redacted_validation_fields({'record_keys': ['text', 'text' + NL]})
        assert fields['record_keys'] == ['text', logs_handler.MASKED_SEGMENT]

    def test_an_error_type_with_a_trailing_newline_is_unknown(self):
        assert logs_handler._redacted_processing_fields({'error_type': 'ValueError'})['error_type'] == 'ValueError'
        fields = logs_handler._redacted_processing_fields({'error_type': 'ValueError' + NL})
        assert fields['error_type'] == logs_handler.UNKNOWN_ERROR_TYPE


class TestScraperErrors:
    def test_an_exception_name_with_a_trailing_newline_is_withheld(self):
        assert redact_scraper_error('Error scraping https://x.test: ValueError') == \
            'Error scraping https://x.test: ValueError'
        assert redact_scraper_error('Error scraping https://x.test: ValueError' + NL) == \
            'Error scraping https://x.test: error details withheld'

    def test_a_policy_detail_with_a_trailing_newline_is_withheld(self):
        ok = 'Error scraping https://x.test: URL blocked by policy (private address)'
        assert redact_scraper_error(ok) == ok
        assert redact_scraper_error(ok + NL) != ok + NL
        assert redact_scraper_error(ok + NL) != SCRAPER_ERROR_WITHHELD  # the prefix is still shown

    def test_a_scraper_id_with_a_trailing_newline_is_refused(self):
        assert scrapers_handler._scraper_shape_error({'id': 'scr' + NL}) == \
            'id must be 1-64 letters, digits, "_" or "-"'


class TestPrototypePinDocumentIds:
    def test_a_document_id_with_a_trailing_newline_is_refused_before_any_read(self):
        with patch.object(projects_handler, '_project_access_for'), \
             patch.object(projects_handler, '_request_caller'), \
             patch.object(projects_handler, 'get_projects_table') as get_table, \
             pytest.raises(ValidationError, match='Invalid document id'):
            projects_handler._pin_form_for('p1', 'doc1' + NL)
        get_table.assert_not_called()

    def test_a_revision_document_id_with_a_trailing_newline_is_refused(self):
        with patch.object(projects_handler, 'json_object_body',
                          return_value={'revision_document_id': 'doc2' + NL, 'pin_ids': [PIN_ID]}), \
             patch.object(projects_handler, '_batch_status_change') as change, \
             pytest.raises(ValidationError, match='revision_document_id'):
            projects_handler.mark_prototype_pins_addressed('p1', 'doc1')
        change.assert_not_called()

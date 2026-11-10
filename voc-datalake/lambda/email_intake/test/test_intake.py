"""The intake pipeline against the .eml fixtures: guards, threads, every dedupe layer, attachments, caps."""
from unittest.mock import patch

import pytest

from email_intake import intake, mime
from email_intake.intake import BudgetSpentError, DailyCapError
from email_intake.test.conftest import BUCKET, DAY, fixture_bytes, queued, run
from shared.email_intake_settings import CONFIG_KEY, stats_key


def _stats(aws) -> dict:
    return aws['aggregates'].get_item(Key=stats_key(DAY)).get('Item') or {}


def _set_caps(aws, **caps) -> None:
    aws['aggregates'].put_item(Item={**CONFIG_KEY, **caps})


def test_new_email_becomes_one_redacted_item_without_signature(aws, ctx):
    outcome = run(aws, ctx, 'new.eml')
    [message] = queued(aws)
    assert (outcome.status, message['id']) == ('accepted', outcome.item_id)
    assert message['source_platform'] == 'email_intake'
    assert message['source_channel'] == 'feedback'
    assert message['title'] == 'Checkout keeps failing'
    assert 'card declined' in message['text']
    assert 'Best regards' not in message['text']
    assert 'Customer since' not in message['text']
    # The default profile for the inbox is redact: no author, the email placeholder only.
    assert message['pii_policy_applied'] == 'redact'
    assert 'author' not in message
    assert message['metadata']['email'] == '[EMAIL]'
    assert message['metadata']['spf_verdict'] == 'PASS'
    assert 'dimensions' not in message  # feedback@ lets the processor decide


def test_accepted_email_keeps_the_original_only_under_inbound_raw(aws, ctx):
    outcome = run(aws, ctx, 'new.eml')
    keys = [obj['Key'] for obj in aws['s3'].list_objects_v2(Bucket=BUCKET).get('Contents', [])]
    assert f'inbound-raw/{outcome.item_id}/message.eml' in keys
    assert _stats(aws)['accepted'] == 1


def test_the_same_message_id_twice_is_one_item(aws, ctx):
    first = run(aws, ctx, 'new.eml')
    second = run(aws, ctx, 'new.eml')
    assert (second.status, second.reason, second.item_id) == ('deduped', 'duplicate_message', first.item_id)
    assert len(queued(aws)) == 1
    assert _stats(aws)['deduped_duplicate_message'] == 1


def test_reply_with_references_joins_the_root_thread_with_only_its_new_text(aws, ctx, models):
    root = run(aws, ctx, 'new.eml')
    reply = run(aws, ctx, 'reply_headers.eml')
    root_message, reply_message = queued(aws)
    assert reply.status == 'accepted'
    assert reply.item_id != root.item_id
    assert reply_message['metadata']['thread_id'] == root_message['metadata']['thread_id']
    assert reply_message['metadata']['is_reply'] is True
    assert reply_message['text'] == 'It also fails in the mobile app now, with error code 402.'
    assert reply_message['dimensions'] == {'feedback_type': 'bug'}  # sent to bugs@
    models.relevance_label.assert_called_once()


def test_a_thanks_reply_is_counted_not_ingested_and_costs_no_model_call(aws, ctx, models):
    run(aws, ctx, 'new.eml')
    outcome = run(aws, ctx, 'reply_thanks.eml')
    assert (outcome.status, outcome.reason) == ('deduped', 'no_new_info')
    models.relevance_label.assert_not_called()
    assert len(queued(aws)) == 1


def test_the_model_gate_drops_a_reply_without_new_information(aws, ctx, models):
    models.relevance_label.return_value = 'no_new_info'
    run(aws, ctx, 'new.eml')
    outcome = run(aws, ctx, 'reply_headers.eml')
    assert (outcome.status, outcome.reason) == ('deduped', 'no_new_info')
    assert _stats(aws)['model_calls'] == 1


def test_re_subject_without_headers_joins_the_thread_by_subject_and_domain(aws, ctx):
    run(aws, ctx, 'new.eml')
    outcome = run(aws, ctx, 'reply_subject_only.eml')
    root_message, reply_message = queued(aws)
    assert outcome.status == 'accepted'
    assert reply_message['metadata']['thread_id'] == root_message['metadata']['thread_id']
    assert reply_message['text'] == 'One more thing: the confirmation email never arrives either.'


def test_the_same_text_resent_under_a_new_message_id_is_seen_in_its_thread(aws, ctx):
    first = run(aws, ctx, 'new.eml')
    resent = fixture_bytes('new.eml').replace(b'Message-ID: <', b'Message-ID: <resent-')
    outcome = run(aws, ctx, 'resent-new.eml', raw=resent)
    assert (outcome.status, outcome.reason) == ('deduped', 'seen_in_thread')
    assert [m['id'] for m in queued(aws)] == [first.item_id]


def test_repeated_new_text_in_a_thread_bumps_a_counter(aws, ctx):
    run(aws, ctx, 'new.eml')
    raw = fixture_bytes('reply_headers.eml')
    run(aws, ctx, 'reply_headers.eml')
    resent = raw.replace(b'reply-002@', b'reply-002-again@')
    outcome = run(aws, ctx, 'resent.eml', raw=resent)
    assert (outcome.status, outcome.reason) == ('deduped', 'seen_in_thread')


def test_gmail_forward_is_authored_by_the_customer(aws, ctx):
    outcome = run(aws, ctx, 'forward_gmail.eml')
    [message] = queued(aws)
    assert outcome.status == 'accepted'
    assert message['metadata']['forwarded'] is True
    assert message['text'].startswith('The delivery tracking page shows my parcel in the wrong city.')
    assert 'FYI' not in message['text']
    assert 'Thanks' not in message['text']


def test_the_same_original_forwarded_twice_is_one_item_with_two_forwarder_domains(aws, ctx):
    first = run(aws, ctx, 'forward_gmail.eml')
    second = run(aws, ctx, 'forward_outlook.eml')
    assert (second.status, second.reason, second.item_id) == ('deduped', 'forward_duplicate', first.item_id)
    [row] = [item for item in aws['watermarks'].scan()['Items'] if item['source'].startswith('email_intake#forward#')]
    assert row['forwarded_by'] == {'company.example', 'company-eu.example'}
    assert row['forwards'] == 2


def test_forward_as_attached_eml_reads_the_nested_customer_message(aws, ctx):
    run(aws, ctx, 'forward_attached_eml.eml')
    [message] = queued(aws)
    assert message['text'] == 'Please add a dark mode to the dashboard, my eyes hurt at night.'
    assert message['dimensions'] == {'feedback_type': 'feature_request'}  # ideas@


def test_attachments_are_summarised_once_and_logos_invites_archives_are_skipped(aws, ctx, models):
    run(aws, ctx, 'attachment.eml')
    [message] = queued(aws)
    models.summarise_attachments.assert_called_once()
    readable = models.summarise_attachments.call_args.args[2]
    assert [item.filename for item in readable] == ['invoice-2026-03.pdf', 'screenshot.png']
    assert 'Attachments:\n- invoice-2026-03.pdf: summary of invoice-2026-03.pdf' in message['text']
    assert 'logo.png' not in message['text']
    assert 'logs.zip' not in message['text']
    assert message['metadata']['attachment_count'] == 2
    assert message['metadata']['attachments_key'].startswith('inbound-raw/em_')
    assert message['dimensions'] == {'feedback_type': 'bug'}  # the [bug] subject tag


@pytest.mark.parametrize(('fixture', 'reason'), [
    ('auto_reply.eml', 'auto_reply'), ('bulk.eml', 'bulk'), ('spam_fail.eml', 'spam'),
])
def test_guards_drop_without_queueing(aws, ctx, fixture, reason):
    outcome = run(aws, ctx, fixture)
    assert (outcome.status, outcome.reason) == ('dropped', reason)
    assert queued(aws) == []
    assert _stats(aws)[f'dropped_{reason}'] == 1


def _from(address: str, spf: str = 'PASS', dkim: str = 'GRAY') -> bytes:
    """new.eml from ``address`` with its own Message-ID and the given SPF / DKIM verdicts."""
    local = address.partition('@')[0]
    return (fixture_bytes('new.eml')
            .replace(b'X-SES-SPF-Verdict: PASS', f'X-SES-SPF-Verdict: {spf}'.encode())
            .replace(b'X-SES-DKIM-Verdict: GRAY', f'X-SES-DKIM-Verdict: {dkim}'.encode())
            .replace(b'ana@customer.example', address.encode())
            .replace(b'root-001@', f'root-{local}@'.encode()))


def test_the_per_sender_cap_drops_the_next_email(aws, ctx):
    _set_caps(aws, sender_daily_cap=1)
    run(aws, ctx, 'new.eml')
    outcome = run(aws, ctx, 'other.eml', raw=fixture_bytes('new.eml').replace(b'root-001@', b'root-099@'))
    assert (outcome.status, outcome.reason) == ('dropped', 'sender_cap')


def test_unauthenticated_senders_share_one_cap_per_domain(aws, ctx):
    _set_caps(aws, sender_daily_cap=1)
    first = run(aws, ctx, 'a.eml', raw=_from('a@rotating.example', spf='FAIL'))
    second = run(aws, ctx, 'b.eml', raw=_from('b@rotating.example', spf='GRAY'))
    assert (first.status, second.status, second.reason) == ('accepted', 'dropped', 'sender_cap')


@pytest.mark.parametrize(('spf', 'dkim'), [('PASS', 'GRAY'), ('FAIL', 'PASS')])
def test_an_authenticated_sender_has_a_cap_of_its_own(aws, ctx, spf, dkim):
    _set_caps(aws, sender_daily_cap=1)
    first = run(aws, ctx, 'a.eml', raw=_from('a@company.example', spf=spf, dkim=dkim))
    second = run(aws, ctx, 'b.eml', raw=_from('b@company.example', spf=spf, dkim=dkim))
    assert (first.status, second.status) == ('accepted', 'accepted')


def test_the_daily_cap_defers_instead_of_dropping(aws, ctx):
    _set_caps(aws, daily_cap=1)
    run(aws, ctx, 'new.eml')
    with pytest.raises(DailyCapError):
        run(aws, ctx, 'forward_gmail.eml')
    assert len(queued(aws)) == 1
    assert not any(key.startswith('dropped_') for key in _stats(aws))


def test_an_email_over_the_raw_limit_is_dropped_unread(ctx):
    outcome = intake.process_email(b'x' * (intake.MAX_RAW_BYTES + 1), 'inbound/big', ctx)
    assert (outcome.status, outcome.reason) == ('dropped', 'too_large')


@pytest.mark.parametrize('error', [RecursionError, MemoryError])
def test_a_hostile_structure_is_dropped_as_unparseable(aws, ctx, error):
    with patch.object(mime, 'parse_email', side_effect=error):
        outcome = run(aws, ctx, 'new.eml')
    assert (outcome.status, outcome.reason) == ('dropped', 'unparseable')
    assert _stats(aws)['dropped_unparseable'] == 1


def test_a_spent_model_budget_defers_instead_of_dropping(aws, ctx):
    _set_caps(aws, daily_model_calls=0)
    with pytest.raises(BudgetSpentError):
        run(aws, ctx, 'attachment.eml')
    assert queued(aws) == []

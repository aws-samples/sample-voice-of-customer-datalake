"""The github_issues ingestor against scripted GitHub responses: incremental fetch,
ETag, pagination, rate limits, time budget, watermark commit-after-send."""
import json
from unittest.mock import MagicMock, patch

import pytest
from github_fixtures import API, ISSUES_PATH, REPO, FakeGitHub, FakeResponse, comment, issue, ok
from github_ingestor_fixtures import WATERMARK_KEY, WatermarkTable, ingestor_with, run_listing, sent_items

AT_BOUNDARY = {"since": "2026-01-03T00:00:00Z", "boundary": [2]}


class TestIncrementalFetch:
    def test_first_run_lists_everything_oldest_change_first_and_commits_the_watermark(self):
        ingestor, github, watermarks, result = run_listing(
            ok([issue(1, "2026-01-02T00:00:00Z"), issue(2, "2026-01-03T00:00:00Z")]))

        assert result["status"] == "success"
        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#1", "acme/Kiro#2"]
        params = github.calls[0].params
        assert params == {"state": "all", "sort": "updated", "direction": "asc", "per_page": 100}
        assert watermarks.state()["since"] == "2026-01-03T00:00:00Z"
        assert watermarks.state()["boundary"] == [2]

    def test_next_run_asks_since_the_watermark_and_skips_the_boundary_issue(self):
        ingestor, github, _, _ = run_listing(
            ok([issue(2, "2026-01-03T00:00:00Z"), issue(3, "2026-01-04T00:00:00Z")]), AT_BOUNDARY)

        params = github.calls[0].params
        assert params is not None
        assert params["since"] == "2026-01-03T00:00:00Z"
        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#3"]

    def test_an_issue_sharing_the_boundary_instant_is_not_skipped(self):
        ingestor, _, watermarks, _ = run_listing(
            ok([issue(2, "2026-01-03T00:00:00Z"), issue(5, "2026-01-03T00:00:00Z")]), AT_BOUNDARY)

        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#5"]
        assert watermarks.state()["boundary"] == [2, 5]

    def test_pull_requests_are_skipped_but_advance_the_watermark(self):
        ingestor, _, watermarks, _ = run_listing(ok([issue(1), issue(4, "2026-02-01T00:00:00Z", pull_request={})]))

        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#1"]
        assert watermarks.state()["since"] == "2026-02-01T00:00:00Z"

    def test_label_filter_admits_any_configured_label(self):
        github = FakeGitHub({ISSUES_PATH: [ok([issue(1), issue(2, labels=[{"name": "question"}])])]})
        with ingestor_with(github, WatermarkTable(), labels="question, feedback") as ingestor:
            ingestor.run()

        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#2"]

    def test_comments_are_fetched_since_the_watermark_as_separate_items(self):
        comments_path = f"/repos/{REPO}/issues/1/comments"
        github = FakeGitHub({
            ISSUES_PATH: [ok([issue(1, "2026-01-05T00:00:00Z", comments=2)])],
            comments_path: [ok([comment(10, 1), comment(11, 1, user={"login": "bot", "type": "Bot"})])],
        })
        watermarks = WatermarkTable({WATERMARK_KEY: json.dumps({"since": "2026-01-01T00:00:00Z", "boundary": []})})
        with ingestor_with(github, watermarks) as ingestor:
            ingestor.run()

        sent = sent_items(ingestor)
        assert [i["id"] for i in sent] == ["acme/Kiro#1", "acme/Kiro#1/comment-10"]
        assert sent[1]["issue_attributes"]["parent_id"] == "acme/Kiro#1"
        assert github.calls[1].params == {"per_page": 100, "since": "2026-01-01T00:00:00Z"}

    def test_follows_link_header_pagination(self):
        page2 = f"{API}{ISSUES_PATH}?page=2"
        github = FakeGitHub({ISSUES_PATH: [ok([issue(1)], next_url=page2), ok([issue(2, "2026-01-09T00:00:00Z")])]})
        with ingestor_with(github, WatermarkTable()) as ingestor:
            ingestor.run()

        assert [call.url for call in github.calls] == [f"{API}{ISSUES_PATH}", page2]
        assert github.calls[1].params is None  # the next link already carries the query
        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#1", "acme/Kiro#2"]


class TestETag:
    def test_an_unmoved_watermark_stores_the_listing_etag(self):
        ingestor, _, watermarks, _ = run_listing(ok([issue(2, "2026-01-03T00:00:00Z")], etag='W/"abc"'), AT_BOUNDARY)

        assert sent_items(ingestor) == []
        assert watermarks.state()["etag"] == 'W/"abc"'

    def test_the_stored_etag_is_sent_and_a_304_ends_the_repo(self):
        state = {**AT_BOUNDARY, "etag": 'W/"abc"'}
        _, github, watermarks, result = run_listing(FakeResponse(304, None, {"X-RateLimit-Remaining": "4000"}), state)

        assert github.calls[0].headers["If-None-Match"] == 'W/"abc"'
        assert result["status"] == "success"
        assert watermarks.state() == state

    def test_a_moved_watermark_drops_the_stale_etag(self):
        _, _, watermarks, _ = run_listing(
            ok([issue(3, "2026-01-04T00:00:00Z")], etag='W/"new"'), {**AT_BOUNDARY, "etag": 'W/"abc"'})

        assert watermarks.state()["etag"] is None
        assert watermarks.state()["since"] == "2026-01-04T00:00:00Z"


class TestStoppingEarly:
    def test_a_rate_limit_stops_the_run_successfully_and_keeps_progress(self):
        page2 = f"{API}{ISSUES_PATH}?page=2"
        github = FakeGitHub({ISSUES_PATH: [
            ok([issue(1, "2026-01-02T00:00:00Z")], next_url=page2),
            FakeResponse(403, {"message": "rate limited"}, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "99"}),
        ]})
        watermarks = WatermarkTable()
        with ingestor_with(github, watermarks) as ingestor:
            result = ingestor.run()

        assert result["status"] == "success"
        assert result["stopped_early"] == "rate_limited"
        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#1"]
        assert watermarks.state()["since"] == "2026-01-02T00:00:00Z"
        ingestor.circuit_breaker.record_failure.assert_not_called()

    def test_retry_after_is_honoured_by_stopping_not_sleeping(self):
        github = FakeGitHub({ISSUES_PATH: [FakeResponse(429, {}, {"Retry-After": "60"})]})
        with patch("time.sleep") as sleep, ingestor_with(github, WatermarkTable()) as ingestor:
            result = ingestor.run()

        assert result["stopped_early"] == "rate_limited"
        sleep.assert_not_called()

    def test_a_quota_near_its_floor_stops_before_the_next_request(self):
        page2 = f"{API}{ISSUES_PATH}?page=2"
        github = FakeGitHub({ISSUES_PATH: [ok([issue(1)], next_url=page2, remaining=3)]})
        with ingestor_with(github, WatermarkTable()) as ingestor:
            result = ingestor.run()

        assert len(github.calls) == 1
        assert result["stopped_early"] == "rate_limited"

    def test_a_spent_lambda_budget_stops_before_any_request(self):
        github = FakeGitHub({})
        with ingestor_with(github, WatermarkTable(), deadline=0.0) as ingestor:
            result = ingestor.run()

        assert github.calls == []
        assert result["stopped_early"] == "time_budget"

    def test_a_stop_mid_comments_does_not_advance_past_that_issue(self):
        github = FakeGitHub({
            ISSUES_PATH: [ok([issue(1, "2026-01-02T00:00:00Z"), issue(2, "2026-01-03T00:00:00Z", comments=1)])],
            f"/repos/{REPO}/issues/2/comments": [FakeResponse(429, {}, {"Retry-After": "1"})],
        })
        watermarks = WatermarkTable()
        with ingestor_with(github, watermarks) as ingestor:
            ingestor.run()

        # Issue 2 was yielded, but its comments were not read: it is re-listed next run.
        assert watermarks.state()["since"] == "2026-01-02T00:00:00Z"


class TestFailures:
    def test_a_missing_repo_is_skipped_and_the_others_still_run(self):
        github = FakeGitHub({
            "/repos/acme/gone/issues": [FakeResponse(404, {"message": "Not Found"})],
            ISSUES_PATH: [ok([issue(1)])],
        })
        with ingestor_with(github, WatermarkTable(), repos=f"acme/gone\n{REPO}") as ingestor:
            result = ingestor.run()

        assert result["status"] == "success"
        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#1"]

    def test_a_rejected_token_fails_the_run_without_naming_the_token(self):
        github = FakeGitHub({ISSUES_PATH: [FakeResponse(401, {"message": "Bad credentials"})]})
        watermarks = WatermarkTable()
        with ingestor_with(github, watermarks) as ingestor, pytest.raises(Exception, match="401") as raised:
            ingestor.run()

        assert "ghp_secret_token" not in str(raised.value)
        ingestor.circuit_breaker.record_failure.assert_called_once()
        assert watermarks.values == {}

    def test_watermarks_are_not_committed_when_the_send_fails(self):
        github = FakeGitHub({ISSUES_PATH: [ok([issue(1)])]})
        watermarks = WatermarkTable()
        with ingestor_with(github, watermarks) as ingestor:
            ingestor.sqs.send_message_batch.side_effect = RuntimeError("sqs down")
            with pytest.raises(RuntimeError):
                ingestor.run()

        assert WATERMARK_KEY not in watermarks.values

    def test_nothing_is_fetched_without_a_token(self):
        github = FakeGitHub({})
        with ingestor_with(github, WatermarkTable(), token="") as ingestor:
            result = ingestor.run()

        assert github.calls == []
        assert result == {"status": "success", "items_processed": 0}


def test_the_token_is_sent_only_as_a_bearer_header():
    github = FakeGitHub({ISSUES_PATH: [ok([])]})
    with ingestor_with(github, WatermarkTable()) as ingestor:
        ingestor.run()

    call = github.calls[0]
    assert call.headers["Authorization"] == "Bearer ghp_secret_token"
    assert "ghp_secret_token" not in call.url
    assert "ghp_secret_token" not in json.dumps(call.params)


def test_the_raw_github_payload_is_archived_and_not_enqueued():
    github = FakeGitHub({ISSUES_PATH: [ok([issue(1)])]})
    with patch("_shared.base_ingestor.RAW_DATA_BUCKET", "raw-bucket"), \
            ingestor_with(github, WatermarkTable()) as ingestor:
        ingestor.run()

    put = ingestor.s3.put_object.call_args.kwargs
    assert put["Key"].startswith("raw/test_source/2026/01/01/")
    archived = json.loads(put["Body"])
    assert json.loads(archived["raw_content"])["number"] == 1
    sent = sent_items(ingestor)[0]
    assert sent["s3_raw_uri"].startswith("s3://raw-bucket/raw/test_source/")
    assert "_github_payload" not in json.dumps(sent)


def test_the_item_cap_ends_the_run():
    from github_issues.ingestor import handler

    github = FakeGitHub({ISSUES_PATH: [ok([issue(n, f"2026-01-0{n}T00:00:00Z") for n in range(1, 5)])]})
    with patch.object(handler, "MAX_ITEMS_PER_RUN", 2), ingestor_with(github, WatermarkTable()) as ingestor:
        result = ingestor.run()

    assert result["stopped_early"] == "item_cap"
    assert len(sent_items(ingestor)) == 1


def test_the_lambda_deadline_comes_from_the_context():
    from github_issues.ingestor.handler import SAFETY_MARGIN_SECONDS, _deadline_for

    context = MagicMock()
    context.get_remaining_time_in_millis.return_value = 300_000
    with patch("time.monotonic", return_value=1000.0):
        assert _deadline_for(context) == 1000.0 + 300 - SAFETY_MARGIN_SECONDS
    assert _deadline_for(object()) is None


class TestVolumeFilters:
    """created_after and exclude_associations bound what a large repository costs."""

    def test_a_first_run_with_a_start_date_lists_from_that_day(self):
        github = FakeGitHub({ISSUES_PATH: [ok([])]})
        with ingestor_with(github, WatermarkTable(), created_after="2026-03-01") as ingestor:
            ingestor.run()

        params = github.calls[0].params
        assert params is not None
        assert params["since"] == "2026-03-01T00:00:00Z"

    def test_a_later_watermark_wins_over_the_start_date(self):
        github = FakeGitHub({ISSUES_PATH: [ok([])]})
        watermarks = WatermarkTable({WATERMARK_KEY: json.dumps({"since": "2026-04-02T00:00:00Z", "boundary": []})})
        with ingestor_with(github, watermarks, created_after="2026-03-01") as ingestor:
            ingestor.run()

        params = github.calls[0].params
        assert params is not None
        assert params["since"] == "2026-04-02T00:00:00Z"

    def test_an_old_issue_is_skipped_but_its_new_reply_is_ingested(self):
        github = FakeGitHub({
            ISSUES_PATH: [ok([issue(1, "2026-05-01T00:00:00Z", comments=2, created_at="2025-06-01T00:00:00Z")])],
            f"/repos/{REPO}/issues/1/comments": [ok([
                comment(10, 1, created_at="2025-07-01T00:00:00Z"),
                comment(11, 1, created_at="2026-04-30T00:00:00Z"),
            ])],
        })
        watermarks = WatermarkTable()
        with ingestor_with(github, watermarks, created_after="2026-03-01") as ingestor:
            ingestor.run()

        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#1/comment-11"]
        assert github.calls[1].params == {"per_page": 100, "since": "2026-03-01T00:00:00Z"}
        assert watermarks.state()["since"] == "2026-05-01T00:00:00Z"

    def test_a_maintainers_issue_is_skipped_but_a_customer_reply_is_ingested(self):
        github = FakeGitHub({
            ISSUES_PATH: [ok([issue(1, comments=2, author_association="MEMBER")])],
            f"/repos/{REPO}/issues/1/comments": [ok([
                comment(10, 1, author_association="OWNER"),
                comment(11, 1, author_association="NONE"),
            ])],
        })
        with ingestor_with(github, WatermarkTable(), exclude_associations="OWNER, MEMBER") as ingestor:
            ingestor.run()

        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#1/comment-11"]

    def test_skipped_issues_do_not_count_against_the_item_cap(self):
        from github_issues.ingestor import handler

        github = FakeGitHub({ISSUES_PATH: [ok([
            issue(1, "2026-01-01T00:00:00Z", author_association="MEMBER"),
            issue(2, "2026-01-02T00:00:00Z", author_association="MEMBER"),
            issue(3, "2026-01-03T00:00:00Z"),
        ])]})
        with patch.object(handler, "MAX_ITEMS_PER_RUN", 2), \
                ingestor_with(github, WatermarkTable(), exclude_associations="MEMBER") as ingestor:
            result = ingestor.run()

        assert "stopped_early" not in result
        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#3"]

    def test_a_label_filtered_issue_drops_its_comments_without_fetching_them(self):
        github = FakeGitHub({ISSUES_PATH: [ok([issue(1, comments=5, labels=[{"name": "question"}])])]})
        with ingestor_with(github, WatermarkTable(), labels="bug") as ingestor:
            ingestor.run()

        assert github.paths() == [ISSUES_PATH]
        assert sent_items(ingestor) == []


def test_a_pasted_issues_url_is_ingested_and_a_bad_entry_is_only_reported():
    github = FakeGitHub({ISSUES_PATH: [ok([issue(1)])]})
    with patch("github_issues.ingestor.handler.logger") as log, ingestor_with(
        github, WatermarkTable(), repos=f"https://github.com/{REPO}/issues\ngitlab.com/acme/Kiro",
    ) as ingestor:
        result = ingestor.run()

    assert result["status"] == "success"
    assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#1"]
    warnings = [str(c.args[0]) for c in log.warning.call_args_list]
    assert any("'gitlab.com/acme/Kiro' names no GitHub repository" in w for w in warnings)

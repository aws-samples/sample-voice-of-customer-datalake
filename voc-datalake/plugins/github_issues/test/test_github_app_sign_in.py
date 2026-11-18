"""A deployment-wide run's sign-in with one of the deployment's GitHub Apps (7.45.00): the token function's
``issues_token`` asked with the run's repositories, each repository read with its installation's token, the
uncovered ones skipped, every token revoked at the end; a run in a workspace ignores the App and signs in with its
own token."""
import io
import json
from unittest.mock import MagicMock, patch

import pytest
from github_fixtures import ISSUES_PATH, REPO, FakeGitHub, FakeResponse, issue, ok
from github_ingestor_fixtures import WatermarkTable, ingestor_with

from github_issues.ingestor import handler

APP_ID = "4242"
FUNCTION = "voc-engineering-app-tokens"
APP_TOKEN = "ghs_app_installation_token"
OTHER = "acme/Other"


def tokens_answer(*, uncovered: list[str] | None = None) -> dict:
    return {"tokens": [{"repositories": [REPO], "token": APP_TOKEN, "expires_at": "2026-11-16T11:00:00Z"}],
            "uncovered": uncovered or []}


@pytest.fixture
def revoked():
    """The revocations sent (the token of each), each answered 204."""
    sent: list[str] = []

    def delete(url, headers, _timeout):
        assert url == "https://api.github.com/installation/token"
        sent.append(headers["Authorization"].removeprefix("Bearer "))
        return FakeResponse(204)

    with patch("_shared.github_api._http_delete", delete):
        yield sent


def test_a_deployment_wide_run_reads_each_repository_with_its_apps_token_and_revokes_it(monkeypatch, revoked):
    monkeypatch.setenv(handler.APP_TOKENS_FUNCTION_ENV, FUNCTION)
    github = FakeGitHub({ISSUES_PATH: [ok([issue(1)])]})
    with patch.object(handler, "_app_tokens", return_value=tokens_answer(uncovered=[OTHER])) as asked, \
            ingestor_with(github, WatermarkTable(), scope=None, github_app_id=APP_ID, token="",
                          repos=f"{REPO}\n{OTHER}") as ingestor:
        result = ingestor.run()
    asked.assert_called_once_with(FUNCTION, APP_ID, (REPO, OTHER))
    assert [call.headers["Authorization"] for call in github.calls] == [f"Bearer {APP_TOKEN}"]
    assert result["items_processed"] == 1
    assert revoked == [APP_TOKEN]


def test_the_tokens_are_revoked_even_when_the_run_fails(monkeypatch, revoked):
    monkeypatch.setenv(handler.APP_TOKENS_FUNCTION_ENV, FUNCTION)
    github = FakeGitHub({ISSUES_PATH: [FakeResponse(500, {})]})
    with patch.object(handler, "_app_tokens", return_value=tokens_answer()), \
            ingestor_with(github, WatermarkTable(), scope=None, github_app_id=APP_ID) as ingestor, \
            pytest.raises(Exception, match="GitHub 500"):
        ingestor.run()
    assert revoked == [APP_TOKEN]


def test_a_run_in_a_workspace_ignores_the_app_and_signs_in_with_its_token(monkeypatch, revoked):
    monkeypatch.setenv(handler.APP_TOKENS_FUNCTION_ENV, FUNCTION)
    github = FakeGitHub({ISSUES_PATH: [ok([])]})
    with patch.object(handler, "_app_tokens", side_effect=AssertionError("asked")) as asked, \
            ingestor_with(github, WatermarkTable(), github_app_id=APP_ID) as ingestor:
        ingestor.run()
    asked.assert_not_called()
    assert [call.headers["Authorization"] for call in github.calls] == ["Bearer ghp_secret_token"]
    assert revoked == []


@pytest.mark.usefixtures("revoked")
@pytest.mark.parametrize("app_id", ["none", "", "0123", "12ab"])
def test_anything_but_an_apps_id_is_the_token(monkeypatch, app_id):
    monkeypatch.setenv(handler.APP_TOKENS_FUNCTION_ENV, FUNCTION)
    github = FakeGitHub({ISSUES_PATH: [ok([])]})
    with patch.object(handler, "_app_tokens", side_effect=AssertionError("asked")), \
            ingestor_with(github, WatermarkTable(), scope=None, github_app_id=app_id) as ingestor:
        ingestor.run()
    assert [call.headers["Authorization"] for call in github.calls] == ["Bearer ghp_secret_token"]


@pytest.mark.parametrize("environment", [{}, {handler.APP_TOKENS_FUNCTION_ENV: FUNCTION}])
def test_without_the_token_function_or_its_answer_nothing_is_fetched(monkeypatch, revoked, environment):
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    github = FakeGitHub({})
    with patch.object(handler, "_app_tokens", return_value=None), \
            ingestor_with(github, WatermarkTable(), scope=None, github_app_id=APP_ID) as ingestor:
        result = ingestor.run()
    assert (github.calls, result["items_processed"], revoked) == ([], 0, [])


def lambda_client(payload: object, function_error: str | None = None) -> MagicMock:
    client = MagicMock()
    answer: dict[str, object] = {"Payload": io.BytesIO(json.dumps(payload).encode())}
    if function_error:
        answer["FunctionError"] = function_error
    client.invoke.return_value = answer
    return client


def test_the_token_function_is_asked_for_issues_tokens_for_the_runs_repositories():
    client = lambda_client(tokens_answer())
    with patch.object(handler, "_lambda_client", return_value=client):
        assert handler._app_tokens(FUNCTION, APP_ID, (REPO, OTHER)) == tokens_answer()
    kwargs = client.invoke.call_args.kwargs
    assert (kwargs["FunctionName"], kwargs["InvocationType"], json.loads(kwargs["Payload"])) == (
        FUNCTION, "RequestResponse", {"action": "issues_token", "app_id": APP_ID, "repositories": [REPO, OTHER]})


def test_its_refusal_is_no_tokens_and_logs_its_kind_only(caplog):
    client = lambda_client({"errorType": "AppKeyUnavailable", "errorMessage": "the App's key is not stored"}, "Unhandled")
    with patch.object(handler, "_lambda_client", return_value=client):
        assert handler._app_tokens(FUNCTION, APP_ID, (REPO,)) is None
    assert "AppKeyUnavailable" in caplog.text


@pytest.mark.usefixtures("revoked")
def test_no_app_token_reaches_a_log(monkeypatch, caplog):
    monkeypatch.setenv(handler.APP_TOKENS_FUNCTION_ENV, FUNCTION)
    github = FakeGitHub({ISSUES_PATH: [ok([issue(1)])]})
    with patch.object(handler, "_app_tokens", return_value=tokens_answer(uncovered=[OTHER])), \
            ingestor_with(github, WatermarkTable(), scope=None, github_app_id=APP_ID) as ingestor:
        ingestor.run()
    assert "not covered by the GitHub App" in caplog.text
    assert APP_TOKEN not in caplog.text

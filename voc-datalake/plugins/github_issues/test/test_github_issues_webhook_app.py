"""The github_issues webhook's GitHub App path (7.45.00): a delivery whose headers name the source's App is checked
against that App's own webhook secret (read from SSM), and only that one; the headers choose the secret, never admit a
delivery: a forged one is the bad signature's 401, and a secret that cannot be read refuses it too."""
import json
from unittest.mock import MagicMock, patch

import pytest
from github_fixtures import REPO, issue
from test_github_issues_webhook import SECRET, call, enqueued, github_webhook, sign

from _shared.test.webhook_fixtures import webhook_event
from github_issues.webhook import handler

APP_ID = "4242"
APP_SECRET = "the-apps-own-webhook-secret"
PREFIX = "/voc/engineering/_github-app/"


class FakeSsm:
    """SSM's GetParameter over ``values`` (name -> value); any other name is a ParameterNotFound."""

    def __init__(self, values: dict[str, str]):
        self.values = values
        self.read: list[str] = []

    def get_parameter(self, Name, WithDecryption):
        assert WithDecryption is True
        self.read.append(Name)
        if Name not in self.values:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "ParameterNotFound"}}, "GetParameter")
        return {"Parameter": {"Value": self.values[Name]}}


@pytest.fixture
def ssm(monkeypatch):
    monkeypatch.setenv(handler.APP_PARAMETER_PREFIX_ENV, PREFIX)
    fake = FakeSsm({f"{PREFIX}{APP_ID}/webhook": json.dumps({"webhook_secret": APP_SECRET})})
    with patch.object(handler, "get_ssm_client", return_value=fake), patch.dict(handler._APP_SECRETS, clear=True):
        yield fake


def app_delivery(*, secret: str = APP_SECRET, target_type: str = "integration", target_id: str = APP_ID) -> dict:
    raw = json.dumps({"action": "opened", "issue": issue(7), "repository": {"full_name": REPO}}).encode()
    headers = {"X-GitHub-Event": "issues", "x-hub-signature-256": sign(raw, secret),
               "X-GitHub-Hook-Installation-Target-Type": target_type, "X-GitHub-Hook-Installation-Target-ID": target_id}
    return webhook_event(body=raw.decode(), headers=headers)


def test_the_apps_delivery_signed_with_its_own_secret_is_accepted(ssm):
    with github_webhook(github_app_id=APP_ID) as (webhook, sqs, _, _audit):
        status, body = call(webhook, app_delivery())
    assert (status, body["items_processed"]) == (200, 1)
    assert enqueued(sqs)[0]["id"] == "acme/Kiro#7"
    assert ssm.read == [f"{PREFIX}{APP_ID}/webhook"]


@pytest.mark.usefixtures("ssm")
def test_a_forged_app_header_with_the_repository_secrets_signature_is_401():
    with github_webhook(github_app_id=APP_ID) as (webhook, sqs, _, audit):
        status, body = call(webhook, app_delivery(secret=SECRET))
    assert (status, body) == (401, {"error": "Invalid signature"})
    sqs.send_message_batch.assert_not_called()
    assert audit.call_args.args[3]["reason"] == "bad_signature"


@pytest.mark.parametrize("headers", [{"target_id": "9999"}, {"target_type": "repository"}])
def test_a_delivery_naming_no_app_or_another_is_checked_against_the_repository_secret(ssm, headers):
    with github_webhook(github_app_id=APP_ID) as (webhook, _sqs, _, _audit):
        signed_by_app = call(webhook, app_delivery(**headers))[0]
        signed_by_repository = call(webhook, app_delivery(secret=SECRET, **headers))[0]
    assert (signed_by_app, signed_by_repository) == (401, 200)
    assert ssm.read == []


@pytest.mark.parametrize("stored", [{}, {f"{PREFIX}{APP_ID}/webhook": "not json"},
                                    {f"{PREFIX}{APP_ID}/webhook": json.dumps({"webhook_secret": ""})}])
def test_an_app_secret_that_cannot_be_read_refuses_the_delivery_never_falls_back(ssm, stored):
    ssm.values = stored
    with github_webhook(github_app_id=APP_ID) as (webhook, sqs, _, _audit):
        statuses = [call(webhook, app_delivery())[0], call(webhook, app_delivery(secret=SECRET))[0]]
    assert statuses == [401, 401]
    sqs.send_message_batch.assert_not_called()


def test_without_the_apps_parameters_named_the_app_path_refuses(ssm, monkeypatch):
    monkeypatch.delenv(handler.APP_PARAMETER_PREFIX_ENV)
    with github_webhook(github_app_id=APP_ID) as (webhook, _sqs, _, _audit):
        assert call(webhook, app_delivery())[0] == 401
    assert ssm.read == []


@pytest.mark.usefixtures("ssm")
def test_an_app_delivery_needs_no_repository_secret():
    with github_webhook(github_app_id=APP_ID, webhook_secret="") as (webhook, _sqs, _, _audit):
        assert call(webhook, app_delivery())[0] == 200


@pytest.mark.parametrize("app_id", ["", "none"])
def test_a_source_without_an_app_never_takes_the_app_path(ssm, app_id):
    with github_webhook(github_app_id=app_id) as (webhook, _sqs, _, _audit):
        assert call(webhook, app_delivery())[0] == 401
        assert call(webhook, app_delivery(secret=SECRET))[0] == 200
    assert ssm.read == []


def test_the_apps_secret_is_kept_for_a_while_and_never_logged(ssm, caplog):
    with github_webhook(github_app_id=APP_ID) as (webhook, _sqs, _, _audit):
        for _ in range(3):
            assert call(webhook, app_delivery())[0] == 200
    assert ssm.read == [f"{PREFIX}{APP_ID}/webhook"]
    assert APP_SECRET not in caplog.text


def test_on_a_workspaces_route_the_app_path_is_never_taken():
    webhook = handler.GitHubIssuesWebhook.__new__(handler.GitHubIssuesWebhook)
    webhook.on_workspace_route = True
    webhook.config = MagicMock(github_app_id=APP_ID)
    assert webhook._app_delivery(app_delivery()) is None

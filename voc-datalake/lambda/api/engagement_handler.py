"""
Engagement API Lambda (voc-engagement-api): participants and the feedback boards.

Routes (docs/participants.md, docs/feature-requests.md), all in ``shared/`` routers so
the bundle (``api/<handler>.py`` + ``shared/``) carries them:

    /participants/*        shared/participants_routes.py, shared/participants_ask_routes.py
                           (main Cognito authorizer: app users)
    POST /unsubscribe      shared/participants_ask_routes.py (PUBLIC, always 200)
    /feature-requests/boards*  shared/feature_boards_routes.py (BOARD authorizer: app + board pools;
                           included FIRST, so ``boards`` is never read as a request id)
    /feature-requests/*    shared/feature_requests_routes.py (BOARD authorizer)

An event ``{"engagement_job": "send_ask", ...}`` is this Lambda invoking ITSELF to send
an ask's emails in the background (shared/participants_send.py); it is routed before
the resolver.
"""

from typing import Any

from shared import (
    feature_boards_routes,
    feature_requests_routes,
    participant_mailer,
    participants_ask_routes,
    participants_routes,
    participants_send,
)
from shared.api import api_handler, create_api_resolver
from shared.aws import get_dynamodb_resource, get_lambda_client
from shared.warm_init import warm_at_init

app = create_api_resolver()
app.include_router(participants_routes.app)
app.include_router(participants_ask_routes.app)
app.include_router(feature_boards_routes.app)
app.include_router(feature_requests_routes.app)

# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource, get_lambda_client, participant_mailer.get_sesv2_client)


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler: the background send job, else the API."""
    if participants_send.is_send_event(event):
        return participants_send.run(event, context)
    return app.resolve(event, context)

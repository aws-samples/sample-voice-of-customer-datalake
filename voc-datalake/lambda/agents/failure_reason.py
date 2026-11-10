"""What a failed step tells a person, and the run summary that repeats it.

People read the run log, so a step's failure is said in plain words
(``plain_failure``): "The AI's answer could not be read. Try running it again."
— not "review analysis was not valid JSON". The technical reason is kept beside it as the event's ``detail``
(the technical log). ``plain_failure`` maps each known technical reason; an
unknown one reads as a generic "could not finish" sentence, never as the raw text.

The run summary is ``<step> failed. <Plain reason>.`` (``<step> failed: <reason>.``
for a lower-case fragment). The reason is the step's own failure summary — the text the event journal
already records for ``node_failed`` (a ``NodeFailure`` / ``WorkflowError``
message, a route's safe message, or a fixed string; never an exception's
traceback). The run summary repeats it so a failed run says WHY on its own,
not only in the event log. It is one line, bounded, and AWS resource names,
account ids and URLs are masked: the run row is listed to every reader of the
agent, and a summary is not the place for infrastructure detail.
"""
from __future__ import annotations

import re
from collections.abc import Callable

MAX_REASON_CHARS = 240
RERUN = 'It is safe to run it again.'
GENERIC_FAILURE = f'This step could not finish, so the run stopped. {RERUN}'
#: An AI answer that did not parse (wave 4 wording; "not valid JSON" is jargon to the people reading runs).
UNREADABLE_ANSWER = "The AI's answer could not be read. Try running it again."
INTERNAL_FAILURE = f'Something went wrong inside the run, so it stopped. {RERUN}'
WORKFLOW_FAILURE = 'The workflow is not set up correctly, so the run stopped. Open the workflow and check its steps.'
WRONG_DOCUMENT = ('This step is set up with a document type it does not support. '
                  'Open the workflow and pick a PR/FAQ, PRD or prototype.')
VERIFICATION_FAILURE = ('The result of this step could not be checked against the project, '
                        'so the run paused for a person to look at it.')
DOCUMENT_LABELS = {'prfaq': 'PR/FAQ', 'prd': 'PRD', 'prototype': 'prototype', 'research': 'research report'}
_ROUTE_FAILURES = {
    403: 'The agent is not allowed to change the project this step needs, so the run stopped.',
    404: 'The project or document this step needs no longer exists, so the run stopped.',
    409: f'The project changed while this step ran, so the run stopped. {RERUN}',
}
REDACTED = '[redacted]'
_SENSITIVE = re.compile(
    r'arn:aws[\w-]*:\S+'            # an ARN
    r'|https?://\S+'                # a URL (pre-signed links carry credentials)
    r'|\b\d{12}\b',                 # an AWS account id
)


def reason_text(reason: object) -> str:
    """The step's reason as one masked line of at most MAX_REASON_CHARS (``''`` when it has none)."""
    if not isinstance(reason, str):
        return ''
    line = ' '.join(_SENSITIVE.sub(REDACTED, reason).split())
    if len(line) > MAX_REASON_CHARS:
        line = line[:MAX_REASON_CHARS - 1].rstrip() + '…'
    return line.rstrip('.').rstrip()


def failure_summary(step_title: str, reason: object) -> str:
    """``<step> failed. <Reason>.`` for a sentence, ``<step> failed: <reason>.`` for a fragment, else ``<step> failed.``

    A known technical reason (``plain_failure`` maps it) reads as its plain sentence, so a run
    summary never says "was not valid JSON" even when a caller hands over the raw reason.
    """
    text = reason_text(reason)
    if not text:
        return f'{step_title} failed.'
    plain = plain_failure(text)
    if plain != GENERIC_FAILURE:
        text = plain.rstrip('.')
    return f'{step_title} failed. {text}.' if text[:1].isupper() else f'{step_title} failed: {text}.'


def document_label(kind: object) -> str:
    """A document kind as people write it (``prfaq`` → ``PR/FAQ``)."""
    text = str(kind or '')
    return DOCUMENT_LABELS.get(text.lower(), text.replace('_', ' '))


def _nothing_yet(match: re.Match[str]) -> str:
    return (f'There is no {document_label(match.group(1))} to {match.group(2)} yet. '
            'Add a step that creates one earlier in the workflow.')


def _fixed(text: str) -> Callable[[re.Match[str]], str]:
    return lambda _match: text


#: Every technical reason a node raises (``NodeFailure``), first match wins.
_PLAIN: tuple[tuple[re.Pattern[str], Callable[[re.Match[str]], str]], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), say) for pattern, say in (
        # The step is named by the run summary's prefix ("Aggregate failed."); the technical reason stays in `detail`.
        (r'^the (.+) was not valid JSON\Z', _fixed(UNREADABLE_ANSWER)),
        (r'^there is no (\w+) to (.+?) yet\Z', _nothing_yet),
        (r'^the review analysis named no problems', _fixed(
            'The review analysis found no problems backed by reviews, so there was nothing to work on. '
            'Try a longer time range or more categories.')),
        (r'^no project has been chosen', _fixed(
            'No project was chosen before this step. Add a step that picks or creates a project first.')),
        (r'^the route did not start a job', _fixed(f'The project service did not start the work, so the run stopped. {RERUN}')),
        (r'^the job finished without a document|^the duplicate route returned no document', _fixed(
            f'The work finished without a document, so the run stopped. {RERUN}')),
        (r'^the model returned nothing', _fixed(f'The AI model returned an empty answer, so the run stopped. {RERUN}')),
        (r'^the document could not be saved', _fixed(f'The document could not be saved, so the run stopped. {RERUN}')),
        (r'^the project could not be created', _fixed(f'The project could not be created, so the run stopped. {RERUN}')),
        (r'^persona generation finished without personas', _fixed(
            'Persona generation finished without any personas, so the run stopped. Try again with more feedback in scope.')),
        (r'^no personas are available', _fixed(
            'There are no personas to review with. Add a step that generates or selects personas first.')),
        (r'^no persona returned a usable verdict', _fixed(
            f'None of the personas gave a usable review, so the run stopped. {RERUN}')),
        (r'needs a different target_project_id', _fixed(
            'Copying a document needs a different target project. Open the workflow and pick another project.')),
        (r'^unsupported document type|unknown document kind|^revise_document can revise|target must be', _fixed(
            WRONG_DOCUMENT)),
        (r'^agents and plans write a', _fixed(
            'The person this agent writes for does not work AI-driven, so agents may not write a PR/FAQ or PRD '
            'for them. An administrator can change that in Administration, Privacy & access, Users.')),
        (r'^the \w+ job failed', _fixed(f'The background work for this step failed, so the run stopped. {RERUN}')),
        (r'not executed by the node Lambda|^poll without a pending job|^agent or run not found|^run is not running',
         _fixed(INTERNAL_FAILURE)),
    )
)


def plain_failure(detail: object) -> str:
    """The plain-language sentence a person reads for a node's technical failure reason."""
    text = ' '.join(detail.split()) if isinstance(detail, str) else ''
    for pattern, say in _PLAIN:
        match = pattern.search(text)
        if match:
            return say(match)
    return GENERIC_FAILURE


def plain_route_failure(status_code: int) -> str:
    """What a person reads when a project route refused the step (the HTTP detail goes to ``detail``)."""
    return _ROUTE_FAILURES.get(status_code, f'A project service refused this step, so the run stopped. {RERUN}')

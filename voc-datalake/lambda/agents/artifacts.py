"""Read a run artifact's text for reviewers (persona panel, final review).

Visibility is always decided by the projects route first: the document must be
listed in ``POST /projects/{id}/chat-context`` as the agent. Text documents come
back from that same call; a prototype's HTML is then read from its S3 key
(``shared.prototypes.prototype_s3_key``) and reduced to its visible text plus
structure hints, which is what a persona can react to.
"""
from __future__ import annotations

import os
from html.parser import HTMLParser

from agents import principal
from agents.fields import dict_field
from shared.aws import get_s3_client
from shared.prototypes import prototype_s3_key

MAX_ARTIFACT_CHARS = 30000
_SKIPPED_TAGS = frozenset({'script', 'style', 'noscript', 'svg'})
_BLOCK_TAGS = frozenset({'h1', 'h2', 'h3', 'h4', 'button', 'a', 'label', 'li', 'p', 'section',
                         'nav', 'header', 'footer', 'form', 'input', 'div'})


class ArtifactUnavailable(Exception):
    """The artifact is missing, not visible to the agent, or unreadable."""


class _VisibleText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIPPED_TAGS:
            self._skip += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append('\n')
            if tag in ('button', 'input'):
                label = dict(attrs).get('placeholder') or dict(attrs).get('aria-label') or ''
                self.parts.append(f'[{tag}] {label}'.strip())

    def handle_endtag(self, tag):
        if tag in _SKIPPED_TAGS and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip and data.strip():
            self.parts.append(data.strip())


def visible_text(html: str) -> str:
    parser = _VisibleText()
    parser.feed(html)
    lines = [' '.join(line.split()) for line in ' '.join(parser.parts).split('\n')]
    return '\n'.join(line for line in lines if line)[:MAX_ARTIFACT_CHARS]


def _listed(context: dict, document_id: str) -> dict | None:
    for document in context.get('documents') or []:
        if isinstance(document, dict) and document.get('document_id') == document_id:
            return document
    return None


def load_text(project_id: str, document_id: str, claims: dict[str, str]) -> tuple[str, str]:
    """``(document_type, text)`` for one document the agent can view."""
    context = principal.chat_context(project_id, claims, [document_id])
    document = _listed(context, document_id)
    if document is None:
        raise ArtifactUnavailable('document not found in the project')
    document_type = str(document.get('document_type') or '')
    sk = str(document.get('sk'))
    if document_type == 'prototype' or sk.startswith('PROTOTYPE#'):
        bucket = os.environ.get('RAW_DATA_BUCKET', '')
        try:
            body = get_s3_client().get_object(Bucket=bucket, Key=prototype_s3_key(project_id, document_id))['Body']
            return 'prototype', visible_text(body.read().decode('utf-8', errors='replace'))
        except Exception as exc:
            raise ArtifactUnavailable('prototype HTML could not be read') from exc
    content = document.get('content')
    if not isinstance(content, str) or not content.strip():
        raise ArtifactUnavailable('document has no content')
    return document_type or 'document', content[:MAX_ARTIFACT_CHARS]


def personas_of(project_id: str, claims: dict[str, str]) -> tuple[str, list[dict]]:
    """``(project_name, personas)`` the agent can view in ``project_id``."""
    context = principal.chat_context(project_id, claims, [])
    project = dict_field(context, 'project')
    personas = [p for p in context.get('personas') or [] if isinstance(p, dict) and p.get('persona_id')]
    return str(project.get('name') or 'research project'), personas

"""The ONE vision call of a live-website capture: up to three labelled screenshots plus the measured facts.

The capture worker (``lambda/design_capture/page_shots.py``) photographs the page above the fold, its
header region and its footer region. All of them go into ONE Converse call on the utility surface
(``design_references.DESIGN_SYSTEM_PROMPT``, the same JSON answer as every reference), each image
preceded by a text block naming it, then the measured facts and page text fenced as ``<reference>``
DATA. The measured components still win over the model's afterwards (``shared.component_overlay``).
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from shared.logging import logger
from shared.prompt_safety import neutralise_tags

#: What each region is, as the prompt names it (the order the worker sends them in).
REGION_LABELS: Final = {
    'fold': 'the page above the fold (the first screen a visitor sees)',
    'header': 'the header region at a higher resolution (logo, navigation, the main call to action)',
    'footer': 'the footer region (secondary links, legal text, the footer colours)',
}
STEP_NAME: Final = 'design_reference_image_summary'
#: Pixels per input token in Anthropic's published image-cost estimate (width * height / 750).
PIXELS_PER_TOKEN: Final = 750


@dataclass(frozen=True)
class PageShot:
    """One screenshot of the page: its region (``REGION_LABELS``), bytes, Converse format and pixel size."""
    region: str
    image: bytes
    image_format: str
    width: int
    height: int

    def estimated_tokens(self) -> int:
        """Anthropic's published estimate for an image the model does not resize: width * height / 750."""
        return round(self.width * self.height / PIXELS_PER_TOKEN)


def page_images_content(shots: Sequence[PageShot], facts: str) -> list[dict]:
    """The user turn: the intro naming every image, then per image its label and the image, then the facts."""
    names = '; '.join(f'image {n} is {REGION_LABELS[shot.region]}' for n, shot in enumerate(shots, 1))
    intro = (f'The {len(shots)} screenshot(s) below of the company\'s live website are <reference> DATA: {names}. '
             'Extract its design system from them; where an image and the measured facts disagree, the facts win.')
    content: list[dict] = [{'text': intro}]
    for n, shot in enumerate(shots, 1):
        content.append({'text': f'Image {n}: {REGION_LABELS[shot.region]}.'})
        content.append({'image': {'format': shot.image_format, 'source': {'bytes': shot.image}}})
    if facts:
        content.append({'text': f'<reference>\n{neutralise_tags(facts)}\n</reference>'})
    return content


def summarise_page_images(shots: Sequence[PageShot], facts: str) -> str:
    """The model's raw answer to ONE Converse call carrying every shot (production collaborator)."""
    from shared.aws import get_bedrock_client
    from shared.converse import converse_blocks
    from shared.design_references import DESIGN_MAX_TOKENS, DESIGN_SYSTEM_PROMPT

    logger.info('Design capture vision call', extra={
        'images': [shot.region for shot in shots], 'estimated_image_tokens': sum(s.estimated_tokens() for s in shots)})
    response = converse_blocks(
        get_bedrock_client(), page_images_content(shots, facts), surface='utility',
        system_prompt=DESIGN_SYSTEM_PROMPT, max_tokens=DESIGN_MAX_TOKENS, max_retries=2,
        step_name=STEP_NAME, call_label='client.converse(page images)',
    )
    content_out = response.get('output', {}).get('message', {}).get('content', [])
    return ''.join(b.get('text', '') for b in content_out if isinstance(b, dict))

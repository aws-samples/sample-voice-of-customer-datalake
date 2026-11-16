"""One target's read as the run row reports it, and an ``auto`` target's cascade of steps (docs/web-reviews.md →
Methods, Learning which method works).

Every target a run reads gets one entry in the run row's ``reads`` (``read_row``): the method it is set to, the step
that read it (``method_used``: ``browser``, ``bedrock_web_search``, ``agentcore_web_search``, or None when none did),
the reviews the run sent for it, each step tried with its outcome (``StepReport``: ``readable``, ``blocked`` with
its vendor, ``no_reviews``, ``error``, ``skipped_time`` when the Lambda had too little time left for it,
``not_offered`` when AgentCore Web Search is not in the region), and for ``auto`` the plan the learned record gave
(``known``, ``reprobe``, ``cascade``) with the best method it knew and when it was learned. The card turns that
into "Browser blocked by Cloudflare → read via Bedrock web index (11 reviews)".
"""
from dataclasses import dataclass, field
from typing import Final

from web_items import WebTarget

from shared.web_review_methods import (
    BLOCKED_PREFIX,
    NO_REVIEWS,
    READABLE,
    STEP_AGENTCORE_WEB_SEARCH,
    STEP_BEDROCK_WEB_SEARCH,
    STEP_BROWSER,
    STEP_ERROR,
    Attempt,
    MethodRecord,
    Plan,
)

#: A step's outcome on the run row (``StepReport.outcome``): the record's three, a block, and the two skips.
BLOCKED: Final = 'blocked'
SKIPPED_TIME: Final = 'skipped_time'
NOT_OFFERED: Final = 'not_offered'
#: Characters of a step's detail kept on the run row.
MAX_DETAIL_CHARS: Final = 120
#: Entries one run row keeps at most (one per target read).
MAX_RUN_READS: Final = 50
#: How the run's errors name each step.
STEP_LABELS: Final = {STEP_BROWSER: 'the browser', STEP_BEDROCK_WEB_SEARCH: 'Amazon Bedrock web search',
                      STEP_AGENTCORE_WEB_SEARCH: 'AgentCore web search'}


@dataclass(frozen=True)
class StepReport:
    """One step of a target's read: what it got (``outcome``), the reviews it sent, the vendor of a block."""

    method: str
    outcome: str
    reviews: int = 0
    vendor: str | None = None
    detail: str | None = None

    def row(self) -> dict[str, object]:
        row: dict[str, object] = {'method': self.method, 'outcome': self.outcome, 'reviews': self.reviews}
        if self.vendor:
            row['vendor'] = self.vendor
        if self.detail:
            row['detail'] = self.detail[:MAX_DETAIL_CHARS]
        return row

    def attempt(self) -> Attempt | None:
        """What the learned record keeps of it; None for a step that did not run (skipped, not offered)."""
        if self.outcome == BLOCKED:
            return Attempt(self.method, f'{BLOCKED_PREFIX}{self.vendor or "unknown"}', self.reviews)
        if self.outcome in (READABLE, NO_REVIEWS, STEP_ERROR):
            return Attempt(self.method, self.outcome, self.reviews)
        return None

    def said(self) -> str:
        """The step in the run's errors: ``the browser: blocked by Cloudflare``."""
        label = STEP_LABELS.get(self.method, self.method)
        if self.outcome == BLOCKED:
            return f'{label}: blocked by {self.vendor}'
        if self.outcome == NO_REVIEWS:
            return f'{label}: no reviews'
        if self.outcome == SKIPPED_TIME:
            return f'{label}: skipped, the run ran out of time'
        if self.outcome == NOT_OFFERED:
            return f'{label}: not offered in this region'
        return f'{label}: {self.detail or "failed"}'


@dataclass
class Cascade:
    """An ``auto`` target's read: its plan, the steps run so far, the step that read it."""

    target: WebTarget
    domain: str
    plan: Plan
    record: MethodRecord | None
    steps: list[StepReport] = field(default_factory=list)
    used: str | None = None
    #: The first page's title as the browser read it (the AgentCore Web Search query's subject), when it did.
    title: str = ''
    #: Set when a step ends the cascade with nothing to fall back on (a redirect off the site).
    stopped: bool = False

    def next_step(self) -> str | None:
        """The plan's next step not run yet, or None when the cascade is over."""
        if self.used is not None or self.stopped:
            return None
        ran = {step.method for step in self.steps}
        return next((step for step in self.plan.order if step not in ran), None)

    def add(self, step: StepReport) -> None:
        self.steps.append(step)
        if step.outcome == READABLE:
            self.used = step.method

    def attempts(self) -> list[Attempt]:
        return [attempt for step in self.steps if (attempt := step.attempt()) is not None]

    def failure(self) -> str:
        """The run's error for a cascade that read nothing: ``<target>: no method read it (…)``."""
        return f'{self.target.name}: no method read it ({"; ".join(step.said() for step in self.steps) or "none ran"})'


def read_row(target: WebTarget, steps: list[StepReport], sent: int, cascade: Cascade | None = None) -> dict[str, object]:
    """The run row's entry of one target's read (the module docstring)."""
    used = next((step.method for step in steps if step.outcome == READABLE), None)
    row: dict[str, object] = {
        'target': target.name, 'target_id': target.id, 'method': target.method, 'method_used': used,
        'reviews': sent, 'steps': [step.row() for step in steps],
        'excerpt': used == STEP_AGENTCORE_WEB_SEARCH,
        'plan': cascade.plan.kind if cascade else None,
        'known_method': cascade.plan.known_method if cascade else None,
        'learned_at': cascade.plan.learned_at if cascade else None,
    }
    return row

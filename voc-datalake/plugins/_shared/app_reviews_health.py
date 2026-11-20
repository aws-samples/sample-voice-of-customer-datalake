"""Run health of the app-review ingestors: which storefronts failed, and why.

A storefront (an App Store country, a Google Play locale) that answers an error is
otherwise indistinguishable from one with no reviews: the run "completes" with 0
items. These helpers make that visible in the places an admin can read without AWS
access — Administration → System → Logs (WARNING lines) and the source's run row
(``errors``):

* ``StorefrontFetch`` — one storefront's reviews plus the short cause it failed with;
* ``StorefrontTally`` — per app: storefronts with reviews / empty / failed (by cause),
  an INFO summary line, a WARNING when any failed, and the run-row text;
* ``check_review_drop`` — a WARNING when an app that had reviews last run gets none
  from any storefront now (watermark ``<app>_last_count``).

Logged text names the app, its store id, countries and causes (HTTP status or
exception type) — never a URL, a review or a reviewer.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from _shared.base_ingestor import logger

# The status AppStoreError carries ("iTunes API request failed with status 403").
_STATUS = re.compile(r"\bstatus (\d{3})\b")
# Countries named per cause in a log line (the rest are counted, not listed).
MAX_COUNTRIES_LISTED = 10
# The run-row text is shown in the Data sources page; kept short.
MAX_RUN_ERROR_CHARS = 200


def failure_cause(error: BaseException) -> str:
    """A short, URL-free cause: ``HTTP 403`` for a status, else the exception type
    (with the urllib3 ``reason`` type when it has one, e.g. ``MaxRetryError(ConnectTimeoutError)``)."""
    match = _STATUS.search(str(error))
    if match:
        return f"HTTP {match.group(1)}"
    reason = getattr(error, "reason", None)
    if isinstance(reason, BaseException):
        return f"{type(error).__name__}({type(reason).__name__})"
    return type(error).__name__


def _country_list(countries: list[str]) -> str:
    """``gb, us`` — sorted, at most ``MAX_COUNTRIES_LISTED`` named, the rest counted."""
    listed = ", ".join(sorted(countries)[:MAX_COUNTRIES_LISTED])
    more = len(countries) - MAX_COUNTRIES_LISTED
    return f"{listed}, +{more} more" if more > 0 else listed


@dataclass
class StorefrontFetch:
    """One storefront's answer: its reviews, and the cause when it failed."""

    reviews: list[dict]
    failure: str | None = None


@dataclass
class StorefrontTally:
    """What every storefront of one app answered during one run."""

    platform_label: str
    app_name: str
    app_identifier: str
    with_reviews: int = 0
    empty: int = 0
    reviews: int = 0
    failures: dict[str, list[str]] = field(default_factory=dict)

    @property
    def failed(self) -> int:
        return sum(len(countries) for countries in self.failures.values())

    def record(self, country: str, fetch: StorefrontFetch) -> None:
        if fetch.failure:
            self.failures.setdefault(fetch.failure, []).append(country)
        elif fetch.reviews:
            self.with_reviews += 1
        else:
            self.empty += 1
        self.reviews += len(fetch.reviews)

    def _causes(self, *, with_countries: bool) -> str:
        """``HTTP 403 x2 (gb, us); MaxRetryError x1 (kr)`` — most frequent cause first."""
        ordered = sorted(self.failures.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        return "; ".join(
            f"{cause} x{len(countries)}" + (f" ({_country_list(countries)})" if with_countries else "")
            for cause, countries in ordered
        )

    def report(self) -> str | None:
        """Log the summary (INFO, plus a WARNING when storefronts failed); the run-row
        text for a failed storefront, else None."""
        label = f"{self.platform_label} {self.app_name} ({self.app_identifier})"
        summary = {
            "app": self.app_name,
            "app_identifier": self.app_identifier,
            "storefronts_with_reviews": self.with_reviews,
            "storefronts_empty": self.empty,
            "storefronts_failed": self.failed,
            "reviews": self.reviews,
        }
        logger.info(
            f"{label}: {self.with_reviews} storefronts with reviews, {self.empty} empty, "
            f"{self.failed} failed, {self.reviews} reviews",
            extra={"storefront_summary": summary},
        )
        if not self.failed:
            return None
        logger.warning(
            f"{label}: {self.failed} of {self.failed + self.with_reviews + self.empty} storefronts failed "
            f"- {self._causes(with_countries=True)}",
            extra={"storefront_summary": summary, "storefront_failures": self.failures},
        )
        noun = "storefront" if self.failed == 1 else "storefronts"
        text = f"{self.app_name}: {self.failed} {noun} failed ({self._causes(with_countries=False)})"
        return text[:MAX_RUN_ERROR_CHARS]


def check_review_drop(
    get_watermark_fn: Callable[[str], str | None],
    set_watermark_fn: Callable[[str, str], None],
    *,
    platform_label: str,
    app_name: str,
    candidates: int,
) -> str | None:
    """Warn when an app that had reviews last run gets none at all now.

    Compares this run's candidate count (reviews fetched from every storefront, before
    the watermark filter) with the previous run's ``<app>_last_count``, then stores it.
    Returns the run-row text when it warned.
    """
    key = f"{app_name}_last_count"
    previous_raw = get_watermark_fn(key)
    set_watermark_fn(key, str(candidates))
    try:
        previous = int(previous_raw) if previous_raw else 0
    except ValueError:
        previous = 0
    if candidates or previous <= 0:
        return None
    logger.warning(
        f"{platform_label} {app_name}: no reviews from any storefront "
        f"(the previous run fetched {previous}). The store may be blocking or failing "
        "requests, or the app id changed",
        extra={"app": app_name, "previous_count": previous},
    )
    return f"{app_name}: no reviews from any storefront (previous run: {previous})"

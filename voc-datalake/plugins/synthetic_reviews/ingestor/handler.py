"""
Synthetic Data Review Generator - Ingestor

Generates realistic synthetic customer reviews with Amazon Bedrock (Claude Sonnet)
from operator-provided company/product/customer context, then ingests them through
the standard processing pipeline tagged as synthetic data:
  - source_platform = "synthetic_reviews" (its own filterable source)
  - metadata.is_synthetic = true (plus generator/focus_area for traceability)

This plugin is on-demand only (no EventBridge schedule). It is triggered from the
dashboard ("Synthetic Data" in the Add Data Source modal) or via
POST /sources/synthetic_reviews/run, which async-invokes this Lambda.

Configuration (company, product, focus areas, count, sentiment, language) is stored
per-plugin in Secrets Manager and loaded via BaseIngestor secrets isolation.
"""

import json
import os
import random
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from typing import Generator

# Add shared module path (mirrors plugin template); _shared/shared resolve as
# top-level packages in the bundled Lambda and via conftest in tests.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics
from shared.converse import converse

# Generation limits (kept conservative to stay within the Lambda timeout/token budget)
MAX_REVIEWS = 50
DEFAULT_REVIEWS = 10
BATCH_SIZE = 10
MAX_FOCUS_AREAS = 12
GENERATION_WINDOW_DAYS = 90

SENTIMENT_GUIDANCE = {
    "balanced": "a realistic balanced mix (roughly 55% positive, 25% neutral, 20% negative)",
    "mostly_positive": "mostly positive (about 80% positive) with a few critical reviews",
    "mostly_negative": "mostly negative (about 70% negative) reflecting customers facing problems",
    "mixed": "highly polarized — a mix of very positive and very negative reviews",
}

SYSTEM_PROMPT = (
    "You are a data generation assistant that produces realistic, diverse synthetic "
    "customer reviews for software/product testing and analytics. "
    "Never use real people's names or real personal data; invent plausible but "
    "fictional reviewer first names with a last initial. "
    "Return ONLY a valid JSON array with no markdown fences or commentary."
)


class SyntheticReviewsIngestor(BaseIngestor):
    """Generates synthetic customer reviews via Bedrock and ingests them as synthetic data."""

    def __init__(self):
        super().__init__()
        self.company_name = (self.secrets.get("company_name") or "").strip()
        self.product_name = (self.secrets.get("product_name") or "").strip()
        self.product_description = (self.secrets.get("product_description") or "").strip()
        self.target_customer = (self.secrets.get("target_customer") or "").strip()
        self.focus_areas = self._parse_focus_areas(self.secrets.get("focus_areas") or "")
        self.num_reviews = self._parse_count(self.secrets.get("num_reviews"))
        self.sentiment_mix = (self.secrets.get("sentiment_mix") or "balanced").strip() or "balanced"
        self.language = (self.secrets.get("language") or "en").strip() or "en"

    @staticmethod
    def _parse_count(raw) -> int:
        """Parse and clamp the requested review count to [1, MAX_REVIEWS]."""
        try:
            value = int(str(raw).strip())
        except (TypeError, ValueError):
            return DEFAULT_REVIEWS
        return max(1, min(value, MAX_REVIEWS))

    @staticmethod
    def _parse_focus_areas(raw: str) -> list[str]:
        """Split a comma/newline separated string into a trimmed, capped list of areas."""
        parts = re.split(r"[,\n]", raw)
        areas = [p.strip() for p in parts if p.strip()]
        return areas[:MAX_FOCUS_AREAS]

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Generate reviews in batches and yield normalized-ready items."""
        if not self.company_name or not self.product_name:
            logger.warning(
                "Synthetic generator not configured: company_name and product_name are required"
            )
            return

        logger.info(
            f"Generating {self.num_reviews} synthetic reviews for "
            f"'{self.company_name}' / '{self.product_name}' (lang={self.language})"
        )

        remaining = self.num_reviews
        generated = 0
        while remaining > 0:
            batch_n = min(BATCH_SIZE, remaining)
            reviews = self._generate_batch(batch_n)
            if not reviews:
                logger.warning("Batch returned no parseable reviews; stopping early")
                break
            for review in reviews:
                item = self._build_item(review)
                if item is not None:
                    yield item
                    generated += 1
            remaining -= batch_n

        logger.info(f"Synthetic generation produced {generated} reviews")
        metrics.add_metric(name="SyntheticReviewsGenerated", unit="Count", value=generated)

    @tracer.capture_method
    def _generate_batch(self, count: int) -> list[dict]:
        """Call Bedrock to generate a batch of reviews; returns [] on failure."""
        prompt = self._build_prompt(count)
        try:
            response_text = converse(
                prompt=prompt,
                system_prompt=SYSTEM_PROMPT,
                max_tokens=4096,
                temperature=0.9,
                step_name="synthetic_reviews",
            )
        except Exception as e:
            logger.exception(f"Bedrock generation failed: {e}")
            return []
        return self._parse_reviews(response_text)

    def _build_prompt(self, count: int) -> str:
        sentiment = SENTIMENT_GUIDANCE.get(self.sentiment_mix, SENTIMENT_GUIDANCE["balanced"])
        areas = ", ".join(self.focus_areas) if self.focus_areas else "general product experience"

        context_lines = [f"Company: {self.company_name}", f"Product: {self.product_name}"]
        if self.product_description:
            context_lines.append(f"Product description: {self.product_description}")
        if self.target_customer:
            context_lines.append(f"Target customer: {self.target_customer}")
        context = "\n".join(context_lines)

        return (
            f"Generate {count} realistic, distinct customer reviews written in language code "
            f"'{self.language}'.\n\n"
            f"{context}\n\n"
            f"Spread the reviews across these areas/topics: {areas}.\n"
            f"Sentiment distribution: {sentiment}.\n\n"
            "Make each review specific and varied in length, tone, and detail. "
            "Ratings must align with sentiment (1-2 = negative, 3 = neutral/mixed, 4-5 = positive).\n\n"
            "Return ONLY a JSON array. Each element must be an object with keys: "
            '"text" (2-5 sentences), "rating" (integer 1-5), "title" (short string), '
            '"author" (fictional first name + last initial), '
            '"focus_area" (one of the listed areas).'
        )

    @staticmethod
    def _parse_reviews(response_text: str) -> list[dict]:
        """Extract and parse the JSON array of reviews from the model response."""
        match = re.search(r"\[[\s\S]*\]", response_text)
        if not match:
            logger.warning("No JSON array found in synthetic reviews response")
            return []
        try:
            data = json.loads(match.group())
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse synthetic reviews JSON: {e}")
            return []
        if not isinstance(data, list):
            return []
        return [r for r in data if isinstance(r, dict) and r.get("text")]

    def _build_item(self, review: dict) -> dict | None:
        """Convert a raw model review object into an ingestor item dict."""
        text = str(review.get("text", "")).strip()
        if not text:
            return None

        focus_area = str(review.get("focus_area", "") or "").strip() or "general"
        author = str(review.get("author", "") or "").strip() or None
        title = str(review.get("title", "") or "").strip() or None

        return {
            "id": f"synthetic-{uuid.uuid4().hex}",
            "text": text[:50000],
            "rating": self._coerce_rating(review.get("rating")),
            "created_at": self._random_created_at(),
            "channel": "review",
            "author": author,
            "title": title,
            "language": self.language,
            "metadata": {
                "is_synthetic": True,
                "generator": "synthetic_reviews",
                "generator_model": "claude-sonnet-4-5",
                "focus_area": focus_area,
            },
        }

    @staticmethod
    def _coerce_rating(raw) -> float | None:
        """Coerce a rating into a 1-5 float, or None if not parseable."""
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None
        return float(max(1, min(5, round(value))))

    @staticmethod
    def _random_created_at() -> str:
        """Spread synthetic reviews over a recent window (non-cryptographic jitter)."""
        now = datetime.now(timezone.utc)
        offset = timedelta(
            days=random.randint(0, GENERATION_WINDOW_DAYS),  # noqa: S311 - synthetic timestamps, not security-sensitive
            hours=random.randint(0, 23),  # noqa: S311
            minutes=random.randint(0, 59),  # noqa: S311
        )
        return (now - offset).isoformat()

    def normalize_item(self, item: dict, raw_content: str = None) -> dict:
        """Extend base normalization to carry synthetic tagging fields through to SQS.

        author/title/language/metadata are accepted by the IngestMessage schema
        (metadata permits extra primitive keys), so the synthetic markers survive
        validation and reach the raw S3 record and downstream processing.
        """
        normalized = super().normalize_item(item, raw_content)
        for key in ("author", "title", "language", "metadata"):
            value = item.get(key)
            if value is not None:
                normalized[key] = value
        return normalized


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point. Honors execution_id from the manual-run payload for status tracking."""
    ingestor = SyntheticReviewsIngestor()
    if isinstance(event, dict) and event.get("execution_id"):
        ingestor.execution_id = event["execution_id"]
    return ingestor.run()

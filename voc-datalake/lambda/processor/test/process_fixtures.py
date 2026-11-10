"""Run ``processor.handler.process_feedback`` with no AWS call: the enrichment model answers ``llm``."""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

from processor import handler


def process_with_model(record: dict, llm: dict, categories: list[dict]) -> Any:
    """``process_feedback(record)`` with Comprehend, Translate, the duplicate check and Bedrock stubbed."""
    with patch.object(handler, 'check_duplicate', return_value=False), \
         patch.object(handler, 'detect_language', return_value='en'), \
         patch.object(handler, 'translate_text', side_effect=lambda text, *_: text), \
         patch.object(handler, 'get_comprehend_sentiment', return_value={'label': 'neutral', 'score': 0.0}), \
         patch.object(handler, 'invoke_bedrock_llm', return_value=llm), \
         patch.object(handler, 'get_categories_config', return_value=categories):
        return handler.process_feedback(record)

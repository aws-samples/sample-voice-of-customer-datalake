"""Fixtures shared by the Radar news scan tests."""
from unittest.mock import patch

import pytest

from jobs.radar_scan import extract, scan


@pytest.fixture
def no_model():
    """The extractor answers nothing, and nothing is stored."""
    with patch.object(extract, 'converse', return_value='{"releases": []}') as model, \
         patch.object(scan, 'embed_text', return_value=[1.0]), patch.object(scan, 'store_candidate', return_value='added'):
        yield model

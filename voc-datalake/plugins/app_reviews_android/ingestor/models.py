"""
App configuration model for Android App Reviews plugin.
"""

from dataclasses import dataclass


@dataclass
class AndroidAppConfig:
    """Configuration for a single Android app to collect reviews from."""
    name: str
    package_name: str
    enabled: bool = True
    max_reviews_per_run: int = 500
    # Google Play filters reviews by language: lang="en" only returns
    # English-written reviews. For a Korean app you MUST set lang="ko" or you
    # get a tiny English subset. Empty/None = use the ingestor's country sweep.
    lang: str = ""
    country: str = ""

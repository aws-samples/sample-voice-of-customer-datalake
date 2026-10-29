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
    # The app connector's own schedule in minutes (0 = manual only); None = the
    # plugin's top-level frequency_minutes.
    frequency_minutes: int | None = None
    # The app connector's own sort order; "" = the plugin's top-level sort_by.
    sort_by: str = ""
    # The Radar brand key its reviews go to (docs/radar.md); empty for one of our own apps.
    radar_brand: str = ""

"""
App configuration validation for Android App Reviews plugin.
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

    @classmethod
    def from_dict(cls, data: dict) -> "AndroidAppConfig":
        """Create from dictionary, with validation."""
        name = data.get("name", "").strip()
        if not name:
            raise ValueError("App config missing required field: name")

        package_name = data.get("package_name", "").strip()
        if not package_name:
            raise ValueError(f"App '{name}' missing required field: package_name")

        return cls(
            name=name,
            package_name=package_name,
            enabled=data.get("enabled", True),
            max_reviews_per_run=int(data.get("max_reviews_per_run", 500)),
            lang=str(data.get("lang", "") or "").strip(),
            country=str(data.get("country", "") or "").strip(),
        )

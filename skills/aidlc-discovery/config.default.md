# AIDLC: Discovery Workshop Configuration

## Data Sources

```yaml
# Path to folder containing VoC feedback data (JSON, CSV, Excel, text)
data_folder: ""

# Path to folder containing market research documents (PDF, DOCX, Excel)
research_folder: ""

# Amazon Quick Space name for indexed feedback (Quick only; alternative to local folder)
space_name: "voc-data-lake"
```

## Output Settings

```yaml
# Where to save generated artifacts (default: project-scoped knowledge-base folder)
output_folder: "knowledge-base/projects/"

# Document format for generated reports
doc_format: "markdown"  # markdown | docx
```

## Analysis Settings

```yaml
# Default time window for feedback analysis (days)
default_days: 30

# Maximum feedback items to include in LLM context
max_context_items: 50

# Default number of personas to generate
default_persona_count: 3

# Default categories (comma-separated, or "auto" for AI detection)
categories: "auto"
```

## Survey Settings

```yaml
# Default survey theme
survey_theme:
  primary_color: "#3B82F6"
  background_color: "#FFFFFF"
  text_color: "#1F2937"
  border_radius: "8px"

# Default rating type: stars | nps | emoji | scale
default_rating_type: "stars"
```

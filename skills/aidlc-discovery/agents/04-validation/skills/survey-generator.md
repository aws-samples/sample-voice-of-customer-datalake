# Survey Generator—Skill

## Purpose

Create validation surveys as an **embeddable HTML form** and/or a **structured question list**, with each question mapped to a testable hypothesis.

> This skill absorbs the former `survey-builder` skill: it produces both a self-contained HTML form with iframe embed code and a copy-paste question list for external form tools. Choose the output option that fits how the survey will be distributed.

**Hosting and data-collection limitation:** The assistant previews the generated form but does not publish the HTML or host a submission backend. To embed the form on another site, publish the HTML at a web-accessible URL and connect your own submission endpoint. For managed data collection, copy the questions into Microsoft Forms, Google Forms, or another survey platform using output option 2.

## Available Survey Types

### 1. Star Rating

```text
1  2  3  4  5
"How do you rate [Feature/Product]?"
Scale: 1-5 (configurable up to 10)
```

### 2. NPS (Net Promoter Score)

```text
0  1  2  3  4  5  6  7  8  9  10
"How likely are you to recommend [X] to others?"
Detractors (0-6) | Passives (7-8) | Promoters (9-10)
```

### 3. Likert Scale

```text
Strongly Disagree | Disagree | Neutral | Agree | Strongly Agree
"The feature solves my problem effectively."
```

### 4. Multiple Choice

```text
Option A
Option B
Option C
Other: ___
```

### 5. Multi-Select

```text
[ ] Feature A
[ ] Feature B
[ ] Feature C
```

### 6. Ranking or Prioritization

```text
Rank by importance (1 = most important):
[ ] Speed
[ ] Reliability
[ ] Price
[ ] Support
```

### 7. Matrix or Grid

```text
              | Very Important | Important | Neutral | Unimportant |
Feature A     |        o       |     o     |    o    |      o      |
Feature B     |        o       |     o     |    o    |      o      |
```

### 8. A/B Preference

```text
Which solution do you prefer?
[Screenshot A] versus [Screenshot B]
Solution A | Solution B | No difference
Why? ___
```

### 9. Free Text

```text
"What do you miss the most about [Product]?"
[_________________________________]
```

## Prompt Template

### System Prompt

```text
You create validation surveys for Product Discovery Workshops.
Each question must be mapped to a testable hypothesis.
Keep surveys short (5-10 questions maximum); respondents have limited time.
Mix question types for better insights.
Surveys must be clear, mobile-friendly, and branded with the provided theme colors.
```

### User Prompt Template

```text
Create a validation survey for:

HYPOTHESIS/HYPOTHESES: {hypotheses}
FEATURE/PROTOTYPE: {feature_description}
TARGET AUDIENCE: {target_audience}

Generate:
1. Survey with 5-10 questions (mix of Rating, Likert, MC, Free Text)
2. Each question with hypothesis mapping, and which questions are required vs optional
3. A completion or thank-you message
4. HTML preview (standalone, styled)
5. Copy-paste question list for Microsoft Forms

Format for each question:
- Question text
- Type (rating, nps, likert, multiple_choice, multi_select, ranking, matrix, ab_preference, open_text, or yes_no)
- Options (when applicable)
- Required or optional
- Hypothesis being tested
- Expected result if hypothesis is correct
```

### Intermediate Survey Configuration

The model may first emit the survey as JSON, then render it to HTML. Keep the hypothesis mapping and validation criterion in the structured form:

```json
{
  "title": "Survey title",
  "description": "Brief intro text",
  "questions": [
    {
      "id": "q1",
      "type": "rating",
      "text": "How valuable is this feature?",
      "required": true,
      "options": [],
      "scale_max": 5,
      "placeholder": "",
      "hypothesis_id": "H1",
      "expected_result": "At least 60% select 4 or 5"
    }
  ],
  "completion_message": "Thank you for your feedback!",
  "theme": {
    "primary_color": "#3B82F6",
    "background_color": "#FFFFFF",
    "text_color": "#1F2937"
  }
}
```

Allowed `type` values are `rating`, `nps`, `likert`, `multiple_choice`, `multi_select`, `ranking`, `matrix`, `ab_preference`, `open_text`, and `yes_no`. Add type-specific fields such as choices, rows, columns, or scale labels when required.

## Output Options

Choose the output that matches how the survey will be distributed. You can produce both.

### Option 1: Embeddable HTML Form

Build a self-contained, styled HTML form from the JSON configuration using [`../templates/survey-iframe.html`](../templates/survey-iframe.html) as the base template. Inject the questions into it.

Deliverables:

- standalone HTML at `knowledge-base/projects/[name]/validation/survey-[topic].html`;
- iframe embed code for use after the HTML is published; and
- an immediate preview in a Session Tab.

```html
<iframe src="https://example.com/surveys/survey-[topic].html" width="100%" height="600" frameborder="0"></iframe>
```

Publish the HTML at the URL used by the iframe and connect your own endpoint for real submissions, or use output option 2.

### Option 2: External Form Question List

Produce structured Markdown that is ready to copy into Microsoft Forms, Google Forms, or another external survey tool:

```markdown
# Survey: [Title]
Target audience: [Who]
Estimated duration: [X] minutes

## Question 1 (NPS)
**How likely are you to recommend [X] to others?**
Scale: 0-10
Tests hypothesis: [H1]
Validated when: NPS > 30

## Question 2 (Likert)
**[Statement]**
Strongly Disagree to Strongly Agree
Tests hypothesis: [H2]
Validated when: more than 60% Agree or Strongly Agree
```

Save the result to `knowledge-base/projects/[name]/validation/survey-[topic].md`.

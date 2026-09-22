# Feature Description Skill

## Purpose
Generate a structured feature description based on the Working Backwards Document. Propose options, let the user choose, and create the final description.

---

## Flow

### 1. Generate Feature Proposals

Based on the WB Document (Section 3: INVENT), propose 3-5 concrete feature ideas:

```
Based on your Working Backwards Document, I see these feature possibilities:

1. **[Feature A]** — [1-sentence description]
   Addresses: [Which problem from DEFINE]
   
2. **[Feature B]** — [1-sentence description]
   Addresses: [Which problem]

3. **[Feature C]** — [1-sentence description]
   Addresses: [Which problem]

Which feature would you like to explore further? Or do you have your own idea?
```

### 2. Create Feature Description

After the user has chosen, create a structured description:

## Output: Feature Description

```markdown
# Feature: [Name]

## Problem Statement
[1-2 sentences: What customer problem does this feature solve?]

## Solution
[2-3 sentences: How does the feature solve the problem?]

## Target Users
- **Primary:** [Persona/Segment]
- **Secondary:** [Persona/Segment]

## Key Capabilities
1. [Capability 1] — [What it does]
2. [Capability 2] — [What it does]
3. [Capability 3] — [What it does]

## User Stories

### As [Persona A]
- I want to [action], so that [benefit]
- I want to [action], so that [benefit]

### As [Persona B]
- I want to [action], so that [benefit]

## Success Criteria
| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| [Metric 1] | [Target value] | [How measured] |
| [Metric 2] | [Target value] | [How measured] |

## Out of Scope
- [What this feature does NOT do]
- ...

## Assumptions & Risks
| Assumption/Risk | Type | Mitigation |
|-----------------|:----:|------------|
| [Assumption 1] | Assumption | [How to validate] |
| [Risk 1] | Risk | [How to mitigate] |

## Connection to the WB Document
- Listen (Insights): [Which insights support the feature?]
- Define (Problem): [Which problem is being solved?]
- Invent (Solution): [Which capability is being realized?]
```

## Storage Location

`knowledge-base/projects/[project]/ideation/feature-description.md`

## Important

- Feature description is SHORTER than a PRD — it is an intermediate step
- Serves as input for PRFAQ generation
- The user should review the description before proceeding
- Always make proposals with reference back to WB document and signals

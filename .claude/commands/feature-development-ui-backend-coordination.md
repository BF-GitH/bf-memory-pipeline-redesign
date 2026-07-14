---
name: feature-development-ui-backend-coordination
description: Workflow command scaffold for feature-development-ui-backend-coordination in bf-memory-pipeline-redesign.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-development-ui-backend-coordination

Use this workflow when working on **feature-development-ui-backend-coordination** in `bf-memory-pipeline-redesign`.

## Goal

Implements a new feature that requires both backend logic and UI/UX changes, typically involving new settings, panels, or modes.

## Common Files

- `src/settings.js`
- `src/pipeline.js`
- `src/agent-writer.js`
- `src/fact-retrieval.js`
- `templates/settings.html`
- `style.css`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Implement backend logic in src/*.js (e.g., src/settings.js, src/pipeline.js, src/agent-writer.js, src/fact-retrieval.js)
- Update or create UI components/templates in templates/settings.html
- Update or create related CSS in style.css
- Update manifest.json if needed (for versioning or feature flags)
- Document the change in CHANGELOG.md

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.
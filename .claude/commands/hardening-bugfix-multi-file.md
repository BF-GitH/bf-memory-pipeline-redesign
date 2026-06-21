---
name: hardening-bugfix-multi-file
description: Workflow command scaffold for hardening-bugfix-multi-file in bf-memory-pipeline-redesign.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /hardening-bugfix-multi-file

Use this workflow when working on **hardening-bugfix-multi-file** in `bf-memory-pipeline-redesign`.

## Goal

Performs a hardening or bugfix pass that touches multiple related files to address edge cases, review feedback, or security issues.

## Common Files

- `src/agent-writer.js`
- `src/pipeline.js`
- `src/settings.js`
- `src/profiler.js`
- `src/review-popup.js`
- `CHANGELOG.md`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Identify edge cases or bugs from review/testing
- Update logic in relevant backend files (e.g., src/agent-writer.js, src/pipeline.js, src/settings.js, src/profiler.js, src/review-popup.js)
- Update UI logic if needed (e.g., src/review-popup.js, templates/settings.html)
- Update documentation in CHANGELOG.md if significant
- Re-verify end-to-end in the target environment

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.
```markdown
# bf-memory-pipeline-redesign Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to contribute to the `bf-memory-pipeline-redesign` JavaScript codebase. You'll learn the project's coding conventions, how to implement new features that span backend and UI, perform bugfix/hardening passes, and enhance UI panels or popups. The repository is structured without a framework, uses conventional commits, and coordinates changes across JavaScript source files, HTML templates, CSS, and manifest files.

---

## Coding Conventions

- **File Naming:**  
  Use `camelCase` for file names.  
  _Example:_  
  ```
  src/agentWriter.js
  src/factRetrieval.js
  ```

- **Import Style:**  
  Use **relative imports**.  
  _Example:_  
  ```js
  import { getSettings } from './settings.js';
  ```

- **Export Style:**  
  Use **named exports**.  
  _Example:_  
  ```js
  // src/pipeline.js
  export function runPipeline(data) { ... }
  export const PIPELINE_VERSION = '2.0';
  ```

- **Commit Messages:**  
  Use [Conventional Commits](https://www.conventionalcommits.org/):  
  - Prefixes: `feat`, `fix`, `docs`
  - Example:  
    ```
    feat: add new agent writer logic for memory pipeline
    fix: handle edge case in fact retrieval
    docs: update settings documentation
    ```

---

## Workflows

### Feature Development: UI & Backend Coordination

**Trigger:** When adding a new feature that changes both backend behavior and the user interface.  
**Command:** `/new-feature-ui-backend`

1. **Implement backend logic**  
   - Add or update logic in relevant files:  
     - `src/settings.js`
     - `src/pipeline.js`
     - `src/agent-writer.js`
     - `src/fact-retrieval.js`
   - _Example:_  
     ```js
     // src/settings.js
     export function enableNewMode(flag) { ... }
     ```

2. **Update or create UI components/templates**  
   - Edit `templates/settings.html` to add new panels or settings.
   - _Example:_  
     ```html
     <!-- templates/settings.html -->
     <div class="new-mode-panel"> ... </div>
     ```

3. **Update or create related CSS**  
   - Edit `style.css` for new styles.

4. **Update `manifest.json` if needed**  
   - For versioning or feature flags.

5. **Document the change**  
   - Add an entry to `CHANGELOG.md`.

---

### Hardening/Bugfix: Multi-file Pass

**Trigger:** When fixing bugs, addressing edge cases, or hardening the codebase after review or testing.  
**Command:** `/hardening-pass`

1. **Identify edge cases or bugs**  
   - Review code, feedback, or test results.

2. **Update backend logic**  
   - Edit relevant files:  
     - `src/agent-writer.js`
     - `src/pipeline.js`
     - `src/settings.js`
     - `src/profiler.js`
     - `src/review-popup.js`
   - _Example:_  
     ```js
     // src/pipeline.js
     export function runPipeline(data) {
       if (!data) return;
       // handle edge case
     }
     ```

3. **Update UI logic if needed**  
   - Edit `src/review-popup.js` or `templates/settings.html`.

4. **Document significant changes**  
   - Update `CHANGELOG.md`.

5. **Re-verify end-to-end**  
   - Test the changes in the target environment.

---

### UI Panel or Popup Enhancement

**Trigger:** When adding a new UI panel or improving an existing popup for better data visualization or interaction.  
**Command:** `/new-ui-panel`

1. **Implement or update UI logic**  
   - Edit `src/settings.js` or `src/review-popup.js`.

2. **Update templates**  
   - Edit `templates/settings.html` for new panel markup.
   - _Example:_  
     ```html
     <section id="fact-visualizer"> ... </section>
     ```

3. **Add or modify CSS**  
   - Update `style.css` for visual changes.

4. **Update backend logic if needed**  
   - Edit `src/agent-writer.js` or `src/fact-retrieval.js` to support new data.

5. **Document the change**  
   - Add an entry to `CHANGELOG.md`.

---

## Testing Patterns

- **Test File Naming:**  
  Test files follow the pattern `*.test.*`.  
  _Example:_  
  ```
  src/pipeline.test.js
  ```

- **Framework:**  
  The specific testing framework is unknown, but tests are colocated with source files and named accordingly.

- **Test Example:**  
  ```js
  // src/pipeline.test.js
  import { runPipeline } from './pipeline.js';

  test('runPipeline processes data correctly', () => {
    const result = runPipeline({ ... });
    expect(result).toBe(...);
  });
  ```

---

## Commands

| Command                | Purpose                                                         |
|------------------------|-----------------------------------------------------------------|
| /new-feature-ui-backend| Start a new feature involving both backend and UI changes       |
| /hardening-pass        | Begin a multi-file bugfix or hardening pass                    |
| /new-ui-panel          | Add or enhance a UI panel or popup                             |
```

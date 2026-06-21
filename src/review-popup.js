// BF Memory Pipeline - Review Popup
// Every N messages, shows user all new/changed facts for review

const META_KEY = 'bf_mem_review';

function getMeta() {
    try {
        const md = SillyTavern.getContext().chatMetadata || SillyTavern.getContext().chat_metadata;
        if (!md) return null;
        // Shape-check the existing entry — not just falsiness. If it's a non-object
        // (string from a corrupt write, array, primitive) or missing required arrays,
        // reinitialize. Otherwise downstream .push() crashes (T1.13 from suite v3.2).
        const existing = md[META_KEY];
        const isValid = existing
            && typeof existing === 'object'
            && !Array.isArray(existing)
            && Array.isArray(existing.pendingReviewItems)
            && typeof existing.messagesSinceLastReview === 'number';
        // Track whether we mutated metadata so we can persist exactly once before
        // returning. Without persisting, a re-init or fallback drain only lives
        // in-memory: the next getMeta() can re-detect corruption (stale on-disk
        // data) and the drained fallback items are silently lost (H5).
        let mutated = false;
        if (!isValid) {
            md[META_KEY] = { messagesSinceLastReview: 0, pendingReviewItems: [] };
            mutated = true;
        }
        // Drain any fallback state accumulated before chat metadata was available
        // (e.g. during extension boot, before the user opened a chat). Without this,
        // those items would be permanently stranded outside any chat's persistence.
        if (fallbackPending.length > 0) {
            md[META_KEY].pendingReviewItems.push(...fallbackPending);
            fallbackPending = [];
            mutated = true;
        }
        if (fallbackCounter > 0) {
            md[META_KEY].messagesSinceLastReview = (md[META_KEY].messagesSinceLastReview || 0) + fallbackCounter;
            fallbackCounter = 0;
            mutated = true;
        }
        if (mutated) saveMeta();
        return md[META_KEY];
    } catch { return null; }
}

function saveMeta() {
    try { SillyTavern.getContext().saveMetadata?.(); } catch { /* best-effort */ }
}

// In-memory fallback if chat_metadata is unavailable (extension boot, no chat yet)
let fallbackPending = [];
let fallbackCounter = 0;

/**
 * Track a new fact update for eventual review
 */
export function trackUpdate(update) {
    const entry = { ...update, timestamp: Date.now(), reviewed: false };
    const meta = getMeta();
    if (meta) {
        meta.pendingReviewItems.push(entry);
        saveMeta();
    } else {
        fallbackPending.push(entry);
    }
}

/**
 * Increment message counter and check if review is due
 */
export function tickMessageCounter(reviewInterval) {
    const meta = getMeta();
    if (meta) {
        meta.messagesSinceLastReview = (meta.messagesSinceLastReview || 0) + 1;
        saveMeta();
        return meta.messagesSinceLastReview >= reviewInterval && (meta.pendingReviewItems?.length || 0) > 0;
    }
    fallbackCounter++;
    return fallbackCounter >= reviewInterval && fallbackPending.length > 0;
}

/**
 * Reset the message counter (after review is shown)
 */
export function resetCounter() {
    const meta = getMeta();
    if (meta) {
        meta.messagesSinceLastReview = 0;
        saveMeta();
    } else {
        fallbackCounter = 0;
    }
}

/**
 * Get pending items
 */
export function getPendingItems() {
    const meta = getMeta();
    return [...(meta ? meta.pendingReviewItems || [] : fallbackPending)];
}

/**
 * Clear all pending items (after user accepts)
 */
export function clearPendingItems() {
    const meta = getMeta();
    if (meta) {
        meta.pendingReviewItems = [];
        saveMeta();
    } else {
        fallbackPending = [];
    }
}

/**
 * Show the review popup with all pending fact changes
 * @param {Function} onAccept - Callback when user accepts all
 * @param {Function} onEdit - Callback with edited items
 */
export async function showReviewPopup(onAccept, onEdit) {
    const items = getPendingItems();
    if (items.length === 0) return;

    // Render a single item's card (idx = its index in the ORIGINAL items[] so the edit/remove
    // handlers, which key off data-idx, stay correct regardless of display order).
    const itemHtml = (item, idx) => {
        // Contradiction items (atomic #7) are INFORMATIONAL: read-only, both values shown, only
        // a dismiss button — no editable inputs, so they never flow into the upsert path.
        if (item.action === 'conflict') {
            return `
            <div class="bf-mem-review-item bf-mem-conflict" data-idx="${idx}">
                <span class="bf-mem-action-badge bf-mem-badge-conflict">CONFLICT</span>
                <span class="bf-mem-category">${escapeHtml(item.category)}</span>
                <strong>${escapeHtml(item.key)}</strong>
                <div class="bf-mem-conflict-values">${escapeHtml(item.value || '')}</div>
                <span class="bf-mem-known">Resolve in the Database tab; dismiss here when handled.</span>
                <button class="bf-mem-remove-btn" data-idx="${idx}" title="Dismiss this conflict">X</button>
            </div>`;
        }

        const actionClass = item.action === 'delete' ? 'bf-mem-delete' : item.action === 'update' ? 'bf-mem-update' : 'bf-mem-add';
        const actionLabel = item.action === 'delete' ? 'DEL' : item.action === 'update' ? 'UPD' : 'NEW';
        const knownBy = (item.knownBy || []).join(', ') || 'everyone';

        return `
            <div class="bf-mem-review-item ${actionClass}" data-idx="${idx}">
                <span class="bf-mem-action-badge">${actionLabel}</span>
                <span class="bf-mem-category">${escapeHtml(item.category)}</span>
                <input class="bf-mem-key" value="${escapeHtml(item.key)}" data-field="key" data-idx="${idx}" />
                <textarea class="bf-mem-value" data-field="value" data-idx="${idx}" rows="2">${escapeHtml(item.value || '')}</textarea>
                <span class="bf-mem-known">Known by: ${escapeHtml(knownBy)}</span>
                <button class="bf-mem-remove-btn" data-idx="${idx}" title="Remove this update">X</button>
            </div>`;
    };

    // GROUP by action (NEW → UPD → DEL → CONFLICT) with a counted header per group, so a big batch
    // reads as organized sections instead of a flat scroll. We pair each item with its ORIGINAL
    // index first, then sort by group — indices are preserved so handlers stay correct.
    const GROUP_ORDER = { add: 0, update: 1, delete: 2, conflict: 3 };
    const GROUP_LABEL = { add: 'New facts', update: 'Updated facts', delete: 'Deletions', conflict: 'Conflicts' };
    // Bucket into a Map keyed by action so each group's header is emitted EXACTLY once — robust to a
    // non-stable Array.sort and to unknown/future action types (which would otherwise interleave and
    // emit duplicate headers). Group display order follows GROUP_ORDER; unknown actions fall to the
    // end in first-seen order. Each item keeps its ORIGINAL index so edit/remove handlers stay correct.
    const groups = new Map(); // action -> [{item, idx}, ...]
    items.forEach((item, idx) => {
        const a = item.action;
        if (!groups.has(a)) groups.set(a, []);
        groups.get(a).push({ item, idx });
    });
    const orderedActions = [...groups.keys()].sort((a, b) => (GROUP_ORDER[a] ?? 9) - (GROUP_ORDER[b] ?? 9));
    const listHtml = orderedActions.map(action => {
        const recs = groups.get(action);
        const header = `<div class="bf-mem-review-group-header">${escapeHtml(GROUP_LABEL[action] || action)} (${recs.length})</div>`;
        return header + recs.map(({ item, idx }) => itemHtml(item, idx)).join('');
    }).join('');

    const html = `
        <div class="bf-mem-review-popup">
            <h3>Memory Review (${items.length} changes)</h3>
            <p>Review facts extracted from recent messages. Edit or remove before saving.</p>
            <div class="bf-mem-review-list">
                ${listHtml}
            </div>
            <div class="bf-mem-review-actions">
                <button id="bf_mem_accept_all" class="menu_button">Accept All</button>
                <button id="bf_mem_save_edited" class="menu_button">Save Edited</button>
                <button id="bf_mem_dismiss" class="menu_button">Dismiss</button>
            </div>
        </div>`;

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'bf_mem_review_overlay';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);

    return new Promise((resolve) => {
        // Keyboard-aware sizing: track visualViewport so the popup never grows
        // taller than the area NOT covered by the soft keyboard. Without this,
        // max-height:80vh measures the layout viewport (full screen) and the top
        // of the popup gets pushed above the visible area on Android Chrome.
        const popupEl = overlay.querySelector('.bf-mem-review-popup');
        const syncViewport = () => {
            const vv = window.visualViewport;
            const h = vv ? vv.height : window.innerHeight;
            popupEl.style.setProperty('--bf-mem-vv-h', `${Math.max(200, h - 32)}px`);
        };
        syncViewport();
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', syncViewport);
            window.visualViewport.addEventListener('scroll', syncViewport);
        }
        window.addEventListener('orientationchange', syncViewport);

        // Focus + scroll first editable field into view so mobile users see it.
        requestAnimationFrame(() => {
            const first = overlay.querySelector('.bf-mem-key, .bf-mem-value');
            if (first) {
                first.focus({ preventScroll: true });
                first.scrollIntoView({ block: 'center', behavior: 'instant' });
            }
        });

        // Centralized cleanup: remove listeners on every dismiss path.
        const cleanup = () => {
            if (window.visualViewport) {
                window.visualViewport.removeEventListener('resize', syncViewport);
                window.visualViewport.removeEventListener('scroll', syncViewport);
            }
            window.removeEventListener('orientationchange', syncViewport);
            overlay.remove();
        };

        // Backdrop click closes (was previously impossible to dismiss if buttons
        // scrolled off-screen on mobile). Ignore clicks inside the popup.
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                cleanup();
                resetCounter();
                resolve('dismissed');
            }
        });

        // Remove item button
        overlay.addEventListener('click', (e) => {
            if (e.target.classList.contains('bf-mem-remove-btn')) {
                const idx = parseInt(e.target.dataset.idx);
                const item = overlay.querySelector(`.bf-mem-review-item[data-idx="${idx}"]`);
                if (item) item.remove();
            }
        });

        // Accept all
        overlay.querySelector('#bf_mem_accept_all')?.addEventListener('click', () => {
            cleanup();
            clearPendingItems();
            resetCounter();
            onAccept?.();
            resolve('accepted');
        });

        // Save edited
        overlay.querySelector('#bf_mem_save_edited')?.addEventListener('click', () => {
            // Collect edited values
            const editedItems = [];
            overlay.querySelectorAll('.bf-mem-review-item').forEach((el) => {
                const idx = parseInt(el.dataset.idx);
                const original = items[idx];
                if (!original) return;
                if (original.action === 'conflict') return; // informational — never upsert

                const keyInput = el.querySelector('.bf-mem-key');
                const valueInput = el.querySelector('.bf-mem-value');

                editedItems.push({
                    ...original,
                    key: keyInput?.value || original.key,
                    value: valueInput?.value || original.value,
                });
            });

            cleanup();
            clearPendingItems();
            resetCounter();
            onEdit?.(editedItems);
            resolve('edited');
        });

        // Dismiss (keep items for next review)
        overlay.querySelector('#bf_mem_dismiss')?.addEventListener('click', () => {
            cleanup();
            resetCounter();
            resolve('dismissed');
        });
    });
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

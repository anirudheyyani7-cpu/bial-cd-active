/**
 * HIDDEN, NOT UNMOUNTED — one treatment, one definition, with its reason attached.
 *
 * WHY THIS EXISTS. `visibility:hidden`, not `aria-hidden` or zero width alone — the difference
 * is not cosmetic. Zero width plus `overflow:hidden` clips a subtree visually but does NOT
 * remove its descendants from the tab order, so `aria-hidden` alone left a collapsed panel's
 * composer, Send and attach controls keyboard-reachable — a WCAG 4.1.2 violation.
 * `visibility:hidden` drops the whole subtree from BOTH the tab order and the accessibility
 * tree while leaving it MOUNTED — which is the requirement, not an optimisation: hiding a
 * conversation must never unmount one, or its stream aborts and its scroll position is gone
 * the moment something else takes the screen.
 *
 * ITS OWN MODULE, holding a string and a paragraph, for one reason: every alternative home
 * imports a page. The conversation slot applies this treatment and would be the natural home,
 * but the builder surface's chat-panel collapse is its other caller — a page importing the
 * slot that mounts pages is a cycle dragging the whole other chat kind into every one of that
 * page's fifteen test suites. A leaf module is what keeps one definition possible.
 *
 * Callers compose it with their own layout classes; `aria-hidden` beside it is belt-and-braces,
 * not the mechanism.
 */
export const HIDDEN_BUT_MOUNTED = 'invisible'

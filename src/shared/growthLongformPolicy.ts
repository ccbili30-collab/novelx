/**
 * Authoritative minimum for a completed focused-OC personal story.
 *
 * Counted as Unicode code points by the existing Longform progress and
 * Closure evaluators. Keep this policy centralized so model constraints,
 * runtime completion, and acceptance tests cannot drift independently.
 */
export const GROWTH_LONGFORM_MIN_CODE_POINTS = 7_000;

/** Hard safety ceiling for one persisted section; outline maxima are estimates. */
export const GROWTH_LONGFORM_SECTION_HARD_MAX_CODE_POINTS = 20_000;

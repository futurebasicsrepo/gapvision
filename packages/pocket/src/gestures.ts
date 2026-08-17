/**
 * The six verbs, named once.
 *
 * Identical to `meta-lens/src/input.ts` on purpose — same union, same
 * semantics, so `@cue/lens-core`'s deck takes either without knowing whether a
 * Neural Band, a temple strip or a thumb produced it.
 *
 * Kept as its own module rather than imported from the Meta lens because
 * Pocket must not depend on a sibling surface: the day the Meta package is
 * retired or forked, this one keeps working. Shared *semantics* live in
 * lens-core; shared *input plumbing* is two lines and not worth a coupling.
 */
export type LensGesture = "prev" | "next" | "up" | "down" | "select" | "back";

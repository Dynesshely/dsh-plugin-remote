import { computed, ref } from 'vue'

/**
 * Layout mode detection.
 *
 * A viewport breakpoint is not enough: a wide window whose composer toolbar still cannot fit its
 * desktop controls (the telemetry strip gets crushed to a dot) is functionally a phone. So the mode
 * is mobile when EITHER
 *
 *   - the viewport is below the `wide` breakpoint, or
 *   - the composer reported that its toolbar cannot fit the desktop controls.
 *
 * `ComposerBar` learns the desktop controls' natural widths while they are mounted and reports the
 * comparison through {@link reportComposerOverflow}; everything else just reads {@link mobile}.
 */

const WIDE = '(min-width: 44rem)'

const belowWide = ref(typeof window === 'undefined' ? false : !window.matchMedia(WIDE).matches)
const composerOverflow = ref(false)

if (typeof window !== 'undefined') {
  window.matchMedia(WIDE).addEventListener('change', (event) => {
    belowWide.value = !event.matches
  })
}

/** True when the page should use the phone layout: drawer sidebar, icon-only composer controls. */
export const mobile = computed(() => belowWide.value || composerOverflow.value)

/** @returns the viewport half of the decision, for diagnostics. */
export const isBelowWide = computed(() => belowWide.value)

/**
 * Report whether the composer toolbar fits its desktop controls.
 * @param value - true when the row overflows or the telemetry strip is squeezed.
 */
export function reportComposerOverflow (value) {
  if (composerOverflow.value !== value) composerOverflow.value = value
}

<script setup>
/**
 * A brand mark for a model, inlined from @lobehub/icons-static-svg.
 *
 * Rendered as markup rather than an <img>: the artwork is already in the bundle, needs no request, and the
 * monochrome files use `currentColor` so they follow the theme while the `-color` files keep the brand's
 * own palette. The wrapper owns the size, because the source files carry a fixed `1em`.
 */
defineProps({
  /** `{ svg, title }` from `modelMark()`. */
  mark: { type: Object, required: true },
  /** Rendered size in px. */
  size: { type: Number, default: 14 },
})
</script>

<template>
  <span
    class="model-mark inline-flex shrink-0 items-center justify-center"
    :style="{ width: `${String(size)}px`, height: `${String(size)}px` }"
    :title="mark.title"
    role="img"
    :aria-label="mark.title"
    v-html="mark.svg"
  />
</template>

<style scoped>
.model-mark :deep(svg) {
  width: 100%;
  height: 100%;
}
</style>

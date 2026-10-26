<script setup>
/**
 * Self-drawn icon set: every glyph is a stroked 24×24 path, so the UI never needs an icon font,
 * an external request, or a raster asset (the page CSP allows neither).
 */
const PATHS = {
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  moon: ['M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a7.2 7.2 0 1 0 11.1 11.1z'],
  monitor: ['M3 5.5h18v10.5H3z', 'M8.5 20h7M12 16v4'],
  chevron: ['M6 9.5l6 6 6-6'],
  chevronRight: ['M9.5 6l6 6-6 6'],
  check: ['M4.5 12.5l4.5 4.5L19.5 6.5'],
  search: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M20 20l-4.6-4.6'],
  paperclip: ['M20.5 11.6l-8.2 8.2a4.8 4.8 0 0 1-6.8-6.8l8.4-8.4a3.2 3.2 0 0 1 4.6 4.6l-8.4 8.4a1.6 1.6 0 0 1-2.3-2.3l7.6-7.6'],
  send: ['M4.5 12.2 20 4.2l-4.6 15.6-3-6.1z', 'M12.4 13.7 20 4.2'],
  stop: ['M7.5 7.5h9v9h-9z'],
  refresh: ['M20 12a8 8 0 1 1-2.6-5.9', 'M20 4.5V9h-4.5'],
  menu: ['M4 7h16M4 12h16M4 17h16'],
  close: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
  brain: ['M12 3.5l1.7 4 4 1.7-4 1.7-1.7 4-1.7-4-4-1.7 4-1.7z', 'M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z'],
  wrench: ['M14.7 3.6a5 5 0 0 0-6.5 6.5L3.4 14.9V19h4.1l4.8-4.8a5 5 0 0 0 6.5-6.5l-2.9 2.9-2.6-2.6z'],
  shield: ['M12 3.2l7 2.8v5.6c0 4.3-2.9 7.5-7 9-4.1-1.5-7-4.7-7-9V6z', 'M9.2 12.2l2 2 3.6-3.8'],
  cpu: ['M7.5 7.5h9v9h-9z', 'M4 10h3.5M4 14h3.5M16.5 10H20M16.5 14H20M10 4v3.5M14 4v3.5M10 16.5V20M14 16.5V20'],
  dot: ['M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  layers: ['M12 3.5l8 4-8 4-8-4z', 'M4 12.5l8 4 8-4', 'M4 16.5l8 4 8-4'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5V12l3 2'],
  spark: ['M12 3v3.2M12 17.8V21M3 12h3.2M17.8 12H21M5.6 5.6l2.3 2.3M16.1 16.1l2.3 2.3M5.6 18.4l2.3-2.3M16.1 7.9l2.3-2.3'],
  gear: ['M4 7.5h8M17 7.5h3', 'M4 16.5h3M11 16.5h9', 'M14 5.4a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2z', 'M9 14.4a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2z'],
  info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 10.8V17', 'M12 7.4v.5'],
  pencil: ['M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z', 'M13.5 6.5l3 3'],
  help: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M9.6 9.4a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.8-.9 1.4v.5', 'M12 16.6v.4'],
  pin: ['M12 4.2a3.6 3.6 0 0 0-3.6 3.6c0 2.4 3.6 7.4 3.6 7.4s3.6-5 3.6-7.4A3.6 3.6 0 0 0 12 4.2z', 'M12 15.2V20'],
  fork: ['M7 3.6v9.4', 'M7 9h6a4 4 0 0 1 4 4v1.4', 'M7 3.6a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8z', 'M17 14.6a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8z', 'M7 16.6a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8z'],
  more: ['M7 12h.4', 'M12 12h.4', 'M17 12h.4'],
  sidebar: ['M3.5 5.5h17v13h-17z', 'M14.5 5.5v13'],
  folder: ['M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v8A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z'],
  file: ['M6.5 3.5h7L18.5 8v12.5h-12z', 'M13 3.5V8h5.5'],
  download: ['M12 4v10', 'M8 10.5l4 4 4-4', 'M4.5 19.5h15'],
  copy: ['M9 9h10v11H9z', 'M5 15V4h10'],
  cut: ['M6.5 4.5l11 13', 'M6.5 17.5l11-13', 'M5.5 20a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 0 0-3.2 0z', 'M15.3 20a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 0 0-3.2 0z'],
  power: ['M12 4v7', 'M7.5 6.6a7 7 0 1 0 9 0'],
  restart: ['M20 12a8 8 0 1 1-2.3-5.6', 'M20 4v4h-4'],
  // Model families. Abstract marks rather than the real logos: recognisable by shape, and nobody's
  // trademark ends up in an open-source repository.
  modelOpenai: ['M12 4.5a7.5 7.5 0 1 1-6.4 3.6', 'M12 8.4a3.6 3.6 0 1 1-3.1 1.8'],
  modelAnthropic: ['M6.5 19l5.5-13 5.5 13', 'M9.2 14.2h5.6'],
  modelGoogle: ['M12 3.6l2.1 6.3 6.3 2.1-6.3 2.1L12 20.4l-2.1-6.3L3.6 12l6.3-2.1z'],
  modelMeta: ['M4 15.4c1.6-6 4.6-9 8-9s6.4 3 8 9', 'M8 15.4h8'],
  modelDeepseek: ['M3.6 13.4c3-6 6.4-8 8.4-8s5.4 2 8.4 8', 'M9 16.6c1.6 1.5 4.4 1.5 6 0'],
  modelQwen: ['M12 3.6l7 3.9v8.9l-7 3.9-7-3.9V7.5z', 'M12 8.6v6.8'],
  modelGrok: ['M5 5l14 14', 'M19 5L5 19'],
  modelMistral: ['M4 18l4-10 4 6 4-6 4 10'],
  plus: ['M12 5v14', 'M5 12h14'],
}

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
  width: { type: [Number, String], default: 1.7 },
})

/** @returns the path list for the requested glyph. */
function paths () {
  return PATHS[props.name] ?? []
}
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="width"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
  >
    <path v-for="(d, index) in paths()" :key="index" :d="d" />
  </svg>
</template>

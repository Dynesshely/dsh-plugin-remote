<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'

/**
 * Self-drawn combobox: a glass trigger plus a listbox teleported to `<body>`.
 *
 * The list is teleported so its own `backdrop-blur` really samples the page behind it — nested
 * inside an already-frosted panel a child backdrop-filter cannot blur through the parent — and so
 * no ancestor can clip it.
 */
const model = defineModel({ type: String, default: '' })

const props = defineProps({
  /** Options: `{ value, name, description?, icon? }`. */
  items: { type: Array, default: () => [] },
  placeholder: { type: String, default: '选择' },
  /** Glyph shown before the current label. */
  icon: { type: String, default: '' },
  /** Open upwards, for controls that live in the composer. */
  placement: { type: String, default: 'down' },
  align: { type: String, default: 'left' },
  disabled: { type: Boolean, default: false },
  /** Tailwind width utility for the trigger. */
  width: { type: String, default: 'max-w-[11rem]' },
  /** Extra classes for the label span, so a narrow screen can hide the text and keep the icon. */
  labelClass: { type: String, default: '' },
})

/** Smallest list width, so a narrow trigger still shows descriptions. */
const MIN_LIST_WIDTH = 208
const GAP = 8
const EDGE = 8

const open = ref(false)
const active = ref(-1)
const trigger = ref(null)
const list = ref(null)
const position = ref({ left: 0, width: MIN_LIST_WIDTH, top: 0, bottom: 0, up: false })

const current = computed(() => props.items.find((item) => item.value === model.value))

/** Place the listbox against the trigger, clamped to the viewport. */
function updatePosition () {
  const node = trigger.value
  if (node === null) return
  const rect = node.getBoundingClientRect()
  const width = Math.max(rect.width, MIN_LIST_WIDTH)
  const left = Math.max(EDGE, Math.min(props.align === 'right' ? rect.right - width : rect.left, window.innerWidth - width - EDGE))
  const up = props.placement === 'up'
  position.value = {
    left,
    width,
    up,
    top: rect.bottom + GAP,
    bottom: window.innerHeight - rect.top + GAP,
  }
}

async function scrollActiveIntoView () {
  await nextTick()
  list.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
}

function toggle () {
  if (props.disabled) return
  open.value = !open.value
  if (!open.value) return
  const index = props.items.findIndex((item) => item.value === model.value)
  active.value = index < 0 ? 0 : index
  updatePosition()
  void scrollActiveIntoView()
}

function choose (item) {
  if (item === undefined) return
  model.value = item.value
  open.value = false
}

function move (step) {
  if (!open.value) {
    toggle()
    return
  }
  const count = props.items.length
  if (count === 0) return
  active.value = (active.value + step + count) % count
  void scrollActiveIntoView()
}

function onKeydown (event) {
  if (event.key === 'Escape') {
    open.value = false
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (open.value) choose(props.items[active.value])
    else toggle()
  }
}

function onPointerDown (event) {
  if (trigger.value?.contains(event.target) === true) return
  if (list.value?.contains(event.target) === true) return
  open.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
})

watch(() => props.disabled, (value) => {
  if (value) open.value = false
})
</script>

<template>
  <div class="relative">
    <button
      ref="trigger"
      type="button"
      class="control w-full"
      :class="[width, { 'chip-strong': open, 'opacity-40': disabled }]"
      :disabled="disabled"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
      @keydown="onKeydown"
    >
      <AppIcon v-if="icon" :name="icon" :size="13" />
      <AppIcon v-else-if="current?.icon" :name="current.icon" :size="13" />
      <span class="truncate" :class="labelClass">{{ current?.name ?? placeholder }}</span>
      <AppIcon name="chevron" :size="12" class="opacity-50 transition-transform duration-200" :class="open ? 'rotate-180' : ''" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="list"
        role="listbox"
        class="card pop fixed z-[120] max-h-72 overflow-y-auto p-1.5"
        :style="{
          left: `${position.left}px`,
          width: `${position.width}px`,
          ...(position.up ? { bottom: `${position.bottom}px` } : { top: `${position.top}px` }),
        }"
      >
        <button
          v-for="(item, index) in items"
          :key="item.value"
          type="button"
          role="option"
          :aria-selected="item.value === model"
          :data-active="index === active"
          class="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors"
          :class="index === active
            ? 'bg-white/80 dark:bg-white/[0.12]'
            : 'hover:bg-white/60 dark:hover:bg-white/[0.08]'"
          @pointerenter="active = index"
          @click="choose(item)"
        >
          <AppIcon v-if="item.icon" :name="item.icon" :size="14" class="opacity-70" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px]">{{ item.name }}</span>
            <span v-if="item.description" class="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {{ item.description }}
            </span>
          </span>
          <AppIcon v-if="item.value === model" name="check" :size="14" class="text-blue-500" />
        </button>
        <p v-if="items.length === 0" class="px-2.5 py-2 text-xs text-zinc-400">暂无选项</p>
      </div>
    </Teleport>
  </div>
</template>

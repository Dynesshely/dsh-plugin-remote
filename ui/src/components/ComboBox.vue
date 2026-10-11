<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import ModelMark from './ModelMark.vue'

/**
 * Self-drawn combobox: a glass trigger plus a listbox teleported to `<body>`.
 *
 * The list is teleported so its own `backdrop-blur` really samples the page behind it — nested
 * inside an already-frosted panel a child backdrop-filter cannot blur through the parent — and so
 * no ancestor can clip it.
 *
 * Long lists get two affordances the model picker needs: a search field (a provider can expose
 * dozens of models) and provider grouping (options carrying a `group` are listed under one heading,
 * and their own description is dropped because the heading already says it).
 */
const model = defineModel({ type: String, default: '' })

const props = defineProps({
  /** Text of the footer action; an empty string hides it. */
  allLabel: { type: String, default: '' },
  /** CSS max-height for the panel, so a long catalogue can ask for more room than a short one. */
  listHeight: { type: String, default: '' },
  /** Options: `{ value, name, description?, icon?, group? }`. */
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
  /** Offer a filter field at the top of the list. */
  searchable: { type: Boolean, default: false },
  /** Floor for the listbox width, so a narrow trigger still shows long names. */
  minListWidth: { type: Number, default: 208 },
})

const GAP = 8
const EDGE = 8

const open = ref(false)
const active = ref(-1)
const query = ref('')
const trigger = ref(null)
const list = ref(null)
const search = ref(null)
const position = ref({ left: 0, width: props.minListWidth, top: 0, bottom: 0, up: false })

/** @returns whether an item matches the current query, by name, provider or value. */
function matches (item, needle) {
  if (needle === '') return true
  return `${item.name ?? ''} ${item.description ?? ''} ${item.group ?? ''} ${item.value ?? ''}`
    .toLowerCase()
    .includes(needle)
}

/** Options after filtering, in list order. */
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return props.items.filter((item) => matches(item, needle))
})

const current = computed(() => props.items.find((item) => item.value === model.value))

/**
 * The filtered options arranged for display, each paired with its index in the flat list so keyboard
 * navigation and highlighting share one source of truth.
 *
 * Items that carry a `group` are collected under one heading; a list without any groups stays flat,
 * which is what the shorter selectors (permissions) want.
 */
const sections = computed(() => {
  const indexed = filtered.value.map((item, index) => ({ item, index }))
  const grouped = filtered.value.some((item) => typeof item.group === 'string' && item.group !== '')
  if (!grouped) return [{ title: '', options: indexed }]
  const order = []
  const byTitle = new Map()
  for (const entry of indexed) {
    const title = typeof entry.item.group === 'string' && entry.item.group !== '' ? entry.item.group : ''
    if (!byTitle.has(title)) {
      byTitle.set(title, [])
      order.push(title)
    }
    byTitle.get(title).push(entry)
  }
  return order.map((title) => ({ title, options: byTitle.get(title) }))
})

/** Place the listbox against the trigger, clamped to the viewport. */
function updatePosition () {
  // Registered on window scroll for every instance, so it must be free when the list is closed:
  // otherwise each scroll of any element measures every trigger on the page.
  if (!open.value) return
  const node = trigger.value
  if (node === null) return
  const rect = node.getBoundingClientRect()
  const width = Math.max(rect.width, props.minListWidth)
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
  query.value = ''
  const index = filtered.value.findIndex((item) => item.value === model.value)
  active.value = index < 0 ? 0 : index
  updatePosition()
  void scrollActiveIntoView()
  if (props.searchable) void nextTick(() => search.value?.focus())
}

function choose (item) {
  if (item === undefined) return
  model.value = item.value
  open.value = false
  query.value = ''
}

function move (step) {
  if (!open.value) {
    toggle()
    return
  }
  const count = filtered.value.length
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
  if (event.key === 'Enter' || (event.key === ' ' && event.target === trigger.value)) {
    event.preventDefault()
    if (open.value) choose(filtered.value[active.value])
    else toggle()
  }
}

function onPointerDown (event) {
  if (trigger.value?.contains(event.target) === true) return
  if (list.value?.contains(event.target) === true) return
  open.value = false
}

/** Keep the active row valid while the query narrows the list. */
watch(query, () => {
  active.value = 0
  void scrollActiveIntoView()
})

/**
 * Start the hover scroll for a clipped name.
 *
 * The overflow is measured rather than guessed, so the animation always ends exactly at the last
 * character, and the duration scales with the distance so short and long names feel alike.
 * @param event - the pointerenter event.
 */
function startScroll (event) {
  const element = event.currentTarget?.querySelector?.('.rc-marquee')
  if (element === null || element === undefined) return
  const available = element.parentElement?.clientWidth ?? 0
  const overflow = element.scrollWidth - available
  if (overflow <= 2) return
  element.style.setProperty('--rc-marquee-shift', `-${String(overflow)}px`)
  element.style.setProperty('--rc-marquee-duration', `${String(Math.min(4, Math.max(0.9, overflow / 45)).toFixed(2))}s`)
  element.dataset.scroll = 'true'
}

/** @param event - the pointerleave event. */
function stopScroll (event) {
  const element = event.currentTarget?.querySelector?.('.rc-marquee')
  if (element === null || element === undefined) return
  delete element.dataset.scroll
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
      @pointerenter="startScroll"
      @pointerleave="stopScroll"
    >
      <ModelMark v-if="current?.mark" :mark="current.mark" :size="13" />
        <AppIcon v-else-if="icon" :name="icon" :size="13" />
      <AppIcon v-else-if="current?.icon" :name="current.icon" :size="13" />
      <!-- The clipped wrapper keeps the row narrow; the inner span is what scrolls on hover. -->
      <span class="min-w-0 flex-1 overflow-hidden text-left" :class="labelClass">
        <span class="rc-marquee">{{ current?.name ?? placeholder }}</span>
      </span>
      <AppIcon name="chevron" :size="12" class="opacity-50 transition-transform duration-200" :class="open ? 'rotate-180' : ''" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="list"
        role="listbox"
        class="card pop fixed z-[120] flex flex-col overflow-hidden p-1.5"
        :style="{
          left: `${position.left}px`,
          width: `${position.width}px`,
          // The panel owns the height: a taller list only means a taller panel, since the scroller is
          // the flex child that fills it.
          maxHeight: listHeight === '' ? '18rem' : listHeight,
          ...(position.up ? { bottom: `${position.bottom}px` } : { top: `${position.top}px` }),
        }"
      >
        <div v-if="searchable" class="shrink-0 px-0.5 pb-1.5">
          <input
            ref="search"
            v-model="query"
            type="text"
            class="field py-1.5 text-[13px]"
            placeholder="搜索模型"
            @keydown="onKeydown"
          />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <template v-for="section in sections" :key="section.title || '__flat__'">
            <!-- Provider heading: it sticks to the top while its models scroll underneath, and the
                 options below need no provider subtitle of their own. -->
            <p
              v-if="section.title !== ''"
              class="rc-combo-group px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-zinc-400 first:pt-0.5"
            >
              {{ section.title }}
            </p>
            <button
              v-for="option in section.options"
              :key="option.item.value"
              type="button"
              role="option"
              :aria-selected="option.item.value === model"
              :data-active="option.index === active"
              class="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors"
              :class="option.index === active
                ? 'bg-white/80 dark:bg-white/[0.12]'
                : 'hover:bg-white/60 dark:hover:bg-white/[0.08]'"
              @pointerenter="active = option.index; startScroll($event)"
              @pointerleave="stopScroll"
              @click="choose(option.item)"
            >
              <ModelMark v-if="option.item.mark" :mark="option.item.mark" :size="14" class="opacity-90" />
              <AppIcon v-else-if="option.item.icon" :name="option.item.icon" :size="14" class="shrink-0 opacity-70" />
              <span class="min-w-0 flex-1 overflow-hidden">
                <span class="rc-marquee text-[13px]">{{ option.item.name }}</span>
                <span v-if="section.title === '' && option.item.description" class="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                  {{ option.item.description }}
                </span>
              </span>
              <AppIcon v-if="option.item.value === model" name="check" :size="14" class="shrink-0 text-blue-500" />
            </button>
          </template>
          <p v-if="filtered.length === 0" class="px-2.5 py-2 text-xs text-zinc-400">
            {{ searchable && query.trim() !== '' ? '没有匹配的模型' : '暂无选项' }}
          </p>
        </div>

        <!-- The footer is a sibling of the scroller, so it stays put while the options move. -->
        <button
          v-if="allLabel !== ''"
          type="button"
          class="mx-1 mt-2 mb-1 flex shrink-0 items-center gap-2 rounded-xl border border-white/50 px-2.5 py-2 text-left text-[12px] text-zinc-600 transition-colors hover:bg-white/70 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/[0.1]"
          @click="$emit('view-all')"
        >
          <AppIcon name="more" :size="13" class="shrink-0 opacity-70" />
          <span class="min-w-0 flex-1 truncate">{{ allLabel }}</span>
          <AppIcon name="chevron" :size="12" class="shrink-0 opacity-50" />
        </button>
      </div>
    </Teleport>
  </div>
</template>

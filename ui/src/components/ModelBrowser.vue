<script setup>
import { computed, onMounted, ref } from 'vue'
import { api } from '../lib/api.js'
import { modelIcon, modelMark } from '../lib/model-icons.js'
import AppIcon from './AppIcon.vue'
import ModelMark from './ModelMark.vue'

/**
 * The whole model catalogue, grouped three ways.
 *
 * The picker beside the composer is a shortcut: it shows what the current provider offers. This modal is
 * for choosing deliberately — by family, by provider, or by family inside a provider — and shows what the
 * catalogue and the gateway between them know about each model: its capacity, and whether it can think.
 */
const props = defineProps({
  /** The catalogue groups, as returned by `/api/models`. */
  groups: { type: Array, default: () => [] },
  /** The currently selected model id. */
  model: { type: String, default: '' },
})

const emit = defineEmits(['close', 'select'])

/** How the list is grouped. */
const view = ref('family')
const query = ref('')
/** `{ id: contextLength }` from the gateway, joined onto the catalogue. */
const contextWindows = ref({})
const metaSource = ref('')

/** @returns every model, flattened, with its provider attached. */
const flat = computed(() => {
  const rows = []
  for (const group of groups.value) {
    for (const model of group.models ?? []) {
      rows.push({
        id: String(model.id ?? ''),
        name: String(model.name ?? model.id ?? ''),
        description: String(model.description ?? ''),
        provider: String(group.name ?? group.id ?? ''),
        providerId: String(group.id ?? ''),
        reasoning: model.reasoning,
        mark: modelMark(model.id, model.name),
        icon: modelIcon(model.id, model.name),
      })
    }
  }
  return rows
})

/** @returns the rows matching the search box. */
const matched = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (needle === '') return flat.value
  return flat.value.filter((row) => `${row.id} ${row.name} ${row.provider}`.toLowerCase().includes(needle))
})

/** @returns the family a model belongs to, for grouping. */
function familyOf (row) {
  return row.mark?.title ?? '其他'
}

/** @returns `[title, rows]` groups for the current view. */
const grouped = computed(() => {
  const rows = matched.value
  const map = new Map()
  for (const row of rows) {
    const key = view.value === 'family'
      ? familyOf(row)
      : view.value === 'provider' ? row.provider : `${row.provider} · ${familyOf(row)}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  return [...map.entries()].sort((left, right) => left[0].localeCompare(right[0]))
})

/** @returns a capacity as `200k` / `1M`, or an empty string. */
function capacity (id) {
  const value = Number(contextWindows.value[id])
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  return `${Math.round(value / 1000)}k`
}

/** @returns whether the model can be asked to think. */
function thinking (row) {
  return row.reasoning?.efforts?.length > 0
}

/** @returns the default thinking effort, when the catalogue names one. */
function effort (row) {
  const id = row.reasoning?.defaultEffort
  if (typeof id !== 'string') return ''
  const named = (row.reasoning?.efforts ?? []).find((entry) => entry.id === id)
  return named?.name ?? id
}

/** The catalogue, when the parent did not supply one. */
const loaded = ref([])

/** @returns the groups to render. */
const groups = computed(() => (props.groups.length > 0 ? props.groups : loaded.value))

onMounted(async () => {
  if (props.groups.length === 0) {
    try {
      const catalogue = await api('/api/models')
      loaded.value = Array.isArray(catalogue.groups) ? catalogue.groups : []
    } catch {
      /* the empty state explains itself */
    }
  }
  try {
    const payload = await api('/api/model-meta')
    contextWindows.value = payload.contextWindows ?? {}
    metaSource.value = String(payload.source ?? '')
  } catch {
    /* capacity is a bonus: the modal works without it */
  }
})
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[127] flex items-center justify-center bg-black/55 p-4 backdrop-blur-xl"
      @click.self="emit('close')"
    >
      <div class="panel panel-veil pop flex max-h-[88dvh] w-full max-w-2xl flex-col p-4">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="text-sm font-medium">所有模型</h2>
          <span class="text-[11px] text-zinc-400">{{ matched.length }} 个</span>
          <span v-if="metaSource === 'gateway'" class="rounded-full bg-white/60 px-1.5 text-[9px] text-zinc-500 dark:bg-white/10 dark:text-zinc-400">
            容量来自网关
          </span>
          <button class="icon-btn ml-auto h-7 w-7" type="button" title="关闭" @click="emit('close')">
            <AppIcon name="close" :size="13" />
          </button>
        </div>

        <!-- View switcher: the same catalogue, three ways of finding a model in it. -->
        <div class="mb-2 flex flex-wrap items-center gap-1.5">
          <button
            v-for="option in [
              { id: 'family', label: '按家族' },
              { id: 'provider', label: '按渠道' },
              { id: 'provider-family', label: '渠道内家族' },
            ]"
            :key="option.id"
            type="button"
            class="rounded-full px-2.5 py-1 text-[11px] transition-colors"
            :class="view === option.id
              ? 'bg-blue-500 text-white hover:bg-blue-500'
              : 'bg-white/60 text-zinc-500 hover:bg-white/80 dark:bg-white/10 dark:text-zinc-300 dark:hover:bg-white/[0.16]'"
            @click="view = option.id"
          >
            {{ option.label }}
          </button>
          <input v-model="query" type="text" class="field ml-auto max-w-[12rem] py-1 text-[12px]" placeholder="搜索模型" />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <section v-for="[title, rows] in grouped" :key="title" class="mb-3">
            <p class="mb-1 text-[11px] font-medium tracking-wide text-zinc-400">{{ title }}</p>
            <div class="grid grid-cols-1 gap-1 sm:grid-cols-2">
              <button
                v-for="row in rows"
                :key="row.id"
                type="button"
                class="flex items-start gap-2 rounded-xl border border-white/50 px-2 py-1.5 text-left transition-colors hover:bg-white/60 dark:border-white/10 dark:hover:bg-white/[0.08]"
                :class="row.id === model ? 'ring-1 ring-blue-400' : ''"
                @click="emit('select', row.id)"
              >
                <ModelMark v-if="row.mark" :mark="row.mark" :size="16" class="mt-0.5 opacity-90" />
                <AppIcon v-else :name="row.icon" :size="16" class="mt-0.5 shrink-0 opacity-70" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate text-[12px] text-zinc-700 dark:text-zinc-100">{{ row.name }}</span>
                    <AppIcon v-if="row.id === model" name="check" :size="12" class="shrink-0 text-blue-500" />
                  </span>
                  <span class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">
                    <span v-if="capacity(row.id) !== ''" class="rounded bg-white/60 px-1 dark:bg-white/10" :title="`上下文窗口 ${String(contextWindows[row.id])}`">
                      {{ capacity(row.id) }} 上下文
                    </span>
                    <span v-if="thinking(row)" class="rounded bg-white/60 px-1 dark:bg-white/10" :title="`可调思考强度，默认 ${effort(row)}`">
                      思考 {{ effort(row) }}
                    </span>
                    <span class="truncate" :title="row.id">{{ row.id }}</span>
                  </span>
                </span>
              </button>
            </div>
          </section>
          <p v-if="grouped.length === 0" class="px-1 py-3 text-[12px] text-zinc-400">没有匹配的模型。</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

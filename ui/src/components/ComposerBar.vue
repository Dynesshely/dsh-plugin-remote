<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cancelTurn, selectModel, selectPermission, sendPrompt, stageImage, state } from '../lib/store.js'
import { mobile, reportComposerOverflow } from '../lib/layout.js'
import ComboBox from './ComboBox.vue'
import StatusStrip from './StatusStrip.vue'
import AppIcon from './AppIcon.vue'

const text = ref('')
const attachments = ref([])
const busy = ref(false)
const fileInput = ref(null)
const area = ref(null)
const settingsOpen = ref(false)
const infoOpen = ref(false)
/** Data URL of the attachment being previewed full screen. */
const zoom = ref('')

const running = computed(() => state.telemetry.running)
const canSend = computed(() => !busy.value && state.selected !== undefined && (text.value.trim() !== '' || attachments.value.length > 0))

/** Model options flattened from the provider groups. */
const modelItems = computed(() =>
  state.models.groups.flatMap((group) =>
    (group.models ?? []).map((model) => ({
      value: `${group.id}/${model.id}`,
      name: model.name,
      description: group.name,
      icon: 'cpu',
    }))))

const currentModel = computed(() => {
  const selection = state.selection
  return selection === null || selection === undefined ? '' : `${selection.provider}/${selection.model}`
})

const permissionItems = computed(() =>
  state.permissions.options.map((option) => ({
    value: option.value,
    name: option.name,
    description: option.description,
    icon: 'shield',
  })))

/** Rows of the long-press detail sheet. */
const infoRows = computed(() => {
  const telemetry = state.telemetry
  const cacheTotal = telemetry.totalCacheRead + telemetry.totalInput
  return [
    ['状态', telemetry.running ? '运行中' : '空闲'],
    ['进度', telemetry.turn > 0 ? `第 ${telemetry.turn} 轮 · 第 ${telemetry.step} 步` : '—'],
    ['模型', telemetry.model || currentModel.value || '—'],
    ['供应商', telemetry.provider || '—'],
    ['输入 tokens', String(telemetry.totalInput)],
    ['输出 tokens', String(telemetry.totalOutput)],
    ['缓存读取', `${telemetry.totalCacheRead}（命中 ${cacheTotal === 0 ? 0 : Math.round((telemetry.totalCacheRead / cacheTotal) * 100)}%）`],
    ['缓存写入', String(telemetry.totalCacheWrite)],
    ['推理 tokens', String(telemetry.totalReasoning)],
    ['生成速度', telemetry.tokensPerSecond > 0 ? `${telemetry.tokensPerSecond.toFixed(1)} tok/s` : '—'],
    ['上下文', telemetry.contextWindow > 0 ? `${telemetry.lastInput} / ${telemetry.contextWindow}（${Math.round((telemetry.lastInput / telemetry.contextWindow) * 100)}%）` : '—'],
    ['权限', state.permissions.current ?? '—'],
    ['会话', state.selected ?? '—'],
    ['监听', state.bind || '—'],
  ]
})

/** Grow the textarea with its content, up to a share of the viewport. */
async function autosize () {
  await nextTick()
  const node = area.value
  if (node === null) return
  node.style.height = 'auto'
  node.style.height = `${String(Math.min(node.scrollHeight, window.innerHeight * 0.4))}px`
}

async function send () {
  if (!canSend.value) return
  busy.value = true
  try {
    const content = []
    // Images first, then the text — the same order the Desktop composer submits.
    for (const attachment of attachments.value) {
      content.push({
        type: 'image',
        mediaType: attachment.mediaType,
        data: attachment.data,
        ...(attachment.name === undefined ? {} : { name: attachment.name }),
      })
    }
    const trimmed = text.value.trim()
    if (trimmed !== '') content.push({ type: 'text', text: trimmed })
    await sendPrompt(content, 'queue')
    text.value = ''
    attachments.value = []
    await autosize()
  } catch {
    /* the store surfaces the error */
  } finally {
    busy.value = false
  }
}

/** Stage a picked image on the Host and show a chip until the message is sent. */
async function stage (file) {
  try {
    attachments.value = [...attachments.value, await stageImage(file)]
  } catch (error) {
    state.actionError = String(error.message ?? error)
  }
}

async function pick (event) {
  const files = [...(event.target.files ?? [])]
  event.target.value = ''
  for (const file of files) {
    if (file.type.startsWith('image/')) await stage(file)
  }
}

/** Paste an image from the clipboard as an attachment. */
async function onPaste (event) {
  const items = [...(event.clipboardData?.items ?? [])]
  const images = items.filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean)
  if (images.length === 0) return
  event.preventDefault()
  for (const file of images) await stage(file)
}

function onKeydown (event) {
  // Matching the Desktop composer after the Enter-swap plugin: Ctrl/Cmd+Enter sends, Enter breaks
  // the line. The send button stays available for touch.
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

async function chooseModel (value) {
  const separator = value.indexOf('/')
  await selectModel({ provider: value.slice(0, separator), model: value.slice(separator + 1) })
  settingsOpen.value = false
}

async function choosePermission (value) {
  await selectPermission(value)
  settingsOpen.value = false
}

/** Long press opens the detail sheet; a plain tap stays inert so it cannot be hit by accident. */
function openInfo () {
  infoOpen.value = true
}

/* ---------------------------------------------------------------- toolbar fitting */

/** The row itself plus every control whose natural width decides whether it still fits. */
const toolbar = ref(null)
const attachRef = ref(null)
const stripRef = ref(null)
const modelRef = ref(null)
const permissionRef = ref(null)
const sendRef = ref(null)
/** Learned natural width of the desktop row; only ever grows, so the decision cannot oscillate. */
const neededWidth = ref(0)
let observer

/** @returns the DOM node behind a template ref, which may be a child component instance. */
function nodeOf (reference) {
  const value = reference?.value
  if (value === null || value === undefined) return undefined
  const node = value.$el ?? value
  return node instanceof HTMLElement ? node : undefined
}

/**
 * Compare the row's width with what the desktop controls actually need.
 *
 * `scrollWidth` is used next to `offsetWidth` because the telemetry strip is the control that gets
 * squeezed: its own box shrinks while its content keeps its full width, which is exactly the signal
 * that the desktop row no longer fits.
 */
function measure () {
  const row = toolbar.value
  if (row === null) return
  const nodes = [attachRef, stripRef, modelRef, permissionRef, sendRef].map(nodeOf).filter((node) => node !== undefined)
  if (nodes.length > 0) {
    const natural = nodes.reduce((total, node) => total + Math.max(node.offsetWidth, node.scrollWidth), 0)
    // gap-1.5 between controls plus the row's own horizontal padding.
    neededWidth.value = Math.max(neededWidth.value, natural + 6 * (nodes.length - 1) + 16)
  }
  if (neededWidth.value === 0) return
  const available = row.clientWidth
  if (available < neededWidth.value) reportComposerOverflow(true)
  else if (available > neededWidth.value * 1.06) reportComposerOverflow(false)
}

onMounted(() => {
  observer = new ResizeObserver(measure)
  if (toolbar.value !== null) observer.observe(toolbar.value)
  measure()
  void autosize()
})

onBeforeUnmount(() => {
  observer?.disconnect()
})

watch([() => attachments.value.length, () => state.selected, running, mobile], () => {
  void nextTick(measure)
})

/* The placeholder must stay one line: a wrapped placeholder cannot grow the textarea, so its second
   line would be clipped and the field would look scrollable on a phone. */
const placeholder = computed(() => {
  if (state.selected === undefined) return '先选择一个会话'
  return mobile.value ? '发消息…' : '发消息…（Enter 换行 / Ctrl+Enter 发送，可直接粘贴图片）'
})
</script>

<template>
  <div class="px-2 pt-2" style="padding-bottom: calc(0.5rem + env(safe-area-inset-bottom, 0px))">
    <div v-if="state.actionError" class="mb-1.5 px-1 text-[12px] text-rose-500">{{ state.actionError }}</div>

    <!-- Slightly tighter corners than the other panels (18px instead of 24px). -->
    <!-- No `overflow-hidden` here: the model/permission comboboxes open upwards out of the card.
         Paste is handled on the card so an image can be dropped anywhere in the composer. -->
    <div class="glass rounded-[18px]" @paste="onPaste">
      <div
        v-if="attachments.length > 0"
        class="flex gap-2 overflow-x-auto border-b border-white/50 px-3 py-2 dark:border-white/10"
      >
        <div
          v-for="(attachment, index) in attachments"
          :key="index"
          class="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-white/60 dark:border-white/10"
        >
          <button type="button" class="h-full w-full" title="预览" @click="zoom = attachment.preview">
            <img :src="attachment.preview" :alt="attachment.name" class="h-full w-full object-cover" />
          </button>
          <button
            type="button"
            class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
            title="移除"
            @click="attachments = attachments.filter((_, position) => position !== index)"
          >
            <AppIcon name="close" :size="11" />
          </button>
        </div>
      </div>

      <textarea
        ref="area"
        v-model="text"
        rows="1"
        class="max-h-[38dvh] min-h-[2.75rem] w-full resize-none border-0 bg-transparent px-3.5 py-2.5 text-[15px] outline-none placeholder:text-zinc-400"
        :placeholder="placeholder"
        :disabled="state.selected === undefined"
        @input="autosize"
        @keydown="onKeydown"
      />

      <!-- Left cluster: attachment intake and the telemetry strip. -->
      <div ref="toolbar" class="flex items-center gap-1.5 px-2 pb-2">
        <button ref="attachRef" class="icon-btn shrink-0" type="button" title="添加图片" :disabled="state.selected === undefined" @click="fileInput.click()">
          <AppIcon name="paperclip" :size="16" />
        </button>
        <input ref="fileInput" type="file" accept="image/*" multiple class="hidden" @change="pick" />
        <StatusStrip v-if="!mobile && state.selected !== undefined" ref="stripRef" class="min-w-0 shrink" />

        <!-- Right cluster: the full controls while they fit, icons once they do not. -->
        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <ComboBox
            v-if="!mobile"
            ref="modelRef"
            class="shrink-0"
            :model-value="currentModel"
            :items="modelItems"
            icon="cpu"
            placeholder="模型"
            placement="up"
            align="right"
            width="max-w-[18rem]"
            :disabled="state.selected === undefined"
            @update:model-value="chooseModel"
          />
          <ComboBox
            v-if="!mobile"
            ref="permissionRef"
            class="shrink-0"
            :model-value="state.permissions.current ?? ''"
            :items="permissionItems"
            icon="shield"
            placeholder="权限"
            placement="up"
            align="right"
            width="max-w-[12rem]"
            :disabled="state.selected === undefined"
            @update:model-value="choosePermission"
          />
          <button
            v-if="mobile"
            class="icon-btn"
            type="button"
            title="查看状态详情"
            @click="openInfo"
          >
            <AppIcon name="info" :size="16" />
          </button>
          <button
            v-if="mobile"
            class="icon-btn"
            type="button"
            title="模型与权限"
            :disabled="state.selected === undefined"
            @click="settingsOpen = true"
          >
            <AppIcon name="gear" :size="16" />
          </button>
          <button
            v-if="running"
            type="button"
            class="btn btn-danger h-9 w-9 shrink-0 p-0"
            title="停止当前轮次"
            @click="cancelTurn"
          >
            <AppIcon name="stop" :size="15" />
          </button>
          <button
            ref="sendRef"
            type="button"
            class="btn btn-primary h-9 w-9 shrink-0 p-0"
            title="发送（Ctrl+Enter）"
            :disabled="!canSend"
            @click="send"
          >
            <AppIcon name="send" :size="16" />
          </button>
        </div>
      </div>
    </div>

    <!-- Staged attachment viewer -->
    <Teleport to="body">
      <div
        v-if="zoom"
        class="fixed inset-0 z-[130] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
        @click="zoom = ''"
      >
        <img :src="zoom" alt="" class="max-h-full max-w-full rounded-2xl shadow-2xl" />
      </div>
    </Teleport>

    <!-- Settings sheet: the narrow-screen home of the model and permission pickers. -->
    <Teleport to="body">
      <div
        v-if="settingsOpen"
        class="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 p-3 backdrop-blur-sm wide:items-center"
        @click.self="settingsOpen = false"
      >
        <div class="panel pop flex max-h-[82dvh] w-full max-w-md flex-col overflow-hidden">
          <header class="flex shrink-0 items-center gap-2 border-b border-white/50 px-3 py-2.5 dark:border-white/10">
            <AppIcon name="gear" :size="15" class="text-zinc-400" />
            <span class="flex-1 text-sm font-medium">模型与权限</span>
            <button class="icon-btn h-7 w-7" type="button" @click="settingsOpen = false">
              <AppIcon name="close" :size="13" />
            </button>
          </header>
          <!-- Only the model list scrolls: the permission switch stays pinned to the sheet's bottom,
               so a long model catalog can never push it out of reach. -->
          <div class="min-h-0 flex-1 overflow-y-auto p-3">
            <section>
              <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">模型</h3>
              <div class="space-y-1">
                <button
                  v-for="item in modelItems"
                  :key="item.value"
                  type="button"
                  class="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors"
                  :class="item.value === currentModel ? 'bg-white/80 dark:bg-white/[0.12]' : 'hover:bg-white/60 dark:hover:bg-white/[0.08]'"
                  @click="chooseModel(item.value)"
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[13px]">{{ item.name }}</span>
                    <span class="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">{{ item.description }}</span>
                  </span>
                  <AppIcon v-if="item.value === currentModel" name="check" :size="14" class="text-blue-500" />
                </button>
                <p v-if="modelItems.length === 0" class="px-2 py-1 text-xs text-zinc-400">模型目录不可用</p>
              </div>
            </section>
          </div>
          <section class="shrink-0 border-t border-white/50 bg-white/30 p-3 dark:border-white/10 dark:bg-white/[0.03]">
            <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">权限预设</h3>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="item in permissionItems"
                :key="item.value"
                type="button"
                class="chip"
                :class="{ 'chip-strong': item.value === state.permissions.current }"
                :title="item.description"
                @click="choosePermission(item.value)"
              >
                <AppIcon v-if="item.value === state.permissions.current" name="check" :size="12" />
                {{ item.name }}
              </button>
              <span v-if="permissionItems.length === 0" class="text-xs text-zinc-400">权限目录不可用</span>
            </div>
          </section>
        </div>
      </div>
    </Teleport>

    <!-- Detail sheet: opened by long-pressing the info button (or right-click on desktop). -->
    <Teleport to="body">
      <div
        v-if="infoOpen"
        class="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 p-3 backdrop-blur-sm wide:items-center"
        @click.self="infoOpen = false"
      >
        <div class="panel pop flex max-h-[82dvh] w-full max-w-md flex-col overflow-hidden">
          <header class="flex shrink-0 items-center gap-2 border-b border-white/50 px-3 py-2.5 dark:border-white/10">
            <AppIcon name="info" :size="15" class="text-zinc-400" />
            <span class="flex-1 text-sm font-medium">状态详情</span>
            <button class="icon-btn h-7 w-7" type="button" @click="infoOpen = false">
              <AppIcon name="close" :size="13" />
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-3">
            <div class="mb-3">
              <StatusStrip />
            </div>
            <dl class="space-y-1.5 text-[13px]">
              <div v-for="row in infoRows" :key="row[0]" class="flex items-baseline gap-3">
                <dt class="w-24 shrink-0 text-zinc-400">{{ row[0] }}</dt>
                <dd class="min-w-0 flex-1 break-all">{{ row[1] }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

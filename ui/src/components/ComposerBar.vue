<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cancelTurn, releaseImagePreview, selectModel, selectPermission, sendPrompt, stageImage, state } from '../lib/store.js'
import { compact, reportComposerOverflow } from '../lib/layout.js'
import { modelIcon, modelMark } from '../lib/model-icons.js'
import ModelBrowser from './ModelBrowser.vue'
import ComboBox from './ComboBox.vue'
// The editor carries CodeMirror, so it loads as its own chunk: the transcript paints first.
const MarkdownComposer = defineAsyncComponent(() => import('./MarkdownComposer.vue'))
import StatusStrip from './StatusStrip.vue'
import AppIcon from './AppIcon.vue'

const text = ref('')
const attachments = ref([])
const busy = ref(false)
/** 正在处理（解码 → 降采样 → 上传）的图片数量；>0 时给出可见提示，收尾后必然归零。 */
const staging = ref(0)
const fileInput = ref(null)
const area = ref(null)
const settingsOpen = ref(false)
const infoOpen = ref(false)
/** Data URL of the attachment being previewed full screen. */

const running = computed(() => state.telemetry.running)
// 图片还在解码/压缩/上传时不允许发送：否则会发出一条只有文字、图片被悄悄丢掉的消息。
const canSend = computed(() => !busy.value && staging.value === 0 && state.selected !== undefined && (text.value.trim() !== '' || attachments.value.length > 0))

/** Model options flattened from the provider groups, each tagged with its provider for grouping. */
const modelItems = computed(() =>
  state.models.groups.flatMap((group) =>
    (group.models ?? []).map((model) => ({
      value: `${group.id}/${model.id}`,
      name: model.name,
      group: group.name,
      // Matched by keyword, so a newly configured provider still gets a sensible mark.
      icon: modelIcon(model.id, model.name),
      mark: modelMark(model.id, model.name),
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

/** Keep the document area scrolled to the caret after a programmatic change. */
async function autosize () {
  await nextTick()
  // The editor sizes itself; this only matters for anything that still measures the composer.
  void area
}

async function send () {
  if (!canSend.value) return
  busy.value = true
  try {
    const content = []
    // Images first, then the text — the same order the Desktop composer submits.
    // 图片只带 uploadId：字节在二进制上传时已经到宿主了，这里不再塞 base64，也不 stringify 整张图。
    for (const attachment of attachments.value) {
      content.push({
        type: 'image',
        uploadId: attachment.uploadId,
        ...(attachment.name === undefined ? {} : { name: attachment.name }),
      })
    }
    const trimmed = text.value.trim()
    if (trimmed !== '') content.push({ type: 'text', text: trimmed })
    await sendPrompt(content, 'queue')
    text.value = ''
    clearAttachments()
    await autosize()
  } catch {
    /* the store surfaces the error; 附件保留，读者可以改完再发一次 */
  } finally {
    busy.value = false
  }
}

/** 释放所有预览 URL；blob 不 revoke 就会一直占着内存。 */
function clearAttachments () {
  for (const attachment of attachments.value) releaseImagePreview(attachment)
  attachments.value = []
}

/** 移除一张附件，并释放它的预览 URL。 */
function removeAttachment (index) {
  const target = attachments.value[index]
  if (target !== undefined) releaseImagePreview(target)
  attachments.value = attachments.value.filter((_, position) => position !== index)
}

/**
 * 暂存一张图片：字节直接上传（不经过 base64），预览用 object URL。
 *
 * `staging` 计数保证任何失败路径都会把提示收掉 —— 卡在「处理中」比报错更难受。
 * @param file - 选中的或粘贴的图片。
 */
async function stage (file) {
  staging.value += 1
  try {
    const attachment = await stageImage(file)
    attachments.value = [...attachments.value, attachment]
  } catch (error) {
    state.actionError = String(error?.message ?? error)
  } finally {
    staging.value -= 1
  }
}

async function pick (event) {
  const files = [...(event.target.files ?? [])]
  event.target.value = ''
  for (const file of files) {
    if (file.type.startsWith('image/')) await stage(file)
  }
}

/**
 * Paste an image from the clipboard as an attachment.
 *
 * 只处理「还没人处理过」的粘贴：编辑器自己也会接 paste（MarkdownComposer 的 domEventHandlers），
 * 它处理过就会 preventDefault；这里再处理一遍会把同一张图 stage 两次（两次 base64/上传、两个附件）。
 */
async function onPaste (event) {
  if (event.defaultPrevented) return
  const items = [...(event.clipboardData?.items ?? [])]
  const images = items.filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean)
  if (images.length === 0) return
  event.preventDefault()
  for (const file of images) await stage(file)
}

/** Image files handed over by the editor (paste or drop) are staged like the picker's. */
async function attachFiles (files) {
  for (const file of files) {
    if (file.type.startsWith('image/')) await stage(file)
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
/** 上一次真正提交给 layout 的结论：迟滞的参照系（中间带维持现状）。 */
let reportedOverflow = false
/** 待提交的结论与它的稳定计时器。 */
let overflowTimer
let pendingOverflow

/** @returns the DOM node behind a template ref, which may be a child component instance. */
function nodeOf (reference) {
  const value = reference?.value
  if (value === null || value === undefined) return undefined
  const node = value.$el ?? value
  return node instanceof HTMLElement ? node : undefined
}

/**
 * 结论必须稳定 250ms 才提交。
 *
 * ResizeObserver 在一次重排里可能连发好几拍（滚动条出现、字体加载、宽度过渡的每一帧）。不加这道闸，
 * 打开右栏的那一瞬间就会先判「放不下」再判「放得下」；而 `compact` 一旦回写布局（旧实现里它直接进
 * `mobile`），布局变化又会引起下一次测量 —— 那个自激回路就是这样转起来的。250ms 足够滤掉过渡帧。
 * @param value - 本次测出来的结论。
 */
function scheduleOverflow (value) {
  if (value === pendingOverflow) return
  pendingOverflow = value
  if (overflowTimer !== undefined) clearTimeout(overflowTimer)
  overflowTimer = setTimeout(() => {
    overflowTimer = undefined
    if (pendingOverflow === reportedOverflow) return
    reportedOverflow = pendingOverflow
    reportComposerOverflow(reportedOverflow)
  }, 250)
}

/**
 * Compare the row's width with what the desktop controls actually need.
 *
 * `scrollWidth` is used next to `offsetWidth` because the telemetry strip is the control that gets
 * squeezed: its own box shrinks while its content keeps its full width, which is exactly the signal
 * that the desktop row no longer fits. 判定带迟滞：明确不够才收、明确富余才放，中间带不动。
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
  if (available < neededWidth.value) scheduleOverflow(true)
  else if (available > neededWidth.value * 1.06) scheduleOverflow(false)
}

onMounted(() => {
  observer = new ResizeObserver(measure)
  if (toolbar.value !== null) observer.observe(toolbar.value)
  measure()
  void autosize()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (overflowTimer !== undefined) {
    clearTimeout(overflowTimer)
    overflowTimer = undefined
  }
  // 卸载时把还在预览的 blob 释放掉：草稿没了，object URL 不该继续占内存。
  clearAttachments()
})

// 注意：这里**不能**再依赖 `mobile`。旧实现 `watch(..., mobile, () => nextTick(measure))` 把
// 「布局变化 → 重新测量」这条回路显式闭合了，正是自激的关键一环；现在只跟着内容变化重测。
watch([() => attachments.value.length, () => state.selected, running], () => {
  void nextTick(measure)
})

/* The placeholder must stay one line: a wrapped placeholder cannot grow the textarea, so its second
   line would be clipped and the field would look scrollable on a phone. */
const placeholder = computed(() => {
  if (state.selected === undefined) return '先选择一个会话'
  return compact.value ? '发消息…' : '发消息…（Enter 换行 / Ctrl+Enter 发送，可直接粘贴图片）'
})
/** Whether the full catalogue browser is open. */
const browserOpen = ref(false)

/**
 * Choose a model picked in the browser.
 *
 * It goes through the picker's own handler rather than a second code path, so the composer, the session
 * and the store cannot disagree about what is selected.
 * @param modelId - the model id chosen in the browser.
 */
function chooseFromBrowser (modelId) {
  browserOpen.value = false
  chooseModel(modelId)
}
</script>

<template>
  <div class="px-2 pt-2" style="padding-bottom: calc(0.5rem + env(safe-area-inset-bottom, 0px))">
    <div v-if="state.actionError" class="mb-1.5 px-1 text-[12px] text-danger">{{ state.actionError }}</div>

    <!-- Slightly tighter corners than the other panels (18px instead of 24px). -->
    <!-- No `overflow-hidden` here: the model/permission comboboxes open upwards out of the card.
         Paste is handled on the card so an image can be dropped anywhere in the composer. -->
    <div class="glass rounded-[18px]" @paste="onPaste">
      <div
        v-if="attachments.length > 0 || staging > 0"
        class="flex items-center gap-2 overflow-x-auto border-b border-outline-medium px-3 py-2 dark:border-white/10"
      >
        <div
          v-for="(attachment, index) in attachments"
          :key="attachment.uploadId"
          class="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-outline"
        >
          <!-- 预览是 blob: URL（零拷贝），不再把整张图的 base64 塞进 <img src>。 -->
          <button type="button" class="h-full w-full" title="预览" data-zoom="1">
            <img :src="attachment.previewUrl" :alt="attachment.name" decoding="async" class="h-full w-full object-cover" />
          </button>
          <button
            type="button"
            class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
            title="移除"
            @click="removeAttachment(index)"
          >
            <AppIcon name="close" :size="11" />
          </button>
        </div>
        <!-- 处理中就说出来：解码/压缩/上传期间不显示任何提示，读者会以为卡死了。 -->
        <span v-if="staging > 0" class="shrink-0 px-1 text-[11px] text-tertiary">
          正在处理图片…
        </span>
      </div>

      <MarkdownComposer
        v-model="text"
        :placeholder="placeholder"
        :disabled="state.selected === undefined"
        @submit="send"
        @files="attachFiles"
      />

      <!-- Left cluster: attachment intake and the telemetry strip. -->
      <div ref="toolbar" class="flex items-center gap-1.5 px-2 pb-2">
        <button ref="attachRef" class="icon-btn shrink-0" type="button" title="添加图片" :disabled="state.selected === undefined" @click="fileInput.click()">
          <AppIcon name="paperclip" :size="16" />
        </button>
        <input ref="fileInput" type="file" accept="image/*" multiple class="hidden" @change="pick" />
        <StatusStrip v-if="!compact && state.selected !== undefined" ref="stripRef" class="min-w-0 shrink" />

        <!-- Right cluster: the full controls while they fit, icons once they do not. -->
        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <ComboBox
            v-if="!compact"
            ref="modelRef"
            class="shrink-0"
            :model-value="currentModel"
            :items="modelItems"
        all-label="查看所有模型"
        list-height="min(50vw, 80dvh)"
        @view-all="browserOpen = true"
            icon="cpu"
            placeholder="模型"
            placement="up"
            align="right"
            width="max-w-[22rem]"
            :min-list-width="340"
            searchable
            :disabled="state.selected === undefined"
            @update:model-value="chooseModel"
          />
          <ComboBox
            v-if="!compact"
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
            v-if="compact"
            class="icon-btn"
            type="button"
            title="查看状态详情"
            @click="openInfo"
          >
            <AppIcon name="info" :size="16" />
          </button>
          <button
            v-if="compact"
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
          </Teleport>

    <!-- Settings sheet: the narrow-screen home of the model and permission pickers. -->
    <Teleport to="body">
      <div
        v-if="settingsOpen"
        class="fixed inset-0 z-[110] flex items-end justify-center bg-fill-scrim p-3 backdrop-blur-sm wide:items-center"
        @click.self="settingsOpen = false"
      >
        <div class="panel pop flex max-h-[82dvh] w-full max-w-md flex-col overflow-hidden">
          <header class="flex shrink-0 items-center gap-2 border-b border-outline-medium px-3 py-2.5 dark:border-white/10">
            <AppIcon name="gear" :size="15" class="text-tertiary" />
            <span class="flex-1 text-sm font-medium">模型与权限</span>
            <button class="icon-btn h-7 w-7" type="button" @click="settingsOpen = false">
              <AppIcon name="close" :size="13" />
            </button>
          </header>
          <!-- Only the model list scrolls: the permission switch stays pinned to the sheet's bottom,
               so a long model catalog can never push it out of reach. -->
          <div class="min-h-0 flex-1 overflow-y-auto p-3">
            <section>
              <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-tertiary uppercase">模型</h3>
              <div class="space-y-1">
                <button
                  v-for="item in modelItems"
                  :key="item.value"
                  type="button"
                  class="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors"
                  :class="item.value === currentModel ? 'bg-fill-hover' : 'hover:bg-fill-tint-hover'"
                  @click="chooseModel(item.value)"
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[13px]">{{ item.name }}</span>
                    <span class="block truncate text-[11px] text-secondary">{{ item.description }}</span>
                  </span>
                  <AppIcon v-if="item.value === currentModel" name="check" :size="14" class="text-primary" />
                </button>
                <p v-if="modelItems.length === 0" class="px-2 py-1 text-xs text-tertiary">模型目录不可用</p>
              </div>
            </section>
          </div>
          <section class="shrink-0 border-t border-outline-medium bg-white/30 p-3 dark:border-white/10 dark:bg-white/[0.03]">
            <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-tertiary uppercase">权限预设</h3>
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
              <span v-if="permissionItems.length === 0" class="text-xs text-tertiary">权限目录不可用</span>
            </div>
          </section>
        </div>
      </div>
    </Teleport>

    <!-- Detail sheet: opened by long-pressing the info button (or right-click on desktop). -->
    <Teleport to="body">
      <div
        v-if="infoOpen"
        class="fixed inset-0 z-[110] flex items-end justify-center bg-fill-scrim p-3 backdrop-blur-sm wide:items-center"
        @click.self="infoOpen = false"
      >
        <div class="panel pop flex max-h-[82dvh] w-full max-w-md flex-col overflow-hidden">
          <header class="flex shrink-0 items-center gap-2 border-b border-outline-medium px-3 py-2.5 dark:border-white/10">
            <AppIcon name="info" :size="15" class="text-tertiary" />
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
                <dt class="w-24 shrink-0 text-tertiary">{{ row[0] }}</dt>
                <dd class="min-w-0 flex-1 break-all">{{ row[1] }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
  <ModelBrowser
    v-if="browserOpen"
    :groups="state.modelGroups ?? []"
    :model="state.selectedModel ?? ''"
    @close="browserOpen = false"
    @select="chooseFromBrowser"
  />
</template>

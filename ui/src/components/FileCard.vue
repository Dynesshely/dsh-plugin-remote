<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { selectedSession } from '../lib/store.js'
import AppIcon from './AppIcon.vue'

/**
 * 消息里的一条文件引用，渲染成一行卡片（类似桌面端的文件条目）。
 *
 * 左侧是缩略图或类型图标，中间是文件名 + 一行说明，右侧是主操作（预览）与下拉菜单。
 * 预览走页面内的轻量浮层，不新开标签页；缩略图走宿主的 `/api/image?path=`，同一条消息里同一路径
 * 只出现一张卡片，所以这里不需要再去重，也不会重复请求。卡片不做任何 DOM 测量。
 */
const props = defineProps({
  /** `extractFileReferences` 产出的引用对象。 */
  file: { type: Object, required: true },
})

/** 缩略图加载失败：回退到类型图标，绝不显示破图。 */
const thumbnailFailed = ref(false)
/** 下拉菜单是否打开。 */
const menuOpen = ref(false)
/** 页面内预览浮层是否打开。 */
const previewOpen = ref(false)
/** 浮层里的大图是否加载失败。 */
const previewFailed = ref(false)
/** 「已复制」的短暂反馈。 */
const copied = ref(false)
let copiedTimer

const ICONS = {
  image: 'spark',
  document: 'file',
  sheet: 'layers',
  code: 'cpu',
  archive: 'folder',
  media: 'send',
  unknown: 'help',
}

const path = computed(() => String(props.file?.path ?? ''))
const name = computed(() => String(props.file?.name ?? '') || path.value.split(/[\\/]/u).pop() || path.value)
const kind = computed(() => String(props.file?.kind ?? 'unknown'))
const isImage = computed(() => props.file?.isImage === true)
const extension = computed(() => String(props.file?.extension ?? '').toUpperCase())
const icon = computed(() => ICONS[kind.value] ?? ICONS.unknown)
/** 说明行：alt/title 优先；没有就写类型，不为了拿大小额外发请求。 */
const description = computed(() => {
  const given = String(props.file?.description ?? '').trim()
  if (given !== '') return given
  return extension.value === '' ? '文件' : `${extension.value} 文件`
})

/** 缩略图与预览都走同一条宿主图片路由。 */
const imageUrl = computed(() => `/api/image?${new URLSearchParams({ path: path.value }).toString()}`)

/** 下载地址：图片走图片路由，其它类型走宿主原始字节路由（需要当前工作区）。 */
const downloadUrl = computed(() => {
  if (isImage.value) return imageUrl.value
  const workspaceId = selectedSession.value?.workspaceId ?? ''
  return `/api/files/raw?${new URLSearchParams({ workspaceId, path: path.value }).toString()}`
})

/** 收起菜单（点外部、Esc、任何一次操作之后都调用）。 */
function closeMenu () {
  menuOpen.value = false
}

/** 打开下拉菜单。 */
function toggleMenu () {
  menuOpen.value = !menuOpen.value
}

/** 主操作：页面内预览。 */
function preview () {
  previewFailed.value = false
  previewOpen.value = true
  closeMenu()
}

/** 关闭预览浮层。 */
function closePreview () {
  previewOpen.value = false
}

/**
 * 复制路径（「复制路径」菜单项与「文件面板没响应」时的兜底共用）。
 * @returns 复制是否成功。
 */
async function copyPath () {
  try {
    await navigator.clipboard.writeText(path.value)
  } catch {
    return false
  }
  copied.value = true
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copiedTimer = undefined
    copied.value = false
  }, 1600)
  return true
}

/**
 * 请求在文件浏览器里定位这个文件。
 *
 * 页面其它部分通过 `rc:reveal-file` 事件接入（`cancelable`，监听方 `preventDefault()` 表示已处理）；
 * 当前没有监听方时把路径复制到剪贴板并给出提示，而不是让按钮点了没反应。
 */
function revealInFileManager () {
  const event = new CustomEvent('rc:reveal-file', { detail: { path: path.value }, cancelable: true })
  const handled = window.dispatchEvent(event) === false
  if (!handled) void copyPath()
  closeMenu()
}

/** 点菜单/卡片之外的位置关菜单。 */
function onWindowPointerDown (event) {
  if (!menuOpen.value) return
  const root = rootEl.value
  if (root === null || root === undefined) return
  if (event.target instanceof Node && root.contains(event.target)) return
  closeMenu()
}

/** Esc：先关浮层，再关菜单。 */
function onWindowKeyDown (event) {
  if (event.key !== 'Escape') return
  if (previewOpen.value) {
    closePreview()
    return
  }
  closeMenu()
}

const rootEl = ref(null)

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown, true)
  window.addEventListener('keydown', onWindowKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
  window.removeEventListener('keydown', onWindowKeyDown)
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
})
</script>

<template>
  <div
    ref="rootEl"
    class="rc-file-card my-1.5 flex max-w-xl items-center gap-2 rounded-xl border border-outline bg-white/55 px-2 py-1.5 dark:bg-white/[0.06]"
    data-file-card="1"
    :data-file-path="path"
  >
    <!-- 左：缩略图或类型图标 -->
    <span class="rc-file-thumb relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/70 text-secondary dark:bg-white/10 text-muted">
      <img
        v-if="isImage && !thumbnailFailed"
        :src="imageUrl"
        :alt="name"
        loading="lazy"
        decoding="async"
        class="h-full w-full object-cover"
        data-file-thumb="1"
        @error="thumbnailFailed = true"
      >
      <AppIcon v-else :name="icon" :size="16" />
    </span>

    <!-- 中：文件名 + 说明 -->
    <button type="button" class="min-w-0 flex-1 text-left" :title="path" @click="preview">
      <span class="block truncate text-[12.5px] font-medium text-strong">{{ name }}</span>
      <span class="block truncate text-[11px] text-tertiary text-subtle">{{ description }}</span>
    </button>

    <!-- 右：主操作 + 下拉 -->
    <button type="button" class="rc-file-primary shrink-0" @click="preview">预览</button>
    <div class="relative shrink-0">
      <button
        type="button"
        class="rc-file-more flex h-6 w-6 items-center justify-center rounded-lg text-tertiary hover:text-zinc-600 dark:hover:text-zinc-200"
        aria-label="更多操作"
        :aria-expanded="menuOpen"
        data-file-menu-toggle="1"
        @click="toggleMenu"
      >
        <AppIcon name="chevron" :size="11" />
      </button>
      <div
        v-if="menuOpen"
        class="rc-file-menu absolute right-0 top-full z-[150] mt-1 w-40 overflow-hidden rounded-xl border border-outline-medium-strong bg-white py-1 shadow-[0_12px_30px_-12px_rgb(15_23_42/0.5)] dark:border-white/15 bg-fill-solid"
        role="menu"
        data-file-menu="1"
      >
        <a
          class="rc-file-menu-item"
          :href="downloadUrl"
          :download="name"
          @click="closeMenu"
        >下载</a>
        <button type="button" class="rc-file-menu-item" @click="copyPath(); closeMenu()">
          {{ copied ? '已复制路径' : '复制路径' }}
        </button>
        <button type="button" class="rc-file-menu-item" @click="revealInFileManager">在文件浏览器中打开</button>
      </div>
    </div>

    <!-- 页面内预览浮层：图片直接看，其它类型给"用文件浏览器打开" -->
    <Teleport to="body">
      <div
        v-if="previewOpen"
        class="rc-file-veil fixed inset-0 z-[160] flex items-center justify-center bg-black/45 p-4"
        @pointerdown.self="closePreview"
      >
        <div
          class="rc-file-dialog flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-outline-medium-strong bg-white shadow-2xl dark:border-white/15 bg-fill-solid"
          role="dialog"
          aria-modal="true"
          :aria-label="name"
          data-file-preview="1"
        >
          <div class="flex items-center gap-2 px-3 py-2">
            <AppIcon :name="icon" :size="13" class="shrink-0 text-tertiary" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[12px] font-medium text-strong">{{ name }}</p>
              <p class="truncate text-[10px] text-tertiary">{{ path }}</p>
            </div>
            <button type="button" class="rc-file-close" aria-label="关闭预览" @click="closePreview">✕</button>
          </div>
          <div class="min-h-0 flex-1 overflow-auto bg-black/5 p-2 dark:bg-black/40">
            <img
              v-if="isImage && !previewFailed"
              :src="imageUrl"
              :alt="name"
              class="mx-auto max-h-[70vh] max-w-full rounded-lg object-contain"
              @error="previewFailed = true"
            >
            <div v-else class="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <AppIcon :name="icon" :size="26" class="text-tertiary" />
              <p class="text-[12px] text-secondary-strong">
                {{ isImage ? '图片加载失败' : '该类型暂不支持页面内预览' }}
              </p>
              <p class="max-w-full truncate text-[11px] text-tertiary">{{ path }}</p>
              <div class="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button type="button" class="rc-file-primary" @click="revealInFileManager">用文件浏览器打开</button>
                <button type="button" class="rc-file-ghost" @click="copyPath">{{ copied ? '已复制路径' : '复制路径' }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style>
/* 卡片与菜单：实色/半透明底，不使用 backdrop-filter（毛玻璃此前被全局移除）。 */
.rc-file-card {
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.rc-file-card:hover {
  background-color: rgb(255 255 255 / 0.72);
}

.dark .rc-file-card:hover {
  background-color: rgb(255 255 255 / 0.09);
}

.rc-file-primary {
  border-radius: 0.5rem;
  padding: 0.2rem 0.55rem;
  font-size: 11px;
  line-height: 1.3;
  color: rgb(255 255 255);
  background-color: rgb(37 99 235);
  transition: background-color 0.15s ease;
}

.rc-file-primary:hover {
  background-color: rgb(29 78 216);
}

.rc-file-ghost {
  border-radius: 0.5rem;
  padding: 0.2rem 0.55rem;
  font-size: 11px;
  color: rgb(82 82 91);
  background-color: rgb(0 0 0 / 0.06);
}

.dark .rc-file-ghost {
  color: rgb(228 228 231);
  background-color: rgb(255 255 255 / 0.1);
}

.rc-file-more:hover {
  background-color: rgb(255 255 255 / 0.7);
}

.dark .rc-file-more:hover {
  background-color: rgb(255 255 255 / 0.1);
}

.rc-file-menu-item {
  display: block;
  width: 100%;
  padding: 0.3rem 0.7rem;
  text-align: left;
  font-size: 11.5px;
  color: rgb(63 63 70);
  white-space: nowrap;
}

.dark .rc-file-menu-item {
  color: rgb(228 228 231);
}

.rc-file-menu-item:hover {
  background-color: rgb(0 0 0 / 0.06);
}

.dark .rc-file-menu-item:hover {
  background-color: rgb(255 255 255 / 0.1);
}

.rc-file-close {
  display: inline-flex;
  height: 1.5rem;
  width: 1.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  font-size: 11px;
  color: rgb(113 113 122);
}

.rc-file-close:hover {
  background-color: rgb(0 0 0 / 0.08);
}

.dark .rc-file-close:hover {
  background-color: rgb(255 255 255 / 0.12);
}

/* 浮层不做动画：减少动效偏好下无需特判，也避免"打开时闪一下"的观感。 */
@media (prefers-reduced-motion: reduce) {
  .rc-file-card,
  .rc-file-primary {
    transition: none;
  }
}
</style>

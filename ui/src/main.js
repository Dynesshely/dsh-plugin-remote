import { createApp } from 'vue'
import App from './App.vue'
import { reportError } from './lib/store.js'
import './style.css'

const app = createApp(App)

/**
 * 兜底三件套：Vue 组件异常、未捕获的运行时异常、未处理的 Promise 拒绝。
 *
 * 一条都不能省。SPA 最糟的失败形态不是报错，而是"什么都不显示、控制台也安静"：渲染期间抛出的
 * 异常会让 Vue 把出错的那棵子树（严重时是整棵）拆掉，页面上就只剩背景色 —— 读者看到的是黑屏，
 * 而不是错误。把错误收进 `state.lastError`（App 顶部有可关闭的错误条），至少能让人知道发生了什么、
 * 并把它复制出来。
 */
app.config.errorHandler = (error, _instance, info) => {
  reportError(error, `vue:${info}`)
  // 控制台留一份完整对象：错误条只显示摘要，堆栈得去控制台看。
  console.error('[remote-control] Vue 错误：', error)
}

window.addEventListener('error', (event) => {
  // 静态资源加载失败也会触发 error 事件（既无 error 也无 message）：那不是脚本异常，跳过。
  if (event.error === undefined && typeof event.message !== 'string') return
  reportError(event.error ?? event.message, 'window.error')
  console.error('[remote-control] 未捕获异常：', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  reportError(event.reason ?? '未处理的 Promise 拒绝', 'unhandledrejection')
  console.error('[remote-control] 未处理的 Promise 拒绝：', event.reason)
})

app.mount('#app')

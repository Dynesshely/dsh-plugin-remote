/**
 * First batch of localised strings: the shell, the composer, permissions and the run-state labels.
 *
 * Keys are added as areas are migrated. A key missing from one language falls back to the other, so a partially
 * translated screen is still readable — that is what makes it safe to migrate the components in batches.
 */

export const zhCN = {
  // ---- permissions -------------------------------------------------------
  'permission.label': '权限',
  'permission.read': '只读',
  'permission.workspace': '工作区可写',
  'permission.full': '完全权限',
  'permission.auto': '自动',

  // ---- top bar -----------------------------------------------------------
  'toolbar.toggleSidebar': '展开/收起侧栏',
  'toolbar.toggleFiles': '右侧栏',
  'toolbar.settings': '设置',
  'toolbar.refresh': '重新加载当前会话',
  'toolbar.language': '界面语言',
  'toolbar.theme': '主题',
  'toolbar.skin': '皮肤',
  'toolbar.noSession': '未选择会话',

  // ---- theme -------------------------------------------------------------
  'theme.system': '跟随系统',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'skin.glass': '液态玻璃',
  'skin.md3': 'Material Design 3',

  // ---- run state ---------------------------------------------------------
  'run.idle': '空闲',
  'run.done': '已完成',
  'run.failed': '加载失败',
  'run.thinking': '思考中',
  'run.responding': '输出中',
  'run.tool': '正在调用 {name}',
  'run.toolShell': '正在执行脚本 {name}',
  'run.waiting': '等待你的回应',
  'run.compacting': '整理上下文',

  // ---- composer ----------------------------------------------------------
  'composer.placeholder': '发送消息…（Enter 换行 / Ctrl+Enter 发送，可直接粘贴图片）',
  'composer.send': '发送',
  'composer.stop': '停止',
  'composer.attach': '添加图片',
  'composer.preview': '预览',
  'composer.processingImages': '正在处理图片…',

  // ---- common actions ----------------------------------------------------
  'action.close': '关闭',
  'action.refresh': '刷新',
  'action.retry': '重试',
  'action.cancel': '取消',
  'action.confirm': '确定',
  'action.open': '打开',
  'action.download': '下载',
  'action.rename': '重命名',
  'action.copy': '复制',
  'action.cut': '剪切',
  'action.paste': '粘贴',
  'action.delete': '删除',

  // ---- containers --------------------------------------------------------
  'container.newTab': '新标签页',
  'container.pick': '选择要在此标签页中打开的工具',
  'container.files': '文件资源管理器',
  'container.filesDetail': '浏览工作区、管理文件、预览常见格式',
  'container.preview': '文件预览',
  'container.previewDetail': '预览图片、PDF、音视频、Markdown 与代码',
  'container.git': 'Git 状态',
  'container.gitDetail': '查看工作区的分支、变更与差异',
  'container.switch': '换一个工具',
}

export const enUS = {
  // ---- permissions -------------------------------------------------------
  'permission.label': 'Permissions',
  'permission.read': 'Read only',
  'permission.workspace': 'Workspace write',
  'permission.full': 'Full access',
  'permission.auto': 'Automatic',

  // ---- top bar -----------------------------------------------------------
  'toolbar.toggleSidebar': 'Toggle sidebar',
  'toolbar.toggleFiles': 'Right sidebar',
  'toolbar.settings': 'Settings',
  'toolbar.refresh': 'Reload this session',
  'toolbar.language': 'Language',
  'toolbar.theme': 'Theme',
  'toolbar.skin': 'Skin',
  'toolbar.noSession': 'No session selected',

  // ---- theme -------------------------------------------------------------
  'theme.system': 'Follow system',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'skin.glass': 'Liquid glass',
  'skin.md3': 'Material Design 3',

  // ---- run state ---------------------------------------------------------
  'run.idle': 'Idle',
  'run.done': 'Finished',
  'run.failed': 'Load failed',
  'run.thinking': 'Thinking',
  'run.responding': 'Writing',
  'run.tool': 'Running {name}',
  'run.toolShell': 'Executing {name}',
  'run.waiting': 'Waiting for you',
  'run.compacting': 'Compacting context',

  // ---- composer ----------------------------------------------------------
  'composer.placeholder': 'Send a message… (Enter for a new line, Ctrl+Enter to send, paste images directly)',
  'composer.send': 'Send',
  'composer.stop': 'Stop',
  'composer.attach': 'Add image',
  'composer.preview': 'Preview',
  'composer.processingImages': 'Processing images…',

  // ---- common actions ----------------------------------------------------
  'action.close': 'Close',
  'action.refresh': 'Refresh',
  'action.retry': 'Retry',
  'action.cancel': 'Cancel',
  'action.confirm': 'Confirm',
  'action.open': 'Open',
  'action.download': 'Download',
  'action.rename': 'Rename',
  'action.copy': 'Copy',
  'action.cut': 'Cut',
  'action.paste': 'Paste',
  'action.delete': 'Delete',

  // ---- containers --------------------------------------------------------
  'container.newTab': 'New tab',
  'container.pick': 'Choose a tool for this tab',
  'container.files': 'File explorer',
  'container.filesDetail': 'Browse the workspace, manage files, preview common formats',
  'container.preview': 'File preview',
  'container.previewDetail': 'Preview images, PDF, audio, video, Markdown and code',
  'container.git': 'Git status',
  'container.gitDetail': "See the workspace's branch, changes and diffs",
  'container.switch': 'Switch tool',
}

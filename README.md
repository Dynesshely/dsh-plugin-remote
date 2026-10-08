# Remote Control · 遥控页面

一个 Host 插件（bundle）。它在 DSH 桌面版进程里**自己开一个 HTTP 监听**，对外提供一个 **Vue 3 + Vite + Tailwind 的单页应用**：手机/平板/另一台电脑打开就能看会话、看实时生成、发消息（含图片）、回答提问、切模型与权限、看 token 与上下文占用。

它**不碰**桌面版原有的 `127.0.0.1:19387` 载体（那个口子被 token 挡着、并且假定访问者是 Electron 窗口），也不加载 DSH 前端资源——页面是插件自己构建并发布的静态 bundle。

## UI

- **视觉**：液态玻璃（liquid glass）——背景是**多层漂移光场**（三组不同周期/路径的位移与缩放，外加 41s 的色相循环），面板是 `backdrop-blur` 毛玻璃 + 高光内描边 + 柔和投影；浅/深两套配色各自调过透明度与描边。侧栏、顶栏、输入卡片与品牌图标统一 **18px 圆角**（`.panel-tight` / `.brand-tile`）。
- **站点图标**：`ui/public/` 里放的是 **DSH 应用图标**（由 `resources/icon.png` 生成），构建后 `favicon-32/64.png`、`apple-touch-icon.png`（iOS 加到主屏用）随站点发布；应用内品牌位用同一张 `app-icon.png`，**硬裁剪**成圆角矩形——`.brand-tile` 固定 `border-radius:10px`，在 32/36px 的尺寸下与侧栏面板 18px 的圆角观感一致（遮罩 + 放大 125% 把源图标自带的圆角方底切掉）。站点标题与侧栏标题均为 **DSH REMOTE**。
- **控件全部自绘**：图标是内联 SVG 描边字形（`AppIcon.vue`，无图标字体/外链），下拉选择器是自绘 combobox（`ComboBox.vue`，支持 ↑/↓/Enter/Esc 与 `role="listbox"`），上下文占用是 SVG 圆环，运行态是脉冲点——没有一处用原生 `<select>` 或系统控件。
- **弹出层**：combobox 的 listbox 与两个设置/详情弹层都用 `Teleport` 挂到 `<body>`。这既避免被祖先裁剪，也让 `backdrop-filter` 真正采样页面背后的内容——嵌在已有毛玻璃面板里的子元素是无法「穿透」父级背景做模糊的。
- **布局与移动端判定**（`lib/layout.js`）：视口宽度**不再是唯一判据**。满足**任一**条件即进入移动端模式——① 视口 < `wide`（44rem，含横屏手机）；② **prompt 编辑区底部控件行放不下桌面控件**（状态信息栏被挤压）。第二个信号由 `ComposerBar` 用 `ResizeObserver` + `scrollWidth` 实测得出（被挤压的控件自身盒子会收缩、但内容宽度不变，正是"放不下"的证据），并与视口信号取或。
  - 移动端模式：抽屉式侧栏、输入区图标按钮（info/设置）、顶栏主题下拉只留图标、单行占位文案、手势可用；桌面模式：常驻侧栏、完整状态栏与模型/权限控件。
  - 实测出来的桌面控件所需宽度只会**单调增长**（取历史最大值），配合 6% 的迟滞，因此不会在临界宽度反复抖动。
  - 整页 **pin 在视口上**（`#app{position:fixed;inset:0}` + `overflow:hidden`），只有转录区自己滚动——移动端地址栏伸缩不会把页面滚走；输入区带 iOS 安全区内边距。侧栏在桌面模式可**收起/展开**（顶栏左侧按钮，状态持久化），移动模式同一按钮开合抽屉。
- **主题**：顶栏的自绘 combobox 切换 `跟随系统 / 浅色 / 深色`，持久化到 localStorage，`<html class="dark">` 驱动 Tailwind 深浅色；顶栏里主题下拉与刷新按钮共用 36px 的 `.control`/`.icon-btn` 高度，顶栏自身只留淡色底（不加 blur），这样里面的控件才有可见的毛玻璃效果。
- **会话分组**：按 `workspaceRegistry` 的工作区树分组（`sessionIds` 为准，cwd 前缀兜底）。工作区是**父级行**（图标块 + 13px 半粗标题 + 路径副标题 + 数量徽标 + 折叠箭头），会话行缩进在一条**层级引导线**之后；分组折叠状态持久化（`rc.collapsed`）。
- **转录（面向 agent 特性）**：助手的**思维链默认折叠**（点开才展开，显示字数），**展开后与正文同样按 Markdown 渲染**（历史与流式都一样，流式走 150ms 节流）；**工具调用默认折叠**为一行摘要（名称 + 参数预览 + 状态点），**连续同类调用再向上折叠成一组**（例如 `5 × read`，展开是五个折叠卡片，再展开某一个才是参数与结果；工具的成败状态会汇总到组头）；工具调用不会在正文里重复出现（正文只渲染文本块）。用户气泡（图片直接以缩略图呈现，**不再另挂「🖼 图片」字样**）、助手 Markdown（`marked` + `DOMPurify` 消毒）、异常轮次提示；**消息里的图片会渲染成缩略图并可点击全屏预览**（字节通过 `/api/attachment` 从会话日志取证，见 HTTP API）；**生成中的正文同样按 Markdown 渲染**（150ms 节流，避免每个 token 都重解析），思维链仍折叠并带光标。
- **代码高亮**：用 **highlight.js 11**（190+ 语言语法 + 模糊自动识别），Markdown 的围栏代码块走官方集成 **marked-highlight**（`langPrefix: 'hljs language-'`）。接入三处：① 工具调用的**参数**（以 `json` 为语言提示着色）；② 工具调用的**结果**——先按 JSON **解析**判定（确定），否则交给 highlight.js **自动识别**，但只在文本 ≥40 字符且识别置信度 ≥6 时着色，否则保持纯文本，免得把一行命令输出或普通句子染成乱七八糟的颜色；③ 围栏代码块（语言来自 info string，没写语言时同样走"JSON 解析 → 自动识别"）。未注册的语言一律降级为 `plaintext` 转义输出。
  - **安全性**：highlight.js 自己转义输出，而这页持有 agent 控制令牌、又用 `v-html`，所以单测里专门有 `<script>` / `<img onerror>` 注入用例，覆盖 JSON 与自动识别两条路径。
  - **主题**：**不引入第三方主题 CSS**，而是在 `style.css` 里用 Tailwind `@apply` 给 `.hljs-*` 类上色（浅/深各一套），配色跟随本页玻璃主题；想换成官方主题文件（如 `github.css` + `github-dark.css`）随时可换。
  - **体积**：highlight.js 整包单块打包（为了自动识别与任意围栏语言），JS 从 204KB 涨到 **1.13MB / gzip 379KB**，`vite.config.js` 里相应调高了 `chunkSizeWarningLimit` 并注明原因；资源是 `immutable` 一年缓存，每台设备只付一次。若哪天更在意手机首屏，可改为 `highlight.js/lib/common` 立即加载 + 其余语言 `import()` 按需分包（需接受"自动识别只覆盖常用语言"）。
- **输入区**：玻璃卡片（圆角 18px），内含附件缩略图轨、自适应高度文本框与底部工具行，整行控件同高 36px。
  - 桌面模式（且放得下）：`[附件] [状态信息栏]` 靠左顶置，`[模型] [权限] [停止] [发送]` 靠右顶置（`ml-auto`）——状态栏**宽度由内容决定**，模型/权限控件放宽到完整显示名称。
  - 移动模式（或放不下时）：`[附件] … [info] [设置] [停止] [发送]`——模型/权限收进**设置弹层**（只有模型列表滚动，**权限切换固定在弹层底部**，模型再多也不用滑到底），状态详情由 **info 按钮轻点**打开（长按会被 Chrome 识别成选中文本，故不用长按）；顶栏主题下拉**只显示图标**。
  - 图片：**在输入卡片任意位置粘贴**即可作为附件入队（也支持选择文件），已入队的缩略图**点一下全屏预览**；发送时按桌面端同样的形状提交——`{ type:'image', mediaType, data(base64), name? }` **字节随 prompt 一起走**，由 Host 在受理提交时落库，所以没有“先上传再引用”的两段式，也不会有悬空的临时附件。
  - 占位文案在窄屏只保留「发消息…」（长提示会折成两行，而占位符撑不高 textarea，第二行会被裁掉并让输入框看起来可滚动）。
  - 手势：移动模式下从**左边缘右滑**展开会话列表、在抽屉内**左滑**收起（水平位移 > 64px 且明显大于垂直位移才触发，避免与卡片内横向滚动冲突）。
  - 键盘：**Enter 换行、Ctrl/Cmd+Enter 发送**（与桌面端插件语义一致），手机用发送按钮。
- **会话操作**：发消息、发图（选择或粘贴，图片字节内联进 prompt）、停止当前轮次、切模型、切权限预设、回答提问（选项或自定义）。
- **上下文注记（Harness 注入）**：DSH 会把注入的上下文快照也写进会话日志（时间戳那条来自 `@deepseek-ai/dsh-time-context`：每步的当前时间、浏览器时区、距上一条模型可见消息的间隔）。它们**不是用户写的 prompt**，所以：① 判定是结构性的——注入消息带 `source.kind !== 'user'`（time-context 是 `time-context`），另有少数固定开头行做兜底；② **折进所属 prompt 气泡的右下角**，显示为「ⓘ 上下文」小胶囊（多条显示 `×N`），点开才看原文与 `source:` 标记；日志开头没有 prompt 可依附时退化为独立的 `context` 条目；③ **不计入 prompt 导航轨**。
- **历史深度**：`follow` 的初始窗口是 `maxMessages: 500, turnWindow: { minMessages: 320, minTurns: 20 }`——宿主会在**同时**满足两个下限的第一个轮次边界停止，所以小窗口（早先的 80/20/3）只会打开最后几轮，导航轨自然只有几个刻度；现在一次打开**二十多轮以上**。更早的历史用 `GET /api/older`（`page` 远端，`maxMessages: 200, minMessages: 150, minTurns: 10`）向前翻页，转录区顶部有「加载更早的消息」按钮，并在前插后补偿 `scrollTop`，所以读者视线不会跳。
- **Prompt 导航轨**（转录区右缘、纵向居中、桌面模式）：**每条用户 prompt 一个刻度**，聚拢在会话流的垂直中央（不是铺满整条高度的比例尺）。**悬浮**（或键盘聚焦）出玻璃预览卡——序号、图片数、prompt 文本（6 行截断，图片-only 显示「（仅图片）」）；**单击平滑跳转**到那条 prompt 并置顶；正在阅读的那条刻度会加亮。
  - 高亮哪一条由 `activeTick(tops, scrollTop, lead, bottomGap)` 决定：默认取「最后一个越过阅读线（顶部下移 80px）」的 prompt；**滚到底部（距底 ≤ `BOTTOM_SNAP` = 24px）时直接判定最后一条激活**——否则短尾巴、或内容不足一屏时，最后一条永远不会亮。
  - 悬浮**零延迟**：命中判定是**「指针 Y 减去列顶再除以格子高度」**（`indexAt`），不是逐格 `mouseenter` 竞速；条线与预览卡都在**同一帧**响应，所以鼠标快速划过去也能逐条纵览。预览卡在指针进入列后**只挂载一次**，之后仅更新内容与 `top`（`transition-[top] duration-100`），因此快速扫动看起来是**一张卡沿着列滑行**，而不是一连串弹窗闪断；条线自身的过渡压到 `duration-75`，扫过时不会拖影。键盘聚焦与鼠标同等即时。
  - 视觉与交互**分离**：可见的条线是 18×1.5px 的圆头横线（激活/悬浮那条高 3px、宽 24px），而**命中区是逐格无缝平铺的**——每个刻度占一个 `tickCellHeight(count, height)` 高的格子、彼此没有 margin，所以整列没有点不到的死角；看上去的"间距"只是格子里没被横线填满的部分。
  - 格子高度自适应：够用时保持 12px 的舒适格子，prompt 极多时逐级压缩（下限 4px），绝不溢出；而**居中由 flex 布局保证**，因此即便高度还没测出来也仍然是居中聚拢的。
  - 预览卡以**被悬浮刻度的 `offsetTop`** 为锚点（而不是按比例算），所以永远跟着那根条线；`previewCentre` 只在轨道够高时才做夹取，高度未知时直接跟随刻度（这正是之前"预览卡跑到页面右上角"的成因：`v-if` 让根元素在挂载时为 `null`，观察器没挂上、高度恒为 0）。
  - 刻度之外整列 `pointer-events-none`，底下的原生滚动条依旧可拖。纯逻辑在 `lib/rail.js`（`promptTicks` / `activeTick` / `tickCellHeight` / `previewCentre`），有独立单测。
- **提问（`ask_user_question`）**：这个工具调用不再渲染成 JSON 工具卡，而是按桌面端的样子渲染成**提问卡片**（`QuestionCard.vue`）——顶部 eyebrow + 标题（`header` 为主、`question` 为副）、选项行**单选显示序号 / 多选显示勾选框**（选中的行高亮描边）、`(Recommended)` 标记从标签里剥离并显示成「推荐」chip、描述文字 11px 次级色、末尾一个自由输入框（「其他…」）、多个问题时底部有 `i/n` 分页与上下一条按钮，右下角是「提交」。
  - **两处同一组件**：转录里那个工具调用的位置（卡片可原地作答）与输入区上方的 dock（`PendingPanel`），所以滚动到别处也不会漏答。
  - **作答链路**：`dsh-tool-ask-user` 用的是 `wait: { callId: exec.callId }`，因此提问请求的 callId **就是工具调用的 callId**；于是转录卡片能用 `tool/call` 的 callId 去 `state.pending.questions` 里认领状态——pending 时可交互，一旦不再 pending（本地或桌面已答、或超时）就自动变成**只读的作答记录**（按已收到的工具结果回显选中项与自定义文本）。
  - **捕获路径（踩过的三个坑）**：
    1. **主路径是会话日志，而不是瀑布**。提问工具调用本身就是一条持久 `tool/call` 事件：`data.callId` 就是答案要路由回去的那个 id，`data.arguments` 就是问题本体。所以监听 `session/event`（`emit` 语义——**所有被接纳的监听器都会跑，没有任何否决语义**）即可稳定捕获，作答仍走 `ctx.userQuestions.answer(agent, callId, …)`，配套的 `tool/result` 一到（本地/桌面/超时结算都算）自动退场。
    2. **waterfall 观察者必须 `prepend`**。Cordis 的 waterfall 是 outermost-first，且**不调 `next()` 的监听器会否决链上其余监听器**（原话：*a listener that does not call `next()` vetoes the rest of the chain*）。桌面 answerer 先注册、拿到答案直接返回，于是追加在它后面的观察者永远轮不到。这条瀑布路径现在仍保留（`{ prepend: true }`）作为**次要来源**，覆盖不经过工具调用的提问。
    3. **实测该瀑布载荷里没有 `wait`**：`rootQuestions` 会 +1、`missingWait` 也会 +1（收到事件但拿不到 `callId`）——这正是改用日志路径的直接原因。`/api/diagnose` 的 `lastRequest` 会记录最近一次瀑布载荷的 keys 便于复核。
    另外这类事件按 Agent 作用域派发（`dsh-scope` 的 invariant 用 `args[0].agent` 取路由键），而桌面启动会先恢复你正在看的会话，**它的 agent 早于 profile bundle 加载完成就已存在**，`agent/created` 不会再触发——所以加载时还要用 `ctx.get('agents').list()` 枚举已存在的 agent。`GET /api/diagnose` 可核对 `attached` / `liveAgents` / `sessionCalls` / `rootQuestions` / `missingWait`。
  - 交互与桌面一致：单选点一下即选中并自动跳到下一个问题，多选是切换；Enter 提交；未答完时提交按钮禁用并把焦点跳回缺答的那一题。
  - **`(Recommended)` 标记**：桌面端的用途不是显示徽标，而是 `recommendedFirstOption` —— **把第一个被标记的选项预选为草稿**（用户仍需提交）。这里照做（`initialDraft`），并额外在该选项旁显示一个「推荐」chip 说明它为什么一开始就是选中态。
- **审批**：只展示不代答（见下）。

### 重新构建 UI

```bash
pnpm --dir plugins/remote-control/ui install
pnpm --dir plugins/remote-control/ui run build   # 产出 ui/dist
```

> `style.css` 里有 `@source not "../../dist"`：Tailwind 的自动源检测会扫描整个项目，若把构建产物算进去，一个只在旧 `dist` 里存在的类会被每轮构建重新发射出来（自我喂养）。

未构建时插件会退回到旧的单文件页面 `page.html`，功能可用但界面简单。

## 它用到的 Host 能力

| 能力 | 来源 |
|---|---|
| 会话目录（标题/运行态/子代理） | `ctx.sessionController.list()` |
| 工作区分组 | `workspaceRegistry.list()`（`sessionIds` 归属，cwd 兜底） |
| 起始快照 + 历史事件 + 助手增量 | `ctx.sessionController.follow()` |
| 发消息（文本 / 图片） | `ctx.attachments.saveImages()` + `ctx.sessionController.prompt()` |
| 停止当前轮次 | `ctx.sessionController.cancel()` |
| 模型目录 / 切换 / 当前选择 | `sessionController.modelCatalog()` / `selectModel()` / Session 的 `requestHeader()` |
| 权限预设目录 / 当前 / 切换 | `permissionPresets.catalog()` / `current()` / `set()` |
| 提问的展示与远程作答 | `user-questions/request` 瀑布（观察，始终 `next()`）+ `ctx.userQuestions.answer()` |
| 审批的展示 | `approval/request` 瀑布（只观察） |

## 用法

1. 插件启动时会在 Host 日志里打印一行可直接打开的链接：
   `http://127.0.0.1:19400/?k=<token>`
2. 用手机/另一台设备打开它。**`?k=` 只用于第一次**：页面把 token 换成 HttpOnly + SameSite=Strict 的 cookie，然后把 URL 清干净。
3. token 首次启动时随机生成，写在 `~/.dsh/remote-control/auth.json`（0600）；也可以用配置里的 `token:` 固定一个。

> **改完 Host 侧代码要重启 DSH**：客户端插件能靠浏览器的模块图热更新，但 Host 半边属于 Loader 的模块生成，替换后需要重启才会加载新代码（`install_bundle`/开关 bundle 只会重新 apply 同一个模块）。

## 配置

```yaml
- id: remote-control
  name: '@local/dsh-remote-control'
  config:
    bind: '0.0.0.0'     # 当前配置：对网络开放（配合下面的防火墙规则）；改回 '127.0.0.1' 并重载即可收回
    port: 19400
    token: ''           # 留空 = 自动生成并持久化
```

- **隧道/VPN（推荐）**：保持 `bind: 127.0.0.1`，用 WireGuard/Tailscale 把设备带进来，再访问 `127.0.0.1:19400`。
- **直接局域网**：改成 `bind: 0.0.0.0`，用 `http://<局域网IP>:19400/?k=...` 打开。明文 http 且非本机地址时浏览器视为**非安全上下文**：PWA 安装、通知、剪贴板 API 不可用（页面功能不受影响），建议在反代上终止 TLS。

### Windows 防火墙

直连局域网还需要放通入站端口。仓库里带了脚本（**需要管理员权限**，会弹 UAC）：

```powershell
# 放通（入站 TCP 19400，仅 Domain/Private 配置文件，且只允许本地子网）
pwsh -File plugins\remote-control\tools\firewall-remote-control.ps1

# 撤销
pwsh -File plugins\remote-control\tools\firewall-remote-control.ps1 -Remove
```

规则名：`DSH Remote Control (TCP <port>)`。注意它**只放通防火墙**——插件仍按 `bind` 决定监听地址；`bind: 127.0.0.1` 时这条规则不产生任何暴露，只有把 `bind` 改成 `0.0.0.0`（或具体网卡地址）局域网才真正可达。

## HTTP API

| 路由 | 作用 |
|---|---|
| `GET /` 、`/assets/*` | SPA shell 与静态资源（其余 GET 回落到 shell） |
| `GET /healthz` | 免鉴权存活检查 |
| `POST /api/login` / `logout` | token ↔ cookie |
| `GET /api/state` | 会话 + 工作区 + 待交互 + 绑定信息 |
| `GET /api/stream?sessionId=` | SSE：`hello` / `pending` / `sessions` / `frame` / `stream-error` |
| `GET /api/models`、`GET /api/selection?sessionId=` | 模型目录与当前选择 |
| `GET /api/attachment?sessionId=&attachmentId=` | 从会话日志取回一张图片的字节（转录/预览用） |
| `GET /api/older?sessionId=&beforeSeq=` | 向前翻一页历史（`page` 远端），返回 `{records, hasMore}` |
| `GET /api/diagnose` | 自检：提问/审批的捕获计数、已挂上监听的 agent id、当前挂起的提问（含 `answerable`） |
| `POST /api/select-model` | 切换模型 |
| `GET /api/permissions?sessionId=`、`POST /api/permission` | 权限预设目录与切换 |
| `POST /api/attach` | 图片（data URL）单独入附件库，返回 `ImageAttachmentRef`（SPA 已改走内联字节，此路由保留给脚本使用） |
| `POST /api/send` | `content`：`{type:'text'}` 与 `{type:'image', mediaType, data}`（内联 base64，可到 16 MB；兼容旧的 `text` 与 `{type:'image', attachment}`） |
| `POST /api/cancel`、`POST /api/answer` | 停止轮次、作答 |

## 能力边界（有意为之）

- **不能远程确认工具审批**。审批是单槽 waterfall、由桌面端 answerer 拥有；劫持它会让桌面面板卡在一个永远不来的答复上。页面展示「等待确认：<工具> — <原因>」并要求回桌面处理。
- 切权限预设需要**活着的 Session**：冷会话会先被 resume（`resolveAgent`）再改，失败会返回明确错误。
- 不是桌面 UI 的镜像：没有文件树、终端、轨迹视图、队列编辑、附件以外的多模态。

## 安全

- 32 字节 token 门禁全部 `/api/*`（`/`、`/healthz` 例外）；常量时间比较；Cookie 之外也接受 `Authorization: Bearer <token>`。
- 登录失败按来源限速（6 次/分钟 → 429）；请求体上限 64 KiB；静态资源目录逃逸已拦截；页面 CSP `default-src 'none'` + `frame-ancestors 'none'`。
- 模型输出以 `DOMPurify` 消毒后再渲染（页面持有 agent 控制凭据，不能信任任何模型文本）。
- **拿到 token 就等于拿到「让这台机器上的 Agent 执行命令」的能力**，别外传；`bind` 到局域网时务必配 TLS 或走隧道。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：监听、鉴权、路由、SSE、静态资源、会话/工作区/模型/权限/附件适配 |
| `ui/` | Vue 3 + Vite + Tailwind SPA 源码（`ui/dist` 为构建产物，插件直接发布） |
| `page.html` | 旧单文件页面，`ui/dist` 缺失时的回退 |
| `package.json` / `cordis.patch.yml` | bundle 清单与 profile 行（bind/port/token） |
| `tools/` | 测试套件、冒烟探针与防火墙脚本 |

## 测试

全部是可独立运行的脚本（不需要 DSH 在跑；集成套件会在进程内启动插件并用真实 HTTP + SSE 访问它）：

```bash
# 从工作区根目录
node plugins/remote-control/tools/test-remote-control.mjs      # Host：鉴权、路由、SSE、模型/权限、附件、内联图片、翻页、提问/审批捕获
node plugins/remote-control/tools/test-remote-ui-store.mjs     # 转录归并：工具分组、上下文注记、图片
node plugins/remote-control/tools/test-remote-ui-questions.mjs # 提问：参数/作答解析、推荐标记、转录认领
node plugins/remote-control/tools/test-remote-ui-rail.mjs      # 导航轨：刻度、激活判定、格子几何
node plugins/remote-control/tools/test-remote-ui-layout.mjs    # 移动端判定：视口 vs 控件行溢出
node plugins/remote-control/tools/test-remote-ui-highlight.mjs # 高亮：语言集、注入、自动识别、Markdown 管线

# 对正在运行的实例做只读探针
node plugins/remote-control/tools/smoke-remote-control.mjs http://127.0.0.1:19400 <sessionId>
```

## 卸载

设置 → 插件 → 卸载 `Remote Control` 即可，监听随即关闭。

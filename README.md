# 头歌代码复制助手（EduCoder Copy Helper）

一个独立的 Chrome / Edge 扩展（Manifest V3），专门解决两类场景：

1. **网页 IDE 里已经写好的代码复制不出来**——页面用 `user-select: none`、拦截 `copy` / `contextmenu`、接管 `selectstart` 等手段禁止选中与复制；
2. **本地写好的代码粘不进去**——头歌这类在线 IDE 使用 CodeMirror / Monaco 等编辑器，只接受"真实键盘输入"，脚本合成的 `paste` 事件会被丢弃。

结论先说：**这类前端层面的"禁止复制/粘贴"可以 100% 绕过**，因为限制发生在页面自己的 JS/CSS 里，而扩展运行在比页面脚本更早、更高的权限层。但**服务端根本不下发的内容**（付费墙背后的内容、图片/Canvas 里画的文字、DRM 保护内容）绕不过——那不是"禁止复制"，而是"没有可复制的文本"。

## 它做了什么

| 能力 | 实现方式 | 适用页面 |
| --- | --- | --- |
| 取出代码 | 直接读取编辑器实例（CodeMirror 5/6、Monaco、Ace、textarea、contenteditable），不依赖 DOM 选中 | 任何在线 IDE |
| 选对编辑器 | 扫描页面上所有可编辑区（含 Web Component 里的 shadow DOM），按"可见 → 字符数 → 面积"打分；也可在弹窗下拉里精确指定，或选"当前光标所在编辑器" | 页面上有多个编辑器的 IDE |
| 复制到剪贴板 | 一键 `navigator.clipboard.writeText`，失败自动退回 `execCommand` | 任意 http(s) 页面 |
| 粘贴代码 | Chrome 调试协议 `Input.insertText`（可信输入），或用真实按键事件逐字键入 | 拒绝合成 paste 的编辑器 |
| 解除复制/右键限制 | `document_start` 注入样式 + 事件捕获层拦截页面监听器 | 整页禁止选中的页面 |
| 执行脚本 | `Runtime.evaluate` 在页面主世界执行任意表达式 | 任意 http(s) 页面 |
| 诊断 | 扫描编辑器类型、序号、frame、每个 frame 的候选数量与注入情况、解锁状态、调试权限，可一键"复制诊断" | 排错用 |

## 安装

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）。
2. 右上角开启 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择本目录 `educoder-copy-helper`。
4. 首次粘贴时会弹出调试权限提示，点弹窗里的 **"同意并启用调试权限"** 完成授权。

> 说明：Chrome 137+ 已移除命令行 `--load-extension` 参数（自动化和测试时必须用 `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked`），但**手动加载已解压扩展**不受影响，上面的步骤照常可用。

## 使用

### 1. 取出网页里的代码

打开头歌代码编辑页 → 点扩展图标 → "读取编辑器" 自动执行，文本框显示代码 → **复制**（或 `Ctrl+C` 直接复制文本框内容）。

头歌一页里往往同时有"代码编辑区"和"自定义测试用例"两个 CodeMirror。扩展默认自动选**最像代码编辑器**的那个（可见 → 字符数 → 面积综合打分），一般不需要手工干预；如果自动选错，"代码取出"卡片里会出现 **编辑器** 下拉框，选另一项即可，弹窗会按站点记住你的选择，读取和写入都用同一个目标，不会再"读代码区、写测试用例框"。

**下拉框里没有代码区怎么办**：某些页面的代码编辑器被 Web Component（shadow DOM）或特殊 iframe 包住，扩展枚举不到，这时用下拉框里的第二项 **"当前光标所在编辑器（先点一下代码区）"**——先在网页上点一下代码区让光标进去，再回弹窗读取或写入。这个模式不看类型和序号，只认"你最近点过/聚焦过的那个编辑器"，选中后同样会被记住。

打开弹窗时浏览器会把焦点从网页拿走，编辑器光标会停止闪烁。扩展在页面里用捕获阶段监听 `focusin` / `mousedown` / `pointerdown`，把**最近一次交互的元素**记了下来，所以：

- 点一下代码区就打开弹窗，仍然能定位到它；
- 只是"点一下"没真正拿到焦点（部分编辑器会这样），也能定位到被点的编辑器。

如果某个页面什么候选都没有、也定位不到，用"诊断 → 复制诊断"把报告发出来（贴到对话里最有用）。

**代码只在屏幕上渲染、DOM 里读不到时**，用"代码取出"卡片里的 **强制读取（Ctrl+A/C）**：先在网页上点一下代码区，再点这个按钮（新版还会自己找编辑器正文区域的中心点，避免点到右侧 minimap 上）。其实从 v1.3 起，遇到 Monaco 这种"DOM 里只有可见行"的编辑器，直接点 **读取编辑器** 就会自动改用键盘通道把全文拿回来，不用再单独点强制读取。扩展用 CDP 发真实的 `Ctrl+A` + `Ctrl+C`，把内容送进系统剪贴板再读回来。它先**放行页面自己的复制实现**（画布编辑器、CodeMirror 都靠这个），剪贴板没变化时再**打开快捷键护盾、改走浏览器原生复制**——两种方式里只要有一种成立，就能拿到代码，完全不依赖"认不认得出编辑器"。

如果页面是"不可选中"的普通文章/题目描述，先保持"页面解锁"开关为开，然后正常鼠标选中复制即可。

### 2. 把本地代码粘进去

本地复制好代码 → 打开头歌编辑器页面 → 扩展弹窗 → "从剪贴板读取" → 勾选/取消 **覆盖原内容** → 点 **写入编辑器**。

- 默认 `insertText` 模式：几乎瞬间完成，适合大段代码；
- 如果目标编辑器仍然拒绝，切到 **逐字键入** 模式：走 `Input.dispatchKeyEvent`，和真人敲键盘在浏览器层面无法区分（速度稍慢，几万字会明显变慢）。

写入后弹窗会显示 `method`（`insertText` / `keys` / `setValue`）和 `verified`（是否与剪贴板逐字一致）。`setValue` 是最后兜底，说明可信输入失败过。

如果你在下拉框里选了 **"当前光标所在编辑器"**，写入前要先点一下目标编辑器（让页面焦点落在里面），否则会报 `NO_ACTIVE_EDITOR`。

**写入也一样有兜底**：代码写进"代码写入"的文本框后，先在网页上点一下代码区，再点 **强制写入（Ctrl+V）**。扩展把文本写进系统剪贴板，用 CDP 发真实的 `Ctrl+V`（默认先 `Ctrl+A` 全选覆盖），让浏览器按标准粘贴路径把内容塞进编辑器；粘完再 `Ctrl+A` + `Ctrl+C` 读回来和原文比对，把结论显示在弹窗里。它和强制读取一样，不依赖"认不认得出这个编辑器"。

**强制读取 / 强制写入实际有两条通道，会自动依次尝试**：

1. **先让页面自己跑**（不拦页面监听器）：很多画布编辑器、CodeMirror 5 自己监听 `keydown` 再调 `clipboard.writeText` / `readText`，只有放行它才拿得到内容；
2. **再护盾 + 浏览器原生**：页面自己不行、或者它的剪贴板调用被拒，就打开快捷键护盾，让浏览器默认的全选/复制/粘贴执行。

两条都失败时（例如平台明确检测并拦截了粘贴事件，弹"该作业设置了禁止复制粘贴"），扩展会**自动改走逐字键入**：粘贴后回读发现内容没变，就直接换成真实按键逐字敲进去，并把结论显示出来。也可以手动点 **逐字键入写入（模拟打字）**：不开剪贴板、不触发 `paste`，直接用 CDP `Input.dispatchKeyEvent` 一个字符一个字符敲进去——平台看到的完全是真人打字。缺点是慢（几百行代码要等十几秒到一分钟），适合"只差这一步就能交"的场景。

### 3. 执行脚本

"执行脚本"卡片里写任意 JS 表达式，`Ctrl+Enter` 执行，返回值以 JSON 形式显示。例如：

```js
document.querySelector('.ace_editor') ? 'ace' : 'other'
```

### 4. 页面解锁

弹窗里的开关（默认开启）控制是否解除复制/右键限制。关掉后刷新页面即恢复原状。

## 原理

限制来自三层，逐层突破：

**第一层：CSS**。`user-select: none` 让浏览器不允许选中文本。扩展在 `document_start` 注入 `html, body, body * { user-select: text !important }`，并保持 `::selection` 高亮可见。

**第二层：事件监听**。页面在 `document` / `window` 上监听 `copy`、`contextmenu`、`selectstart`、`keydown` 并 `preventDefault()`。扩展在 `window` 的**捕获阶段**注册同类监听器，先于页面拿到事件，调用 `stopImmediatePropagation()` 阻止页面的处理器执行，同时保留浏览器默认行为（所以复制/右键/选中照常工作）。针对 `oncopy="return false"` 这种内联写法，直接清除元素上的 `on*` 属性，并用 `MutationObserver` 处理动态插入的节点。

**第三层：编辑器只认真实输入**。CodeMirror 5 等编辑器监听的是 `input`、`keydown` 或 `beforeinput`，脚本 `dispatchEvent(new ClipboardEvent('paste'))` 会被识别为合成事件丢弃。这里复用浏览器控制项目的做法：扩展通过 `chrome.debugger` 接入 CDP：

- `Input.insertText`：在浏览器进程层面插入文本，同时更新选区，与用户输入同等可信；
- `Input.dispatchKeyEvent`：逐字发送 `rawKeyDown` / `char` / `keyUp`，带正确的 `key`、`code`、`windowsVirtualKeyCode`、`modifiers`（大写字母和 `!@#` 等符号自动带 Shift）。

写入前先让编辑器自身执行"全选"：在页面主世界注入一个探测函数，按编辑器类型分别调用 `execCommand('selectAll')`、`setSelection(model.getFullModelRange())`、`selectAll()` 等，避免 CDP 的 `commands: ['selectAll']` 在 textarea/编辑器上无效导致"覆盖"变成"插到光标处"。写入后再读一次编辑器内容和原文比对，作为 `verified` 的依据。

**读取编辑器**用的是同一套注入函数：优先读实例（`element.CodeMirror.getValue()`、`monaco.editor.getModels()`、`ace.edit(el).getValue()`、CM6 `view.state.doc.toString()`），读不到才退回 textarea/contenteditable；多 frame 页面会用 `chrome.scripting.executeScript({ allFrames: true })` 扫一遍。

一个页面有多个编辑器时（头歌的"代码编辑区"+"自定义测试用例"就是两个 CodeMirror），**不能按类型先到先得**——早先的实现只要发现第一个 `.CodeMirror` 就直接返回，于是 3 个字符的测试用例框把代码区挤掉了。现在改成：

1. 一次性列出页面上**所有**可编辑区，每个带 `type`、同类序号 `nth`、字符数、面积、是否可见；
2. 打分 `可见(1e6) + min(字符数,20000)×20 + min(面积,400000)/40`，取最高分作为"自动"目标；
3. 读取和写入都只认同一个定位 `{type, nth}`（`nth` 是同类元素在 DOM 里的序号，写入前后稳定），所以不会出现"读代码区、写测试用例框"；
4. 弹窗把这些候选渲染成下拉框，手动选过的目标按站点记住，存在 `chrome.storage.local` 的 `editorChoice` 里。

**枚举必须穿透 shadow DOM**。`document.querySelectorAll('.CodeMirror')` 只看得见 light DOM；如果页面把编辑器包进 Web Component（`attachShadow({ mode: 'open' })`），普通查询会漏掉它，候选里就只剩页面上的小输入框，表现是"下拉框里每一项都写进了测试用例框"。所以候选枚举走的是递归深度遍历：从 `document` 出发，遇到 `shadowRoot` 就进去继续查，去重后统一打分。

**明确指定了目标就绝不静默替换**。以前命中失败会退回"同类型随便找一个"或"自动最高分"，于是你选了代码区、写进去的却是别的小框，还显示成功。现在：

- 显式 `{type, nth}` 找不到 → 直接报 `EDITOR_NOT_FOUND`，页面一个字都不动；
- "当前焦点"模式找不到焦点 → 报 `NO_ACTIVE_EDITOR`，提示先点一下代码区；
- 只有在下拉框选"自动"时，才允许按打分挑一个。

**"当前焦点"模式**是最后一道保险：注入函数沿合成树（`parentNode || host`）往上找 `document.activeElement` 被哪个编辑器包住——CodeMirror / Monaco 都把焦点放在内部的隐藏 `textarea` 上，所以这个判断比类型识别更可靠。它完全绕开"认不认得出这个编辑器"的问题。

但"打开弹窗"本身会夺走页面焦点，`document.activeElement` 可能已经变回 `body`。所以 `unlock.js` 在捕获阶段用 `focusin` / `mousedown` / `pointerdown` / `keydown` 记住**最近一次交互的元素**（挂在 `window.__educoderLastTarget`），焦点判断先试它、再试 `document.activeElement`。这样"点一下代码区 → 打开弹窗 → 读取"的顺序不会失效；即使编辑器没真正拿到焦点、只是被点了一下，也能定位。

**第四层：DOM 完全读不到时，走"键盘剪贴板通道"**。有些站点（例如你的头歌版本）把代码区渲染成画面、封装进封闭组件或特殊 iframe，`querySelectorAll`、`document.activeElement`、注入函数都够不着，候选里只剩页面上的小输入框——这正是"下拉框里每一项都写进测试用例框"的真实原因。此时不要试图读 DOM，而是借用浏览器自己的编辑命令：

1. **封闭影子 DOM 捕获**：`unlock.js` 在 `document_start` 猴补 `Element.prototype.attachShadow`，把每个 `shadowRoot`（包括 `mode: 'closed'` 的）都记进 `window.__educoderShadowRoots`；枚举候选时把它们当额外种子遍历，所以封闭组件里的编辑器也能列出来。
2. **按坐标点回焦点**：canvas/封闭组件没法用 JS `focus()`，`unlock.js` 记下最近一次 `mousedown`/`pointerdown` 的屏幕坐标（`window.__educoderLastPoint`），后台用 CDP `Input.dispatchMouseEvent` 在那个坐标发可信鼠标点击，把焦点还给用户刚才点的编辑器。
3. **快捷键护盾**：页面常在 `window` 捕获阶段 `preventDefault()` 掉 `Ctrl+A/C/V`（这正是父项目里必须绕过的坑）。后台先注入 `window.__educoderShortcutShield(5000)`，让解锁脚本在这 5 秒内对 `a/c/x/v` 和 `paste` 抢先 `stopImmediatePropagation()`——页面监听器收不到事件，浏览器默认的全选/复制/粘贴照常执行。
4. **CDP 可信按键**：`Input.dispatchKeyEvent` 按下 `Control`（`modifiers: 2`）→ 组合键 → 依次 `keyUp`，与真人按键在浏览器层面不可区分；读的时候 `Ctrl+A` + `Ctrl+C` 把选区写进系统剪贴板，写的时候先 `Ctrl+A` 覆盖再 `Ctrl+V`。

这条路完全不依赖编辑器类型识别，所以"识别不出编辑器"不再等于"用不了"。注意：Windows 剪贴板换行是 CRLF、页面文本是 LF，扩展比对时统一归一化，`verified` 不会因为换行符误报失败。

5. **两条动作用户快捷键的方式，先页面后浏览器**：护盾不是无条件开的。默认先"不拦"——让页面自己的 `keydown → clipboard` 实现跑（画布编辑器都这么做）；剪贴板没变化再开护盾、走浏览器原生全选/复制/粘贴。这也解释了旧版本"强制读取只读到 1 个字符"：护盾把页面自己的复制路径也拦了，而原生复制对画布没有可复制的内容。
6. **纯键入兜底**：`keytype` 走 `typeByKeyEvents`，全程只发真实键盘事件，不碰剪贴板，所以"平台禁止粘贴"对它无效——它看起来就是打字。
7. **Monaco 的另一种形态**：头歌的在线 IDE 把 Monaco 打进了 bundle，页面里没有 `window.monaco`，只有 `.monaco-editor` 渲染出来的行。这种情况扩展退化成"DOM 候选"（读 `.view-line` 拼文本），并在读取结果里标记"只有可见部分"——这时点"读取编辑器"会**自动**改用键盘通道拿全文（弹窗里显示"键盘读取"和"DOM 里只有 N 字符"），DOM 里只渲染可见行的问题对用户就透明了。写入时 `Input.insertText` 落在 Monaco 1px 的隐藏 `textarea` 上不会进文档，所以会自动退到真键盘：点正文 → `Ctrl+A` → 逐字敲（换行发真实 `Enter` 键）。
8. **点焦点要点正文**：Monaco 右侧的 minimap 也是 `<canvas>`，按"用户上次点的坐标"点回去很容易点在 minimap 上——焦点没进编辑器，`Ctrl+A` 就变成选中整个页面 DOM，`Ctrl+C` 只能拿到视口里渲染出来的前几行（这正是"强制读取只读到前几行"的原因）。所以取点顺序改成了：**你自己点过、且落在编辑器里的位置** → 编辑器里**第一条可见行的中心** → 正文容器中心 → 正文左上角，逐个点、逐个验证。每点一次都会用 `document.activeElement` 确认焦点真的进了编辑器；如果所有候选点都点不进去（页面拿浮层盖住了编辑器、或坐标被别的东西挡住），就直接报 `FOCUS_NOT_IN_EDITOR`，**不会再默默把整页选上、复制出几行可见文字**。诊断报告里也新增了"焦点"一段（当前 `activeElement`、是否有编辑器、尝试过的取点），方便排查。
9. **页面结构快照**：诊断会注入一段只读探针，报告指针位置下的元素、画布数量、iframe（含 `sandbox` 属性）、DOM 里各类编辑器的数量与页面正文长度，用来判断"代码区到底是不是 canvas / 特殊 iframe"，不用再靠猜。

## 权限说明

| 权限 | 用途 | 为什么必须 |
| --- | --- | --- |
| `debugger` | 使用 CDP 发送可信输入、执行脚本 | 没有它就无法绕过"只接受真实键盘事件"的编辑器 |
| `scripting` + `host_permissions: <all_urls>` | 向页面主世界注入读取/聚焦/全选函数 | 头条/头歌的编辑器在 iframe 里，需要跨 frame |
| `clipboardRead` / `clipboardWrite` | 读剪贴板、写回剪贴板 | 剪贴板是"本地代码"与"网页 IDE"之间的中转站 |
| `storage` | 保存"页面解锁"开关和调试授权状态 | 授权只需一次 |

扩展**不上传任何数据**，没有后台服务器，不收集账号信息。所有代码都在本地：`background.js`、`content/*.js`、`popup.js`。

## 能力边界（绕不过去的）

- **付费墙/登录墙**：服务端不返回内容，前端怎么改都拿不到；
- **图片、Canvas、WebGL 渲染的文字**：没有文本节点可复制；若页面自己实现了复制（很多在线 IDE 是），用"强制读取"能走它的剪贴板路径拿到代码，纯图片/截图类内容则只能截图或 OCR；
- **DRM 保护内容**、浏览器内部页面（`chrome://`、扩展页、应用商店）；
- **被评测系统禁止的自动化**：本工具面向"自己已经写好的代码搬来搬去"，请勿用于考试作弊或绕过平台版权限制。

## 排错

| 现象 / 错误码 | 原因 | 处理 |
| --- | --- | --- |
| `DEBUG_CONSENT_REQUIRED` | 还没同意调试权限 | 弹窗点"同意并启用调试权限" |
| `DEBUGGER_BUSY` | 该标签页开着 DevTools | 关掉 F12 面板后重试 |
| `DEBUGGER_PERMISSION_REQUIRED` | Chrome 未授予调试权限 | `chrome://extensions` 里重新加载扩展并接受权限 |
| `RESTRICTED_PAGE` | 当前页是 chrome:// 或扩展页 | 切到头歌页面 |
| `未识别到编辑器，已向当前焦点插入` | 编辑器类型不在支持列表 | 用"诊断"看编辑器信息，必要时用"逐字键入"模式 |
| `写入后内容与剪贴板不一致` | 编辑器拒绝了输入 | 手动点一下编辑区再重试；或改用"逐字键入" |
| 读取/写入落到了"测试用例"小框 | 页面有多个编辑器，自动打分没选中你要的 | 用"代码取出"里的 **编辑器** 下拉框改选另一个，之后按站点记住 |
| 点了代码区、一开弹窗光标就停闪，读不到 | 弹窗抢走了页面焦点 | 已支持：扩展记住了最近点过的编辑器；实在不行先点代码区再选"当前光标所在编辑器"，然后立刻读取 |
| 选了"当前光标"后没法换回别的编辑器 | 旧版在读取失败时不渲染候选 | 已修：读取失败也会把候选列进下拉框，随时可以切换 |
| 下拉框里每一项都写进"测试用例"框，或代码区根本不在下拉里 | 代码编辑器被 shadow DOM / 特殊 iframe 包住，枚举不到 | 改用下拉框第二项 **"当前光标所在编辑器（先点一下代码区）"**；仍不行就点"诊断 → 复制诊断"发出来 |
| `EDITOR_NOT_FOUND` | 记住的 `{type, nth}` 在刷新后失效（页面结构变了） | 重新点一次"读取编辑器"，或在下拉框里重新选 |
| `NO_ACTIVE_EDITOR` | 选了"当前光标所在编辑器"但页面里还没有焦点 | 先在网页上点一下代码区，再回弹窗操作 |
| 复制按钮无效 | 页面无焦点 / 剪贴板被拒 | 点一下页面再试；扩展会自动退回 `execCommand` |
| 读取报"未检测到编辑器"，下拉框只有"当前光标所在编辑器" | 代码区是 canvas/封闭组件/特殊 iframe，DOM 里没有文本节点 | 点一下代码区 → 用 **强制读取（Ctrl+A/C）**；写入用 **强制写入（Ctrl+V）** |
| 强制读取拿到的是空内容 | 目标编辑器没拿到焦点，或护盾已过期 | 先在网页上点一下代码区再点按钮；护盾只开 5 秒 |
| 强制读取只读到"前几行" | 焦点落在 minimap / 行号槽上，`Ctrl+A` 选中的是页面 DOM | 新版会自动点编辑器正文区域；仍不行就先在网页上点一下代码正文再点按钮 |
| 强制写入后出现"乱码"或被拒绝 | 平台拦了 `paste`，文本被插到了错误位置 | 新版粘贴失败会自动改逐字键入；也可以手动点"逐字键入写入" |
| 读取提示"只有可见部分" | 该编辑器（如 Monaco）只把视口里的行写进 HTML | 点"读取编辑器"会自动改用键盘通道拿全文（显示"键盘读取"）；仍不行再点 **强制读取（Ctrl+A/C）** |
| `FOCUS_NOT_IN_EDITOR` | 自动点击被浮层/遮罩挡住，焦点没进编辑器；继续按键只会打在页面上 | 先在网页里手动点一下代码正文（扩展会记住这个位置），再重试；读取用 **强制读取**、写入用 **逐字键入写入（模拟打字）**；并把"诊断 → 复制诊断"发出来 |
| `NO_EDITOR` / `NO_ACTIVE_EDITOR` 但页面上确实有代码 | 站点用了非常规渲染 | 同上：强制读取 / 强制写入，或"诊断 → 复制诊断"发出来 |
| 平台弹"该作业设置了禁止复制粘贴，请手动输入代码" | 平台拦 `paste` 事件或校验 `inputType` | 用 **逐字键入写入（模拟打字）**，它不产生 `paste` 事件 |
| 强制读取只读到"1 字符"或页面正文 | 目标没拿到焦点，或护盾把页面自己的复制也拦了 | 先在网页上点一下代码区再点按钮；新版已改成"先放行页面、再护盾原生" |

## 目录结构

```
educoder-copy-helper/
├── manifest.json            # MV3 清单
├── background.js            # service worker：CDP、编辑器读写、消息路由
├── typing.js                # 文本 → 按键事件规划（planTyping / keyEventParams）
├── popup.html / popup.css / popup.js
├── content/
│   ├── unlock.js            # 主世界：解除复制/右键/选中限制
│   └── bridge.js            # 隔离世界：把开关状态同步给 unlock.js
├── icons/                   # 16 / 48 / 128 图标
└── test/
    ├── test-page.html       # 模拟"全面禁止复制粘贴"的页面
    ├── e2e.mjs              # 自动验收：起无头 Chrome、加载扩展、跑 58 项断言
    ├── vendor/codemirror5/  # 真实 CodeMirror 5.65.16（测试用，本地静态文件）
    └── fixtures/
        ├── cm5-editor.html               # 模拟 CodeMirror 5 的编辑器夹具
        ├── cm5-two-editors.html          # 双编辑器：小测试用例框 + 大代码区
        ├── shadow-editor.html            # 编辑器藏在 shadow DOM 里
        ├── closed-shadow-editor.html     # 编辑器藏在封闭 shadow root（mode: closed）里
        ├── iframe-editor.html            # 编辑器在 iframe 里（验证跨 frame 与键盘通道）
        ├── canvas-copy.html              # 代码只画在 canvas 上，页面自己实现 Ctrl+C / Ctrl+V
        ├── monaco-dom.html               # Monaco 形态：没有 window.monaco，只有 .view-line 渲染行
        └── real-cm5-two-editors.html     # 真实 CM5 双实例（贴近头歌）
```

## 本地测试

`test/test-page.html` 是一个"反人类"测试页：整页禁止选中，`copy`/`cut`/`paste`/`contextmenu`/`selectstart`/`Ctrl+C`/`Ctrl+X`/`Ctrl+A` 全部被 `preventDefault`，textarea 还会丢弃合成 `paste` 事件。加载扩展后在该页面验证：选中复制、右键、粘贴写入、脚本执行。

`test/fixtures/cm5-editor.html` 模拟头歌同款 CodeMirror 5 形态（内容只存在 `element.CodeMirror` 实例里，DOM 只是渲染副本），用于验证"读取实例 → 全选 → 写入 → 回调校验"整条链路。

`test/fixtures/cm5-two-editors.html` 还原真实头歌布局：DOM 里先出现 3 个字符的"自定义测试用例"小编辑器，后面才是体量更大的代码编辑区，外加一个普通 textarea 搜索框。它专门用来防回归——自动选择必须选中代码区，且按 `{type, nth}` 手动指定时只能改到指定那个；两个假编辑器内部都放了隐藏 `textarea`，所以"当前焦点"模式也在这里被覆盖。

`test/fixtures/shadow-editor.html` 把编辑器放进 `attachShadow({ mode: 'open' })`，外面只留一个 3 字符的小 textarea。它验证枚举确实穿透了 shadow DOM，而不是只挑到页面上的小输入框。

`test/fixtures/closed-shadow-editor.html` 用 `attachShadow({ mode: 'closed' })` 把编辑器彻底藏起来（外部拿不到 `shadowRoot`），验证猴补 `attachShadow` 的捕获确实生效。

`test/fixtures/iframe-editor.html` 把编辑器放进 `srcdoc` 的 iframe 里，主文档只留一个 3 字符小框，用来验证跨 frame 枚举，以及键盘剪贴板通道能作用到子 frame 的焦点元素。

`test/fixtures/monaco-dom.html` 还原头歌这种"Monaco 被打进 bundle"的形态：页面里没有 `window.monaco`，代码只以 `.view-line` 渲染在 DOM 里，右侧还有一块 `canvas.minimap-decorations-layer`（真实 minimap）。它用来卡住三个回归点：DOM 候选要能读、隐藏的 `textarea.inputarea` 不能当成编辑器、点焦点必须点正文而不是 minimap（否则 `Ctrl+A` 只会选中页面 DOM，复制出来就是"前几行"）。

`test/fixtures/monaco-blocked.html` 在 Monaco 夹具上加了一层覆盖整个编辑器的透明遮罩，模拟真实页面里浮层/水印挡住点击的情况：扩展必须报 `FOCUS_NOT_IN_EDITOR`，而不是把页面上的几行文字当成代码复制出来。

`test/fixtures/canvas-copy.html` 把代码画在 `<canvas>` 上、DOM 里一个字都没有，页面自己在捕获阶段处理 `Ctrl+C`（`navigator.clipboard.writeText`）和 `Ctrl+V`（`readText`）。它验证两件事：强制读取必须先"放行页面"，否则护盾会把页面自己的复制路径拦掉；以及"逐字键入"能在这种页面上把文本敲进输入框。

`test/fixtures/real-cm5-two-editors.html` 用 cdnjs 上真实的 CodeMirror 5.65.16（`test/vendor/codemirror5/`）起两个实例，整页 `user-select: none` 并拦截 `copy` / `cut` / `contextmenu` / `selectstart`，是最接近头歌实况的夹具：自动选择、当前焦点、可信输入、严格报错都在它上面验证。

维护者可以跑自动化验收（会自己起无头 Chrome、加载扩展、跑断言）：

```bash
node test/e2e.mjs
# 自定义浏览器与端口
CHROME_PATH=/path/to/chrome E2E_HTTP_PORT=8791 E2E_DEBUG_PORT=9333 node test/e2e.mjs
```

当前实测结果：

| 场景 | 结果 |
| --- | --- |
| 扩展加载 / service worker 注册 | ✅ |
| 解锁样式、内联属性清除、右键不再被取消 | ✅ |
| 读取 textarea（209 字符） | ✅ |
| `insertText` 写入 + 自校验 | ✅ `method=insertText verified=true` |
| 逐字键入（含中文、换行） | ✅ `method=keys verified=true` |
| CodeMirror 5 夹具读取与写入 | ✅ `type=codemirror5` |
| 双编辑器页：自动选中代码区而非测试用例框 | ✅ `nth=1`，候选 3 个 |
| 双编辑器页：按选择器精确读/写测试用例框 | ✅ 只改指定框 |
| 真实 CodeMirror 5.65（整页 `user-select:none` + 全部事件 `preventDefault`） | ✅ 读取、`insertText`、逐字键入、解锁复制全部通过 |
| 真实 CM5 双编辑器（小测试用例框 + 170 字符代码区） | ✅ 自动选 `nth=1`；`insertText` / 逐字键入均落在代码区；当前焦点模式定位正确；序号不存在时报 `EDITOR_NOT_FOUND` 且两编辑器不动 |
| 影子 DOM 里的编辑器 | ✅ 能枚举到 `contenteditable`，写入 `verified=true` |
| 当前焦点模式（焦点切到哪个编辑器就只改哪个） | ✅ 代码区 / 测试用例框分别命中 |
| 诊断报告 | ✅ 带 frame 列表与候选数量 |
| 打开弹窗丢了焦点后定位 | ✅ 仍命中刚才点的代码区（`nth=1`） |
| 只点一下、不产生焦点 | ✅ 命中被点的编辑器（`nth=0`） |
| 无焦点且无记忆 | ✅ 报 `NO_ACTIVE_EDITOR`，诊断仍返回候选供下拉框渲染 |
| 选中文本后 `copy` 不被页面取消 | ✅ `defaultPrevented=false` |
| 封闭 shadow root（`mode: 'closed'`）里的编辑器 | ✅ 读取 35 字符，写入 `verified=true` |
| 键盘通道：`Ctrl+A` / `Ctrl+C` 复制页面内容 | ✅ 剪贴板与页面逐字一致（CRLF 归一化） |
| 键盘通道：`Ctrl+V` 写入页面 | ✅ 页面内容被替换 |
| iframe 里的编辑器（枚举 + 键盘复制 + 键盘粘贴） | ✅ `frameId>0`、剪贴板与子 frame 一致、粘贴成功 |
| 画布页：DOM 读不到代码 | ✅ 只枚举到空文本框 |
| 画布页：放行页面后 `Ctrl+C` 能拿到画布代码 | ✅ 剪贴板与画布文本一致 |
| 画布页：放行页面后 `Ctrl+V` 页面能收到内容 | ✅ `window.__pasted` 一致 |
| 纯键入写入（不碰剪贴板） | ✅ 文本框内容逐字一致 |
| 诊断里的页面结构快照 | ✅ 画布数、iframe 数、各类编辑器计数 |
| Monaco 形态：枚举到 `.monaco-editor`（DOM 候选） | ✅ `monaco#0`，隐藏 `textarea.inputarea` 被过滤掉 |
| Monaco 形态：从 `.view-line` 读代码 | ✅ 95 字符，并标记"只有可见部分"（`partial=true`） |
| Monaco 形态：键盘复制先点正文区域 | ✅ 焦点进了内部 `textarea`，`Ctrl+A` 生效 |
| Monaco 形态：复制到全文而不是前几行 | ✅ 剪贴板与全文一致 |
| Monaco 形态：普通写入自动退到真键盘 | ✅ `method=keys-fallback verified=true` |
| 纯键入：多行代码的换行 | ✅ 换行发真实 `Enter` 键，文本框内容逐行一致 |
| Monaco 形态：点"读取编辑器"一步拿全文 | ✅ 弹窗自动走键盘通道，读到 100 字符 / 6 行（DOM 里只有 95 字符） |
| 遮罩挡住编辑器时 | ✅ 报 `FOCUS_NOT_IN_EDITOR`，不再复制页面上的几行文字 |

自动化共 58 项断言，全部通过。其中 "Monaco 形态" 用的是 `.monaco-editor` + `.view-line` + minimap canvas 的 DOM 夹具（没有 `window.monaco`），覆盖了头歌这种 "Monaco 被打进 bundle、只渲染可见行" 的情形；真正带 `window.monaco.getEditors()` 的页面走实例路径（`getValue()`/`setValue()`），Ace 走 `ace.edit()`、CodeMirror 6 走 `view.state.doc`，逻辑与 CM5 一致但没有单独夹具；遇到非常规编辑器时用弹窗里的"诊断"确认类型、候选序号与所在 frame（还可以"复制诊断"整段发出来），再在下拉框里锁定，或直接用"当前光标所在编辑器"。


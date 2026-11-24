// 网页代码复制助手 · 页面解锁脚本（运行在页面主环境，document_start，所有 frame）
//
// 作用：把“禁止复制 / 禁止右键 / 禁止选文字”这类前端限制逐层拆掉。
//   1. CSS 层：强制所有元素可选中，并让 ::selection 可见；
//   2. 内联属性层：清掉 oncopy / oncontextmenu / onselectstart 等；
//   3. 事件层：在 window 捕获阶段抢先处理，阻止页面脚本再拦 default（浏览器原生行为）；
//   4. 动态内容：MutationObserver 对后插入的节点重复清理。
// 开关由隔离世界的 bridge.js 通过 postMessage 下发，不直接读 storage（MAIN 世界无扩展 API）。

(() => {
  const FLAG = '__educoderCopyUnlock__';
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true, configurable: false, enumerable: false });

  const ATTRIBUTES = [
    'oncopy',
    'oncontextmenu',
    'onselectstart',
    'onselect',
    'ondragstart',
    'onbeforecopy'
  ];
  const EDITOR_SELECTOR = '.monaco-editor,.CodeMirror,.ace_editor,.cm-editor,.cm-content';

  let enabled = true;
  let styleElement = null;
  let observer = null;
  // “快捷键护盾”：页面在 window 捕获阶段 preventDefault 掉 Ctrl+A/C 时，
  // 通用的“键盘剪贴板通道”就失效了。开护盾后由我们抢先 stopImmediatePropagation，
  // 让页面监听器收不到事件，浏览器默认的编辑命令照常执行。
  let shieldUntil = 0;
  const shielded = () => Date.now() < shieldUntil;

  // ------------------------------------------------- 记住最近交互的元素
  // 打开扩展弹窗会让页面失去焦点（编辑器光标停止闪烁），此时 document.activeElement
  // 可能已经变回 body，就再也找不到“用户刚才点的那个编辑器”了。
  // 这里在捕获阶段抢先记录用户最后点过/聚焦过的元素，供“当前光标所在编辑器”兜底。
  let lastTarget = null;
  let lastPoint = null;
  function rememberFrom(event) {
    const node = event && event.target;
    if (node && node.nodeType === 1) lastTarget = node;
    if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && event.type !== 'keydown') {
      lastPoint = { x: event.clientX, y: event.clientY };
    }
  }
  window.addEventListener('focusin', rememberFrom, true);
  window.addEventListener('mousedown', rememberFrom, true);
  window.addEventListener('pointerdown', rememberFrom, true);
  window.addEventListener('keydown', rememberFrom, true);
  // 页面脚本读不到这个内部函数也无所谓，它只存一个最近一次交互的节点引用。
  Object.defineProperty(window, '__educoderLastTarget', {
    value: () => lastTarget,
    configurable: true,
    enumerable: false
  });
  // canvas 渲染 / 封闭影子 DOM 的编辑器，JS 没法 focus，只能按坐标点回去。
  Object.defineProperty(window, '__educoderShortcutShield', {
    value: (milliseconds) => {
      shieldUntil = Date.now() + Math.max(0, Number(milliseconds) || 0);
      return shieldUntil;
    },
    configurable: true,
    enumerable: false
  });
  Object.defineProperty(window, '__educoderLastPoint', {
    value: () => lastPoint,
    configurable: true,
    enumerable: false
  });

  // -------------------------------------------------- 记下封闭影子 DOM
  // 有的编辑器把自己包在 closed shadow root 里：document.querySelectorAll 看不见里面，
  // element.shadowRoot 也是 null，于是枚举只会拿到页面上的测试用例小框。
  // 在页面脚本创建组件之前接管 attachShadow，把创建出来的 root 都留个引用。
  const shadowRoots = [];
  try {
    const nativeAttach = Element.prototype.attachShadow;
    if (typeof nativeAttach === 'function' && !nativeAttach.__educoderWrapped) {
      const wrapped = function attachShadow(init) {
        const root = nativeAttach.call(this, init);
        try {
          if (root) shadowRoots.push(root);
        } catch {
          /* 忽略 */
        }
        return root;
      };
      wrapped.__educoderWrapped = true;
      Element.prototype.attachShadow = wrapped;
    }
  } catch {
    /* 浏览器限制时忽略 */
  }
  Object.defineProperty(window, '__educoderShadowRoots', {
    value: () => shadowRoots,
    configurable: true,
    enumerable: false
  });

  // ---------------------------------------------------------------- CSS 层
  function installStyle() {
    if (styleElement || !document.head) return;
    styleElement = document.createElement('style');
    styleElement.id = '__educoder_copy_unlock_style__';
    styleElement.textContent = `
      html, body, body * {
        -webkit-user-select: text !important;
        -moz-user-select: text !important;
        user-select: text !important;
        -webkit-touch-callout: default !important;
      }
      ::selection { background: #7db4ff !important; color: #ffffff !important; }
      ::-moz-selection { background: #7db4ff !important; color: #ffffff !important; }
    `;
    (document.head || document.documentElement).appendChild(styleElement);
  }

  function removeStyle() {
    if (!styleElement) return;
    styleElement.remove();
    styleElement = null;
  }

  // ------------------------------------------------------- 内联属性清理
  function strip(node) {
    if (!node || node.nodeType !== 1) return;
    for (const attribute of ATTRIBUTES) {
      if (node.hasAttribute(attribute)) node.removeAttribute(attribute);
    }
    if (typeof node.oncopy === 'function') node.oncopy = null;
    if (typeof node.oncontextmenu === 'function') node.oncontextmenu = null;
    if (typeof node.onselectstart === 'function') node.onselectstart = null;
    if (node.querySelectorAll) {
      for (const child of node.querySelectorAll(ATTRIBUTES.map((name) => `[${name}]`).join(','))) {
        for (const attribute of ATTRIBUTES) {
          if (child.hasAttribute(attribute)) child.removeAttribute(attribute);
        }
      }
    }
  }

  function stripDocument() {
    strip(document.documentElement);
    strip(document.body);
    if (document.body && document.body.querySelectorAll) {
      const nodes = document.body.querySelectorAll(ATTRIBUTES.map((name) => `[${name}]`).join(','));
      for (const node of nodes) strip(node);
    }
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      if (!enabled) return;
      for (const record of records) {
        for (const node of record.addedNodes) strip(node);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // --------------------------------------------------------------- 事件层
  const insideEditor = (target) => {
    try {
      return !!(target && target.closest && target.closest(EDITOR_SELECTOR));
    } catch {
      return false;
    }
  };

  // 页面常用 window/document 的 copy 监听 preventDefault 来封锁复制；
  // 可读取到选区时，直接把规范化文本写进剪贴板，避免编辑器内部选区被浏览器漏掉。
  function onCopy(event) {
    if (!enabled) return;
    // 画布自己实现的复制（copy 事件里写剪贴板）不能抢。
    if (canvasOwns(event.target)) return;
    const target = event.composedPath()[0] || event.target;
    const editor = insideEditor(target);
    const selected = selectedEditorText(target);
    // 虚拟滚动编辑器的 DOM 选区可能缺行。没有模型选区时，让编辑器处理复制。
    if (editor && !selected && !shielded()) return;
    event.stopImmediatePropagation();
    const text = normalizeCopiedCode(selected ?? (editor ? '' : getSelectionText()));
    if (text && event.clipboardData) {
      try {
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
      } catch {
        // 某些页面会冻结 clipboardData，忽略后仍走默认行为。
      }
    }
  }

  function onContextMenu(event) {
    if (!enabled) return;
    event.stopImmediatePropagation();
  }

  function onSelectStart(event) {
    if (!enabled) return;
    event.stopImmediatePropagation();
  }

  function onDragStart(event) {
    if (!enabled) return;
    event.stopImmediatePropagation();
  }

  function onKeyDown(event) {
    if (!enabled) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = String(event.key || '').toLowerCase();
    // 护盾期间，保留浏览器默认的全选和复制行为。
    if (shielded() && (key === 'a' || key === 'c')) {
      event.stopImmediatePropagation();
      return;
    }
    // 编辑器/画布有自己的复制逻辑（Monaco、CodeMirror、canvas 编辑器都靠自己的
    // keydown → clipboard 写入），拦了页面就复制不出来，所以放行。
    if (editorOwns(event.target) || editorUnderPoint()) return;
    if (key === 'c') event.stopImmediatePropagation();
  }

  // canvas、编辑器内部的事件交给页面自己的实现（很多画布编辑器就是靠
  // 自己的 keydown → clipboard.writeText 来完成复制的，我们拦了反而坏事）。
  function editorOwns(target) {
    try {
      let element = target;
      if (element && element.nodeType !== 1) element = element.parentElement;
      if (!element) return false;
      if (element.tagName === 'CANVAS') return true;
      if (element.isContentEditable) return true;
      return !!element.closest && !!element.closest('.monaco-editor, .CodeMirror, .ace_editor, .cm-editor, .cm-content, textarea');
    } catch {
      return false;
    }
  }

  // 焦点经常落在 body 上（canvas 编辑器不接收焦点），所以还要看“用户最后点的那个
  // 位置下面是不是画布/编辑器”，是的话快捷键归页面自己管。
  function editorUnderPoint() {
    try {
      const point = typeof window.__educoderLastPoint === 'function' ? window.__educoderLastPoint() : null;
      if (!point) return false;
      const element = document.elementFromPoint(point.x, point.y);
      return element ? editorOwns(element) : false;
    } catch {
      return false;
    }
  }

  // 画布可能没有 DOM 文本，复制交给页面自身。
  function canvasOwns(target) {
    try {
      let element = target;
      if (element && element.nodeType !== 1) element = element.parentElement;
      return !!element && element.tagName === 'CANVAS';
    } catch {
      return false;
    }
  }

  function getSelectionText() {
    try {
      const selection = window.getSelection ? window.getSelection() : null;
      return selection ? String(selection) : '';
    } catch {
      return '';
    }
  }

  function normalizeCopiedCode(text) {
    const normalized = String(text ?? '')
      .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
      .replace(/\u200b/g, '');
    // 其他站点的代码可能把 NBSP 当作正常的变量名或字符串。
    const fromEduCoder = /^([\w-]+\.)*educoder\.net$/i.test(location.hostname)
      || Array.from(location.ancestorOrigins || []).some((origin) => /^https?:\/\/([\w-]+\.)*educoder\.net(?::\d+)?$/i.test(origin));
    return fromEduCoder ? normalized.replace(/NBSP/g, ' ') : normalized;
  }

  function selectedEditorText(target) {
    try {
      let element = target;
      if (element && element.nodeType !== 1) element = element.parentElement;
      if (!element) return null;

      const cm5 = element.closest && element.closest('.CodeMirror');
      if (cm5 && cm5.CodeMirror && typeof cm5.CodeMirror.getSelection === 'function') {
        const editor = cm5.CodeMirror;
        return typeof editor.getSelections === 'function' ? editor.getSelections().join('\n') : editor.getSelection();
      }

      const monacoHost = element.closest && element.closest('.monaco-editor');
      const monacoApi = window.monaco && window.monaco.editor;
      if (monacoHost && monacoApi && typeof monacoApi.getEditors === 'function') {
        const editor = monacoApi.getEditors().find((item) => item.getDomNode && item.getDomNode() === monacoHost);
        const model = editor && editor.getModel && editor.getModel();
        const ranges = editor?.getSelections?.() || [editor?.getSelection?.()];
        if (model) {
          return ranges.filter((range) => range && (
            range.startLineNumber !== range.endLineNumber || range.startColumn !== range.endColumn
          )).map((range) => model.getValueInRange(range)).join('\n');
        }
      }

      const aceHost = element.closest && element.closest('.ace_editor');
      const aceEditor = aceHost && ((aceHost.env && aceHost.env.editor)
        || (window.ace && typeof window.ace.edit === 'function' ? window.ace.edit(aceHost) : null));
      if (aceEditor) {
        if (typeof aceEditor.getCopyText === 'function') return aceEditor.getCopyText();
        if (typeof aceEditor.getSelectedText === 'function') return aceEditor.getSelectedText();
      }

      const cm6Host = element.closest && element.closest('.cm-content');
      const cm6Holder = cm6Host && (cm6Host.cmView || (cm6Host.parentElement && cm6Host.parentElement.cmView));
      const cm6View = cm6Holder && cm6Holder.view;
      const state = cm6View?.state;
      if (state?.selection?.ranges && state.doc) {
        return state.selection.ranges.filter((range) => range.from !== range.to)
          .map((range) => state.doc.sliceString(range.from, range.to)).join('\n');
      }

      if (!insideEditor(element) && element.matches?.('textarea')) {
        const start = element.selectionStart;
        const end = element.selectionEnd;
        if (Number.isInteger(start) && Number.isInteger(end)) return element.value.slice(start, end);
      }
      return null;
    } catch {
      return null;
    }
  }

  Object.defineProperty(window, '__educoderReadSelectedCode', {
    value: () => {
      let node = document.activeElement;
      while (node) {
        const root = node.shadowRoot || shadowRoots.find((candidate) => candidate.host === node);
        if (!root?.activeElement) break;
        node = root.activeElement;
      }
      return selectedEditorText(node) || getSelectionText();
    },
    configurable: true
  });

  function installListeners() {
    const capture = { capture: true, passive: false };
    window.addEventListener('copy', onCopy, capture);
    window.addEventListener('contextmenu', onContextMenu, capture);
    window.addEventListener('selectstart', onSelectStart, capture);
    window.addEventListener('dragstart', onDragStart, capture);
    window.addEventListener('keydown', onKeyDown, capture);
  }

  function uninstallListeners() {
    window.removeEventListener('copy', onCopy, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('selectstart', onSelectStart, true);
    window.removeEventListener('dragstart', onDragStart, true);
    window.removeEventListener('keydown', onKeyDown, true);
  }

  // ------------------------------------------------------------- 状态切换
  function apply() {
    if (enabled) {
      installStyle();
      stripDocument();
      startObserver();
    } else {
      removeStyle();
    }
  }

  window.__educoderCopyUnlockSetState = (value) => {
    const next = value !== false;
    if (next === enabled) {
      apply();
      return;
    }
    enabled = next;
    apply();
  };

  // bridge.js 在隔离世界，只能用 postMessage 传开关。
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'educoder-copy-helper' || data.type !== 'unlock-state') return;
    window.__educoderCopyUnlockSetState(data.enabled !== false);
  }, false);

  installListeners();
  installStyle();
  stripDocument();
  startObserver();

  document.addEventListener('DOMContentLoaded', apply, { once: true });
  window.addEventListener('load', apply, { once: true });
})();

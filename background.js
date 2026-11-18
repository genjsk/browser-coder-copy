// 头歌代码复制助手 · 后台服务（MV3 service worker）
//
// 原理与 browser-control-open-source 相同：
//   1. chrome.scripting.executeScript({ world: 'MAIN' }) 在页面主环境读取编辑器内容；
//   2. chrome.debugger + CDP Input.insertText / Input.dispatchKeyEvent 产生浏览器级
//      “可信输入”，不触发页面自身的 paste 拦截；
//   3. Runtime.evaluate 在页面主环境执行脚本。
// 与父项目不同：不经过本地 MCP 服务，扩展直接操作用户当前标签页，点按钮即用。

import { planTyping, keyEventParams } from './typing.js';

const DEFAULTS = { debugConsent: false, unlock: true, typingDelayMs: 3 };
const MAX_TEXT = 300000;
const attachedTabs = new Set();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function assertPage(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) throw fail('NO_TAB', '没有可用的标签页，请打开头歌页面后重试。');
  let tab;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    throw fail('NO_TAB', '标签页已关闭，请重新打开。');
  }
  const url = tab.url || tab.pendingUrl || '';
  if (!/^https?:/i.test(url)) throw fail('RESTRICTED_PAGE', '该页面不受支持（chrome://、扩展页、应用商店等受保护页面无法注入脚本）。');
  return tab;
}

async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    const message = String(error?.message || error).replace(/\s+/g, ' ').trim();
    if (/already attached/i.test(message)) {
      attachedTabs.add(tabId);
      return;
    }
    if (/another debugger|devtools/i.test(message)) {
      throw fail('DEBUGGER_BUSY', '该标签页已被 DevTools 或其他调试工具占用，请先关闭 F12 调试面板再重试。');
    }
    if (/permission|not allowed|access denied/i.test(message)) {
      throw fail('DEBUGGER_PERMISSION_REQUIRED', 'Chrome 未允许扩展使用调试权限，请到 chrome://extensions 重新加载本扩展并接受权限。');
    }
    throw fail('DEBUGGER_ATTACH_FAILED', `无法连接 Chrome 调试器：${message}`);
  }
  attachedTabs.add(tabId);
}

async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // 标签页可能已经关闭或导航，忽略。
  }
}

function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));

// ---------------------------------------------------------------------------
// 页面主环境函数：会被序列化后注入，不能引用本文件的其他变量。
//
// 一个页面里往往有好几个“可编辑区域”：头歌的代码编辑器、自定义测试用例输入框、
// 搜索框……只按类型优先级取第一个必然选错。所以这里统一用 editorApi：
//
//   editorApi('list')                        → 本 frame 全部候选（类型、字符数、面积、预览）
//   editorApi('read' | 'focus' | 'selectAll' | 'set', spec, text)
//
// spec = { type: 'codemirror5', nth: 0 }，nth 是同类型元素在 DOM 里的序号
// （写入前后稳定，不会因为内容变化而漂移）。spec 为空时退回“第一个可见编辑器”。
// ---------------------------------------------------------------------------

function editorApi(op, spec, value) {
  const TYPES = ['codemirror5', 'monaco', 'ace', 'codemirror6', 'textarea', 'contenteditable'];
  const clean = (text) => String(text == null ? '' : text).replace(/\u200b/g, '');
  const visible = (element) => !!(element && element.getClientRects && element.getClientRects().length);
  const insideEditor = (element) => !!(element.closest && element.closest('.monaco-editor,.CodeMirror,.ace_editor,.cm-editor'));
  const measure = (element) => {
    try {
      const rect = element.getBoundingClientRect();
      return Math.round(Math.max(0, rect.width) * Math.max(0, rect.height));
    } catch {
      return 0;
    }
  };

  // 打开影子 DOM：页面用 Web Component 包住编辑器时，document.querySelectorAll 看不见里面的节点，
  // 只会找到页面上剩下的那个小输入框——这正是“所有候选都写进测试用例”的根源之一。
  const deepQuery = (selector, filter) => {
    const found = [];
    const seen = new Set();
    const walk = (root, depth) => {
      if (!root || depth > 20) return;
      let nodes = [];
      try { nodes = root.querySelectorAll(selector); } catch { nodes = []; }
      for (const node of nodes) found.push(node);
      let all = [];
      try { all = root.querySelectorAll('*'); } catch { all = []; }
      for (const element of all) {
        const shadow = element.shadowRoot;
        if (!shadow || seen.has(shadow)) continue;
        seen.add(shadow);
        walk(shadow, depth + 1);
      }
    };
    walk(document, 0);
    // closed shadow root 用 element.shadowRoot 拿不到，只能靠 unlock.js 在
    // 页面创建组件时截下来的引用（window.__educoderShadowRoots）。
    try {
      const roots = typeof window.__educoderShadowRoots === 'function' ? window.__educoderShadowRoots() : [];
      for (const root of roots || []) {
        if (!root || seen.has(root)) continue;
        seen.add(root);
        walk(root, 1);
      }
    } catch {
      /* 忽略 */
    }
    return filter ? found.filter(filter) : found;
  };

  // 同类型元素的 DOM 顺序 —— list 与 read/focus/selectAll/set 共用这一套编号。
  const list = (type) => {
    if (type === 'codemirror5') return deepQuery('.CodeMirror');
    if (type === 'ace') return deepQuery('.ace_editor');
    if (type === 'codemirror6') return deepQuery('.cm-content');
    if (type === 'textarea') {
      return deepQuery('textarea').filter((element) => {
        if (insideEditor(element)) return false;
        const classes = element.classList || { contains: () => false };
        if (classes.contains('inputarea') || classes.contains('monaco-mouse-cursor-text')) return false;
        return measure(element) >= 400; // 1px 的内部输入框没有可读内容，直接扔掉
      });
    }
    if (type === 'contenteditable') return deepQuery('[contenteditable="true"],[contenteditable=""]').filter((element) => !insideEditor(element));
    if (type === 'monaco') {
      const api = window.monaco && window.monaco.editor;
      const editors = api && api.getEditors ? api.getEditors() : [];
      if (editors.length) return editors;
      // Monaco 被 webpack 打进 bundle 时 window.monaco 不存在，但页面里仍有
      // .monaco-editor 的 DOM。这里退化成 DOM 候选：至少能读到渲染出来的行。
      return deepQuery('.monaco-editor');
    }
    return [];
  };

  const access = (type, item) => {
    if (!item) return null;
    try {
      if (type === 'codemirror5') {
        const editor = item.CodeMirror;
        if (!editor || typeof editor.getValue !== 'function') return null;
        return { editor, element: item, model: null };
      }
      if (type === 'monaco') {
        if (item && typeof item.getModel === 'function') {
          const model = item.getModel();
          if (!model) return null;
          return { editor: item, model, element: (item.getDomNode && item.getDomNode()) || document.body, domOnly: false };
        }
        if (item && item.querySelector) {
          return { editor: null, model: null, element: item, domOnly: true };
        }
        return null;
      }
      if (type === 'ace') {
        const editor = (item.env && item.env.editor) || (window.ace && window.ace.edit ? window.ace.edit(item) : null);
        if (!editor || typeof editor.getValue !== 'function') return null;
        return { editor, element: item, model: null };
      }
      if (type === 'codemirror6') {
        const holder = item.cmView || (item.parentElement && item.parentElement.cmView);
        const view = holder && holder.view;
        if (!view || !view.state || !view.state.doc) return null;
        return { editor: view, element: item, model: null };
      }
      if (type === 'textarea' || type === 'contenteditable') {
        return { editor: item, element: item, model: null };
      }
    } catch {}
    return null;
  };

  // DOM-only Monaco：把当前渲染出来的行拼起来。Monaco 是虚拟滚动的，所以只能拿到
  // 视口内的行 —— 只用于识别/诊断，真正读取走键盘通道。
  const monacoDomText = (element) => {
    try {
      const lines = element.querySelectorAll('.view-line');
      return Array.from(lines).map((line) => line.textContent || '').join('\n');
    } catch {
      return '';
    }
  };

  const readValue = (type, hit) => {
    try {
      if (type === 'monaco') return clean(hit.domOnly ? monacoDomText(hit.element) : hit.model.getValue());
      if (type === 'codemirror6') return clean(hit.editor.state.doc.toString());
      if (type === 'textarea') return clean(hit.element.value);
      if (type === 'contenteditable') return clean(hit.element.innerText);
      return clean(hit.editor.getValue());
    } catch {
      return '';
    }
  };

  const describe = (type, nth, item) => {
    const hit = access(type, item);
    if (!hit) return null;
    const text = readValue(type, hit);
    return {
      type,
      nth,
      chars: text.length,
      area: measure(hit.element),
      visible: visible(hit.element),
      preview: text.replace(/\s+/g, ' ').trim().slice(0, 60),
      hit,
      text
    };
  };

  // 可见 → 字符数 → 面积；头歌的代码区大、测试用例框小，分数自然拉开。
  const score = (info) => (info.visible ? 1e6 : 0) + Math.min(info.chars, 20000) * 20 + Math.min(info.area, 400000) / 40;

  const collect = () => {
    const all = [];
    for (const type of TYPES) {
      list(type).forEach((item, nth) => {
        const info = describe(type, nth, item);
        if (info) all.push(info);
      });
    }
    return all;
  };

  const autoPick = () => {
    const all = collect();
    all.sort((a, b) => (b.visible - a.visible) || (score(b) - score(a)));
    return all[0] || null;
  };

  // 焦点归属：编辑器把焦点放在内部的隐藏 textarea 上，所以要沿 composed tree 往上找。
  // 打开扩展弹窗会把焦点从页面拿走（光标停止闪烁），activeElement 可能已经变回 body；
  // 这时用 unlock.js 在捕获阶段记下的“最近一次交互元素”兜底。
  const within = (node, element) => {
    let current = node || null;
    while (current) {
      if (current === element) return true;
      current = current.parentNode || current.host || null;
    }
    return false;
  };
  const rememberedElement = () => {
    try {
      if (typeof window.__educoderLastTarget !== 'function') return null;
      const node = window.__educoderLastTarget();
      if (node && node.nodeType === 1 && node.isConnected) return node;
    } catch {
      // 页面可能把全局删了，忽略。
    }
    return null;
  };
  const focusOrigins = () => {
    const origins = [];
    if (document.activeElement) origins.push(document.activeElement);
    const remembered = rememberedElement();
    if (remembered && remembered !== document.activeElement) origins.push(remembered);
    return origins;
  };
  const holdsFocus = (element) => focusOrigins().some((origin) => within(origin, element));
  const activeCandidate = () => {
    const all = collect();
    // 最近交互的元素优先（弹窗抢焦点后，它才是用户真正的目标）。
    const remembered = rememberedElement();
    if (remembered) {
      const hit = all.find((info) => within(remembered, info.hit.element));
      if (hit) return hit;
    }
    return all.find((info) => holdsFocus(info.hit.element)) || null;
  };

  const locate = (type, nth) => {
    if (!TYPES.includes(type)) return null;
    return describe(type, nth, list(type)[nth]);
  };

  // 显式 spec 找不到时**绝不**偷偷退回自动选择——否则用户选了代码区，结果又写进测试用例框。
  const resolve = (desired) => {
    if (desired && desired.type === 'active') {
      const info = activeCandidate();
      return { info, error: info ? null : 'NO_ACTIVE_EDITOR' };
    }
    if (desired && typeof desired.type === 'string' && desired.type) {
      const info = locate(desired.type, Number.isInteger(desired.nth) ? desired.nth : 0);
      return { info, error: info ? null : 'SPEC_NOT_FOUND' };
    }
    const info = autoPick();
    return { info, error: info ? null : 'NO_EDITOR' };
  };

  const publicInfo = (info) => ({
    type: info.type,
    nth: info.nth,
    chars: info.chars,
    area: info.area,
    visible: info.visible,
    preview: info.preview
  });

  if (op === 'list') {
    const infos = collect();
    infos.sort((a, b) => (b.visible - a.visible) || (score(b) - score(a)));
    const active = activeCandidate();
    let selection = '';
    try { selection = String(window.getSelection ? window.getSelection() : ''); } catch {}
    return {
      ok: true,
      frameUrl: location.href,
      selection,
      editorCount: infos.length,
      candidates: infos.map((info) => ({
        ...publicInfo(info),
        score: score(info),
        active: !!(active && active.type === info.type && active.nth === info.nth)
      })),
      active: active ? { type: active.type, nth: active.nth } : null,
      best: infos[0] ? { type: infos[0].type, nth: infos[0].nth } : null
    };
  }

  const desired = spec && typeof spec === 'object' ? spec : null;
  const resolved = resolve(desired);
  if (!resolved.info) {
    return { ok: false, error: resolved.error, type: desired && desired.type ? desired.type : null };
  }
  const target = resolved.info;
  const type = target.type;
  const nth = target.nth;
  const hit = target.hit;
  try {
    if (op === 'read') {
      const partial = type === 'monaco' && hit.domOnly;
      return { ok: true, type, nth, text: target.text, partial };
    }

    if (op === 'focus') {
      if (type === 'monaco' && hit.domOnly) {
        const input = hit.element.querySelector('textarea');
        if (input && input.focus) input.focus();
      } else if (type === 'textarea' || type === 'contenteditable') hit.element.focus();
      else if (hit.editor && typeof hit.editor.focus === 'function') hit.editor.focus();
      else if (hit.element.focus) hit.element.focus();
      if (type === 'monaco' && !hit.domOnly && hit.editor && typeof hit.editor.revealLine === 'function') {
        hit.editor.revealLine(1);
      }
      return { ok: true, type, nth };
    }

    if (op === 'selectAll') {
      if (type === 'monaco' && hit.domOnly) {
        return { ok: false, type, nth, error: 'dom-only monaco' };
      }
      if (type === 'codemirror5') {
        hit.editor.focus();
        hit.editor.execCommand('selectAll');
      } else if (type === 'monaco') {
        hit.editor.focus();
        hit.editor.setSelection(hit.model.getFullModelRange());
      } else if (type === 'ace') {
        hit.editor.focus();
        hit.editor.selectAll();
      } else if (type === 'codemirror6') {
        if (typeof hit.editor.focus === 'function') hit.editor.focus();
        hit.editor.dispatch({ selection: { anchor: 0, head: hit.editor.state.doc.length } });
      } else if (type === 'textarea') {
        hit.element.focus();
        hit.element.select();
      } else {
        hit.element.focus();
        document.execCommand('selectAll');
      }
      return { ok: true, type, nth };
    }

    if (op === 'set') {
      const text = String(value == null ? '' : value);
      if (type === 'monaco' && hit.domOnly) {
        return { ok: false, type, nth, error: 'dom-only monaco' };
      }
      if (type === 'codemirror5') {
        hit.editor.setValue(text);
      } else if (type === 'monaco') {
        hit.model.setValue(text);
      } else if (type === 'ace') {
        hit.editor.setValue(text, -1);
      } else if (type === 'codemirror6') {
        hit.editor.dispatch({ changes: { from: 0, to: hit.editor.state.doc.length, insert: text } });
      } else if (type === 'textarea') {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(hit.element), 'value')?.set;
        if (setter) setter.call(hit.element, text);
        else hit.element.value = text;
        hit.element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        hit.element.innerText = text;
        hit.element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      return { ok: true, type, nth };
    }
  } catch (error) {
    return { ok: false, type, nth, error: String(error && error.message ? error.message : error) };
  }
  return { ok: false, error: `未知操作：${op}` };
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

// 每个 frame 都问一遍“你有什么编辑器”，再合并排序：
// 可见 → 字符数 → 面积。头歌页面里代码编辑器大、测试用例框小，分数自然拉开；
// 同分时才看 DOM 顺序。弹窗拿到完整候选列表后可以让用户手动指定。
async function probeAllFrames(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: editorApi,
      args: ['list', null, null]
    });
  } catch {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: editorApi,
      args: ['list', null, null]
    });
  }
  const frames = results
    .filter((item) => item.result && item.result.ok)
    .map((item) => ({ ...item.result, frameId: item.frameId, via: 'scripting' }))
    .sort((a, b) => a.frameId - b.frameId);
  const frameReports = results
    .map((item) => ({
      frameId: item.frameId,
      frameUrl: (item.result && item.result.frameUrl) || '',
      ok: !!(item.result && item.result.ok),
      candidates: (item.result && item.result.candidates) ? item.result.candidates.length : 0,
      error: item.result && item.result.ok
        ? ''
        : ((item.result && item.result.error) || '无法在这个 frame 里执行脚本')
    }))
    .sort((a, b) => a.frameId - b.frameId);
  const merged = mergeFrames(frames);
  if (merged) merged.frameReports = frameReports;
  return merged;
}

function mergeFrames(frames) {
  if (!frames.length) return null;
  const candidates = [];
  for (const frame of frames) {
    for (const candidate of frame.candidates || []) {
      candidates.push({ ...candidate, frameId: frame.frameId, frameUrl: frame.frameUrl });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (Number(b.visible) - Number(a.visible)) || (b.chars - a.chars) || (b.area - a.area));
  return {
    candidates,
    frames,
    selection: frames.map((frame) => frame.selection).find(Boolean) || '',
    editorCount: candidates.length,
    frameId: candidates[0].frameId,
    frameUrl: candidates[0].frameUrl || '',
    via: frames[0].via || 'scripting'
  };
}

// executeScript 被页面策略挡住时，退回 CDP 在默认执行上下文里跑同一个函数。
async function cdpProbe(tabId) {
  const contexts = [];
  const owns = !attachedTabs.has(tabId);
  const onEvent = (source, method, params) => {
    if (source.tabId === tabId && method === 'Runtime.executionContextCreated') contexts.push(params.context);
  };
  chrome.debugger.onEvent.addListener(onEvent);
  const frames = [];
  try {
    await attach(tabId);
    await send(tabId, 'Runtime.enable');
    await sleep(80);
    for (const context of contexts) {
      if (!context.auxData || context.auxData.isDefault !== true) continue;
      try {
        const evaluation = await send(tabId, 'Runtime.evaluate', {
          expression: `(${editorApi.toString()})('list', null, null)`,
          contextId: context.id,
          returnByValue: true,
          awaitPromise: true
        });
        const value = evaluation.result && evaluation.result.value;
        if (value && value.ok) frames.push({ ...value, frameId: context.auxData.frameId, via: 'cdp' });
      } catch {
        // 该上下文不能执行，试下一个。
      }
    }
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    if (owns) await detach(tabId);
  }
  frames.sort((a, b) => a.frameId - b.frameId);
  return frames.length ? mergeFrames(frames) : null;
}

function normalizeSpec(spec) {
  if (!spec || typeof spec.type !== 'string') return null;
  return {
    type: spec.type,
    nth: Number.isInteger(spec.nth) ? spec.nth : 0,
    frameId: Number.isInteger(spec.frameId) ? spec.frameId : null
  };
}

// 精确匹配：type + nth 是唯一标识；frameId 只作为“同款编辑器出现在多个 frame”时的优先级，
// 页面刷新后 frame 编号会变，不能因为它对不上就退回别的编辑器。
function matchCandidate(candidates, spec) {
  const wanted = normalizeSpec(spec);
  if (!wanted || wanted.type === 'active') return null;
  const exact = candidates.filter((candidate) => candidate.type === wanted.type && candidate.nth === wanted.nth);
  if (!exact.length) return null;
  if (wanted.frameId == null) return exact[0];
  return exact.find((candidate) => candidate.frameId === wanted.frameId) || exact[0];
}

async function probeTab(tabId) {
  try {
    const probe = await probeAllFrames(tabId);
    if (probe) return probe;
  } catch {
    // 页面策略可能挡住 scripting，下面用调试通道再试一次。
  }
  try {
    return await cdpProbe(tabId);
  } catch {
    return null;
  }
}

// “当前光标所在编辑器”：用户先在页面里点一下代码区，我们就写那一个，
// 完全不依赖候选列表的顺序，也不受页面里别的小输入框影响。
async function readFocusedEditor(tabId) {
  const probe = await probeTab(tabId);
  const frames = (probe && probe.frames) || [];
  for (const frame of frames) {
    const hit = await runInEditor(tabId, frame.frameId, 'read', { type: 'active' }).catch(() => null);
    if (!hit || !hit.ok) continue;
    const text = hit.text || '';
    return {
      type: hit.type,
      nth: hit.nth,
      text,
      chars: text.length,
      frameId: frame.frameId,
      frameUrl: frame.frameUrl,
      selection: probe.selection || '',
      via: frame.via,
      editorCount: probe.editorCount,
      candidates: probe.candidates,
      partial: !!hit.partial,
      active: true
    };
  }
  throw fail('NO_ACTIVE_EDITOR', '没找到光标所在的编辑器：先在页面里点一下代码区，再点读取或写入。');
}

// 读取：没给 spec 就自动挑分数最高的那个，给了就精确读那一个（找不到就报错，绝不偷偷换目标）。
async function readEditor(tabId, wanted) {
  const desired = normalizeSpec(wanted);
  if (desired && desired.type === 'active') return readFocusedEditor(tabId);

  const probe = await probeTab(tabId);
  if (!probe) return null;

  const target = desired ? matchCandidate(probe.candidates, desired) : probe.candidates[0];
  if (!target) {
    if (desired) {
      throw fail('EDITOR_NOT_FOUND', '页面上已经没有你选的那个编辑器（页面结构或序号变了），请在弹窗里重新选一次。');
    }
    return null;
  }
  const read = await runInEditor(tabId, target.frameId, 'read', { type: target.type, nth: target.nth }).catch(() => null);
  const text = read && read.ok ? read.text : '';
  return {
    type: target.type,
    nth: target.nth,
    text,
    chars: text.length,
    frameId: target.frameId,
    frameUrl: target.frameUrl,
    selection: probe.selection,
    via: probe.via,
    editorCount: probe.editorCount,
    candidates: probe.candidates,
    partial: !!(read && read.partial),
    frames: probe.frameReports || []
  };
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

async function runInEditor(tabId, frameId, op, spec, value) {
  if (frameId == null) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: editorApi,
      args: [op, spec || null, value == null ? null : String(value)]
    });
    const hit = results.find((item) => item.result && item.result.ok);
    return hit ? hit.result : null;
  } catch {
    return null;
  }
}

async function focusEditorFrame(tabId, frameId, spec) {
  return !!(await runInEditor(tabId, frameId, 'focus', spec));
}

async function selectAllViaPage(tabId, frameId, spec) {
  return runInEditor(tabId, frameId, 'selectAll', spec);
}

async function setEditorValueViaPage(tabId, frameId, text, spec) {
  return runInEditor(tabId, frameId, 'set', spec, text);
}

async function selectAllInPage(tabId) {
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
    commands: ['selectAll']
  });
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2
  });
}

// Enter 必须发成真实按键：画布 / Monaco 这类编辑器按 keydown 处理换行，
// 塞一个 '\n' 文本进隐藏 textarea 往往不会进文档。
async function pressEnter(tabId) {
  const params = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  // textarea 的换行来自 char 事件；编辑器（Monaco / 画布）认 keydown，char 对它们无害。
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'char', ...params, text: '\r', unmodifiedText: '\r' });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

async function typeByKeyEvents(tabId, text, delayMs, options = {}) {
  const plan = planTyping(text, { multiline: true });
  for (const segment of plan.segments) {
    if (segment.kind === 'text') {
      if (options.enterForNewline && segment.text.includes('\n')) {
        const pieces = segment.text.split('\n');
        for (let index = 0; index < pieces.length; index++) {
          if (index > 0) {
            await pressEnter(tabId);
            if (delayMs > 0) await sleep(delayMs);
          }
          if (pieces[index]) await send(tabId, 'Input.insertText', { text: pieces[index] });
        }
      } else {
        await send(tabId, 'Input.insertText', { text: segment.text });
      }
    } else {
      for (const type of ['rawKeyDown', 'char', 'keyUp']) {
        await send(tabId, 'Input.dispatchKeyEvent', keyEventParams(segment, type));
      }
    }
    if (delayMs > 0) await sleep(delayMs);
  }
}

function normalize(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n');
}

// DOM-only Monaco 只能从 .view-line 拼文本：行尾空白和最后的空行会丢。比较时按行
// 去掉尾部空白、丢掉结尾空行，避免“写对了却报没验证过”。
function trimLines(value) {
  return normalize(value)
    .split('\n')
    .map((line) => line.replace(/[ \t\u200b]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function textMatches(actual, expected, type) {
  if (actual == null) return null;
  if (type === 'monaco') return trimLines(actual) === trimLines(expected);
  return normalize(actual) === normalize(expected);
}

async function pasteIntoEditor(tabId, args) {
  const settings = await getSettings();
  if (!settings.debugConsent) throw fail('DEBUG_CONSENT_REQUIRED', '请先在弹窗中点击“同意并启用调试权限”。');
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text) throw fail('TEXT_REQUIRED', '没有可粘贴的文本，剪贴板是空的。');
  if (text.length > MAX_TEXT) throw fail('TEXT_TOO_LARGE', `文本太大（${text.length} 字符），请分次粘贴。`);

  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(150);
  }
  if (tab.status === 'loading') await sleep(400);

  // 读写必须落在同一个编辑器上：先按用户的 spec（或自动最高分）定目标，
  // 再把 type/nth 固定下来传给全选、输入、校验和兜底。
  const wanted = normalizeSpec(args.spec);
  let before = null;
  try {
    before = await readEditor(tabId, wanted);
  } catch (error) {
    // 用户明确选了目标时，找不到就报错，绝不悄悄写到别的小输入框里。
    if (wanted) throw error;
    before = null;
  }
  const targetSpec = before ? { type: before.type, nth: before.nth } : wanted;
  const targetFrame = before && before.frameId != null ? before.frameId : (wanted ? wanted.frameId : null);
  if (before && before.frameId != null) await focusEditorFrame(tabId, before.frameId, targetSpec);
  await sleep(40);

  const mode = args.mode === 'keys' ? 'keys' : 'insert';
  const replace = args.replace !== false;
  await attach(tabId);
  try {
    if (replace) {
      const selected = await selectAllViaPage(tabId, targetFrame, targetSpec);
      if (!selected || !selected.ok) await selectAllInPage(tabId);
    }
    if (mode === 'keys') await typeByKeyEvents(tabId, text, settings.typingDelayMs);
    else await send(tabId, 'Input.insertText', { text });
  } catch (error) {
    await detach(tabId);
    if (error && error.code) throw error;
    throw fail('INPUT_FAILED', `可信输入失败：${error?.message || error}`);
  }
  await detach(tabId);

  const stuck = before ? { type: before.type, nth: before.nth, frameId: before.frameId } : wanted;
  let after = await readEditor(tabId, stuck).catch(() => null);
  let verified = after ? textMatches(after.text, text, (after && after.type) || (before && before.type)) : null;
  let method = mode === 'keys' ? 'keys' : 'insertText';
  let usedFallback = false;

  // Monaco 这类编辑器把文档藏在组件里（页面上只有渲染出来的行），Input.insertText 落在
  // 隐藏 textarea 上通常不会进模型。真键盘事件是唯一可靠的路子：先点正文区域拿到焦点，
  // Ctrl+A 全选，再逐字敲进去。
  if (verified === false && before && (method === 'insertText' || method === 'keys')) {
    const typed = await typeByKeyboard(tabId, text, settings.typingDelayMs).catch(() => null);
    after = await readEditor(tabId, stuck).catch(() => null);
    const typedOk = after ? textMatches(after.text, text, (after && after.type) || (before && before.type)) : null;
    if (typed && typed.ok !== false && typedOk !== false) {
      usedFallback = true;
      method = 'keys-fallback';
      verified = typedOk;
    } else {
      after = await readEditor(tabId, stuck).catch(() => null);
      verified = after ? textMatches(after.text, text, (after && after.type) || (before && before.type)) : null;
    }
  }

  if (verified === false && before) {
    const forced = await setEditorValueViaPage(tabId, before.frameId, text, targetSpec).catch(() => null);
    if (forced && forced.ok) {
      usedFallback = true;
      method = 'setValue';
      after = await readEditor(tabId, stuck).catch(() => null);
      verified = after ? textMatches(after.text, text, (after && after.type) || (before && before.type)) : null;
    }
  }

  let warning = '';
  if (!before) warning = '未识别到编辑器，已向当前焦点插入；请确认结果。';
  else if (verified === false) warning = '写入后内容与剪贴板不一致，请手动全选检查。';

  return {
    method,
    usedFallback,
    verified,
    chars: [...text].length,
    editorType: after?.type || before?.type || null,
    editorNth: after?.nth ?? before?.nth ?? null,
    frameId: before?.frameId ?? after?.frameId ?? null,
    beforeLength: before?.text?.length ?? null,
    afterLength: after?.text?.length ?? null,
    candidates: after?.candidates || before?.candidates || [],
    warning
  };
}

// 走真键盘：点编辑器正文确认焦点，Ctrl+A 全选，然后逐字键入。
// 这是 Monaco / 画布编辑器上唯一不依赖“编辑器对象”的写入方式。
async function typeByKeyboard(tabId, text, delayMs) {
  await attach(tabId);
  try {
    assertFocused(await focusEditorTarget(tabId));
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    });
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    });
    await sleep(30);
    await typeByKeyEvents(tabId, text, delayMs, { enterForNewline: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    await detach(tabId);
  }
}

// ---------------------------------------------------------------------------
// 脚本执行
// ---------------------------------------------------------------------------

async function evaluateInPage(tabId, expression) {
  const settings = await getSettings();
  if (!settings.debugConsent) throw fail('DEBUG_CONSENT_REQUIRED', '请先在弹窗中同意启用调试权限。');
  if (typeof expression !== 'string' || !expression.trim()) throw fail('EXPRESSION_REQUIRED', '请输入要执行的脚本。');
  await attach(tabId);
  try {
    const evaluation = await send(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: 8000
    });
    if (evaluation.exceptionDetails) {
      const detail = evaluation.exceptionDetails.exception?.description
        || evaluation.exceptionDetails.text
        || '脚本执行失败';
      throw fail('EVAL_EXCEPTION', String(detail).split('\n')[0].slice(0, 300));
    }
    let value = evaluation.result?.value;
    if (value === undefined && evaluation.result?.unserializableValue) value = evaluation.result.unserializableValue;
    if (value === undefined && evaluation.result?.description) value = evaluation.result.description;
    let serialized = '';
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
    if (serialized === undefined) serialized = String(value);
    const truncated = serialized.length > 120000;
    return {
      value: truncated ? serialized.slice(0, 120000) : value,
      serialized: truncated ? serialized.slice(0, 120000) : serialized,
      truncated
    };
  } finally {
    await detach(tabId);
  }
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

async function diagnose(tabId, spec) {
  const tab = await chrome.tabs.get(tabId);
  const settings = await getSettings();
  let editor = null;
  let error = '';
  try {
    editor = await readEditor(tabId, spec);
  } catch (issue) {
    error = issue?.message || String(issue);
  }
  if (!editor && !error) {
    error = '没有找到可编辑的编辑器。若代码区在 iframe 或 Web Component 里，请先点一下代码区，再选“当前光标所在编辑器”。';
  }
  let probe = null;
  if (!editor) {
    try {
      probe = await probeTab(tabId);
    } catch {
      probe = null;
    }
  }
  const snapshot = await snapshotTab(tabId);
  const focusPlan = await editorFocusPlan(tabId).catch(() => null);
  const focusInfo = await editorFocusInfo(tabId).catch(() => null);
  const reportCandidates = (editor && editor.candidates) || (probe && probe.candidates) || [];
  const reportFrames = (editor && editor.frames) || (probe && probe.frameReports) || [];

  return {
    url: tab.url,
    title: tab.title,
    settings,
    debuggerAttached: attachedTabs.has(tabId),
    editor: editor ? {
      type: editor.type,
      nth: editor.nth,
      frameId: editor.frameId,
      frameUrl: editor.frameUrl,
      chars: (editor.text || '').length,
      editorCount: editor.editorCount,
      via: editor.via || 'scripting'
    } : null,
    focus: {
      active: focusInfo,
      hasEditor: focusPlan ? !!focusPlan.hasEditor : false,
      points: focusPlan ? focusPlan.points.map((point) => `${point.why}@${point.x},${point.y}`) : []
    },
    frames: reportFrames.map((frame) => ({
      frameId: frame.frameId,
      frameUrl: frame.frameUrl,
      ok: frame.ok,
      candidates: frame.candidates,
      error: frame.error
    })),
    snapshot,
    candidateCount: reportCandidates.length,
    candidates: reportCandidates.map((candidate) => ({
      type: candidate.type,
      nth: candidate.nth,
      chars: candidate.chars,
      area: candidate.area,
      visible: candidate.visible,
      frameId: candidate.frameId,
      active: !!candidate.active,
      preview: candidate.preview
    })),
    error
  };
}

// ---------------------------------------------------------------------------
// 键盘剪贴板通道：页面 DOM 完全读不到编辑器时的兜底
//
// 有的站点的代码区画在 canvas 上、藏在 closed shadow root 里、或者放在注入不进去的
// iframe 里：既枚举不到编辑器元素，也找不到编辑器实例。但浏览器自己的快捷键不受影响：
//   Ctrl+A → Ctrl+C：把当前编辑器里选中的内容送进系统剪贴板，弹窗用 clipboardRead 读出来；
//   Ctrl+V：把系统剪贴板的内容交给当前聚焦的元素，页面自己拦 paste 也拦不住浏览器这一层。
// 按键走 CDP 的 Input.dispatchKeyEvent，带真实 Control 修饰键，页面看到的仍是可信事件。
// ---------------------------------------------------------------------------

// 诊断用的页面快照：代码区如果只把文字画在屏幕上，这里能看出它是 canvas、
// 特殊 iframe，还是某种没有暴露实例的编辑器。
function pageSnapshot() {
  const count = (selector) => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return -1;
    }
  };
  const point = typeof window.__educoderLastPoint === 'function' ? window.__educoderLastPoint() : null;
  let elementAtPointer = null;
  if (point) {
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit) {
      elementAtPointer = {
        tag: String(hit.tagName || '').toLowerCase(),
        cls: String(hit.className || '').slice(0, 80),
        id: String(hit.id || ''),
        isCanvas: String(hit.tagName || '').toUpperCase() === 'CANVAS',
        textLength: String(hit.textContent || '').length
      };
    }
  }
  return {
    pointer: point,
    elementAtPointer,
    canvases: count('canvas'),
    iframes: [...document.querySelectorAll('iframe')].map((frame) => ({
      src: String(frame.src || '').slice(0, 120),
      sandbox: frame.getAttribute('sandbox')
    })),
    editors: {
      codemirror5: count('.CodeMirror'),
      monacoDom: count('.monaco-editor'),
      monacoGlobal: typeof monaco !== 'undefined' && !!(monaco && monaco.editor),
      ace: count('.ace_editor'),
      cm6: count('.cm-content'),
      readonlyMonaco: count('.monaco-editor.readOnly'),
      viewLines: count('.view-lines'),
      contenteditable: count('[contenteditable="true"]'),
      textarea: count('textarea')
    },
    bodyText: document.body ? document.body.innerText.length : 0
  };
}

const CTRL_KEY = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };

async function pressShortcut(tabId, key, code, keyCode) {
  const combo = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: 2 };
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...CTRL_KEY, modifiers: 2 });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...combo });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...combo });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...CTRL_KEY, modifiers: 0 });
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(150);
  }
  if (tab.status === 'loading') await sleep(400);
}

// 打开/关闭“快捷键护盾”：页面在 window 捕获阶段 preventDefault 掉 Ctrl+A/C/V 时，
// 由解锁脚本抢先截住事件，让浏览器的默认全选/复制/粘贴照常执行。
async function setShortcutShield(tabId, milliseconds) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (ms) => {
        if (typeof window.__educoderShortcutShield === 'function') window.__educoderShortcutShield(ms);
      },
      args: [milliseconds]
    });
  } catch {
    /* 页面可能还没注入解锁脚本，忽略 */
  }
}

// 找出页面里“编辑器正文”的中心点。Monaco 的 minimap 也是 canvas，按用户上次点的
// 坐标点回去很容易点到 minimap：焦点没进编辑器，Ctrl+A 就变成选中页面 DOM，于是
// 只复制到视口里渲染出来的前几行。所以优先点 .view-lines / .CodeMirror-lines 这类
// 正文区域中心，避开发右侧的 minimap 和行号槽。
// 聚焦前的取点计划：优先“用户自己点过、且落在编辑器里”的位置，
// 再试编辑器里第一条可见行的中心，最后才试正文容器中心。
// 真实页面常在容器上盖遮罩（水印层、讨论浮层），点容器中心不一定能聚焦。
async function editorFocusPlan(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        const push = (list, seen, x, y, why) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (x < 1 || y < 1 || x > window.innerWidth - 2 || y > window.innerHeight - 2) return;
          const roundedX = Math.round(x);
          const roundedY = Math.round(y);
          const key = roundedX + ',' + roundedY;
          if (seen.has(key)) return;
          seen.add(key);
          list.push({ x: roundedX, y: roundedY, why });
        };
        const points = [];
        const seen = new Set();
        const containers = [];
        for (const selector of ['.monaco-editor', '.CodeMirror', '.ace_editor', '.cm-editor']) {
          let nodes = [];
          try {
            nodes = document.querySelectorAll(selector);
          } catch {
            nodes = [];
          }
          for (const node of nodes) {
            const rect = node.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 40) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
            if (rect.right < 0 || rect.left > window.innerWidth) continue;
            containers.push({ node, selector, area: rect.width * rect.height });
          }
        }
        containers.sort((a, b) => b.area - a.area);
        if (!containers.length) {
          try {
            const last = typeof window.__educoderLastPoint === 'function' ? window.__educoderLastPoint() : null;
            if (last) push(points, seen, last.x, last.y, 'remembered');
          } catch {}
          return { points, hasEditor: false };
        }
        const top = containers[0];
        try {
          top.node.scrollIntoView({ block: 'nearest' });
        } catch {}
        try {
          const last = typeof window.__educoderLastPoint === 'function' ? window.__educoderLastPoint() : null;
          if (last && Number.isFinite(last.x) && Number.isFinite(last.y)) {
            const hit = document.elementFromPoint(last.x, last.y);
            if (hit && top.node.contains(hit)) push(points, seen, last.x, last.y, 'remembered');
          }
        } catch {}
        const rect = top.node.getBoundingClientRect();
        for (const lineSelector of ['.view-line', '.CodeMirror-line', '.ace_line', '.cm-line']) {
          let lines = [];
          try {
            lines = top.node.querySelectorAll(lineSelector);
          } catch {
            lines = [];
          }
          let used = 0;
          for (const line of lines) {
            const lineRect = line.getBoundingClientRect();
            if (lineRect.width < 8 || lineRect.height < 6) continue;
            if (lineRect.bottom < 0 || lineRect.top > window.innerHeight) continue;
            push(points, seen, lineRect.left + Math.min(lineRect.width * 0.4, 80), lineRect.top + lineRect.height * 0.5, 'line');
            used += 1;
            if (used >= 3) break;
          }
          if (used) break;
        }
        push(points, seen, rect.left + rect.width * 0.5, rect.top + Math.min(rect.height * 0.5, 120), 'surface');
        push(points, seen, rect.left + Math.min(rect.width * 0.35, 120), rect.top + Math.min(rect.height * 0.25, 60), 'surface-2');
        return { points, hasEditor: true, selector: top.selector };
      }
    });
  } catch {
    return { points: [], hasEditor: false, frames: [] };
  }
  const frames = results
    .filter((item) => item.result && Array.isArray(item.result.points))
    .map((item) => ({ frameId: item.frameId || 0, ...item.result }));
  if (!frames.length) return { points: [], hasEditor: false, frames: [] };
  // 点击坐标只有主框架的才可靠；子框架里的编辑器靠“用户点过就记住”的坐标兜底。
  const main = frames.find((frame) => frame.frameId === 0 && frame.hasEditor) || frames.find((frame) => frame.frameId === 0) || null;
  const primary = main || frames.find((frame) => frame.hasEditor) || frames[0];
  const points = primary.points.slice();
  const weight = (point) => (point.why === 'remembered' ? 0 : point.why === 'line' ? 1 : 2);
  points.sort((a, b) => weight(a) - weight(b));
  return { points, hasEditor: !!primary.hasEditor, frameId: primary.frameId, selector: primary.selector, frames };
}

// 点完之后确认焦点到底落在哪里——点不到编辑器时要明确报错，
// 不能默默把整个页面选上、复制出一段“屏幕上可见的行”。
async function editorFocusInfo(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const node = document.activeElement;
        const host = node && node.closest ? node.closest('.monaco-editor, .CodeMirror, .ace_editor, .cm-editor') : null;
        return {
          tag: node ? node.tagName : null,
          cls: node && typeof node.className === 'string' ? node.className.slice(0, 80) : '',
          inside: !!host,
          host: host ? host.className.toString().slice(0, 80) : '',
          hasFocus: document.hasFocus()
        };
      }
    });
    return (result && result.result) || null;
  } catch {
    return null;
  }
}

async function clickAt(tabId, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1
  });
  await sleep(80);
  return true;
}

// 用户上次点的位置（canvas / 封闭组件只能靠它）。
async function rememberedPoint(tabId) {
  try {
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          if (typeof window.__educoderLastPoint === 'function') {
            const saved = window.__educoderLastPoint();
            if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { x: saved.x, y: saved.y };
          }
          if (typeof window.__educoderLastTarget === 'function') {
            const node = window.__educoderLastTarget();
            const rect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
            if (rect && rect.width && rect.height) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        } catch {
          /* 忽略 */
        }
        return null;
      }
    });
    return (hit && hit.result) || null;
  } catch {
    return null;
  }
}

// 点回去的正确顺序：先试编辑器正文中心，再退回用户上次点的位置。
async function focusEditorTarget(tabId) {
  const plan = await editorFocusPlan(tabId);
  let info = null;
  for (const point of plan.points.slice(0, 8)) {
    if (!(await clickAt(tabId, point))) continue;
    info = await editorFocusInfo(tabId);
    if (!plan.hasEditor) return { ...point, focused: false, hasEditor: false, focus: info };
    if (info && info.inside) return { ...point, focused: true, hasEditor: true, focus: info };
  }
  if (!plan.points.length) {
    const point = await rememberedPoint(tabId);
    if (point && (await clickAt(tabId, point))) {
      info = await editorFocusInfo(tabId);
      return { ...point, focused: !!(info && info.inside), hasEditor: plan.hasEditor, focus: info };
    }
  }
  return { focused: false, hasEditor: plan.hasEditor, focus: info, tried: plan.points.length };
}

// 有编辑器、但点完焦点还是没进去时，后面所有按键都会打在页面上（而不是编辑器里），
// 必须直接报错，避免“复制到几行可见文字 / 写到错误位置”。
function assertFocused(focus) {
  if (focus && focus.hasEditor && !focus.focused) {
    throw fail(
      'FOCUS_NOT_IN_EDITOR',
      '点不到代码区，焦点没有进编辑器（页面可能有遮罩或浮层挡住了点击）。请先在页面里手动点一下代码区，再重试。'
    );
  }
  return focus;
}

async function assertConsent() {
  const settings = await getSettings();
  if (!settings.debugConsent) throw fail('DEBUG_CONSENT_REQUIRED', '请先在弹窗中点击“同意并启用调试权限”。');
  return settings;
}

// shield=false：不拦页面，让编辑器自己的 Ctrl+C 实现跑（CodeMirror/Monaco 都靠自己的复制逻辑）；
// shield=true ：拦掉页面监听器，走浏览器原生的“复制选区”，适合页面把复制整个禁掉的情况。
async function copyByKeyboard(tabId, options = {}) {
  const shield = options.shield !== false;
  await assertConsent();
  await assertPage(tabId);
  await focusTab(tabId);
  await attach(tabId);
  try {
    if (shield) await setShortcutShield(tabId, 5000);
    assertFocused(await focusEditorTarget(tabId));
    await pressShortcut(tabId, 'a', 'KeyA', 65);
    await sleep(150);
    await pressShortcut(tabId, 'c', 'KeyC', 67);
    await sleep(250);
    return { method: shield ? 'keys-copy-native' : 'keys-copy-page', chars: null };
  } finally {
    if (shield) await setShortcutShield(tabId, 0);
    await detach(tabId);
  }
}

async function pasteByKeyboard(tabId, options = {}) {
  const replace = options.replace !== false;
  const shield = options.shield !== false;
  await assertConsent();
  await assertPage(tabId);
  await focusTab(tabId);
  await attach(tabId);
  try {
    if (shield) await setShortcutShield(tabId, 5000);
    assertFocused(await focusEditorTarget(tabId));
    if (replace) {
      await pressShortcut(tabId, 'a', 'KeyA', 65);
      await sleep(150);
    }
    await pressShortcut(tabId, 'v', 'KeyV', 86);
    await sleep(300);
    return { method: shield ? 'keys-paste-native' : 'keys-paste-page' };
  } finally {
    if (shield) await setShortcutShield(tabId, 0);
    await detach(tabId);
  }
}

// 纯键入：不碰剪贴板，像真人一样一个一个键敲进去。
// 平台如果只拦“粘贴”（检测 insertFromPaste / paste 事件），这条路照样能进。
async function typeIntoPage(tabId, text, options = {}) {
  const replace = options.replace !== false;
  await assertConsent();
  await assertPage(tabId);
  await focusTab(tabId);
  await attach(tabId);
  try {
    await setShortcutShield(tabId, 30000);
    assertFocused(await focusEditorTarget(tabId));
    if (replace) {
      await pressShortcut(tabId, 'a', 'KeyA', 65);
      await sleep(150);
    }
    await typeByKeyEvents(tabId, text, 3, { enterForNewline: true });
    await sleep(200);
    return { method: 'keys-typed', chars: text.length };
  } finally {
    await setShortcutShield(tabId, 0);
    await detach(tabId);
  }
}

async function snapshotTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: pageSnapshot
    });
    return results.map((item) => ({ frameId: item.frameId, ...item.result }));
  } catch (error) {
    return [{ frameId: 0, error: String(error && error.message ? error.message : error) }];
  }
}

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

async function handle(message) {
  switch (message.type) {
    case 'settings':
      return { settings: await getSettings() };
    case 'set-setting': {
      const patch = {};
      if (typeof message.debugConsent === 'boolean') patch.debugConsent = message.debugConsent;
      if (typeof message.unlock === 'boolean') patch.unlock = message.unlock;
      if (typeof message.typingDelayMs === 'number') patch.typingDelayMs = Math.max(0, Math.min(50, message.typingDelayMs));
      if (Object.keys(patch).length) await chrome.storage.local.set(patch);
      return { settings: await getSettings() };
    }
    case 'read': {
      const tab = await assertPage(message.tabId);
      return { editor: await readEditor(tab.id, message.spec) };
    }
    case 'paste': {
      const tab = await assertPage(message.tabId);
      return { result: await pasteIntoEditor(tab.id, message) };
    }
    case 'eval': {
      const tab = await assertPage(message.tabId);
      return { result: await evaluateInPage(tab.id, message.expression) };
    }
    case 'diagnose': {
      const tab = await assertPage(message.tabId);
      return { diagnosis: await diagnose(tab.id, message.spec) };
    }
    case 'keytype': {
      const tab = await assertPage(message.tabId);
      const text = String(message.text || '');
      if (!text) throw fail('TEXT_REQUIRED', '没有要键入的文本。');
      if (text.length > MAX_TEXT) throw fail('TEXT_TOO_LARGE', '文本太长，请分段。');
      return { result: await typeIntoPage(tab.id, text, { replace: message.replace !== false }) };
    }
    case 'keycopy': {
      const tab = await assertPage(message.tabId);
      return { result: await copyByKeyboard(tab.id, { shield: message.shield !== false }) };
    }
    case 'keypaste': {
      const tab = await assertPage(message.tabId);
      return { result: await pasteByKeyboard(tab.id, { replace: message.replace !== false, shield: message.shield !== false }) };
    }
    default:
      throw fail('UNKNOWN_ACTION', `未知操作：${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message || {})
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({
      ok: false,
      code: error?.code || 'ERROR',
      error: String(error?.message || error)
    }));
  return true;
});

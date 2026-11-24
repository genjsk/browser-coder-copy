// 网页代码复制助手 · 弹窗逻辑

function normalizeText(text) {
  const normalized = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/\u200b/g, '');
  return /^([\w-]+\.)*educoder\.net(?::\d+)?$/i.test(hostOf()) ? normalized.replace(/NBSP/g, ' ') : normalized;
}

const $ = (id) => document.getElementById(id);

const els = {
  pageInfo: $('pageInfo'),
  statusDot: $('statusDot'),
  consentBanner: $('consentBanner'),
  consentBtn: $('consentBtn'),
  editorBadge: $('editorBadge'),
  pickRow: $('pickRow'),
  editorPick: $('editorPick'),
  readBtn: $('readBtn'),
  readSelectionBtn: $('readSelectionBtn'),
  copyBtn: $('copyBtn'),
  forceReadBtn: $('forceReadBtn'),
  codeView: $('codeView'),
  readMeta: $('readMeta'),
  unlockToggle: $('unlockToggle'),
  diagBtn: $('diagBtn'),
  diagCopyBtn: $('diagCopyBtn'),
  diagResult: $('diagResult')
};

const TYPE_LABELS = {
  active: '当前焦点编辑器',
  monaco: 'Monaco 编辑器',
  codemirror5: 'CodeMirror 5',
  codemirror6: 'CodeMirror 6',
  ace: 'Ace 编辑器',
  codeblock: '网页代码块',
  textarea: '文本框',
  contenteditable: '可编辑区域'
};

// 下拉框里“当前焦点”这一项的取值，用它绕开一切候选排序。
const ACTIVE = 'active';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let tab = null;
let settings = { debugConsent: false, unlock: true };
// choice 是代码来源的定位：{ type, nth, frameId }，null 表示自动识别。
// 读取和诊断使用同一份编辑器选择。
let choice = null;
let previewRequest = 0;
let partialSource = null;

function setDot(state, title) {
  els.statusDot.className = `status-dot ${state || ''}`.trim();
  els.statusDot.title = title || '';
}

function setMeta(element, text, kind) {
  element.textContent = text || '';
  element.className = `meta${kind ? ` ${kind}` : ''}`;
}

function badge(text, kind) {
  els.editorBadge.textContent = text;
  els.editorBadge.className = `badge${kind ? ` ${kind}` : ''}`;
}

function request(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...message, tabId: tab && tab.id }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, code: 'PORT', error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, code: 'EMPTY', error: '后台没有响应，请重新加载扩展。' });
    });
  });
}

function describeFailure(response) {
  const map = {
    RESTRICTED_PAGE: '当前页面受浏览器保护。请打开普通网页后再试。',
    NO_TAB: '没有找到活动标签页。',
    DEBUG_CONSENT_REQUIRED: '请先点击上方“同意并启用调试权限”。',
    DEBUGGER_BUSY: '该标签页被 DevTools 占用，请先关闭 F12 再试。',
    DEBUGGER_ATTACH_FAILED: '无法连接调试器，请刷新页面或重新加载扩展。',
    DEBUGGER_PERMISSION_REQUIRED: '扩展缺少调试权限，请到 chrome://extensions 重新加载。',
    EDITOR_NOT_FOUND: '你选的代码区已经不在页面上了，请在“代码来源”下拉框里重新选择。',
    NO_ACTIVE_EDITOR: '没找到光标所在的编辑器：先在页面里点一下代码区再试；如果代码区是画布/封闭组件，直接用“强制读取（Ctrl+A/C）”（弹窗抢走焦点不影响，扩展会记住你最近点的编辑器）。',
    FOCUS_NOT_IN_EDITOR: '焦点没进入代码区，页面可能有遮罩。请在页面里点一下代码正文，再试一次。',
    NO_EDITOR: '没有识别到编辑器。请先点一下代码区，再用“强制读取（Ctrl+A/C）”。'
  };
  const base = map[response.code] || response.error || '操作失败。';
  return response.code && map[response.code] ? base : `${base}${response.code ? `（${response.code}）` : ''}`;
}

function hostOf() {
  if (!tab) return '';
  try {
    return new URL(tab.url).host;
  } catch {
    return '';
  }
}

async function loadSettings() {
  const response = await request({ type: 'settings' });
  if (response.ok) settings = response.settings;
  els.consentBanner.classList.toggle('hidden', !!settings.debugConsent);
  els.unlockToggle.checked = settings.unlock !== false;
  return settings;
}

async function saveSetting(patch) {
  const response = await request({ type: 'set-setting', ...patch });
  if (response.ok) settings = response.settings;
  return response;
}

// 每个站点记住上次选的编辑器（头歌、其他 OJ 的 DOM 结构各不相同）。
async function loadChoice() {
  const host = hostOf();
  if (!host) return null;
  const stored = await chrome.storage.local.get({ editorChoice: {} });
  const saved = (stored.editorChoice || {})[host];
  return saved && typeof saved.type === 'string' ? saved : null;
}

async function saveChoice(value) {
  const host = hostOf();
  if (!host) return;
  const stored = await chrome.storage.local.get({ editorChoice: {} });
  const map = { ...(stored.editorChoice || {}) };
  if (value) map[host] = value;
  else delete map[host];
  const keys = Object.keys(map);
  // 别让这个 map 无限增长：只留最近 20 个站点。
  while (keys.length > 20) delete map[keys.shift()];
  await chrome.storage.local.set({ editorChoice: map });
}

function specKey(spec) {
  if (!spec) return '';
  if (spec.type === ACTIVE) return ACTIVE;
  return `${spec.type}|${spec.nth}|${spec.frameId == null ? '' : spec.frameId}`;
}

function candidateLabel(candidate, index) {
  const label = TYPE_LABELS[candidate.type] || candidate.type;
  const nth = candidate.nth ? ` #${candidate.nth + 1}` : '';
  const frame = candidate.frameId > 0 ? ` · 框架 ${candidate.frameId}` : '';
  const preview = candidate.preview ? ` · ${candidate.preview.slice(0, 18)}` : '';
  const focused = candidate.active ? ' · 当前焦点' : '';
  return `${label}${nth} · ${candidate.chars} 字${frame}${focused}${preview || ` · 第 ${index + 1} 个可编辑区`}`;
}

function renderPicker(editor) {
  const candidates = (editor && editor.candidates) || [];
  els.editorPick.replaceChildren();

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '自动识别代码区';
  els.editorPick.append(auto);

  const active = document.createElement('option');
  active.value = ACTIVE;
  active.textContent = '当前光标所在编辑器（先点一下代码区）';
  els.editorPick.append(active);

  for (const [index, candidate] of candidates.entries()) {
    const option = document.createElement('option');
    option.value = specKey(candidate);
    option.textContent = candidateLabel(candidate, index);
    els.editorPick.append(option);
  }

  // 只有一个候选时也保留下拉框：用户可以切到“当前光标”，绕开自动判断。
  els.pickRow.classList.remove('hidden');
  const options = Array.from(els.editorPick.options);
  let wanted = '';
  if (choice && choice.type === ACTIVE) {
    wanted = ACTIVE;
  } else if (choice && choice.type) {
    // 先严格匹配（含 frame），再退到同类型同序号（页面刷新后 frame 编号会变）。
    const exact = specKey(choice);
    if (options.some((option) => option.value === exact)) wanted = exact;
    else {
      const loose = options.find((option) => option.value.startsWith(`${choice.type}|${choice.nth}|`));
      if (loose) wanted = loose.value;
    }
  }
  if (wanted && options.some((option) => option.value === wanted)) {
    els.editorPick.value = wanted;
    return;
  }
  const key = specKey(editor);
  const known = candidates.some((candidate) => specKey(candidate) === key);
  els.editorPick.value = known ? key : '';
}

// 读取失败（比如“当前光标”模式下页面没有焦点）时，仍然把候选渲染出来，
// 让用户可以直接在下拉框里换一个编辑器，而不是对着空白下拉框干瞪眼。
async function refreshPicker(requestId = previewRequest) {
  const response = await request({ type: 'diagnose', spec: choice });
  if (!response.ok || requestId !== previewRequest) return;
  const diagnosis = response.diagnosis || {};
  const editor = diagnosis.editor || null;
  renderPicker({
    candidates: diagnosis.candidates || [],
    type: editor ? editor.type : null,
    nth: editor ? editor.nth : null,
    frameId: editor ? editor.frameId : null,
    editorCount: diagnosis.candidateCount || (editor ? editor.editorCount : 0)
  });
}

function readPicker() {
  const value = els.editorPick.value;
  if (value === ACTIVE) return { type: ACTIVE, nth: 0, frameId: null };
  if (!value) return null;
  const [type, nth, frameId] = value.split('|');
  return {
    type,
    nth: Number(nth) || 0,
    frameId: frameId === '' ? null : Number(frameId)
  };
}

async function refreshPage() {
  if (!tab) {
    els.pageInfo.textContent = '没有活动标签页';
    setDot('err', '没有活动标签页');
    return;
  }
  const host = hostOf() || tab.url || '';
  els.pageInfo.textContent = host || '当前标签页';
  els.pageInfo.title = tab.title || tab.url || '';
  setDot(/^https?:/i.test(tab.url || '') ? 'ok' : 'warn', /^https?:/i.test(tab.url || '') ? '就绪' : '该页面不支持注入');
}

async function readEditor({ auto = false } = {}) {
  if (!tab) {
    setMeta(els.readMeta, '没有活动标签页。', 'err');
    return;
  }
  const requestId = ++previewRequest;
  els.readBtn.disabled = true;
  if (!auto) setMeta(els.readMeta, '正在读取…');
  const response = await request({ type: 'read', spec: choice });
  els.readBtn.disabled = false;
  if (requestId !== previewRequest) return;

  if (!response.ok) {
    partialSource = null;
    badge('读取失败', 'miss');
    els.codeView.value = '';
    els.copyBtn.disabled = true;
    setMeta(els.readMeta, describeFailure(response), 'err');
    setDot('warn', '读取失败');
    await refreshPicker(requestId);
    return;
  }

  const editor = response.editor;
  if (!editor || !editor.type) {
    partialSource = null;
    badge('未检测到代码区', 'miss');
    els.codeView.value = '';
    els.copyBtn.disabled = true;
    setMeta(els.readMeta, '没有识别到代码区。可以在网页上选中文字，再点“读取选中文字”。');
    setDot('warn', '未识别到代码区');
    return;
  }

  // 页面刷新后子框架编号可能变化。同步到读到的来源，但保留“当前焦点”模式。
  if (choice && choice.type !== ACTIVE && (editor.type !== choice.type || editor.nth !== choice.nth || (choice.frameId != null && editor.frameId !== choice.frameId))) {
    choice = { type: editor.type, nth: editor.nth, frameId: editor.frameId };
    await saveChoice(choice);
    if (requestId !== previewRequest) return;
  }

  renderPicker(editor);

  const label = TYPE_LABELS[editor.type] || editor.type;
  const suffix = editor.editorCount > 1 ? ` #${(editor.nth || 0) + 1}` : '';
  badge(`${label}${suffix}`, 'ok');
  const text = normalizeText(editor.text);
  partialSource = editor.partial
    ? { type: editor.type, nth: editor.nth, frameId: editor.frameId, visibleText: text }
    : null;
  els.codeView.value = text;
  els.copyBtn.disabled = !text && !partialSource;
  const chars = (editor.text || '').length;
  const lines = (editor.text || '').split('\n').length;
  const via = editor.via === 'cdp' ? '，调试通道读取' : '';
  const frame = editor.frameId > 0 ? `，子框架 #${editor.frameId}` : '';
  const others = editor.editorCount > 1 ? `，共 ${editor.editorCount} 个来源` : '';
  if (editor.partial) {
    // Monaco 只把当前视口的行渲染进 DOM，DOM 里读不到整份文档。
    // 用户手动读取时，尝试用键盘通道读取全文。
    if (!auto && settings.debugConsent) {
      await forceReadByKeyboard();
      return;
    }
    setMeta(
      els.readMeta,
      `${chars} 字符 / ${lines} 行${frame}${others}：以下是可见行预览，点击“复制到剪贴板”会尝试从编辑器读取全文。`,
      'warn',
    );
    setDot('warn', '只读到可见部分');
    return;
  }
  setMeta(els.readMeta, `${chars} 字符 / ${lines} 行${frame}${others}${via}${auto ? '' : '。已读取，可复制。'}`, 'ok');
  setDot('ok', '已读取代码');
}

async function readSelection() {
  const requestId = ++previewRequest;
  els.readSelectionBtn.disabled = true;
  const response = await request({ type: 'read-selection' });
  els.readSelectionBtn.disabled = false;
  if (requestId !== previewRequest) return;
  if (!response.ok) {
    setMeta(els.readMeta, describeFailure(response), 'warn');
    return;
  }
  const text = normalizeText(response.text);
  partialSource = null;
  els.codeView.value = text;
  els.copyBtn.disabled = !text;
  badge('网页选区', 'ok');
  setMeta(els.readMeta, `已读取选中的 ${text.length} 字符，可复制。`, 'ok');
  setDot('ok', '已读取网页选区');
}

async function copyOut() {
  if (partialSource) {
    await forceReadByKeyboard();
    return;
  }
  const text = normalizeText(els.codeView.value);
  if (!text) {
    setMeta(els.readMeta, '还没有可复制的内容。', 'err');
    return;
  }
  els.codeView.value = text;
  try {
    await navigator.clipboard.writeText(text);
    setMeta(els.readMeta, `已复制 ${text.length} 字符到剪贴板。`, 'ok');
    setDot('ok', '已复制');
  } catch (error) {
    els.codeView.removeAttribute('readonly');
    els.codeView.focus();
    els.codeView.select();
    const copied = document.execCommand('copy');
    els.codeView.setAttribute('readonly', '');
    setMeta(els.readMeta, copied ? '已通过备用方式复制。' : `复制失败：${error?.message || error}`, copied ? 'ok' : 'err');
  }
}


// ---- 键盘剪贴板通道 -------------------------------------------------------

async function clipboardText() {
  try {
    return { ok: true, text: await navigator.clipboard.readText() };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// 纯文本剪贴板可临时打标，区分“又复制了同一份代码”和“根本没有复制”。
async function markPlainClipboard(before) {
  if (!before.ok || !before.text) return null;
  try {
    const items = await navigator.clipboard.read();
    if (items.length !== 1 || items[0].types.length !== 1 || items[0].types[0] !== 'text/plain') return null;
    if (await (await items[0].getType('text/plain')).text() !== before.text) return null;
    const marker = `[code-copy:${crypto.randomUUID()}]`;
    await navigator.clipboard.writeText(marker);
    return marker;
  } catch {
    return null;
  }
}

// 优先尝试编辑器自带的复制，必要时再尝试浏览器原生复制。
async function readPageViaKeyboard(partial) {
  const before = await clipboardText();
  const marker = partial ? await markPlainClipboard(before) : null;
  const attempts = [
    { shield: false, label: '页面自身复制' },
    { shield: true, label: '浏览器原生复制' }
  ];
  const source = partial ? { type: partial.type, nth: partial.nth, frameId: partial.frameId } : null;
  const visibleLength = partial?.visibleText?.replace(/\s/g, '').length || 0;
  let failure = null;
  try {
    for (const attempt of attempts) {
      const response = await request({ type: 'keycopy', shield: attempt.shield, source });
      if (!response.ok) {
        failure = response;
        continue;
      }
      await sleep(350);
      const after = await clipboardText();
      if (!after.ok || !after.text || after.text === (marker ?? before.text)) continue;
      const text = normalizeText(after.text);
      const copiedLength = text.replace(/\s/g, '').length;
      if (!text || copiedLength < visibleLength) continue;
      // 浏览器原生全选可能只复制了可见行。
      const mayBePartial = visibleLength > 0 && copiedLength === visibleLength;
      if (attempt.shield && mayBePartial) continue;
      if (text !== after.text) {
        try { await navigator.clipboard.writeText(text); } catch {}
      }
      return { ok: true, text, label: attempt.label, mayBePartial };
    }
  } finally {
    if (marker && (await clipboardText()).text === marker) {
      try { await navigator.clipboard.writeText(before.text); } catch {}
    }
  }
  return failure || { ok: false, error: '没有从编辑器取得可确认的内容。请先在网页里点一下代码正文，再试一次。' };
}

// DOM 里读不到编辑器时的兜底：让页面自己“全选 + 复制”，再从剪贴板把文本取回来。
// 这条路绕开了 DOM 与编辑器实例，所以对 canvas 渲染、closed shadow root、
// 注入不进去的跨域 iframe 都成立——只要页面的复制还能用。
async function forceReadByKeyboard() {
  if (els.forceReadBtn.disabled) return;
  if (!settings.debugConsent) {
    els.consentBanner.classList.remove('hidden');
    setMeta(els.readMeta, '需要先同意启用调试权限。', 'err');
    return;
  }
  const requestId = ++previewRequest;
  const partial = partialSource;
  els.forceReadBtn.disabled = true;
  setMeta(els.readMeta, '正在模拟 Ctrl+A / Ctrl+C…（页面会自动切到前台）');
  setDot('', '正在读取');
  const result = await readPageViaKeyboard(partial);
  els.forceReadBtn.disabled = false;
  if (requestId !== previewRequest) return;
  if (!result.ok) {
    const hint = partial ? ' 当前预览仍可能缺少后续行。' : '';
    setMeta(els.readMeta, describeFailure(result) + hint, 'warn');
    setDot('warn', '没有读到内容');
    return;
  }
  partialSource = result.mayBePartial ? partial : null;
  els.codeView.value = normalizeText(result.text);
  els.copyBtn.disabled = false;
  const lines = result.text.split('\n').length;
  if (result.mayBePartial) {
    badge('可见行', 'miss');
    setMeta(els.readMeta, `已复制 ${lines} 行，与预览长度一致，无法确认是否还有后续行。`, 'warn');
    setDot('warn', '可能仅复制到可见行');
    return;
  }
  badge('键盘读取', 'ok');
  setMeta(els.readMeta, `${result.text.length} 字符 / ${lines} 行 · ${result.label}`, 'ok');
  setDot('ok', '已通过键盘复制读取');
}

async function refreshDiagnosis() {
  els.diagBtn.disabled = true;
  const response = await request({ type: 'diagnose', spec: choice });
  els.diagBtn.disabled = false;
  els.diagResult.classList.remove('hidden');
  if (!response.ok) {
    els.diagResult.textContent = describeFailure(response);
    return;
  }
  const d = response.diagnosis;
  const editor = d.editor
    ? `${TYPE_LABELS[d.editor.type] || d.editor.type}${d.editor.editorCount > 1 ? ` #${(d.editor.nth || 0) + 1}` : ''}，${d.editor.chars} 字符，frame ${d.editor.frameId}，via ${d.editor.via}`
    : '未识别';
  const candidateLines = (d.candidates || []).map((candidate, index) => {
    const label = TYPE_LABELS[candidate.type] || candidate.type;
    const focused = candidate.active ? '（当前焦点）' : '';
    return `  ${index + 1}. ${label} #${(candidate.nth || 0) + 1} · ${candidate.chars} 字 · ${candidate.area}px² · frame ${candidate.frameId}${focused}`;
  });
  const frameLines = (d.frames || []).map((frame) => {
    const where = `frame ${frame.frameId}${frame.frameUrl ? ` ${frame.frameUrl}` : ''}`;
    return `  · ${where} · ${frame.ok ? `${frame.candidates} 个候选` : `注入失败：${frame.error}`}`;
  });
  const snapshotLines = (d.snapshot || []).flatMap((frame) => {
    if (!frame || frame.error) return [];
    const at = frame.elementAtPointer
      ? `指针处 <${frame.elementAtPointer.tag}${frame.elementAtPointer.id ? `#${frame.elementAtPointer.id}` : ''}${frame.elementAtPointer.cls ? `.${frame.elementAtPointer.cls.split(/\s+/)[0]}` : ''}>${frame.elementAtPointer.isCanvas ? '（画布）' : ''}`
      : '指针处（未知）';
    const editors = frame.editors || {};
    return [
      `frame ${frame.frameId} · ${at} · 画布 ${frame.canvases} 个 · iframe ${(frame.iframes || []).length} 个`,
      `  DOM：CodeMirror ${editors.codemirror5} · Monaco(${editors.monacoDom}${editors.monacoGlobal ? '，全局可用' : ''}) · Ace ${editors.ace} · CM6 ${editors.cm6} · 可编辑区 ${editors.contenteditable} · 文本框 ${editors.textarea}`
    ];
  });
  const lines = [
    `页面：${d.title || '（无标题）'}`,
    `地址：${d.url}`,
    `编辑器：${editor}`,
    `候选数：${d.editor ? d.editor.editorCount : (d.candidateCount || 0)}`,
    ...(candidateLines.length ? ['候选列表：', ...candidateLines] : []),
    ...(frameLines.length ? ['页面 frame：', ...frameLines] : []),
    ...(snapshotLines.length ? ['页面结构：', ...snapshotLines] : []),
    `调试器：${d.debuggerAttached ? '已连接' : '未连接'}`,
    `调试授权：${d.settings.debugConsent ? '已同意' : '未同意'}`,
    `页面解锁：${d.settings.unlock ? '开启' : '关闭'}`,
    d.error ? `错误：${d.error}` : ''
  ].filter(Boolean);
  els.diagResult.textContent = lines.join('\n');
}

function bind() {
  els.readBtn.addEventListener('click', () => readEditor());
  els.readSelectionBtn.addEventListener('click', readSelection);
  els.copyBtn.addEventListener('click', copyOut);
  els.forceReadBtn.addEventListener('click', forceReadByKeyboard);
  els.diagBtn.addEventListener('click', refreshDiagnosis);
  els.diagCopyBtn.addEventListener('click', async () => {
    const text = els.diagResult.textContent || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setDot('ok', '诊断信息已复制');
    } catch {
      setDot('warn', '复制失败，请手动选中');
    }
  });

  els.editorPick.addEventListener('change', async () => {
    choice = readPicker();
    await saveChoice(choice);
    await readEditor({ auto: true });
  });

  els.consentBtn.addEventListener('click', async () => {
    await saveSetting({ debugConsent: true });
    els.consentBanner.classList.add('hidden');
    setMeta(els.readMeta, '已启用调试权限，可以使用强制读取。', 'ok');
  });

  els.unlockToggle.addEventListener('change', async () => {
    const enabled = els.unlockToggle.checked;
    await saveSetting({ unlock: enabled });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: 'unlock-refresh' }, () => void chrome.runtime.lastError);
    }
    setMeta(els.readMeta, enabled ? '页面解锁已开启（刷新页面生效）。' : '页面解锁已关闭（刷新页面生效）。');
  });
}

// 如果用户是把 popup.html 当普通标签页打开的，活动标签页就是扩展页自己，
// 这时退回到同窗口里最近用过的 http(s) 页面，否则每个按钮都会报“受浏览器保护”。
async function pickTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && /^https?:/i.test(active.url || '')) return active;
  const webTabs = await chrome.tabs.query({
    currentWindow: true,
    url: ['http://*/*', 'https://*/*'],
  });
  if (!webTabs.length) return active || null;
  webTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return webTabs[0];
}

async function init() {
  bind();
  tab = await pickTab();
  refreshPage();
  await loadSettings();
  choice = await loadChoice().catch(() => null);
  // 总是尝试读一次：成功就显示内容；失败（比如选了“当前焦点”但页面没焦点）
  // 也会把候选渲染进下拉框，用户可以直接换目标，而不是被卡住。
  if (tab && previewRequest === 0) await readEditor({ auto: true }).catch(() => {});
}

init();

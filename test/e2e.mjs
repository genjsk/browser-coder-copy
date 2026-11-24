#!/usr/bin/env node
// 端到端验收脚本（维护者用，普通用户不需要跑）：用无头 Chrome 真加载扩展，逐项断言
//   1) manifest 合法、service worker 起得来；
//   2) content/unlock.js 在 document_start 解除 user-select 与事件拦截；
//   3) 后台能识别并读取页面编辑器；
//   4) 能从 CodeMirror、Monaco、子框架和影子 DOM 读取代码；
//   5) 页面复制和键盘复制通道可用。
//
// 用法：node test/e2e.mjs
//   CHROME_PATH  指定 Chrome 可执行文件（默认 Windows 安装路径）
//   E2E_HTTP_PORT / E2E_DEBUG_PORT  自定义端口（默认 8791 / 9333）

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 8791);
const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT || 9333);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
  const target = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!path.resolve(target).startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'educoder-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  // Chrome 137+ 起命令行 --load-extension 已失效，自动化必须开这个开关后用 CDP 加载
  '--enable-unsafe-extension-debugging',
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeStderr = '';
chrome.stderr.on('data', (chunk) => { chromeStderr += chunk.toString(); });

async function browserInfo() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) return await response.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没有起来');
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id && this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter.resolve(message.result);
    });
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

let cdp;
try {
  const info = await browserInfo();
  console.log('Chrome:', info.Browser);
  cdp = new CDP(info.webSocketDebuggerUrl);
  await cdp.ready;

  // 无头环境里页面自己调 navigator.clipboard.readText/writeText 需要剪贴板权限
  try {
    await cdp.send('Browser.grantPermissions', {
      origin: `http://127.0.0.1:${HTTP_PORT}`,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
    });
  } catch (error) {
    console.log('（剪贴板权限授予失败，忽略）', error.message);
  }

  const evaluateOn = async (sessionId, expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate 失败';
      throw new Error(detail);
    }
    return result.result.value;
  };

  const openPage = async (url, sessionName) => {
    void sessionName;
    const target = await cdp.send('Target.createTarget', { url });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    // 无头窗口默认不算“被聚焦”，页面里的 focus() 会静默失败；打开焦点模拟后
    // 点编辑器才能真的把焦点交给内部 textarea（Monaco / CM5 都是这么收键盘的）。
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    return sessionId;
  };

  // ---- 1. 加载扩展（manifest 被接受、service worker 注册）
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
  const extensionId = loaded.id;
  let worker = null;
  for (let attempt = 0; attempt < 80 && !worker; attempt++) {
    const targets = await cdp.send('Target.getTargets');
    worker = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url === `chrome-extension://${extensionId}/background.js`);
    if (!worker) await sleep(250);
  }
  check('扩展加载 + service worker 已注册', !!worker, worker ? worker.url : '未发现 background.js 的 service worker');

  // ---- 2. content/unlock.js：样式与事件拦截被解除
  const pageSession = await openPage(`http://127.0.0.1:${HTTP_PORT}/test/test-page.html`);
  const evaluate = (expression) => evaluateOn(pageSession, expression);
  await sleep(1200);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, pageSession);

  const unlock = await evaluate(`(() => {
    const area = document.getElementById('lockedArea');
    return {
      styleTag: !!document.getElementById('__educoder_copy_unlock_style__'),
      userSelect: getComputedStyle(area).userSelect || getComputedStyle(area).webkitUserSelect,
      inlineHandlers: ['oncopy', 'oncontextmenu', 'onselectstart'].filter((name) => area.hasAttribute(name)),
      flag: !!window.__educoderCopyUnlock__
    };
  })()`);
  check('注入了解锁样式表', unlock.styleTag);
  check('user-select 被强制为 text', unlock.userSelect === 'text', `computed=${unlock.userSelect}`);
  check('内联阻止属性被清除', unlock.inlineHandlers.length === 0, `remain=${unlock.inlineHandlers.join(',') || 'none'}`);

  const contextProbe = await evaluate(`new Promise((resolve) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.getElementById('lockedArea').dispatchEvent(event);
    setTimeout(() => resolve({ defaultPrevented: event.defaultPrevented }), 30);
  })`);
  check('页面右键拦截已失效', contextProbe.defaultPrevented === false, `defaultPrevented=${contextProbe.defaultPrevented}`);

  // ---- 3. 借扩展页（popup）作为消息客户端调后台
  const popupSession = await openPage(`chrome-extension://${extensionId}/popup.html`, 'popup');
  await sleep(700);
  const popupEval = (expression) => evaluateOn(popupSession, expression);

  const popupState = await popupEval(`({ title: document.title, hasConsentBanner: !!document.getElementById('consentBanner') })`);
  check('popup 页面正常渲染', popupState.title === '网页代码复制助手', popupState.title);
  // 无头模式下页面默认不算“聚焦”，剪贴板 API 会拒绝；让 CDP 帮它装作被聚焦。
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, popupSession);

  const callOn = (urlPart, message) => popupEval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => (tab.url || '').includes(${JSON.stringify(urlPart)}));
    if (!target) return { ok: false, error: '找不到目标标签页' };
    return await chrome.runtime.sendMessage(Object.assign(${JSON.stringify(message)}, { tabId: target.id }));
  })()`);

  const read = await callOn('test/test-page.html', { type: 'read' });
  check('后台读取到页面编辑器', read.ok === true && read.editor?.type === 'textarea',
    read.ok ? `${read.editor?.type} / ${(read.editor?.text || '').length} 字符` : read.error);
  check('读取内容包含页面代码', (read.editor?.text || '').includes('def solve'));

  // ---- 4. CodeMirror 5 夹具（内容只存在于编辑器实例里）
  await openPage(`http://127.0.0.1:${HTTP_PORT}/test/fixtures/cm5-editor.html`);
  await sleep(1000);

  const cmRead = await callOn('cm5-editor.html', { type: 'read' });
  check('识别 CodeMirror 5 并读取内容', cmRead.ok === true && cmRead.editor?.type === 'codemirror5' && (cmRead.editor?.text || '').includes('const answer = 42'),
    cmRead.ok ? `${cmRead.editor?.type} / ${(cmRead.editor?.text || '').slice(0, 24)}…` : cmRead.error);

  // ---- 5. 解锁后 copy 事件不再被页面取消
  const copyProbe = await evaluate(`(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('lockedArea'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
    document.getElementById('lockedArea').dispatchEvent(event);
    return { selected: selection.toString().length, blocked: event.defaultPrevented };
  })()`);
  check('解除复制拦截后 copy 不再被取消', copyProbe.selected > 0 && copyProbe.blocked === false,
    `选中 ${copyProbe.selected} 字，defaultPrevented=${copyProbe.blocked}`);
  // ---- 6. 多编辑器页面：代码区和自定义测试用例
  const multiSession = await openPage(`http://127.0.0.1:${HTTP_PORT}/test/fixtures/cm5-two-editors.html`);
  await sleep(900);

  const autoRead = await callOn('cm5-two-editors.html', { type: 'read' });
  check('多编辑器：自动选中代码区而不是测试用例框',
    autoRead.ok === true && autoRead.editor?.type === 'codemirror5' && (autoRead.editor?.text || '').includes('def solve') && autoRead.editor?.nth === 1,
    autoRead.ok ? `type=${autoRead.editor?.type} nth=${autoRead.editor?.nth} 候选=${autoRead.editor?.editorCount}` : autoRead.error);

  const specRead = await callOn('cm5-two-editors.html', { type: 'read', spec: { type: 'codemirror5', nth: 0 } });
  check('多编辑器：可按选择器精确读取测试用例框',
    specRead.ok === true && specRead.editor?.text === 'ghj',
    specRead.ok ? JSON.stringify(specRead.editor?.text) : specRead.error);

  // ---- 7. 定位当前焦点和指定编辑器
  await evaluateOn(multiSession, `(() => { window.__main.focus(); return true; })()`);
  await sleep(80);
  const activeRead = await callOn('cm5-two-editors.html', { type: 'read', spec: { type: 'active', nth: 0 } });
  check('当前焦点模式：读出焦点所在代码区',
    activeRead.ok === true && activeRead.editor?.type === 'codemirror5' && activeRead.editor?.nth === 1,
    activeRead.ok ? `type=${activeRead.editor?.type} nth=${activeRead.editor?.nth}` : `${activeRead.code}: ${activeRead.error}`);

  await evaluateOn(multiSession, `(() => { window.__stdin.focus(); return true; })()`);
  await sleep(80);
  const activeStdin = await callOn('cm5-two-editors.html', { type: 'read', spec: { type: 'active' } });
  check('当前焦点切到测试用例框后读取该框', activeStdin.ok && activeStdin.editor?.nth === 0 && activeStdin.editor?.text === 'ghj');

  const missing = await callOn('cm5-two-editors.html', { type: 'read', spec: { type: 'codemirror5', nth: 7 } });
  check('指定的编辑器不存在时报错', !missing.ok && missing.code === 'EDITOR_NOT_FOUND');

  // ---- 8. 编辑器在影子 DOM 里时也要被发现
  await openPage(`http://127.0.0.1:${HTTP_PORT}/test/fixtures/shadow-editor.html`);
  await sleep(900);
  const shadowRead = await callOn('shadow-editor.html', { type: 'read' });
  check('影子 DOM 里的编辑器能被发现，不会只认页面上的小输入框',
    shadowRead.ok === true && shadowRead.editor?.type === 'contenteditable' && (shadowRead.editor?.text || '').includes('inside shadow root'),
    shadowRead.ok ? `${shadowRead.editor?.type} nth=${shadowRead.editor?.nth} / ${(shadowRead.editor?.text || '').slice(0, 24)}` : shadowRead.error);

  // ---- 9. 真实 CodeMirror 5（cdnjs 5.65.16）双实例
  const realSession = await openPage(`http://127.0.0.1:${HTTP_PORT}/test/fixtures/real-cm5-two-editors.html`);
  await sleep(1600);

  const realRead = await callOn('real-cm5-two-editors.html', { type: 'read' });
  check('真实 CM5：自动读到代码区而不是测试用例框',
    realRead.ok === true && realRead.editor?.type === 'codemirror5' && (realRead.editor?.text || '').includes('def solve') && realRead.editor?.nth === 1,
    realRead.ok ? `${realRead.editor?.type} nth=${realRead.editor?.nth} ${(realRead.editor?.text || '').length} 字符` : realRead.error);

  await evaluateOn(realSession, `(() => { window.__main.focus(); return true; })()`);
  await sleep(200);
  const realActive = await callOn('real-cm5-two-editors.html', { type: 'read', spec: { type: 'active', nth: 0 } });
  check('真实 CM5：当前焦点模式定位到代码区',
    realActive.ok === true && realActive.editor?.type === 'codemirror5' && realActive.editor?.nth === 1 && realActive.editor?.active === true,
    realActive.ok ? `nth=${realActive.editor?.nth} active=${realActive.editor?.active}` : `${realActive.code}: ${realActive.error}`);

  // 弹窗抢走焦点：activeElement 变回 body，但“最近交互元素”还记得代码区。
  await evaluateOn(realSession, `(() => { window.__main.focus(); document.activeElement.blur(); return document.activeElement.tagName; })()`);
  const blurRead = await callOn('real-cm5-two-editors.html', { type: 'read', spec: { type: 'active', nth: 0 } });
  check('打开弹窗丢了焦点后，仍能定位到刚才点的代码区',
    blurRead.ok === true && blurRead.editor?.type === 'codemirror5' && blurRead.editor?.nth === 1,
    blurRead.ok ? `nth=${blurRead.editor?.nth}（${blurRead.editor?.chars} 字符）` : `${blurRead.code}: ${blurRead.error}`);

  // 只点一下测试用例框（不产生焦点）→ 记忆应该更新成它。
  await evaluateOn(realSession, `(() => {
    const box = document.getElementById('stdinEditor').querySelector('.CodeMirror');
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  })()`);
  const clickRead = await callOn('real-cm5-two-editors.html', { type: 'read', spec: { type: 'active', nth: 0 } });
  check('只点一下（未必拿到焦点）也能定位到被点的编辑器',
    clickRead.ok === true && clickRead.editor?.type === 'codemirror5' && clickRead.editor?.nth === 0,
    clickRead.ok ? `nth=${clickRead.editor?.nth} text=${JSON.stringify(clickRead.editor?.text)}` : `${clickRead.code}: ${clickRead.error}`);

  // 记忆被清掉、页面也没焦点时：读取报错，但诊断仍要给出候选，弹窗才能让用户改选。
  await evaluateOn(realSession, `(() => {
    delete window.__educoderLastTarget;
    if (document.activeElement) document.activeElement.blur();
    return true;
  })()`);
  const noActiveRead = await callOn('real-cm5-two-editors.html', { type: 'read', spec: { type: 'active', nth: 0 } });
  const noActiveDiag = await callOn('real-cm5-two-editors.html', { type: 'diagnose', spec: { type: 'active', nth: 0 } });
  check('没有焦点也没有记忆时报错，但诊断仍给出候选（弹窗据此渲染下拉框）',
    noActiveRead.ok === false && noActiveRead.code === 'NO_ACTIVE_EDITOR'
      && noActiveDiag.ok === true && (noActiveDiag.diagnosis?.candidates || []).length >= 2,
    noActiveRead.ok ? '竟然读到了' : `${noActiveRead.code} / 候选 ${(noActiveDiag.diagnosis?.candidates || []).length}`);

  const realDiag = await callOn('real-cm5-two-editors.html', { type: 'diagnose' });
  check('真实 CM5：诊断报告带 frame 与候选信息',
    realDiag.ok === true && (realDiag.diagnosis?.frames || []).length >= 1 && (realDiag.diagnosis?.candidates || []).length >= 2,
    realDiag.ok ? `frames=${(realDiag.diagnosis?.frames || []).length} 候选=${(realDiag.diagnosis?.candidates || []).length}` : realDiag.error);

  void realSession;

  // ---- 10. 封闭影子 DOM 和键盘复制
  await openPage(`http://127.0.0.1:${HTTP_PORT}/test/fixtures/closed-shadow-editor.html`);
  await sleep(1200);
  const closedRead = await callOn('closed-shadow-editor.html', { type: 'read' });
  check('closed shadow root 里的代码区也能枚举并读取',
    closedRead.ok === true && closedRead.editor?.type === 'contenteditable' && (closedRead.editor?.text || '').includes('closed shadow'),
    closedRead.ok ? `${closedRead.editor?.type} / ${closedRead.editor?.chars} 字符` : `${closedRead.code}: ${closedRead.error}`);

  // 键盘通道：DOM 完全读不到时，靠 Ctrl+A / Ctrl+C 与系统剪贴板互通。
  // 先用可信鼠标点一下代码区（模拟用户操作，记下坐标），再主动 blur 掉焦点，
  // 验证后台能按坐标点回去、而不是依赖页面当前焦点。
  await popupEval(`chrome.storage.local.set({ debugConsent: true })`);
  const boxRect = await evaluateOn(pageSession, `(() => {
    const rect = document.getElementById('codeArea').getBoundingClientRect();
    return { x: Math.round(rect.left + 30), y: Math.round(rect.top + 24) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: boxRect.x, y: boxRect.y, button: 'left', buttons: 1, clickCount: 1 }, pageSession);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: boxRect.x, y: boxRect.y, button: 'left', buttons: 0, clickCount: 1 }, pageSession);
  await sleep(120);
  await evaluateOn(pageSession, `(() => { if (document.activeElement) document.activeElement.blur(); return true; })()`);
  const pageText = await evaluateOn(pageSession, `document.getElementById('codeArea').value`);
  const keyCopy = await callOn('test/test-page.html', { type: 'keycopy' });
  await cdp.send('Page.bringToFront', {}, popupSession);
  await sleep(400);
  const clipboardAfterCopy = await popupEval(`(async () => {
    try {
      return { ok: true, text: await navigator.clipboard.readText() };
    } catch (error) {
      return { ok: false, error: String(error), focused: document.hasFocus() };
    }
  })()`);
  // Windows 剪贴板换行是 CRLF、页面文本是 LF，比较前统一归一化
  const flat = (value) => String(value == null ? '' : value).replace(/\r\n?/g, '\n');
  check('键盘通道：Ctrl+A / Ctrl+C 能把页面内容送进剪贴板',
    keyCopy.ok === true && clipboardAfterCopy.ok === true && clipboardAfterCopy.text.length > 0 && flat(clipboardAfterCopy.text) === flat(pageText),
    keyCopy.ok
      ? (clipboardAfterCopy.ok ? `剪贴板 ${JSON.stringify(flat(clipboardAfterCopy.text).slice(0, 40))} / 页面 ${JSON.stringify(flat(pageText).slice(0, 40))}` : `读剪贴板失败：${clipboardAfterCopy.error}（focused=${clipboardAfterCopy.focused}）`)
      : `${keyCopy.code}: ${keyCopy.error}`);

  // ---- 11. iframe 里的编辑器：枚举和键盘复制
  const frameSession = await openPage(`http://127.0.0.1:${HTTP_PORT}/test/fixtures/iframe-editor.html`);
  await sleep(1500);
  const frameRead = await callOn('iframe-editor.html', { type: 'read' });
  check('iframe 里的编辑器能被枚举并读取',
    frameRead.ok === true && frameRead.editor?.type === 'textarea' && String(frameRead.editor?.text || '').includes('def solve') && frameRead.editor?.frameId > 0,
    frameRead.ok ? `${frameRead.editor?.type} · frame ${frameRead.editor?.frameId} · ${frameRead.editor?.chars} 字符` : `${frameRead.code}: ${frameRead.error}`);

  const innerValue = await evaluateOn(frameSession, `(() => {
    const box = document.getElementById('frame').contentWindow.document.getElementById('inner');
    box.focus();
    box.setSelectionRange(0, 0);
    return box.value;
  })()`);
  const frameRect = await evaluateOn(frameSession, `(() => {
    const rect = document.getElementById('frame').getBoundingClientRect();
    return { x: Math.round(rect.left + 140), y: Math.round(rect.top + 60) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: frameRect.x, y: frameRect.y, button: 'left', buttons: 1, clickCount: 1 }, frameSession);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: frameRect.x, y: frameRect.y, button: 'left', buttons: 0, clickCount: 1 }, frameSession);
  await sleep(200);
  const frameCopy = await callOn('iframe-editor.html', { type: 'keycopy' });
  await cdp.send('Page.bringToFront', {}, popupSession);
  await sleep(400);
  const frameClipboard = await popupEval(`(async () => {
    try {
      return { ok: true, text: await navigator.clipboard.readText() };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
  check('键盘通道：子 frame 里的代码也能 Ctrl+A / Ctrl+C 复制',
    frameCopy.ok === true && frameClipboard.ok === true && innerValue.length > 0 && flat(frameClipboard.text) === flat(innerValue),
    frameCopy.ok
      ? (frameClipboard.ok ? `剪贴板 ${JSON.stringify(flat(frameClipboard.text).slice(0, 24))}` : `读剪贴板失败：${frameClipboard.error}`)
      : `${frameCopy.code}: ${frameCopy.error}`);

  // ---- 12. 画布代码区：页面自己实现复制
  const canvasSession = await openPage(`http://127.0.0.1:${HTTP_PORT}/test/fixtures/canvas-copy.html`);
  await sleep(1200);
  const canvasRead = await callOn('canvas-copy.html', { type: 'read' });
  check('画布页：DOM 读不到代码（只剩空文本框）',
    canvasRead.ok === true && String(canvasRead.editor?.text || '').length < 10,
    canvasRead.ok ? `${canvasRead.editor?.type} · ${canvasRead.editor?.chars} 字符` : `${canvasRead.code}: ${canvasRead.error}`);

  const canvasRect = await evaluateOn(canvasSession, `(() => {
    const rect = document.getElementById('board').getBoundingClientRect();
    return { x: Math.round(rect.left + 200), y: Math.round(rect.top + 90) };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: canvasRect.x, y: canvasRect.y, button: 'left', buttons: 1, clickCount: 1 }, canvasSession);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: canvasRect.x, y: canvasRect.y, button: 'left', buttons: 0, clickCount: 1 }, canvasSession);
  await sleep(200);
  const copyViaPage = await callOn('canvas-copy.html', { type: 'keycopy', shield: false });
  await cdp.send('Page.bringToFront', {}, popupSession);
  await sleep(500);
  const canvasClipboard = await popupEval(`(async () => {
    try {
      return { ok: true, text: await navigator.clipboard.readText() };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
  check('键盘通道：让页面自己的 Ctrl+C 跑，能拿到画布上的代码',
    copyViaPage.ok === true && canvasClipboard.ok === true && flat(canvasClipboard.text).includes('class Demo') && flat(canvasClipboard.text).includes('System.out.println'),
    copyViaPage.ok
      ? (canvasClipboard.ok ? `剪贴板 ${JSON.stringify(flat(canvasClipboard.text).slice(0, 28))}` : `读剪贴板失败：${canvasClipboard.error}`)
      : `${copyViaPage.code}: ${copyViaPage.error}`);

  const canvasDiag = await callOn('canvas-copy.html', { type: 'diagnose' });
  check('诊断包含页面结构快照（画布 / DOM 编辑器计数）',
    canvasDiag.ok === true && Array.isArray(canvasDiag.diagnosis?.snapshot) && canvasDiag.diagnosis.snapshot.some((frame) => frame.canvases === 1 && frame.editors && frame.editors.monacoDom === 0),
    canvasDiag.ok ? `frame ${canvasDiag.diagnosis.snapshot?.map((f) => f.canvases).join(',')} 个画布` : `${canvasDiag.code}: ${canvasDiag.error}`);

  // ---- 13. Monaco 形态：DOM 里只有渲染出来的行
  const monacoSession = await openPage(`http://127.0.0.1:${HTTP_PORT}/test/fixtures/monaco-dom.html`);
  await sleep(1200);
  await cdp.send('Page.bringToFront', {}, monacoSession);
  const monacoCode = await evaluateOn(monacoSession, 'window.__monacoCode()');

  const monacoDiag = await callOn('monaco-dom.html', { type: 'diagnose' });
  const monacoCandidates = (monacoDiag.diagnosis && monacoDiag.diagnosis.candidates) || [];
  check('Monaco 形态：枚举到 monaco 候选，且没把隐藏输入框当成编辑器',
    monacoDiag.ok === true && monacoCandidates.some((candidate) => candidate.type === 'monaco') && !monacoCandidates.some((candidate) => candidate.type === 'textarea'),
    monacoCandidates.map((candidate) => `${candidate.type}#${candidate.nth}`).join(' / ') || '没有候选');

  const monacoRead = await callOn('monaco-dom.html', { type: 'read' });
  check('Monaco 形态：能从渲染行读出代码（DOM-only 兜底）',
    monacoRead.ok === true && String(monacoRead.editor?.text || '').includes('monaco') && Number(monacoRead.editor?.chars || 0) >= 40,
    monacoRead.ok ? `${monacoRead.editor?.type} · ${monacoRead.editor?.chars} 字符` : `${monacoRead.code}: ${monacoRead.error}`);

  check('Monaco 形态：读取结果标记“只有可见部分”，提醒走强制读取',
    monacoRead.ok === true && monacoRead.editor?.partial === true,
    `partial=${monacoRead.editor?.partial}`);

  // 预览只有可见行时，点击复制应该走编辑器自有的 copy 事件，保留视口外的结尾。
  const monacoPopup = await openPage(`chrome-extension://${extensionId}/popup.html`, 'monaco-popup');
  await sleep(900);
  const monacoPopupEval = (expression) => evaluateOn(monacoPopup, expression);
  await cdp.send('Page.bringToFront', {}, monacoPopup);
  await sleep(300);
  await monacoPopupEval(`(() => { document.getElementById('copyBtn').click(); return true; })()`);
  await sleep(2600);
  const monacoPopupText = await monacoPopupEval(`document.getElementById('codeView').value`);
  const monacoPopupMeta = await monacoPopupEval(`document.getElementById('readMeta').textContent`);
  check('Monaco 形态：从可见行预览点复制，也能拿到视口外的最后几行',
    flat(monacoPopupText) === flat(monacoCode),
    `读到 ${monacoPopupText.length} 字符 · ${monacoPopupMeta.slice(0, 44)}`);

  const monacoCopy = await callOn('monaco-dom.html', { type: 'keycopy', shield: false });
  await sleep(450);
  const monacoClip = await popupEval(`(async () => {
    try {
      return { ok: true, text: await navigator.clipboard.readText() };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
  const monacoState = await evaluateOn(monacoSession, `window.__monacoState()`);
  check('Monaco 形态：键盘复制先点正文区域，焦点进了编辑器',
    monacoCopy.ok === true && monacoState && monacoState.focused === true && monacoState.selectedAll === true,
    monacoState ? `focused=${monacoState.focused} selectedAll=${monacoState.selectedAll}` : '拿不到页面状态');
  check('Monaco 形态：复制到的是全文，不是视口里的前几行',
    monacoClip.ok === true && flat(monacoClip.text).trim() === flat(monacoCode).trim(),
    monacoClip.ok ? `${flat(monacoClip.text).split('\n').length} 行 · ${JSON.stringify(flat(monacoClip.text).slice(0, 32))}` : `读剪贴板失败：${monacoClip.error}`);

  // ---- 14. 编辑器被遮罩挡住时报错
  const overlaySession = await openPage(`http://127.0.0.1:${HTTP_PORT}/test/fixtures/monaco-blocked.html`, 'blocked');
  await sleep(900);
  await cdp.send('Page.bringToFront', {}, overlaySession);
  const blockedCopy = await callOn('monaco-blocked.html', { type: 'keycopy', shield: false });
  check('点不到代码区时明确报错，不再默默复制几行文字',
    blockedCopy.ok === false && blockedCopy.code === 'FOCUS_NOT_IN_EDITOR',
    blockedCopy.ok ? '没有报错' : `${blockedCopy.code}: ${blockedCopy.error}`);

  const blockedState = await evaluateOn(overlaySession, `({
    active: document.activeElement ? document.activeElement.tagName : null,
    inside: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.monaco-editor'))
  })`);
  check('被遮罩挡住时焦点确实没有进编辑器',
    blockedState && blockedState.inside === false,
    `activeElement=${blockedState?.active}`);

} catch (error) {
  check('测试过程未抛异常', false, error?.message || String(error));
  if (chromeStderr) console.log('--- chrome stderr (tail) ---\n' + chromeStderr.split('\n').slice(-15).join('\n'));
} finally {
  try { cdp?.close(); } catch {}
  try { chrome.kill(); } catch {}
  server.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  const failed = results.filter((item) => !item.passed);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

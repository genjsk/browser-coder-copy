// 头歌代码复制助手 · 开关桥（隔离世界）
// MAIN 世界拿不到 chrome.storage，这里读出开关后用 postMessage 通知 unlock.js。

const DEFAULTS = { unlock: true };

function post(enabled) {
  try {
    window.postMessage({ source: 'educoder-copy-helper', type: 'unlock-state', enabled: enabled !== false }, '*');
  } catch {
    // 页面在卸载途中，忽略。
  }
}

async function sync() {
  let settings;
  try {
    settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  } catch {
    settings = DEFAULTS;
  }
  post(settings.unlock);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.unlock) return;
  post(changes.unlock.newValue !== false);
});

// 页面脚本可能在场事件里抢先拦截，这里多播几次并跟随文档就绪状态。
sync();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', sync, { once: true });
} else {
  setTimeout(sync, 0);
}
window.addEventListener('load', sync, { once: true });

// 弹窗切换开关后主动推一次，避免依赖 storage 事件时序。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'unlock-refresh') {
    sync().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

/* HappyClaw Knowledge Collector - Background Service Worker */

// ─── Context Menu Setup ─────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

async function setupContextMenu() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: 'happyclaw-save',
    title: '保存到 HappyClaw',
    contexts: ['page', 'selection'],
  });

  chrome.contextMenus.create({
    id: 'happyclaw-save-default',
    parentId: 'happyclaw-save',
    title: '保存（无分类）',
    contexts: ['page', 'selection'],
  });

  chrome.contextMenus.create({
    id: 'happyclaw-separator',
    parentId: 'happyclaw-save',
    type: 'separator',
    contexts: ['page', 'selection'],
  });

  // Load categories and add as sub-menu items
  await refreshCategoryMenuItems();
}

async function refreshCategoryMenuItems() {
  // Remove old category items (try removing any that might exist)
  const config = await getConfig();
  if (!config.serverUrl || !config.apiToken) return;

  try {
    const categories = await apiCall('GET', '/api/knowledge/categories');
    for (const cat of categories) {
      chrome.contextMenus.create({
        id: `happyclaw-cat-${cat.id}`,
        parentId: 'happyclaw-save',
        title: cat.name,
        contexts: ['page', 'selection'],
      });
    }
  } catch (_) {
    // Silently fail - categories will be empty
  }
}

// ─── Context Menu Handler ───────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuId = info.menuItemId;

  if (typeof menuId !== 'string' || !menuId.startsWith('happyclaw-')) return;

  let categoryId = null;
  if (menuId.startsWith('happyclaw-cat-')) {
    categoryId = menuId.replace('happyclaw-cat-', '');
  } else if (menuId !== 'happyclaw-save-default' && menuId !== 'happyclaw-save') {
    return;
  }

  const selectedText = info.selectionText || '';
  const sourceType = selectedText ? 'selection' : 'full_page';

  const clip = {
    title: tab?.title || '未命名',
    url: info.pageUrl || tab?.url || '',
    content: selectedText || tab?.title || '',
    category_id: categoryId,
    tags: [],
    source_type: sourceType,
  };

  try {
    await apiCall('POST', '/api/knowledge/clips', clip);
    // Show notification via content script
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'happyclaw-toast',
          message: '已保存到 HappyClaw',
          status: 'success',
        });
      } catch (_) {
        // Content script not available
      }
    }
  } catch (err) {
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'happyclaw-toast',
          message: `保存失败: ${err.message}`,
          status: 'error',
        });
      } catch (_) {}
    }
  }
});

// ─── Keyboard Shortcut Handler ──────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'quick-save') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  let selectedText = '';
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString(),
    });
    if (result?.result) {
      selectedText = result.result.trim();
    }
  } catch (_) {}

  const sourceType = selectedText ? 'selection' : 'full_page';
  const clip = {
    title: tab.title || '未命名',
    url: tab.url || '',
    content: selectedText || tab.title || '',
    category_id: null,
    tags: [],
    source_type: sourceType,
  };

  try {
    await apiCall('POST', '/api/knowledge/clips', clip);
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'happyclaw-toast',
        message: '已快速保存到 HappyClaw',
        status: 'success',
      });
    } catch (_) {}
  } catch (err) {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'happyclaw-toast',
        message: `保存失败: ${err.message}`,
        status: 'error',
      });
    } catch (_) {}
  }
});

// ─── Message Handler ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'settings_updated') {
    // Rebuild context menu with new categories
    setupContextMenu();
    sendResponse({ ok: true });
  }
  return false;
});

// ─── API Client ─────────────────────────────────────────────────────

async function getConfig() {
  const data = await chrome.storage.local.get(['serverUrl', 'apiToken']);
  return {
    serverUrl: data.serverUrl || '',
    apiToken: data.apiToken || '',
  };
}

async function apiCall(method, path, body) {
  const config = await getConfig();
  if (!config.serverUrl) {
    throw new Error('未配置服务器地址');
  }

  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.apiToken) {
    headers['Authorization'] = `Bearer ${config.apiToken}`;
  }

  const opts = {
    method,
    headers,
    credentials: 'include',
  };

  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(`${config.serverUrl}${path}`, opts);
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const errData = await resp.json();
      if (errData.error) msg = errData.error;
    } catch (_) {}
    throw new Error(msg);
  }

  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

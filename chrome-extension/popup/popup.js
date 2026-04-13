/* HappyClaw Knowledge Collector - Popup Script */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let categories = [];
let selectedColor = '#F57F28';
let currentTab = null;
let selectedText = '';
let settingsSaveTimer = null;

// ─── Init ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await initPopup();
  bindEvents();
});

async function initPopup() {
  // Get current tab info
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  if (tab) {
    $('#page-title').textContent = tab.title || '未知页面';
    $('#page-url').textContent = tab.url || '';
  }

  // Get selected text from content script
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString(),
    });
    if (result && result.result) {
      selectedText = result.result.trim();
      if (selectedText) {
        $('#selection-preview').style.display = 'block';
        $('#selection-text').textContent = selectedText;
      }
    }
  } catch (_) {
    // Content script may not be available on some pages
  }

  // Check connection status and load categories
  await checkConnectionAndLoad();
}

async function checkConnectionAndLoad() {
  const config = await getConfig();
  if (!config.serverUrl || !config.apiToken) {
    updateStatus('disconnected', '未配置');
    $('#categories-list').innerHTML = '<div class="empty-state">请先在设置中配置服务器</div>';
    return;
  }

  try {
    categories = await apiCall('GET', '/api/knowledge/categories');
    updateStatus('connected', '已连接');
    renderCategories();
    renderCategorySelect();
  } catch (err) {
    updateStatus('error', '连接失败');
    $('#categories-list').innerHTML = `<div class="empty-state">连接失败: ${err.message}</div>`;
  }
}

// ─── Events ─────────────────────────────────────────────────────────

function bindEvents() {
  // View switching
  $('#btn-settings').addEventListener('click', () => switchView('settings'));
  $('#btn-back').addEventListener('click', () => switchView('main'));

  // Quick save
  $('#btn-quick-save').addEventListener('click', handleQuickSave);

  // Category form
  $('#btn-add-category').addEventListener('click', () => {
    const form = $('#category-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });
  $('#btn-cancel-cat').addEventListener('click', () => {
    $('#category-form').style.display = 'none';
    resetCategoryForm();
  });
  $('#btn-save-cat').addEventListener('click', handleCreateCategory);

  // Color picker
  $$('.color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      $$('.color-dot').forEach((d) => d.classList.remove('selected'));
      dot.classList.add('selected');
      selectedColor = dot.dataset.color;
    });
  });

  // Settings
  $('#btn-save-settings').addEventListener('click', handleSaveSettings);
  $('#btn-test-conn').addEventListener('click', handleTestConnection);
  $('#btn-toggle-token').addEventListener('click', () => {
    const input = $('#api-token');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Auto-save on input so switching tabs to copy a token doesn't lose
  // what the user has already typed. The popup closes when it loses focus.
  $('#server-url').addEventListener('input', scheduleAutoSave);
  $('#api-token').addEventListener('input', scheduleAutoSave);

  // Load saved settings into form when switching to settings
  $('#btn-settings').addEventListener('click', loadSettingsForm);
}

function scheduleAutoSave() {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(async () => {
    const serverUrl = $('#server-url').value.trim().replace(/\/+$/, '');
    const apiToken = $('#api-token').value.trim();
    await chrome.storage.local.set({ serverUrl, apiToken });
    const hint = $('#autosave-hint');
    if (hint) {
      hint.textContent = '✓ 已自动保存';
      hint.classList.add('autosave-ok');
      setTimeout(() => {
        hint.textContent = '输入会自动保存，切换标签页去复制 Token 不会丢';
        hint.classList.remove('autosave-ok');
      }, 1500);
    }
  }, 300);
}

function switchView(view) {
  if (view === 'settings') {
    $('#main-view').style.display = 'none';
    $('#settings-view').style.display = 'block';
    loadSettingsForm();
  } else {
    $('#settings-view').style.display = 'none';
    $('#main-view').style.display = 'block';
    checkConnectionAndLoad();
  }
}

// ─── Quick Save ─────────────────────────────────────────────────────

async function handleQuickSave() {
  const btn = $('#btn-quick-save');
  const categoryId = $('#category-select').value;
  const tagsRaw = $('#tags-input').value.trim();
  const tags = tagsRaw ? tagsRaw.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : [];

  if (!currentTab) {
    showToast('无法获取当前页面信息', 'error');
    return;
  }

  const sourceType = selectedText ? 'selection' : 'full_page';
  const content = selectedText || currentTab.title || '';

  const clip = {
    title: currentTab.title || '未命名',
    url: currentTab.url || '',
    content,
    category_id: categoryId || null,
    tags,
    source_type: sourceType,
  };

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    await apiCall('POST', '/api/knowledge/clips', clip);
    showToast('保存成功', 'success');
    // Clear selection preview after save
    selectedText = '';
    $('#selection-preview').style.display = 'none';
    $('#tags-input').value = '';
  } catch (err) {
    showToast(`保存失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
        <polyline points="17,21 17,13 7,13 7,21"/>
        <polyline points="7,3 7,8 15,8"/>
      </svg>
      保存`;
  }
}

// ─── Categories ─────────────────────────────────────────────────────

function renderCategories() {
  const list = $('#categories-list');
  if (categories.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无分类，点击 + 创建</div>';
    return;
  }

  list.innerHTML = categories
    .map(
      (cat) => `
    <div class="category-item" data-id="${cat.id}">
      <span class="cat-color" style="background:${cat.color || '#F57F28'}"></span>
      <div class="cat-info">
        <div class="cat-name">${escapeHtml(cat.name)}</div>
        <div class="cat-meta">${cat.description ? escapeHtml(cat.description) + ' · ' : ''}${cat.clip_count || 0} 条</div>
      </div>
      <div class="cat-actions">
        <button class="btn-danger btn-delete-cat" data-id="${cat.id}" title="删除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3,6 5,6 21,6"/>
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </button>
      </div>
    </div>`
    )
    .join('');

  // Bind delete events
  list.querySelectorAll('.btn-delete-cat').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const cat = categories.find((c) => c.id === id);
      if (!confirm(`确认删除分类「${cat?.name || ''}」？`)) return;
      try {
        await apiCall('DELETE', `/api/knowledge/categories/${id}`);
        showToast('分类已删除', 'info');
        await checkConnectionAndLoad();
      } catch (err) {
        showToast(`删除失败: ${err.message}`, 'error');
      }
    });
  });

  // Click category to select it in dropdown
  list.querySelectorAll('.category-item').forEach((item) => {
    item.addEventListener('click', () => {
      $('#category-select').value = item.dataset.id;
      list.querySelectorAll('.category-item').forEach((i) => i.classList.remove('selected'));
      item.classList.add('selected');
    });
  });
}

function renderCategorySelect() {
  const select = $('#category-select');
  const currentVal = select.value;
  select.innerHTML = '<option value="">选择分类...</option>' +
    categories
      .map((cat) => `<option value="${cat.id}">${escapeHtml(cat.name)}</option>`)
      .join('');
  if (currentVal && categories.some((c) => c.id === currentVal)) {
    select.value = currentVal;
  }
}

async function handleCreateCategory() {
  const name = $('#cat-name').value.trim();
  if (!name) {
    showToast('请输入分类名称', 'error');
    return;
  }

  const desc = $('#cat-desc').value.trim();
  const btn = $('#btn-save-cat');
  btn.disabled = true;

  try {
    await apiCall('POST', '/api/knowledge/categories', {
      name,
      description: desc || null,
      color: selectedColor,
    });
    showToast('分类已创建', 'success');
    $('#category-form').style.display = 'none';
    resetCategoryForm();
    await checkConnectionAndLoad();
  } catch (err) {
    showToast(`创建失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function resetCategoryForm() {
  $('#cat-name').value = '';
  $('#cat-desc').value = '';
  $$('.color-dot').forEach((d) => d.classList.remove('selected'));
  $$('.color-dot')[0]?.classList.add('selected');
  selectedColor = '#F57F28';
}

// ─── Settings ───────────────────────────────────────────────────────

async function loadSettingsForm() {
  const config = await getConfig();
  $('#server-url').value = config.serverUrl || '';
  $('#api-token').value = config.apiToken || '';
}

async function handleSaveSettings() {
  const serverUrl = $('#server-url').value.trim().replace(/\/+$/, '');
  const apiToken = $('#api-token').value.trim();

  if (!serverUrl) {
    showToast('请输入服务器地址', 'error');
    return;
  }

  await chrome.storage.local.set({
    serverUrl,
    apiToken,
  });

  showToast('设置已保存', 'success');

  // Notify background script to refresh context menu
  chrome.runtime.sendMessage({ type: 'settings_updated' });
}

async function handleTestConnection() {
  const serverUrl = $('#server-url').value.trim().replace(/\/+$/, '');
  const apiToken = $('#api-token').value.trim();
  const resultEl = $('#conn-result');
  const btn = $('#btn-test-conn');

  if (!serverUrl) {
    showToast('请输入服务器地址', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 测试中...';
  resultEl.style.display = 'none';

  try {
    const resp = await fetch(`${serverUrl}/api/health`, {
      method: 'GET',
      headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    });

    if (resp.ok) {
      resultEl.className = 'conn-result success';
      resultEl.textContent = '连接成功! 服务器运行正常。';
    } else {
      resultEl.className = 'conn-result error';
      resultEl.textContent = `连接失败: HTTP ${resp.status}`;
    }
  } catch (err) {
    resultEl.className = 'conn-result error';
    resultEl.textContent = `连接失败: ${err.message}`;
  } finally {
    resultEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
        <polyline points="22,4 12,14.01 9,11.01"/>
      </svg>
      测试连接`;
  }
}

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
    signal: AbortSignal.timeout(8000),
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

// ─── UI Helpers ─────────────────────────────────────────────────────

function updateStatus(state, title) {
  const dot = $('#status-dot');
  dot.className = `status-dot ${state}`;
  dot.title = title;
}

function showToast(message, type = 'info') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 2500);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

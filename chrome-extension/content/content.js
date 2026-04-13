/* HappyClaw Knowledge Collector - Content Script */

// ─── Toast Notification ─────────────────────────────────────────────

function showHappyclawToast(message, status) {
  // Remove any existing toast
  const existing = document.getElementById('happyclaw-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'happyclaw-toast';

  const bgColor = status === 'success' ? '#10b981' : '#ef4444';

  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    padding: '10px 20px',
    borderRadius: '8px',
    background: bgColor,
    color: '#fff',
    fontSize: '13px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontWeight: '500',
    zIndex: '2147483647',
    boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
    opacity: '0',
    transform: 'translateY(8px)',
    transition: 'opacity 0.2s, transform 0.2s',
    pointerEvents: 'none',
    lineHeight: '1.5',
    maxWidth: '320px',
    wordBreak: 'break-word',
  });

  // Icon
  const icon = status === 'success'
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-3px;margin-right:6px"><polyline points="20,6 9,17 4,12"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-3px;margin-right:6px"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

  toast.innerHTML = icon + message;
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  // Animate out and remove
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 200);
  }, 2500);
}

// ─── Message Listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'happyclaw-toast') {
    showHappyclawToast(message.message, message.status);
    sendResponse({ ok: true });
  }
  return false;
});

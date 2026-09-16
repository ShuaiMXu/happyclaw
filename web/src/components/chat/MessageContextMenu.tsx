import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, FileText, ImageDown, Loader2, Trash2 } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

interface MessageContextMenuProps {
  content: string;
  position: { x: number; y: number };
  onClose: () => void;
  chatJid?: string;
  messageId?: string;
  onShareImage?: () => void;
}

export function MessageContextMenu({
  content,
  position,
  onClose,
  chatJid,
  messageId,
  onShareImage,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${position.y - rect.height - 8}px`;
    }
  }, [position]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    onClose();
  };

  const handleCopyText = () => {
    const plain = content
      .replace(/```[\s\S]*?```/g, (m) =>
        m.replace(/```\w*\n?/, '').replace(/\n?```$/, ''),
      )
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    copyToClipboard(plain);
  };

  const handleCopyMarkdown = () => copyToClipboard(content);

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (!chatJid || !messageId || deleting) return;

    setDeleting(true);
    setDeleteError(null);
    // deleteMessage 内部已经在失败时 toast 一次；这里额外在菜单里留一条常驻
    // 文案并保持菜单打开，避免 toast 一闪而过、用户以为"删除没反应"就是本次
    // 反馈要解决的问题——之前无论成败都立刻 onClose()，看起来跟"卡住不动"
    // 没有区别。失败最常见的原因是权限：非 admin 只能删自己发的消息，AI
    // 回复只有 admin 能删（见 src/routes/groups.ts 的 DELETE /messages 路由）。
    const ok = await useChatStore.getState().deleteMessage(chatJid, messageId);
    if (ok) {
      onClose();
      return;
    }
    setDeleting(false);
    setDeleteError('删除失败，可能没有权限删除这条消息');
  };

  return createPortal(
    <div className="fixed inset-0 z-[60]" onClick={onClose}>
      <div
        ref={menuRef}
        className="absolute bg-surface rounded-xl shadow-lg border border-border py-1 min-w-[160px] animate-in zoom-in-95 fade-in duration-150 select-none"
        style={{ left: position.x, top: position.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleCopyText}
          className="group/item w-full flex items-center gap-3 mx-1 px-3 py-2.5 text-sm text-foreground rounded-lg hover:bg-foreground/10 active:bg-foreground/15 transition-colors"
        >
          <Copy className="w-4 h-4 text-muted-foreground group-hover/item:text-primary transition-colors" />
          复制文本
        </button>
        <div className="mx-3 my-0.5 border-t border-border" />
        <button
          onClick={handleCopyMarkdown}
          className="group/item w-full flex items-center gap-3 mx-1 px-3 py-2.5 text-sm text-foreground rounded-lg hover:bg-foreground/10 active:bg-foreground/15 transition-colors"
        >
          <FileText className="w-4 h-4 text-muted-foreground group-hover/item:text-primary transition-colors" />
          复制 Markdown
        </button>
        {onShareImage && (
          <>
            <div className="mx-3 my-0.5 border-t border-border" />
            <button
              onClick={() => {
                onShareImage();
                onClose();
              }}
              className="group/item w-full flex items-center gap-3 mx-1 px-3 py-2.5 text-sm text-foreground rounded-lg hover:bg-foreground/10 active:bg-foreground/15 transition-colors"
            >
              <ImageDown className="w-4 h-4 text-muted-foreground group-hover/item:text-primary transition-colors" />
              生成分享图片
            </button>
          </>
        )}
        {chatJid && messageId && (
          <>
            <div className="mx-3 my-0.5 border-t border-border" />
            {confirmDelete && !deleteError && (
              <p className="max-w-[240px] px-4 py-1.5 text-xs leading-relaxed text-muted-foreground">
                仅删除持久聊天记录，不会撤回正在处理的模型输入。
              </p>
            )}
            {deleteError && (
              <p className="max-w-[240px] px-4 py-1.5 text-xs leading-relaxed text-red-500">
                {deleteError}
              </p>
            )}
            <button
              onClick={handleDelete}
              disabled={deleting}
              className={`group/item w-full flex items-center gap-3 mx-1 px-3 py-2.5 text-sm rounded-lg transition-colors disabled:cursor-wait ${
                confirmDelete
                  ? 'text-red-400 bg-red-500/20 hover:bg-red-500/30'
                  : 'text-red-400 hover:bg-foreground/10 hover:text-red-500 active:bg-foreground/15'
              }`}
            >
              {deleting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2
                  className={`w-4 h-4 transition-colors ${confirmDelete ? '' : 'group-hover/item:text-red-500'}`}
                />
              )}
              {deleting
                ? '正在删除…'
                : confirmDelete
                  ? '确认删除记录'
                  : '删除聊天记录'}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

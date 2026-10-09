import { useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderCheck, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';

interface DirEntry {
  name: string;
  path: string;
}

interface MoveFilesDialogProps {
  open: boolean;
  groupJid: string;
  itemCount: number;
  /** 正在被移动的路径——这些目录不能作为目标，也不能进去（等于"移进自己"）。 */
  excludePaths: string[];
  onClose: () => void;
  onConfirm: (destination: string) => Promise<void>;
}

/**
 * 工作区内部的目标文件夹选择器：复用 GET /files 列目录接口逐层浏览，
 * 只展示目录（排除系统目录和正被移动的目录本身），点击文件夹进入下一层，
 * 底部按钮把"当前浏览到的这一层"确认为移动目标。
 */
export function MoveFilesDialog({
  open,
  groupJid,
  itemCount,
  excludePaths,
  onClose,
  onConfirm,
}: MoveFilesDialogProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (open) setCurrentPath('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (currentPath) params.set('path', currentPath);
    api
      .get<{
        files: {
          name: string;
          path: string;
          type: string;
          isSystem: boolean;
        }[];
      }>(`/api/groups/${encodeURIComponent(groupJid)}/files?${params}`)
      .then((data) => {
        if (cancelled) return;
        const excludeSet = new Set(excludePaths);
        const list = data.files
          .filter((f) => f.type === 'directory' && !f.isSystem)
          .filter((f) => !excludeSet.has(f.path))
          .sort((a, b) => a.name.localeCompare(b.name));
        setDirs(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载目录失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentPath, groupJid, excludePaths]);

  const breadcrumbs = currentPath ? currentPath.split('/').filter(Boolean) : [];

  const handleConfirm = async () => {
    setMoving(true);
    try {
      await onConfirm(currentPath);
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !moving && onClose()}>
      <DialogContent className="flex max-h-[80dvh] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>移动到…</DialogTitle>
        </DialogHeader>

        <p className="flex-shrink-0 text-xs text-muted-foreground">
          选择 {itemCount} 项要移动到的目标文件夹
        </p>

        <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto text-sm">
          <button
            type="button"
            onClick={() => setCurrentPath('')}
            disabled={moving}
            className="cursor-pointer whitespace-nowrap text-primary hover:underline disabled:cursor-not-allowed"
          >
            根目录
          </button>
          {breadcrumbs.map((crumb, index) => (
            <div key={index} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() =>
                  setCurrentPath(breadcrumbs.slice(0, index + 1).join('/'))
                }
                disabled={moving}
                className="cursor-pointer whitespace-nowrap text-primary hover:underline disabled:cursor-not-allowed"
              >
                {crumb}
              </button>
            </div>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <p className="p-3 text-xs text-red-500">{error}</p>
          ) : dirs.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">没有子文件夹</p>
          ) : (
            <div className="p-1">
              {dirs.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  onClick={() => setCurrentPath(dir.path)}
                  disabled={moving}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed"
                >
                  <Folder className="h-4 w-4 flex-shrink-0 text-primary" />
                  <span className="flex-1 truncate">{dir.name}</span>
                  <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="flex-row flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={moving}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={moving}
          >
            {moving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FolderCheck className="h-4 w-4" />
            )}
            移动到
            {breadcrumbs.length
              ? `「${breadcrumbs[breadcrumbs.length - 1]}」`
              : '「根目录」'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

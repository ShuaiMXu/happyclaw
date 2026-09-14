import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useChatStore } from '../../stores/chat';

interface RenameDialogProps {
  open: boolean;
  jid: string;
  currentName: string;
  onClose: () => void;
}

export function RenameDialog({
  open,
  jid,
  currentName,
  onClose,
}: RenameDialogProps) {
  const [name, setName] = useState(currentName);
  const [loading, setLoading] = useState(false);
  const renameFlow = useChatStore((s) => s.renameFlow);

  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);

  const handleConfirm = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      await renameFlow(jid, trimmed);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>重命名工作区</DialogTitle>
        </DialogHeader>

        <div>
          <Label className="mb-2">工作区名称</Label>
          {/* No onKeyDown-Enter-submits here on purpose: with an IME (e.g.
              拼音输入法), the Enter that confirms a composed character was
              also firing this dialog's submit, so a single letter would
              both land in the field AND trigger "确认" at once. Enter is
              left to the input/IME's own native behavior; submitting
              always requires an explicit click on the 确认 button. */}
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="输入新名称"
            autoFocus
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={loading || !name.trim()}>
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

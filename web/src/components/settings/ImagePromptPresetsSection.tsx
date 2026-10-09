import { useEffect, useState } from 'react';
import { Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { getErrorMessage } from './types';
import { SettingsCard as Section } from './SettingsCard';

interface ImagePromptPreset {
  id: string;
  label: string;
  prompt: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface PresetDraft {
  label: string;
  prompt: string;
  sort_order: number;
  is_active: boolean;
}

function toDraft(preset: ImagePromptPreset): PresetDraft {
  return {
    label: preset.label,
    prompt: preset.prompt,
    sort_order: preset.sort_order,
    is_active: preset.is_active,
  };
}

/**
 * Admin-only: platform-wide, shared prompt presets shown as short-label
 * options next to the "生成图片" button in the Image Studio UI. Any logged-in
 * user can pick one to insert into their prompt; only admins manage the list.
 */
export function ImagePromptPresetsSection() {
  const [presets, setPresets] = useState<ImagePromptPreset[]>([]);
  const [drafts, setDrafts] = useState<Record<string, PresetDraft>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState<PresetDraft>({
    label: '',
    prompt: '',
    sort_order: 0,
    is_active: true,
  });

  const load = () => {
    setLoading(true);
    api
      .get<{ presets: ImagePromptPreset[] }>(
        '/api/config/admin/image-prompt-presets',
      )
      .then((res) => {
        const list = res.presets ?? [];
        setPresets(list);
        setDrafts(Object.fromEntries(list.map((p) => [p.id, toDraft(p)])));
      })
      .catch((err) => toast.error(getErrorMessage(err, '加载常用提示词失败')))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const updateDraft = (id: string, patch: Partial<PresetDraft>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const handleSave = async (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    const label = draft.label.trim();
    const prompt = draft.prompt.trim();
    if (!label || !prompt) {
      toast.error('简短标签和完整提示词都不能为空');
      return;
    }
    setSavingId(id);
    try {
      const updated = await api.patch<ImagePromptPreset>(
        `/api/config/admin/image-prompt-presets/${id}`,
        {
          label,
          prompt,
          sort_order: draft.sort_order,
          is_active: draft.is_active,
        },
      );
      setPresets((prev) => prev.map((p) => (p.id === id ? updated : p)));
      setDrafts((prev) => ({ ...prev, [id]: toDraft(updated) }));
      toast.success('已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存失败'));
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await api.delete(`/api/config/admin/image-prompt-presets/${id}`);
      setPresets((prev) => prev.filter((p) => p.id !== id));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast.success('已删除');
    } catch (err) {
      toast.error(getErrorMessage(err, '删除失败'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreate = async () => {
    const label = newDraft.label.trim();
    const prompt = newDraft.prompt.trim();
    if (!label || !prompt) {
      toast.error('请填写简短标签和完整提示词');
      return;
    }
    setCreating(true);
    try {
      const created = await api.post<ImagePromptPreset>(
        '/api/config/admin/image-prompt-presets',
        {
          label,
          prompt,
          sort_order: newDraft.sort_order,
          is_active: newDraft.is_active,
        },
      );
      setPresets((prev) => [...prev, created]);
      setDrafts((prev) => ({ ...prev, [created.id]: toDraft(created) }));
      setNewDraft({ label: '', prompt: '', sort_order: 0, is_active: true });
      toast.success('已添加');
    } catch (err) {
      toast.error(getErrorMessage(err, '添加失败'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Section
      icon={Sparkles}
      title="生图常用提示词"
      desc="配置全平台共享的常用提示词，会以简短标签的形式出现在「生图」页面「生成图片」按钮旁，任何用户都可以选用来提高画面精确性。"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          加载中…
        </div>
      ) : (
        <>
          {presets.length === 0 && (
            <p className="text-sm text-muted-foreground">
              还没有配置任何常用提示词。
            </p>
          )}
          <div className="space-y-3">
            {presets.map((preset) => {
              const draft = drafts[preset.id] ?? toDraft(preset);
              return (
                <div
                  key={preset.id}
                  className="space-y-2 rounded-lg border border-border p-3"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={draft.label}
                      onChange={(e) =>
                        updateDraft(preset.id, { label: e.target.value })
                      }
                      placeholder="简短标签，例如：写实照片风"
                      maxLength={60}
                      className="flex-1"
                    />
                    <Input
                      type="number"
                      value={draft.sort_order}
                      onChange={(e) =>
                        updateDraft(preset.id, {
                          sort_order: Number(e.target.value) || 0,
                        })
                      }
                      title="排序权重，越小越靠前"
                      className="w-20"
                    />
                    <div className="flex items-center gap-1.5 pl-1">
                      <Switch
                        checked={draft.is_active}
                        onCheckedChange={(checked) =>
                          updateDraft(preset.id, { is_active: checked })
                        }
                      />
                      <span className="text-xs text-muted-foreground">
                        启用
                      </span>
                    </div>
                  </div>
                  <Textarea
                    value={draft.prompt}
                    onChange={(e) =>
                      updateDraft(preset.id, { prompt: e.target.value })
                    }
                    placeholder="完整提示词，选中后会插入到生成图片的描述里"
                    maxLength={4_000}
                    rows={2}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleDelete(preset.id)}
                      disabled={deletingId === preset.id}
                      aria-busy={deletingId === preset.id}
                    >
                      <Trash2 className="h-4 w-4" />
                      删除
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleSave(preset.id)}
                      disabled={savingId === preset.id}
                      aria-busy={savingId === preset.id}
                    >
                      {savingId === preset.id && (
                        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                      )}
                      保存
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
            <Label className="text-xs text-muted-foreground">新增提示词</Label>
            <div className="flex items-center gap-2">
              <Input
                value={newDraft.label}
                onChange={(e) =>
                  setNewDraft((prev) => ({ ...prev, label: e.target.value }))
                }
                placeholder="简短标签，例如：写实照片风"
                maxLength={60}
                className="flex-1"
              />
              <Input
                type="number"
                value={newDraft.sort_order}
                onChange={(e) =>
                  setNewDraft((prev) => ({
                    ...prev,
                    sort_order: Number(e.target.value) || 0,
                  }))
                }
                title="排序权重，越小越靠前"
                className="w-20"
              />
            </div>
            <Textarea
              value={newDraft.prompt}
              onChange={(e) =>
                setNewDraft((prev) => ({ ...prev, prompt: e.target.value }))
              }
              placeholder="完整提示词，选中后会插入到生成图片的描述里"
              maxLength={4_000}
              rows={2}
            />
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                onClick={() => void handleCreate()}
                disabled={creating}
                aria-busy={creating}
              >
                {creating ? (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                添加
              </Button>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

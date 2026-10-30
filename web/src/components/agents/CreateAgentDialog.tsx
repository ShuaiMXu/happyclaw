import { useEffect, useState } from 'react';
import { FileText, LayoutTemplate, Loader2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { SettingsField } from '@/components/settings/SettingsLayout';
import { getErrorMessage } from '@/components/settings/types';
import { useAgentProfilesStore } from '@/stores/agent-profiles';
import type { AgentProfile } from '@/types';
import { AGENT_TEMPLATES } from '@/utils/agent-templates';
import { apiErrorBody } from '@/utils/error';
import { ChoiceCardBody, choiceCardClassName } from './AgentSection';

type Start = 'blank' | 'ai' | 'template';

const START_OPTIONS: Array<{
  value: Start;
  label: string;
  icon: typeof FileText;
}> = [
  { value: 'blank', label: '空白', icon: FileText },
  { value: 'ai', label: 'AI 写提示词', icon: Wand2 },
  { value: 'template', label: '内置模板', icon: LayoutTemplate },
];

/**
 * New Agents start from a name and, optionally, prompts written by AI from a
 * one-line description or taken from a built-in template. Everything else is
 * set on the full editor the dialog hands over to.
 */
export function CreateAgentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (profile: AgentProfile) => void;
}) {
  const createProfile = useAgentProfilesStore((state) => state.createProfile);
  const generateProfileDraft = useAgentProfilesStore(
    (state) => state.generateProfileDraft,
  );
  const [name, setName] = useState('');
  const [start, setStart] = useState<Start>('blank');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState(AGENT_TEMPLATES[0]!.id);
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A retry after a name conflict reuses what AI already wrote.
  const [draft, setDraft] = useState<{
    description: string;
    value: Awaited<ReturnType<typeof generateProfileDraft>>;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setStart('blank');
    setDescription('');
    setTemplateId(AGENT_TEMPLATES[0]!.id);
    setNameError(null);
    setError(null);
    setDraft(null);
  }, [open]);

  const template = AGENT_TEMPLATES.find((item) => item.id === templateId);
  const trimmedName = name.trim();
  // AI may name the Agent itself; the other starts need a name.
  const canSubmit =
    !submitting && (start === 'ai' ? !!description.trim() : !!trimmedName);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setNameError(null);
    setError(null);
    try {
      let profile: AgentProfile;
      if (start === 'ai') {
        const wanted = description.trim();
        const generated =
          draft?.description === wanted
            ? draft.value
            : await generateProfileDraft(wanted);
        setDraft({ description: wanted, value: generated });
        profile = await createProfile({
          name: trimmedName || generated.name,
          identity_prompt: generated.identity_prompt,
          soul_prompt: generated.soul_prompt,
          agents_prompt: generated.agents_prompt,
          tools_prompt: generated.tools_prompt,
          prompt_mode: generated.prompt_mode,
        });
      } else if (start === 'template' && template) {
        profile = await createProfile({
          name: trimmedName,
          ...template.prompts,
          avatar_emoji: template.emoji,
        });
      } else {
        profile = await createProfile({ name: trimmedName });
      }
      onCreated(profile);
    } catch (err) {
      const code = apiErrorBody(err)?.code;
      if (code === 'AGENT_NAME_TAKEN' || code === 'INVALID_NAME') {
        setNameError(getErrorMessage(err, '名称已被使用'));
      } else {
        setError(getErrorMessage(err, '创建失败，请重试'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新建智能体</DialogTitle>
          <DialogDescription>
            起个名字就能创建；提示词、模型和能力都在创建后的编辑页设置。
          </DialogDescription>
        </DialogHeader>

        <form
          id="create-agent-form"
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <SettingsField
            label={
              <>
                名称
                {start !== 'ai' && (
                  <span className="ml-1 text-error" aria-hidden="true">
                    *
                  </span>
                )}
              </>
            }
            htmlFor="new-agent-name"
          >
            <Input
              id="new-agent-name"
              value={name}
              maxLength={80}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
              placeholder={
                start === 'ai'
                  ? '留空则由 AI 起名'
                  : start === 'template'
                    ? template?.name
                    : '例如：代码评审'
              }
              aria-invalid={!!nameError || undefined}
              aria-required={start !== 'ai'}
              aria-describedby={nameError ? 'new-agent-name-error' : undefined}
              className="pointer-coarse:min-h-11"
            />
            {nameError && (
              <p
                id="new-agent-name-error"
                role="alert"
                className="mt-1 text-caption text-error"
              >
                {nameError}
              </p>
            )}
          </SettingsField>

          <div className="min-w-0 space-y-2">
            <div className="text-label text-foreground">从哪里开始</div>
            <SegmentedControl
              label="从哪里开始"
              value={start}
              options={START_OPTIONS}
              onChange={(next) => {
                setStart(next);
                // The template's name follows the template only while the
                // user has not typed one.
                if (next === 'template' && !trimmedName && template) {
                  setName(template.name);
                } else if (
                  start === 'template' &&
                  next !== 'template' &&
                  trimmedName === template?.name
                ) {
                  setName('');
                }
              }}
            />
          </div>

          {start === 'ai' && (
            <div className="space-y-1.5">
              <label
                htmlFor="new-agent-description"
                className="text-label text-foreground"
              >
                一句话描述它要做什么
                <span className="ml-1 text-error" aria-hidden="true">
                  *
                </span>
              </label>
              <Textarea
                id="new-agent-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4000}
                aria-required="true"
                className="min-h-28 resize-y bg-background text-body leading-6"
                placeholder="例如：做代码评审，重点关注架构风险、并发问题和测试缺口，先给结论再按严重程度列问题。"
              />
              <p className="text-caption text-muted-foreground">
                AI 会据此写好四段提示词，创建后可以继续修改。
              </p>
            </div>
          )}

          {start === 'template' && (
            <div
              role="radiogroup"
              aria-label="内置模板"
              className="grid gap-2 sm:grid-cols-2"
            >
              {AGENT_TEMPLATES.map((item) => {
                const checked = item.id === templateId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    onClick={() => {
                      // Follow the template's name until the user types one.
                      if (!trimmedName || trimmedName === template?.name) {
                        setName(item.name);
                      }
                      setTemplateId(item.id);
                    }}
                    className={choiceCardClassName(
                      checked,
                      'pointer-coarse:min-h-11',
                    )}
                  >
                    <ChoiceCardBody
                      checked={checked}
                      title={`${item.emoji} ${item.name}`}
                      description={item.summary}
                    />
                  </button>
                );
              })}
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-error/10 px-3 py-2 text-caption text-error"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button type="submit" form="create-agent-form" disabled={!canSubmit}>
            {submitting && <Loader2 className="animate-spin" />}
            {submitting && start === 'ai' ? '正在生成…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

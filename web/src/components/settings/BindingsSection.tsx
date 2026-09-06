import { useState, useMemo, useCallback } from 'react';
import { Loader2, Link2, RefreshCw, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SearchInput } from '@/components/common/SearchInput';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useImBindings } from './hooks/useImBindings';
import { ImBindingRow } from './ImBindingRow';
import { BindingTargetDialog } from './BindingTargetDialog';
import { api } from '../../api/client';
import type { AvailableImGroup } from '../../types';
import type { BindingTarget } from './hooks/useImBindings';
import {
  getImChannelCapabilities,
  IM_CHANNEL_ORDER,
  type ImChannelType,
} from '../../constants/im-capabilities';
import {
  buildChannelAccountFilterOptions,
  channelAccountKey,
} from '../../utils/channel-accounts';

import {
  hasBindingPolicyMismatch,
  resolveBindingTargetType,
} from '../../utils/im-binding-policy';

type ChannelFilter = 'all' | ImChannelType;

export function BindingsSection() {
  const {
    bindings,
    loading,
    syncing,
    syncError,
    bindingsLoadError,
    targets,
    targetsLoading,
    reload,
    rebind,
    bindTarget,
    resetAllowlist,
    error: hookError,
    clearError: clearHookError,
  } = useImBindings();
  const [localError, setLocalError] = useState<string | null>(null);
  const errorMsg = localError || hookError;
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [actioningJid, setActioningJid] = useState<string | null>(null);
  const [selectingKey, setSelectingKey] = useState<string | null>(null);

  // Dialog state
  const [rebindGroup, setRebindGroup] = useState<AvailableImGroup | null>(null);
  const [unbindGroup, setUnbindGroup] = useState<AvailableImGroup | null>(null);
  const [resetAllowlistGroup, setResetAllowlistGroup] =
    useState<AvailableImGroup | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<AvailableImGroup | null>(null);

  const channels: { key: ChannelFilter; label: string; count: number }[] =
    useMemo(() => {
      const counts = new Map<string, number>();
      for (const binding of bindings) {
        counts.set(
          binding.channel_type,
          (counts.get(binding.channel_type) ?? 0) + 1,
        );
      }
      return [
        { key: 'all', label: '全部', count: bindings.length },
        ...IM_CHANNEL_ORDER.map((type) => ({
          key: type,
          label: getImChannelCapabilities(type)?.label ?? type,
          count: counts.get(type) ?? 0,
        })),
      ];
    }, [bindings]);

  const filtered = useMemo(() => {
    let list = bindings;
    if (accountFilter !== 'all') {
      list = list.filter(
        (binding) => channelAccountKey(binding) === accountFilter,
      );
    }
    if (channelFilter !== 'all') {
      list = list.filter((b) => b.channel_type === channelFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.jid.toLowerCase().includes(q) ||
          (b.bound_target_name &&
            b.bound_target_name.toLowerCase().includes(q)) ||
          b.channel_account_name?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [accountFilter, bindings, channelFilter, search]);
  const accountOptions = useMemo(
    () => buildChannelAccountFilterOptions(bindings),
    [bindings],
  );

  const bindingSections = useMemo(
    () => [
      {
        key: 'needs-migration',
        title: '需要迁移',
        description: '历史绑定与当前规则不一致，请换绑到正确目标',
        items: filtered.filter(hasBindingPolicyMismatch),
      },
      {
        key: 'workspace',
        title: '工作区绑定',
        description: '话题群绑定工作区，每个话题使用独立会话',
        items: filtered.filter(
          (item) =>
            resolveBindingTargetType(item) === 'workspace' &&
            !(item.bound_session_id ?? item.bound_agent_id) &&
            !!(item.bound_workspace_jid ?? item.bound_main_jid),
        ),
      },
      {
        key: 'main-session',
        title: '主会话绑定',
        description: '私聊和普通群使用目标工作区的主会话',
        items: filtered.filter(
          (item) =>
            resolveBindingTargetType(item) === 'session' &&
            !hasBindingPolicyMismatch(item) &&
            !(item.bound_session_id ?? item.bound_agent_id) &&
            !!(item.bound_workspace_jid ?? item.bound_main_jid),
        ),
      },
      {
        key: 'session',
        title: '会话绑定',
        description: '私聊和普通群使用指定会话',
        items: filtered.filter(
          (item) =>
            resolveBindingTargetType(item) === 'session' &&
            !hasBindingPolicyMismatch(item) &&
            Boolean(item.bound_session_id ?? item.bound_agent_id),
        ),
      },
      {
        key: 'unbound',
        title: '未绑定',
        description: '未绑定的渠道不会响应消息',
        items: filtered.filter(
          (item) =>
            !(item.bound_session_id ?? item.bound_agent_id) &&
            !(item.bound_workspace_jid ?? item.bound_main_jid),
        ),
      },
    ],
    [filtered],
  );

  const selectedChannelLabel =
    channelFilter === 'all'
      ? null
      : (getImChannelCapabilities(channelFilter)?.label ?? channelFilter);

  const selectableTargets = useMemo(() => {
    if (!rebindGroup) return [];
    const targetType = resolveBindingTargetType(rebindGroup);
    return targets.filter((target) => target.type === targetType);
  }, [rebindGroup, targets]);

  const handleRebind = useCallback((group: AvailableImGroup) => {
    setRebindGroup(group);
  }, []);

  const handleUnbind = useCallback((group: AvailableImGroup) => {
    setUnbindGroup(group);
  }, []);

  const handleResetAllowlist = useCallback((group: AvailableImGroup) => {
    setResetAllowlistGroup(group);
  }, []);

  const handleDelete = useCallback((group: AvailableImGroup) => {
    setDeleteGroup(group);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteGroup) return;
    const jid = deleteGroup.jid;
    setDeleteGroup(null);
    setActioningJid(jid);
    setLocalError(null);
    try {
      await api.delete(`/api/groups/${encodeURIComponent(jid)}`);
      reload();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setActioningJid(null);
    }
  }, [deleteGroup, reload]);

  const confirmResetAllowlist = useCallback(async () => {
    if (!resetAllowlistGroup) return;
    const jid = resetAllowlistGroup.jid;
    setResetAllowlistGroup(null);
    setActioningJid(jid);
    setLocalError(null);
    const err = await resetAllowlist(jid);
    setActioningJid(null);
    if (err) setLocalError(err);
  }, [resetAllowlistGroup, resetAllowlist]);

  const handleActivationModeChange = useCallback(
    async (jid: string, mode: string) => {
      setActioningJid(jid);
      setLocalError(null);
      const err = await rebind(jid, {
        activation_mode: mode as
          | 'auto'
          | 'always'
          | 'when_mentioned'
          | 'owner_mentioned'
          | 'disabled',
      });
      setActioningJid(null);
      if (err) setLocalError(err);
    },
    [rebind],
  );

  const handleAudienceModeChange = useCallback(
    async (jid: string, mode: 'everyone' | 'owner_only') => {
      setActioningJid(jid);
      setLocalError(null);
      const err = await rebind(jid, { audience_mode: mode });
      setActioningJid(null);
      if (err) setLocalError(err);
    },
    [rebind],
  );

  const confirmUnbind = useCallback(async () => {
    if (!unbindGroup) return;
    const jid = unbindGroup.jid;
    setUnbindGroup(null);
    setActioningJid(jid);
    setLocalError(null);
    const err = await rebind(jid, { unbind: true });
    setActioningJid(null);
    if (err) setLocalError(err);
  }, [unbindGroup, rebind]);

  const handleSelectTarget = useCallback(
    async (target: BindingTarget) => {
      if (!rebindGroup) return;
      const key = `${target.groupJid}:${target.type}:${target.sessionId ?? ''}`;
      setSelectingKey(key);
      setLocalError(null);

      const hasBound =
        !!(rebindGroup.bound_session_id ?? rebindGroup.bound_agent_id) ||
        !!(rebindGroup.bound_workspace_jid ?? rebindGroup.bound_main_jid);
      const err = await bindTarget(rebindGroup, target, hasBound);
      setSelectingKey(null);
      if (!err) setRebindGroup(null);
      else setLocalError(err);
    },
    [rebindGroup, bindTarget],
  );

  const [restoreConfirmGroup, setRestoreConfirmGroup] =
    useState<AvailableImGroup | null>(null);

  const handleRestoreDefault = useCallback(() => {
    if (!rebindGroup) return;
    setRestoreConfirmGroup(rebindGroup);
    setRebindGroup(null);
  }, [rebindGroup]);

  const confirmRestoreDefault = useCallback(async () => {
    if (!restoreConfirmGroup) return;
    const imJid = restoreConfirmGroup.jid;
    setRestoreConfirmGroup(null);
    setActioningJid(imJid);
    setLocalError(null);
    const err = await rebind(imJid, { unbind: true });
    setActioningJid(null);
    if (err) setLocalError(err);
  }, [restoreConfirmGroup, rebind]);

  return (
    <div>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Link2 className="w-6 h-6" />
              渠道绑定
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              私聊和普通群绑定会话，话题群绑定工作区。回复返回当前消息所在渠道或话题；未绑定时不响应。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={reload}
            disabled={loading || syncing}
          >
            <RefreshCw
              className={`w-3.5 h-3.5 mr-1.5 ${loading || syncing ? 'animate-spin' : ''}`}
            />
            {syncing ? '正在同步 Bot 聊天' : '同步聊天'}
          </Button>
        </div>

        {syncError && bindings.length > 0 && (
          <div
            role="status"
            className="rounded-lg border border-amber-300/70 bg-amber-50/60 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-200"
          >
            同步未完成，当前显示本地记录：{syncError}
          </div>
        )}

        {/* Error banner */}
        {errorMsg && (
          <div className="bg-error-bg border border-error/20 text-error text-sm rounded-lg px-4 py-2.5 flex items-center justify-between">
            <span>{errorMsg}</span>
            <button
              onClick={() => {
                setLocalError(null);
                clearHookError();
              }}
              className="text-error hover:text-error ml-2 text-xs"
            >
              ✕
            </button>
          </div>
        )}

        {/* Toolbar: channel filter + search */}
        {bindings.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              {channels.map((ch) => (
                <button
                  key={ch.key}
                  onClick={() => setChannelFilter(ch.key)}
                  className={`px-3 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer ${
                    channelFilter === ch.key
                      ? 'bg-primary text-white'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                  }`}
                >
                  {ch.label}
                  <span
                    className={`ml-1 ${channelFilter === ch.key ? 'text-white/80' : 'text-muted-foreground/70'}`}
                  >
                    {ch.count}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex-1 min-w-[200px]">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="搜索渠道名称..."
                debounce={200}
              />
            </div>
            {accountOptions.length > 1 && (
              <div className="flex items-center gap-2">
                <label
                  htmlFor="settings-binding-bot-account"
                  className="text-xs text-muted-foreground"
                >
                  机器人身份
                </label>
                <select
                  id="settings-binding-bot-account"
                  value={accountFilter}
                  onChange={(event) => setAccountFilter(event.target.value)}
                  aria-label="筛选机器人身份"
                  className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                >
                  <option value="all">全部机器人</option>
                  {accountOptions.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            加载中...
          </div>
        ) : bindingsLoadError ? (
          <Card>
            <CardContent className="space-y-3 text-center">
              <MessageSquare className="w-10 h-10 mx-auto text-error" />
              <p className="text-sm text-error">
                消息渠道加载失败：{bindingsLoadError}
              </p>
              <Button variant="outline" size="sm" onClick={reload}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                重试
              </Button>
            </CardContent>
          </Card>
        ) : bindings.length === 0 ? (
          <Card>
            <CardContent className="text-center">
              <MessageSquare className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">
                暂无 IM 渠道。在飞书、Telegram、QQ、微信、钉钉、Discord 或
                WhatsApp 中向 Bot 发送消息后，渠道会自动出现在这里。
              </p>
            </CardContent>
          </Card>
        ) : filtered.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm">
            {selectedChannelLabel && !search.trim()
              ? `暂无 ${selectedChannelLabel} 渠道。请先完成该渠道配置，并向 Bot 发送一条消息。`
              : '没有匹配的渠道'}
          </div>
        ) : (
          <div className="space-y-5">
            {bindingSections.map((section) =>
              section.items.length > 0 ? (
                <section key={section.key} className="space-y-2">
                  <div className="flex items-end justify-between px-1">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">
                        {section.title}
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          {section.items.length}
                        </span>
                      </h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {section.description}
                      </p>
                    </div>
                  </div>
                  {section.items.map((group) => (
                    <ImBindingRow
                      key={group.jid}
                      group={group}
                      isActioning={actioningJid === group.jid}
                      onRebind={handleRebind}
                      onUnbind={handleUnbind}
                      onResetAllowlist={handleResetAllowlist}
                      onActivationModeChange={handleActivationModeChange}
                      onAudienceModeChange={handleAudienceModeChange}
                      onDelete={handleDelete}
                    />
                  ))}
                </section>
              ) : null,
            )}
          </div>
        )}
      </div>

      {/* Rebind target dialog */}
      <BindingTargetDialog
        open={!!rebindGroup}
        imGroupName={rebindGroup?.name || ''}
        targets={selectableTargets}
        targetsLoading={targetsLoading}
        targetType={
          rebindGroup
            ? (resolveBindingTargetType(rebindGroup) ?? 'session')
            : 'session'
        }
        canUnbind={
          !!(
            (rebindGroup?.bound_session_id ?? rebindGroup?.bound_agent_id) ||
            (rebindGroup?.bound_workspace_jid ?? rebindGroup?.bound_main_jid)
          )
        }
        onSelect={handleSelectTarget}
        onRestoreDefault={handleRestoreDefault}
        onClose={() => setRebindGroup(null)}
        selecting={selectingKey}
      />

      {/* Unbind confirm dialog */}
      <ConfirmDialog
        open={!!unbindGroup}
        onClose={() => setUnbindGroup(null)}
        onConfirm={confirmUnbind}
        title="解除渠道绑定"
        message={
          unbindGroup
            ? `「${unbindGroup.name}」解除绑定后不再响应消息。已有会话和历史不会被删除。`
            : ''
        }
        confirmText="解除绑定"
      />

      {/* Unbind target confirm dialog */}
      <ConfirmDialog
        open={!!restoreConfirmGroup}
        onClose={() => setRestoreConfirmGroup(null)}
        onConfirm={confirmRestoreDefault}
        title="解除渠道绑定"
        message={
          restoreConfirmGroup
            ? `「${restoreConfirmGroup.name}」解除绑定后不再响应消息。已有会话和历史不会被删除。`
            : ''
        }
        confirmText="解除绑定"
      />

      {/* Release sender restriction confirm dialog */}
      <ConfirmDialog
        open={!!resetAllowlistGroup}
        onClose={() => setResetAllowlistGroup(null)}
        onConfirm={confirmResetAllowlist}
        title="解除发言者限制"
        message={
          resetAllowlistGroup
            ? `「${resetAllowlistGroup.name}」当前没有可触发机器人的成员。解除限制后，群内允许成员将可以触发机器人。继续？`
            : ''
        }
        confirmText="解除限制"
      />

      {/* Delete IM group confirm dialog */}
      <ConfirmDialog
        open={!!deleteGroup}
        onClose={() => setDeleteGroup(null)}
        onConfirm={confirmDelete}
        title="删除接入记录与本地历史"
        message={
          deleteGroup
            ? `确认删除「${deleteGroup.name}」的接入记录？此操作会删除它在 HappyClaw 中的渠道绑定、本地消息、关联会话及运行数据，且不可撤销；不会删除 IM 平台上的群聊。如果机器人之后再次收到该群消息，它可能会重新注册。若只是更换路由，请使用“换绑”或“解除绑定”。`
            : ''
        }
        confirmText="删除接入记录"
        confirmVariant="danger"
      />
    </div>
  );
}

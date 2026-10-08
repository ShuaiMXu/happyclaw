import {
  MessageCircle,
  Clock4,
  Bot,
  Puzzle,
  BarChart3,
  Wallet,
  Settings,
  KeyRound,
} from 'lucide-react';
import type { Permission } from '../../stores/auth';

export interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  requiresBilling?: boolean;
  requiredPermission?: Permission;
  hideOnMobile?: boolean;
}

export const baseNavItems: NavItem[] = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/agent-profiles', icon: Bot, label: '智能体' },
  { path: '/capabilities', icon: Puzzle, label: '能力库' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  {
    path: '/external-capabilities',
    icon: KeyRound,
    label: '外调',
    requiredPermission: 'manage_external_capabilities',
    hideOnMobile: true,
  },
  { path: '/usage', icon: BarChart3, label: '用量', hideOnMobile: true },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function filterNavItems(
  billingEnabled: boolean,
  hasPermission: (permission: Permission) => boolean = () => false,
) {
  return baseNavItems.filter(
    (item) =>
      (!item.requiresBilling || billingEnabled) &&
      (!item.requiredPermission || hasPermission(item.requiredPermission)),
  );
}

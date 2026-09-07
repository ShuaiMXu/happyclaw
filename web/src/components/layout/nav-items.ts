import {
  MessageCircle,
  Clock4,
  Bot,
  ImagePlus,
  Puzzle,
  BarChart3,
  Wallet,
  Settings,
} from 'lucide-react';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  /** 面向技术小白的一句话说明，用于侧边栏悬浮提示 */
  description?: string;
  requiresBilling?: boolean;
  hideOnMobile?: boolean;
}

export const baseNavItems: NavItem[] = [
  {
    path: '/chat',
    icon: MessageCircle,
    label: '工作台',
    description: '和 AI 聊天、办事的地方，像发微信一样跟它说需求',
  },
  {
    path: '/agent-profiles',
    icon: Bot,
    label: '智能体',
    description: '给 AI 设定人设和专长，打造专属你的助手',
  },
  {
    path: '/image-studio',
    icon: ImagePlus,
    label: '生图',
    description: '跟 AI 说一句话，马上生成一张图片',
  },
  {
    path: '/capabilities',
    icon: Puzzle,
    label: '能力库',
    description: '给 AI 开通更多技能和插件',
  },
  {
    path: '/tasks',
    icon: Clock4,
    label: '任务',
    description: '让 AI 到点自动帮你干活，不用每次都开口提醒',
  },
  {
    path: '/usage',
    icon: BarChart3,
    label: '用量',
    description: '查看已经用掉多少额度',
    hideOnMobile: true,
  },
  {
    path: '/billing',
    icon: Wallet,
    label: '账单',
    description: '充值和消费记录',
    requiresBilling: true,
  },
  {
    path: '/settings',
    icon: Settings,
    label: '设置',
    description: '账号信息和界面的个性化设置',
  },
];

export function filterNavItems(billingEnabled: boolean) {
  return baseNavItems.filter((item) => !item.requiresBilling || billingEnabled);
}

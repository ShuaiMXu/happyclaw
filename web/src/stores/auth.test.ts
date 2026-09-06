import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  clearMessageSnapshotCache: vi.fn().mockResolvedValue(undefined),
  resetUsage: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: {
    get: mocks.apiGet,
    post: mocks.apiPost,
    put: vi.fn(),
  },
  apiFetch: vi.fn(),
}));

vi.mock('../utils/messageSnapshotCache', () => ({
  clearMessageSnapshotCache: mocks.clearMessageSnapshotCache,
}));

vi.mock('./usage', () => ({
  useUsageStore: {
    getState: () => ({ reset: mocks.resetUsage }),
  },
}));

const { useAuthStore } = await import('./auth');

const registeredUser = {
  id: 'user-1',
  username: 'member',
  display_name: 'Member',
  role: 'member' as const,
  status: 'active' as const,
  permissions: [],
  must_change_password: false,
  disable_reason: null,
  notes: null,
  created_at: '2026-08-15T00:00:00.000Z',
  last_login_at: null,
  last_active_at: null,
  deleted_at: null,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  ai_name: null,
  ai_avatar_emoji: null,
  ai_avatar_color: null,
  ai_avatar_url: null,
  default_require_mention: false,
};

const appearance = {
  appName: 'Team Claw',
  aiName: 'HappyClaw',
  aiAvatarEmoji: '🐱',
  aiAvatarColor: '#0d9488',
  aiAvatarUrl: null,
  aiAvatarMode: 'brand' as const,
  brandIconUrl: '/api/config/brand-assets/brand-icon-12345678.png',
  brandBannerUrl: null,
};

beforeEach(() => {
  mocks.apiGet.mockReset().mockResolvedValue(appearance);
  mocks.apiPost.mockReset().mockResolvedValue({
    success: true,
    user: registeredUser,
  });
  mocks.clearMessageSnapshotCache.mockClear();
  mocks.resetUsage.mockClear();
  useAuthStore.setState({
    authenticated: false,
    user: null,
    setupStatus: null,
    appearance: null,
    initialized: true,
    checking: false,
  });
});

describe('auth store public appearance hydration', () => {
  test('hydrates appearance before registration completes', async () => {
    await useAuthStore.getState().register({
      username: 'member',
      password: 'password-123',
    });

    expect(mocks.apiPost).toHaveBeenCalledWith('/api/auth/register', {
      username: 'member',
      password: 'password-123',
    });
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/config/appearance/public');
    expect(useAuthStore.getState()).toMatchObject({
      authenticated: true,
      user: registeredUser,
      appearance,
    });
  });
});

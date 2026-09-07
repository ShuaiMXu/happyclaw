import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { UsageTrendChart } from '../web/src/components/usage/UsageTrendChart.js';

const point = {
  date: '2026-08-21',
  inputTokens: 100,
  cacheReadTokens: 200,
  cacheCreationTokens: 50,
  reasoningTokens: 25,
  outputTokens: 75,
  totalTokens: 450,
  providerEstimatedCostUSD: 0.12,
  billedCostUSD: null,
  runCount: 3,
  modelCallCount: 4,
};

describe('UsageTrendChart', () => {
  test('renders an accessible dependency-free token trend', () => {
    const html = renderToStaticMarkup(
      <UsageTrendChart data={[point]} metric="tokens" />,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('2026-08-21');
    expect(html).toContain('普通输入');
    expect(html).toContain('缓存读取');
    expect(html).toContain('每日 Token 趋势图');
  });
});

import { useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import 'katex/dist/katex.min.css';

export function MathMarkdownRenderer(props: MarkdownRendererProps) {
  const remarkPlugins = useMemo(
    () => [
      remarkGfm,
      remarkBreaks,
      [remarkMath, { singleDollarTextMath: false }] as const,
    ],
    [],
  );
  const rehypePlugins = useMemo(
    () => [[rehypeKatex, { throwOnError: false, strict: false }] as const],
    [],
  );
  return (
    <MarkdownContent
      {...props}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
    />
  );
}

import { useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import 'highlight.js/styles/github.css';

export function CodeMarkdownRenderer(props: MarkdownRendererProps) {
  const rehypePlugins = useMemo(
    () => [[rehypeHighlight, { plainText: ['mermaid'] }] as const],
    [],
  );
  return (
    <MarkdownContent
      {...props}
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={rehypePlugins}
    />
  );
}

import { useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import { markdownSanitizeSchema } from './markdownSanitizeSchema';

export function RawMarkdownRenderer(props: MarkdownRendererProps) {
  const rehypePlugins = useMemo(
    () => [rehypeRaw, [rehypeSanitize, markdownSanitizeSchema] as const],
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

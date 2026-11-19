export interface Paragraph {
  index: number;
  text: string;
  chars: number;
}

/** 单段上限：过长段落拆成多段，播放进度更细、分段结果也更稳定。 */
export const MAX_SEGMENT_CHARS = 240;

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/!\[\[([^\]|]*)\|?([^\]]*)\]\]/g, '$2$1')
    .replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, '$2$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*\*|\*\*|\*|___|__|_|~~)([^*]+?)\1/g, '$2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  const sentencePattern = /[^。！？!?；;\n]+[。！？!?；;]?/g;
  const sentences = text.match(sentencePattern) ?? [text];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) parts.push(current);
      current = '';
      for (let offset = 0; offset < sentence.length; offset += maxChars) {
        parts.push(sentence.slice(offset, offset + maxChars));
      }
      continue;
    }
    if (current.length + sentence.length > maxChars) {
      if (current) parts.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * 把 Markdown 正文切成朗读段落：
 * 跳过 frontmatter、代码块、表格、HTML 块与纯链接行，行内语法读成纯文本，标题按普通文字朗读。
 */
export function splitIntoParagraphs(markdown: string, maxChars = MAX_SEGMENT_CHARS): Paragraph[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const paragraphs: Paragraph[] = [];
  let buffer: string[] = [];
  let inCode = false;
  let inFrontmatter = false;
  let inTable = false;

  const flush = () => {
    const raw = buffer.join(' ').trim();
    buffer = [];
    if (!raw) return;
    for (const part of splitLongText(raw, maxChars)) {
      paragraphs.push({ index: paragraphs.length, text: part, chars: part.length });
    }
  };

  for (const line of lines) {
    if (paragraphs.length === 0 && buffer.length === 0 && !inFrontmatter && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false;
      continue;
    }
    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
      flush();
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      inTable = true;
      flush();
      continue;
    }
    if (inTable) {
      // 表格结束后继续读正文（表头分隔行或数据行之外的第一个非表格行）。
      if (line.trim().startsWith('|')) continue;
      inTable = false;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      const text = stripInlineMarkdown(heading[1]);
      if (text) paragraphs.push({ index: paragraphs.length, text, chars: text.length });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const text = stripInlineMarkdown(line.replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      if (text) paragraphs.push({ index: paragraphs.length, text, chars: text.length });
      continue;
    }
    if (/^(>\s*|---+|===+|\[![A-Z]+\]|<!--)/.test(line.trim())) {
      flush();
      continue;
    }
    const text = stripInlineMarkdown(line);
    if (text) buffer.push(text);
  }
  flush();
  return paragraphs;
}

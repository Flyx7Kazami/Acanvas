import MarkdownIt from 'markdown-it';

export function safeMarkdownLink(value: string): boolean {
  try {
    if (value.startsWith('#')) return true;
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol);
  } catch { return false; }
}

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdown.validateLink = safeMarkdownLink;
const linkOpen = markdown.renderer.rules.link_open || ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return linkOpen(tokens, index, options, env, self);
};
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index], destination = token.attrGet('src') || '', label = token.content || 'Image';
  return `<span class="markdown-image-placeholder" role="img" aria-label="${markdown.utils.escapeHtml(label)}"><span>${markdown.utils.escapeHtml(label)}</span><small>${markdown.utils.escapeHtml(destination)} · Image attachment required</small></span>`;
};

export function renderMarkdown(source: string): string { return markdown.render(source); }

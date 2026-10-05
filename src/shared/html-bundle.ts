export const bundleLimits = { files: 128, directories: 128, fileBytes: 10 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 };
const mimeTypes: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};
export const bundleMime = (path: string): string | undefined => mimeTypes[path.split('.').pop()?.toLowerCase() ?? ''];
export const validBundlePath = (path: unknown): path is string => typeof path === 'string' && path.length > 0 && path.length <= 500 && !/[\\\u0000-\u001f\u007f?#%:]/.test(path) && path.split('/').every(part => !!part && !part.startsWith('.') && part === part.trim());

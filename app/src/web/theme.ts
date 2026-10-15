export type ThemePreference = 'light' | 'dark' | 'system';

export function readThemePreference(): ThemePreference {
  const saved = localStorage.getItem('acanvas-theme');
  return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'light';
}

export function themeFromPreference(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

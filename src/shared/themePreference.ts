export const NOVAX_THEMES = ["white", "cloude", "dark", "high-contrast"] as const;

export type NovaxTheme = typeof NOVAX_THEMES[number];

const STORAGE_KEY = "novax.appearance.theme";

interface ThemeStorageReader {
  getItem(key: string): string | null;
}

interface ThemeStorageWriter {
  setItem(key: string, value: string): void;
}

interface ThemeRoot {
  dataset: Record<string, string | undefined>;
  removeAttribute(name: string): void;
}

export function readThemePreference(storage: ThemeStorageReader): NovaxTheme {
  const value = storage.getItem(STORAGE_KEY);
  return isNovaxTheme(value) ? value : "white";
}

export function applyThemePreference(theme: NovaxTheme, root: ThemeRoot, storage: ThemeStorageWriter): void {
  root.dataset.theme = theme;
  storage.setItem(STORAGE_KEY, theme);
}

function isNovaxTheme(value: string | null): value is NovaxTheme {
  return NOVAX_THEMES.some((theme) => theme === value);
}

export const NOVAX_BACKGROUND_MODES = ["snow", "custom", "none"] as const;

export type NovaxBackgroundMode = typeof NOVAX_BACKGROUND_MODES[number];

export interface NovaxBackgroundPreference {
  mode: NovaxBackgroundMode;
  customDataUrl: string | null;
}

const MODE_STORAGE_KEY = "novax.appearance.background.mode";
const CUSTOM_STORAGE_KEY = "novax.appearance.background.custom";

interface BackgroundStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface BackgroundRoot {
  dataset: Record<string, string | undefined>;
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
}

export function readBackgroundPreference(storage: Pick<BackgroundStorage, "getItem">): NovaxBackgroundPreference {
  const mode = storage.getItem(MODE_STORAGE_KEY);
  const customDataUrl = storage.getItem(CUSTOM_STORAGE_KEY);
  if (mode === "none") return { mode: "none", customDataUrl: null };
  if (mode === "custom" && isSupportedImageDataUrl(customDataUrl)) return { mode: "custom", customDataUrl };
  return { mode: "snow", customDataUrl: null };
}

export function applyBackgroundPreference(
  preference: NovaxBackgroundPreference,
  snowUrl: string,
  root: BackgroundRoot,
  storage: BackgroundStorage,
): boolean {
  const resolved = preference.mode === "custom" && !isSupportedImageDataUrl(preference.customDataUrl)
    ? { mode: "snow" as const, customDataUrl: null }
    : preference;
  root.dataset.background = resolved.mode;
  root.style.setProperty("--novax-snow-background", `url("${snowUrl}")`);
  if (resolved.mode === "none") root.style.removeProperty("--novax-workspace-background");
  else root.style.setProperty(
    "--novax-workspace-background",
    `url("${resolved.mode === "snow" ? snowUrl : resolved.customDataUrl}")`,
  );
  try {
    storage.setItem(MODE_STORAGE_KEY, resolved.mode);
    if (resolved.mode === "custom" && resolved.customDataUrl) storage.setItem(CUSTOM_STORAGE_KEY, resolved.customDataUrl);
    else storage.removeItem(CUSTOM_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function isSupportedImageDataUrl(value: string | null): value is string {
  return typeof value === "string" && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,/i.test(value);
}

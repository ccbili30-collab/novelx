import { describe, expect, it } from "vitest";
import { applyThemePreference, readThemePreference } from "../../src/shared/themePreference";

describe("theme preference", () => {
  it("falls back to the white theme for missing or invalid values", () => {
    expect(readThemePreference({ getItem: () => null })).toBe("white");
    expect(readThemePreference({ getItem: () => "unknown" })).toBe("white");
  });

  it("applies named themes", () => {
    const values = new Map<string, string>();
    const attributes = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string | undefined>,
      removeAttribute: (name: string) => {
        attributes.delete(name);
        if (name === "data-theme") delete root.dataset.theme;
      },
    };
    const storage = { setItem: (key: string, value: string) => void values.set(key, value) };
    applyThemePreference("dark", root, storage);
    expect(root.dataset.theme).toBe("dark");
    applyThemePreference("cloude", root, storage);
    expect(root.dataset.theme).toBe("cloude");
    applyThemePreference("white", root, storage);
    expect(root.dataset.theme).toBe("white");
    expect(values.get("novax.appearance.theme")).toBe("white");
  });

  it("restores the cloude theme from storage", () => {
    expect(readThemePreference({ getItem: () => "cloude" })).toBe("cloude");
  });
});

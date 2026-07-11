import { describe, expect, it, vi } from "vitest";
import { applyBackgroundPreference, readBackgroundPreference } from "../../src/shared/backgroundPreference";

describe("background preference", () => {
  it("uses Snow when no preference exists", () => {
    expect(readBackgroundPreference({ getItem: () => null })).toEqual({ mode: "snow", customDataUrl: null });
  });

  it("restores a supported custom image", () => {
    const values = new Map([
      ["novax.appearance.background.mode", "custom"],
      ["novax.appearance.background.custom", "data:image/png;base64,AAAA"],
    ]);
    expect(readBackgroundPreference({ getItem: (key) => values.get(key) ?? null })).toEqual({
      mode: "custom",
      customDataUrl: "data:image/png;base64,AAAA",
    });
  });

  it("centers application state on Snow when custom data is invalid", () => {
    const setProperty = vi.fn();
    const root = { dataset: {}, style: { setProperty, removeProperty: vi.fn() } };
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    expect(applyBackgroundPreference({ mode: "custom", customDataUrl: "not-an-image" }, "/snow.svg", root, storage)).toBe(true);
    expect(root.dataset).toEqual({ background: "snow" });
    expect(setProperty).toHaveBeenCalledWith("--novax-workspace-background", "url(\"/snow.svg\")");
  });
});

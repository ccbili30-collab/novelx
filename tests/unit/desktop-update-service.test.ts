import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AppUpdater } from "electron-updater";
import { createDesktopUpdateService } from "../../src/main/desktopUpdateService";

describe("Desktop update service", () => {
  it("fails closed when the packaged app has no update feed", async () => {
    const service = createDesktopUpdateService({ currentVersion: "0.1.0", packaged: true });

    expect(await service.check()).toMatchObject({
      kind: "not_configured",
      currentVersion: "0.1.0",
      canCheck: false,
      canDownload: false,
      canInstall: false,
    });
  });

  it("projects available, download progress, and restart-install states", async () => {
    const updater = new FakeUpdater();
    const service = createDesktopUpdateService({
      currentVersion: "0.1.0",
      packaged: true,
      updateUrl: "https://updates.example.invalid/novax/",
      updater: updater as unknown as AppUpdater,
    });
    const states: string[] = [];
    service.subscribe((state) => states.push(state.kind));

    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "0.2.0" });
      return null;
    });
    expect(await service.check()).toMatchObject({ kind: "available", availableVersion: "0.2.0", canDownload: true });

    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("download-progress", { percent: 42 });
      updater.emit("update-downloaded", { version: "0.2.0" });
      return [];
    });
    expect(await service.download()).toMatchObject({ kind: "downloaded", progress: 100, canInstall: true });

    service.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(states).toEqual(expect.arrayContaining(["checking", "available", "downloading", "downloaded"]));
    expect(updater.feed).toEqual({ provider: "generic", url: "https://updates.example.invalid/novax/" });
  });

  it("uses electron-builder embedded update configuration without a runtime URL", () => {
    const updater = new FakeUpdater();
    const service = createDesktopUpdateService({
      currentVersion: "0.1.0",
      packaged: true,
      embeddedConfig: true,
      updater: updater as unknown as AppUpdater,
    });

    expect(service.getStatus()).toMatchObject({ kind: "idle", canCheck: true });
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });
});

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  feed: unknown = null;
  setFeedURL = vi.fn((value: unknown) => { this.feed = value; });
  checkForUpdates = vi.fn<() => Promise<null>>();
  downloadUpdate = vi.fn<() => Promise<string[]>>();
  quitAndInstall = vi.fn();
}

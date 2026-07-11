import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";
import updaterPackage from "electron-updater";
import type { DesktopUpdateState } from "../shared/desktopUpdateContract";

export interface DesktopUpdateService {
  getStatus(): DesktopUpdateState;
  check(): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  install(): void;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}

export function createDesktopUpdateService(input: {
  currentVersion: string;
  packaged: boolean;
  updateUrl?: string;
  embeddedConfig?: boolean;
  updater?: AppUpdater;
}): DesktopUpdateService {
  const updateUrl = input.updateUrl?.trim();
  if (!input.packaged || (!updateUrl && !input.embeddedConfig)) {
    return new StaticDesktopUpdateService({
      kind: "not_configured",
      currentVersion: input.currentVersion,
      availableVersion: null,
      progress: null,
      message: input.packaged ? "尚未配置 novelx 更新源。" : "开发模式不执行软件更新。",
      canCheck: false,
      canDownload: false,
      canInstall: false,
    });
  }
  return new ElectronDesktopUpdateService(input.updater ?? updaterPackage.autoUpdater, input.currentVersion, updateUrl);
}

class StaticDesktopUpdateService implements DesktopUpdateService {
  constructor(private readonly state: DesktopUpdateState) {}
  getStatus(): DesktopUpdateState { return { ...this.state }; }
  async check(): Promise<DesktopUpdateState> { return this.getStatus(); }
  async download(): Promise<DesktopUpdateState> { return this.getStatus(); }
  install(): void {}
  subscribe(): () => void { return () => undefined; }
}

class ElectronDesktopUpdateService implements DesktopUpdateService {
  readonly #listeners = new Set<(state: DesktopUpdateState) => void>();
  #state: DesktopUpdateState;

  constructor(
    private readonly updater: AppUpdater,
    currentVersion: string,
    updateUrl?: string,
  ) {
    this.#state = state("idle", currentVersion, "可以检查 novelx 更新。", { canCheck: true });
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    if (updateUrl) updater.setFeedURL({ provider: "generic", url: updateUrl });
    updater.on("checking-for-update", () => this.#set(state("checking", currentVersion, "正在检查更新。")));
    updater.on("update-available", (info: UpdateInfo) => this.#set(state("available", currentVersion, `发现 novelx ${info.version}。`, {
      availableVersion: info.version,
      canCheck: true,
      canDownload: true,
    })));
    updater.on("update-not-available", () => this.#set(state("up_to_date", currentVersion, "当前已经是最新版本。", { canCheck: true })));
    updater.on("download-progress", (progress: ProgressInfo) => this.#set(state("downloading", currentVersion, `正在下载更新 ${Math.round(progress.percent)}%。`, {
      availableVersion: this.#state.availableVersion,
      progress: progress.percent,
    })));
    updater.on("update-downloaded", (info: UpdateInfo) => this.#set(state("downloaded", currentVersion, `novelx ${info.version} 已下载，等待重启安装。`, {
      availableVersion: info.version,
      progress: 100,
      canInstall: true,
    })));
    updater.on("error", () => this.#set(state("error", currentVersion, "软件更新失败，请稍后重试。", { canCheck: true })));
  }

  getStatus(): DesktopUpdateState { return { ...this.#state }; }

  async check(): Promise<DesktopUpdateState> {
    if (!this.#state.canCheck || this.#state.kind === "checking" || this.#state.kind === "downloading") return this.getStatus();
    try {
      await this.updater.checkForUpdates();
    } catch {
      this.#set(state("error", this.#state.currentVersion, "无法连接 novelx 更新源。", { canCheck: true }));
    }
    return this.getStatus();
  }

  async download(): Promise<DesktopUpdateState> {
    if (!this.#state.canDownload) return this.getStatus();
    this.#set(state("downloading", this.#state.currentVersion, "正在准备下载更新。", {
      availableVersion: this.#state.availableVersion,
      progress: 0,
    }));
    try {
      await this.updater.downloadUpdate();
    } catch {
      this.#set(state("error", this.#state.currentVersion, "更新下载失败，请稍后重试。", { canCheck: true }));
    }
    return this.getStatus();
  }

  install(): void {
    if (!this.#state.canInstall) return;
    this.updater.quitAndInstall(false, true);
  }

  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(next: DesktopUpdateState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener(this.getStatus());
  }
}

function state(
  kind: DesktopUpdateState["kind"],
  currentVersion: string,
  message: string,
  overrides: Partial<Omit<DesktopUpdateState, "kind" | "currentVersion" | "message">> = {},
): DesktopUpdateState {
  return {
    kind,
    currentVersion,
    availableVersion: null,
    progress: null,
    message,
    canCheck: false,
    canDownload: false,
    canInstall: false,
    ...overrides,
  };
}

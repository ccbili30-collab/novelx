import { app, BrowserWindow, safeStorage, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createMainWindowOptions } from "./createMainWindow";
import { registerDesktopIpc } from "./registerDesktopIpc";
import { registerWorkspaceIpc } from "./workspaceIpc";
import { installWindowCloseCoordinator } from "./windowCloseCoordinator";
import { ProviderSecureStore } from "./providerSecureStore";
import { registerProviderIpc } from "./providerIpc";
import { ImageProviderSecureStore } from "./imageProviderSecureStore";
import { registerImageProviderIpc } from "./imageProviderIpc";
import { ApplicationRegistryRepository } from "../domain/application/applicationRegistryRepository";
import { registerPath, registerProjectSessionIpc } from "./projectRegistryIpc";
import { createDesktopUpdateService } from "./desktopUpdateService";
import { registerDesktopUpdateIpc } from "./desktopUpdateIpc";
import { registerImageAssetProtocol, registerImageAssetScheme } from "./imageAssetProtocol";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
registerImageAssetScheme();
const e2eUserDataPath = !app.isPackaged ? process.env.NOVAX_DESKTOP_E2E_USER_DATA : undefined;
if (e2eUserDataPath) app.setPath("userData", path.resolve(e2eUserDataPath));

function createWindow(): BrowserWindow {
  const preloadPath = path.join(currentDir, "../preload/index.cjs");
  const window = new BrowserWindow(createMainWindowOptions(preloadPath));
  installWindowCloseCoordinator(window);

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(currentDir, "../renderer/index.html"));
  }

  return window;
}

app.whenReady().then(() => {
  const updateService = createDesktopUpdateService({
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    updateUrl: process.env.NOVAX_UPDATE_URL,
    embeddedConfig: app.isPackaged && fs.existsSync(path.join(process.resourcesPath, "app-update.yml")),
  });
  const disposeUpdateEvents = registerDesktopUpdateIpc(updateService);
  const providerStore = new ProviderSecureStore(app.getPath("userData"), safeStorage);
  const imageProviderStore = new ImageProviderSecureStore(app.getPath("userData"), safeStorage);
  const applicationRegistry = new ApplicationRegistryRepository(path.join(app.getPath("userData"), "application.db"));
  applicationRegistry.removeSafeE2eRegistrations();
  registerProviderIpc(providerStore);
  registerImageProviderIpc(imageProviderStore);
  const workspaceSession = registerWorkspaceIpc({
    getImageProviderProfile: () => imageProviderStore.loadRuntimeProfile(),
  });
  const disposeImageAssetProtocol = registerImageAssetProtocol(workspaceSession);
  registerProjectSessionIpc(applicationRegistry, workspaceSession);
  const e2eWorkspace = !app.isPackaged ? process.env.NOVAX_DESKTOP_E2E_WORKSPACE : undefined;
  if (e2eWorkspace) registerPath(applicationRegistry, workspaceSession, e2eWorkspace);
  const supervisor = registerDesktopIpc(
    path.join(currentDir, "agent-worker.js"),
    applicationRegistry,
    () => workspaceSession.acquireAgentRuntimeLease(),
    () => providerStore.loadRuntimeProfile(),
    () => workspaceSession.acquirePlayerRuntimeLease(),
    () => workspaceSession.acquireDecomposerRuntimeLease(),
    app.getPath("userData"),
  );
  app.once("before-quit", () => {
    disposeUpdateEvents();
    disposeImageAssetProtocol();
    supervisor.dispose();
    workspaceSession.close();
    applicationRegistry.close();
  });
  createWindow();

  if (updateService.getStatus().canCheck) {
    setTimeout(() => void updateService.check(), 5_000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

import { BrowserWindow, ipcMain } from "electron";
import { desktopIpcChannels } from "../shared/ipcContract";
import { desktopUpdateStateSchema } from "../shared/desktopUpdateContract";
import type { DesktopUpdateService } from "./desktopUpdateService";

export function registerDesktopUpdateIpc(service: DesktopUpdateService): () => void {
  ipcMain.handle(desktopIpcChannels.updateStatus, () => desktopUpdateStateSchema.parse(service.getStatus()));
  ipcMain.handle(desktopIpcChannels.updateCheck, () => service.check().then((value) => desktopUpdateStateSchema.parse(value)));
  ipcMain.handle(desktopIpcChannels.updateDownload, () => service.download().then((value) => desktopUpdateStateSchema.parse(value)));
  ipcMain.handle(desktopIpcChannels.updateInstall, () => service.install());
  return service.subscribe((state) => {
    const safeState = desktopUpdateStateSchema.parse(state);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(desktopIpcChannels.updateEvent, safeState);
    }
  });
}

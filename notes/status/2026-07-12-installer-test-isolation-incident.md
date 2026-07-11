# Installer Test Isolation Incident

## Incident

The production NovelX installation disappeared while `v0.2.7` packaging checks were run on the developer workstation.

## Cause

`verify-installer.mjs` and `verify-old-client-update.mjs` installed an NSIS package with the production `AppId`. A custom installation directory and redirected `APPDATA` / `LOCALAPPDATA` did not isolate the per-user Windows uninstall registration. NSIS could therefore treat the test package as the installed production application and remove the production installation during its lifecycle test.

## Recovery

- Reinstalled NovelX `v0.2.7` to `D:\NovelX`.
- Recreated `C:\Users\16014\Desktop\NovelX.lnk`.
- Confirmed the application launches from the D drive.

## Immediate Guard

Both installer lifecycle scripts now fail with `PRODUCTION_INSTALL_DETECTED` before creating a temporary directory or launching an installer whenever a production NovelX uninstall registration exists.

## Remaining Work

This guard prevents another local deletion but is not full test isolation. Installer and updater lifecycle tests still need a separately built test package with its own `AppId`, product name, shortcut names, and uninstall registry key, or they must run in a disposable Windows virtual machine. Until then, the lifecycle scripts cannot be run on a workstation that has production NovelX installed.

The previous provider and application configuration files were not found in the standard user-data locations after the incident. Project folders stored outside the application data directory are unaffected and can be reopened or rescanned.

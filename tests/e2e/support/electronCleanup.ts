import { spawnSync } from "node:child_process";
import type { ElectronApplication } from "@playwright/test";

const CLOSE_TIMEOUT_MS = 10_000;

export async function closeTestElectronApp(app: ElectronApplication | null): Promise<void> {
  if (!app) return;

  const rootPid = app.process().pid;
  if (!rootPid) {
    await app.close().catch(() => undefined);
    return;
  }
  const ownedPids = collectProcessTree(rootPid);

  await Promise.race([
    app.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
  ]);

  for (const pid of ownedPids.reverse()) {
    if (!isProcessAlive(pid)) continue;
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
}

function collectProcessTree(rootPid: number): number[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  const script = [
    `$rootPid = ${rootPid}`,
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId",
    "$result = [System.Collections.Generic.List[int]]::new()",
    "$queue = [System.Collections.Generic.Queue[int]]::new()",
    "$queue.Enqueue($rootPid)",
    "while ($queue.Count -gt 0) {",
    "  $current = $queue.Dequeue()",
    "  if (-not $result.Contains($current)) { $result.Add($current) }",
    "  foreach ($child in $all | Where-Object ParentProcessId -eq $current) { $queue.Enqueue([int]$child.ProcessId) }",
    "}",
    "$result -join ','",
  ].join("; ");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", script,
  ], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return [rootPid];
  const pids = result.stdout.trim().split(",")
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  return pids.includes(rootPid) ? pids : [rootPid, ...pids];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

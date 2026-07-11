# NovelX 0.2.5 Project File Worker Repair

## Scope

This note covers only the packaged Agent Worker（代理工作进程） interruption that occurred after `inspect_project_files`（检查项目文件） read a real project directory. Renderer（渲染进程） layout, the file tree, and the `cloude` theme are outside this diagnostic task.

## User-visible failure

The installed 0.2.4 client answered `Agent 工作进程已中断。` after the user corrected the Agent and stated that the project contained many Markdown（文档） files.

The affected project was `C:\Users\16014\Desktop\诡秘之主完整解析`. Its readable overview was large enough to exercise IPC（进程间通信） backpressure.

## Evidence

### Packaged Worker load was healthy

The Worker inside both `release\win-unpacked\resources\app.asar` and the installed 0.2.4 application returned:

```json
{"type":"runtime.ready","piLoaded":true,"promptRegistryVerified":true}
```

This falsified the initial hypotheses that `app.asar` could not be forked or that Pi Agent dependencies were absent from the package.

### The project file tool completed before the interruption

The workspace audit for run `51f0035e-3417-4c8f-a1de-dcaa66668806` recorded this order:

1. `inspect_project_files` tool invocation `482aca3b-6295-4d12-bc52-221f728c536e`: `succeeded`.
2. Steward（大管家） invocation: `interrupted`, `AGENT_WORKER_INTERRUPTED`.
3. Agent run: `interrupted`, `AGENT_WORKER_INTERRUPTED`.

The file gateway therefore did read the project. The failure occurred while returning the result to the Worker.

### Node.js IPC backpressure was misclassified as failure

Using the packaged NovelX executable as the Node.js runtime, a 239,552-byte tool response produced:

```text
send-return false
callback ok
```

For `ChildProcess.send()`, `false` indicates that the IPC queue has applied backpressure. It does not mean that the message failed. Delivery failure is reported by a synchronous exception or the send callback.

The 0.2.4 supervisor used this incorrect condition in the tool response path:

```ts
if (!run.child.send(response)) interrupt();
```

It therefore killed a healthy Worker precisely when a real project produced a sufficiently large response. Small E2E（端到端测试） fixtures did not cross the backpressure threshold and gave false confidence.

## Repair

- All Agent supervisor sends now ignore the boolean backpressure signal.
- A run is interrupted only when `send()` throws or its callback receives an `Error`.
- Startup commands, tool responses, and audit responses use the same corrected transport rule.
- Unexpected process errors, exits, and actual send failures are written to `agent-worker-diagnostics.jsonl` under the Electron user data directory.
- Diagnostics include only run ID, phase, event, exit code/signal, and a bounded error message. They do not include Provider（模型服务） credentials, prompts, project file content, or model responses.

Worker `stdout` and `stderr` remain disconnected from the release log. Capturing arbitrary provider output could persist request bodies or credentials. The new structured lifecycle log closes the proven blind spot without creating that leakage path. If a future native crash cannot be diagnosed from exit metadata, stderr capture must first add explicit redaction and a bounded allowlist.

## Regression coverage

`tests/unit/agent-process-supervisor.test.ts` now returns `false` for a valid approximately 240 KB project-file response while invoking the callback with success. The test requires that:

- no `run.failed` event is emitted;
- the Worker is not killed;
- file inspection activity completes.

`tests/unit/agent-worker-diagnostic-log.test.ts` verifies bounded, payload-free diagnostic persistence.

Verified locally:

```text
2 test files passed
11 tests passed
npm run typecheck passed
```

## Combined 0.2.5 verification

The combined renderer, theme, and Worker repair was verified after integration:

1. the complete suite passed with 78 test files and 299 tests;
2. the production build passed;
3. `novelx-Setup-0.2.5-x64.exe` and update metadata were generated;
4. package verification confirmed the ASAR and packaged Worker were present and loadable;
5. the unpacked packaged application read an overview containing six real Markdown files and more than 200 KB of returned text through a real Provider;
6. the Agent returned the expected `COASTLINE_BACKPRESSURE_OK` marker without interruption;
7. no `agent-worker-diagnostics.jsonl` failure record was created.

The Worker interruption is therefore closed for the proven IPC backpressure case. The remaining release risk is unrelated: the Windows installer is still unsigned and may display an Unknown publisher warning.

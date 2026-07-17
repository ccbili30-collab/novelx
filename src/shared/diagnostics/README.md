# Safe diagnostics

This directory owns the stable, content-free Safe Diagnostic Envelope shared across trusted process boundaries.

It owns:

- strict diagnostic identity and correlation fields;
- owner, boundary, side-effect, disposition and retryability vocabularies;
- the module-local catalog interface.

It does not own:

- phase-specific error codes or messages;
- raw exceptions, stacks, Provider payloads or tool arguments;
- user-facing or model-facing prose;
- persistence, recovery or Renderer state.

Each capability keeps its catalog beside its implementation. A downstream boundary references an existing diagnostic instead of replacing its root code. Read the capability catalog and its focused tests before changing an error.

Focused test:

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/safe-diagnostic-contract.test.ts
```

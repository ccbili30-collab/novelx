# Long-context project reading regression

## Contract

- Project text is read by explicit character ranges with SHA-256 source identity.
- Every consumed range must be persisted as an `agent_task_notes` record before its raw content can leave active context.
- Completed read/note tool pairs are replaced by one aggregate durable-source receipt; uncovered raw content remains.
- File offsets are selected by the Harness, not by model arguments.
- Final tool outcomes are copied from the Harness execution trace, not trusted from model-authored audit fields.
- Missing Provider configuration remains fail-closed.

## Real Provider acceptance

`tests/e2e/real-provider-long-context-reading.spec.ts` verifies:

- all discovered Markdown files appear in the final response;
- the run completes without a context-budget error;
- saved note ranges start at zero, are contiguous, and end at the actual file length;
- every file's durable notes contain its source marker;
- Electron cleanup targets only the test process tree.

## Known separate risk

The Steward can still semantically misstate a correctly saved note in its final prose. Range coverage and durable memory are verified here; semantic agreement between final prose and notes requires Checker-backed final-answer validation.

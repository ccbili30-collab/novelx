# Growth Story Fragment Compiler

Growth story Cycles expose a compact Story Fragment rather than low-level Change Set items. Story Brief is a Growth-story-only Harness input compiler: Main/Receipt supplies the trusted unique world evidence, the model supplies only the high-level brief, and the real Writer supplies the prose candidate. Ordinary Writer and Player/GM paths remain unchanged.

The Writer candidate is the sole prose source; the compiler copies it byte-for-byte and creates one story, prose document pair, and `uses_world` relation with deterministic IDs and dependencies. Invalid Fragment/evidence failures occur before the existing executor and may use only the existing bounded pre-executor correction. Gateway or ChangeSetService failures are terminal and never retried. This adds no persistence, public protocol, or policy change; OC support remains separate.

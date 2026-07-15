# Growth OC Fragment compiler

## Decision

Growth Cycle 3 uses a model-facing OC Fragment rather than low-level Change Set items. The pinned Receipt must contain exactly one distinct formal story resource. The compiler deterministically creates OC resources, `character_profile` documents, `uses_oc` edges from that story, and optional `related_to` edges among the new OCs, then calls the existing proposal executor once.

## Boundaries

The model supplies only OC titles, profile text, and character-to-character choices. The compiler supplies IDs, roots, dependencies, create/state fields, ordering, document kind, and relation kinds. Invalid Fragments may use the existing two pre-executor corrections; executor, Gateway, policy, persistence, and unknown-result failures remain terminal. Profile creative bytes are model-authored and preserved; they are not exposed in safe public activity/evidence.

This does not change the public protocol, Change Set policy, permissions, Canon/Lens, persistence schema, Prompt identities, images, or story/world behavior.

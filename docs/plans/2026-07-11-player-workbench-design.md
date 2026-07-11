# Player Workbench Design

## Purpose

Player Mode（玩家模式）is a visible reading-and-action surface, not another Agent chat. It presents only accepted immutable prose, the player's own actions, public state, and explicit blocked/reconciliation decisions. GM resolutions, evidence ids, Prompt identities, tool calls, and audit fields remain outside the Renderer.

## Layout

- Left rail: Story Profile（故事配置）, optional Start Profile（起始模板）, and Playthrough（游玩存档）selection. When no Story Profile exists, the user can create one from an existing Story（故事）and World（世界）resource.
- Center: a vertically scrollable stream of prose cards. Each card is one immutable turn. The action is secondary; prose is primary. A fixed composer at the bottom submits the next action.
- Right rail: only localized, allowlisted public state such as location, health, stamina, and luck. Unknown internal keys are not rendered.
- Titlebar: Player / Agent / IDE segmented mode switch. Player remains separate from creation chat and document editing.

## Data Flow

The Renderer sends only `playthroughId` and player action. The main process handles reconciliation, pinned canon retrieval, state and memory assembly, Provider injection, audit, validation, and atomic persistence. Completion events expose only the stored turn projection. A canon divergence opens a modal with exactly two actions: continue the pinned save or fork an empty save from current canon.

## Failure Behavior

Missing Provider, unpublished GM Prompt, incomplete pinned context, audit failure, validation rejection, cancellation, and Worker interruption appear as blocked messages above the composer. No failure creates a prose card. Running state disables profile, save, and action mutations.

## Verification

Unit tests cover profile/save listing and event state transitions. Electron Playwright covers visible Player mode, empty state, no-Provider fail-closed behavior, and reconciliation dialog. Real Provider prose remains a separately credentialed test and cannot be replaced with fixtures marked live.

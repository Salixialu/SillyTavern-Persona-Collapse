# Sortable Persona Layout Design

**Status:** Approved for planning
**Target release:** 3.2.0
**Baseline:** 3.1.1 (`8c64347` on `source`)

## Goal

Replace the branch panel's fixed parent and subgroup select controls with a smooth, touch-capable sortable layout. Personas and named subgroups can be mixed at the branch root, subgroup contents can be reordered or moved across groups, and the first root persona becomes the dynamic entry shown in SillyTavern's native persona list.

## Product Model

The feature keeps the name **人设分支**, but no persona has a permanent "主卡" identity.

- **Branch:** A collection of related personas currently represented by one visible persona in the native list.
- **Entry persona:** The first root persona. It is the branch representative visible in the native persona list.
- **Root persona:** A branch member that is not inside a named subgroup.
- **Named subgroup:** A collapsible folder inside a branch.

The entry persona is a presentation role, not a separate persona type. Moving another persona to the first root slot transfers the role without changing character, chat, or group bindings.

## Invariants

1. Every branch contains at least one persona.
2. The first root layout item is always a persona and is the entry persona.
3. The entry persona is not a subgroup member.
4. Every other branch persona appears exactly once, either at the root or inside one subgroup.
5. Every named subgroup appears exactly once at the root.
6. Subgroups cannot contain other subgroups.
7. The native persona list shows only the current entry persona for a folded branch.
8. Dragging changes layout and subgroup membership only; it never copies persona bindings.

## User Experience

### Branches Without Named Subgroups

The panel behaves like the pre-subgroup branch list. There is no "未分组" label or container. All personas form one flat sortable list, including the entry persona.

- Dragging a non-entry persona changes its order.
- Dragging a persona to the first slot makes it the new entry persona.
- The former entry becomes a normal root persona at the position produced by the drag operation.

### Mixed Root Layout

Once named subgroups exist, root personas and subgroup containers share one sortable root:

```text
[entry persona]
[root persona]
[subgroup]
[root persona]
[subgroup]
```

Subgroups may be placed between root personas, but no subgroup may move before the entry persona.

### Persona Dragging

- Root to root: reorder the persona.
- Root to subgroup: remove the root item and insert the persona at the selected subgroup position.
- Subgroup to root: remove subgroup membership and insert the persona at the selected root position.
- Subgroup to subgroup: transfer membership and insert at the selected position.
- Within one subgroup: reorder the subgroup members.
- Persona to absolute first root position: make that persona the new entry.

The current entry cannot be dropped directly into a subgroup. The user first moves another persona to the first slot, then the former entry can be grouped normally. This keeps the first-item invariant visible and predictable.

### Subgroup Dragging

Each subgroup header has a dedicated grip. A subgroup can be reordered among root personas and other subgroups, except that it cannot occupy the first root slot. A subgroup cannot be dropped inside another subgroup.

### Folding

- Clicking the chevron toggles the subgroup.
- Clicking the non-interactive area of the complete subgroup header also toggles it.
- The grip, rename button, delete button, and rename input stop click propagation.
- Collapsed state remains persisted per subgroup.
- While a persona is being dragged, hovering over a collapsed subgroup for 500 ms expands it without interrupting the active drag.

### Entry Persona Feedback

The current `主卡` text badge is removed. The entry row instead shows a small eye icon with the tooltip `左侧列表入口`. This communicates visibility without preserving the old parent-child terminology.

Changing the entry updates the folded native list but does not force SillyTavern to switch the currently active persona.

## Visual Design

- Keep the panel compact and theme-aware; do not turn sections into large cards.
- Use SillyTavern theme variables for borders, body color, quote/accent color, and translucent backgrounds.
- Persona rows retain the existing avatar, name, title, binding indicators, copy action, and unlink action.
- Remove the subgroup `<select>` and all related responsive CSS.
- Subgroup header order: grip, chevron, folder icon, name, count, rename, delete.
- Subgroup contents use a small left indent and a subtle vertical guide line.
- Sortable states use a translucent ghost, a clearly bounded chosen item, and an accent insertion marker.
- Use approximately 150 ms movement animation.
- Expand/collapse uses a CSS grid row transition instead of the `hidden` attribute.
- Empty subgroup content remains compact but keeps a usable drop target while dragging.
- Respect `prefers-reduced-motion` by disabling movement and folding animation.

## Drag Engine

Use SortableJS as a direct runtime dependency. It is preferred over expanding the current hand-written HTML5 and touch implementations because this feature requires nested cross-container sorting, touch fallback, auto-scroll, stable placeholders, and animation.

The panel owns:

- One root Sortable instance for root personas and subgroup wrappers.
- One child Sortable instance for each subgroup's persona container.
- A collection of live instances that is destroyed before the panel is rebuilt.

All containers share one Sortable group. `onMove` enforces item-type restrictions:

- Persona items may enter root or subgroup containers.
- Subgroup wrappers may move only in the root container.
- A subgroup cannot occupy root index zero.
- A move that would leave no root persona at index zero is rejected.

Recommended behavior settings are `animation: 150`, a dedicated handle, touch fallback on `body`, vertical direction, auto-scroll, and a nonzero empty insertion threshold. Exact thresholds should be tuned during browser verification rather than exposed as user settings.

## Persisted Data

Extend `GroupSettings` with a root layout map:

```ts
type BranchLayoutItem =
  | { type: 'persona'; id: string }
  | { type: 'subgroup'; id: string };

branchLayouts: Record<string, BranchLayoutItem[]>;
```

The map key remains the current entry persona ID for compatibility with the existing branch ownership model. The layout includes the entry persona as its first item. Existing `subgroups[parentId][].personaIds` remains authoritative for subgroup membership and subgroup-internal order.

`manualGroups[parentId]` continues to contain every branch persona except the current entry. Its order is synchronized to a depth-first flattening of the visual layout so legacy operations and a later subgroup deletion retain intuitive ordering.

## Atomic Snapshot Update

Do not compose a drop from separate `promoteToParent`, `movePersonaToSubgroup`, and `reorderChild` saves. At the end of a drag, serialize the complete visible layout:

```ts
interface BranchLayoutSnapshot {
  root: BranchLayoutItem[];
  subgroupMembers: Record<string, string[]>;
}
```

The manager applies the snapshot in one transaction:

1. Resolve all valid branch personas and subgroup IDs.
2. Reject unknown, missing, or duplicate IDs.
3. Reject a root whose first item is not a persona.
4. Reject an entry persona that also occurs inside a subgroup.
5. Determine the new entry from `root[0]`.
6. Re-key branch-owned settings when the entry changed.
7. Store root layout and subgroup member order under the new entry ID.
8. Rebuild `manualGroups[newEntryId]` from the flattened visual order, excluding the entry.
9. Invalidate effective-group caches.
10. Call the save callback exactly once.

If validation fails, no settings change. The panel is rerendered from the last valid manager state and shows a short warning.

For a branch that exists only through automatic grouping, the first manual drag materializes the current effective members into `manualGroups` so the user's explicit order remains stable. Automatic grouping preferences remain enabled.

## Migration And Compatibility

No eager destructive migration is required.

- Missing `branchLayouts` defaults to `{}`.
- For a legacy branch without a stored layout, derive the 3.1.1 appearance: current parent persona, ungrouped children, then named subgroups.
- Persist the derived layout only after an explicit layout-changing action.
- Existing subgroup IDs, names, membership, collapsed state, copy behavior, and binding behavior remain valid.
- Keep the legacy `ungroupedCollapsed` setting readable during this release for rollback compatibility, but do not render or mutate an ungrouped fold control.

## Lifecycle Rules

### Create Subgroup

Append the empty subgroup node to the root layout. Enter rename mode as today.

### Delete Subgroup

Replace the subgroup node at its current root position with persona nodes for its members, preserving subgroup order. This avoids moving released personas to an unrelated part of the list.

### Duplicate Persona

- If the source is a root persona, insert the copy immediately after it at the root.
- If the source is inside a subgroup, insert the copy immediately after it in that subgroup.
- Do not copy character, chat, or group bindings.

### Delete Persona

Remove stale persona references from root layouts and subgroup membership. If the deleted persona was the entry, promote the first remaining root persona. If no root persona remains but subgroup members exist, move the first persona from the earliest subgroup to the first root slot and make it the entry.

### Disband Or Reset

Remove the associated layout state together with existing branch and subgroup state.

### Promote And Relink

Existing explicit promotion and relinking operations must transfer or clean layout state with the rest of branch-owned settings. A persona moved to another branch cannot remain referenced by the old layout.

## Error Handling

- Invalid Sortable snapshots are rejected atomically.
- Missing DOM IDs cause a rerender rather than partial persistence.
- Sortable instances are destroyed before panel replacement to prevent duplicate handlers.
- Auto-expand timers and drag-state classes are cleared on drag end, cancellation, panel rerender, and extension disable.
- Deleting or changing a subgroup while dragging is prevented by the active drag state.

## Testing

Manager tests must cover:

1. Legacy layout derivation.
2. Flat root reorder with no named subgroups.
3. Root persona and subgroup mixed ordering.
4. Persona move from root into a subgroup.
5. Persona move between subgroups.
6. Persona move from subgroup back to root.
7. Subgroup reorder among root personas.
8. Entry persona replacement and state re-keying.
9. Rejection of subgroup-at-first, nested subgroup, duplicate, missing, and unknown IDs.
10. Exactly one save for a valid snapshot and zero saves for an invalid snapshot.
11. Subgroup deletion expanding members at the former subgroup position.
12. Copy placement at root and inside a subgroup.
13. Cleanup after persona deletion, relink, disband, reset, and entry deletion.
14. Compatibility with automatic groups after the first explicit drag.

Presentation tests must verify that the select control and `主卡` badge are absent, Sortable data attributes are present, and header actions do not trigger folding.

Manual browser verification must cover desktop mouse, touch emulation, narrow mobile width, auto-scroll, empty groups, collapsed-group hover expansion, reduced motion, repeated entry changes, and SillyTavern persona switching while a non-entry branch member is active.

## Versioning And Release

- Develop on an isolated `codex/` branch from `source` 3.1.1.
- Use separate commits for data model/tests, Sortable integration, folding/visual polish, lifecycle compatibility, and release artifacts.
- Release as 3.2.0 because this changes the branch interaction model and adds persisted layout data.
- Run Vitest, ESLint, production Webpack build, ZIP packaging, ZIP content verification, and SHA-256 verification.
- Update `source` with full development files.
- Update `main` with only `LICENSE`, `README.md`, `dist/index.js`, `manifest.json`, and `style.css`.
- Keep the ZIP limited to `persona-collapse/manifest.json`, `persona-collapse/style.css`, and `persona-collapse/dist/index.js`.

## Reference Decisions

The compact folder header, full-header fold toggle, 150 ms sorting animation, touch fallback, and delayed hover expansion are informed by the local JS-Slash-Runner folder implementation. Persona Collapse will use equivalent interaction principles in its existing vanilla TypeScript architecture rather than copying Vue components or introducing Vue at runtime.

## Non-Goals

- Nested named subgroups.
- Dragging a branch into another branch from this panel.
- A synthetic non-persona tile in SillyTavern's native persona list.
- Replacing the entire native persona manager.
- User-configurable drag thresholds, animation duration, or subgroup colors in this release.

# Stable Branch Manager Design

## Goal

Improve Persona Collapse branch management so normal users can organize persona branches and subgroups without relying on drag-and-drop. Dragging remains available as a fast path, but every core action must also have a stable click/menu path.

## Scope

- When creating a subgroup from the branch panel, open a naming popup first.
- If the user cancels or submits an empty name, do not create a subgroup.
- If the user submits a name, create the subgroup with that name and refresh the branch panel.
- Rework the existing branch management popup into a unified manager that understands subgroups.
- Preserve the existing main/entry persona behavior: the first root persona remains the left-list entry.
- Keep drag-and-drop as an enhancement, not as the only way to move personas.

Out of scope for this pass:

- Replacing SillyTavern's left persona list with a full custom overlay.
- Publishing to `main` or `source`.
- Changing stored data shape unless required by the existing `GroupManager` APIs.

## UX Design

The branch panel stays compact. Its header keeps:

- Branch title and count.
- New subgroup button.
- Manage button.

The new subgroup button opens a small popup with one text input. Confirm creates a subgroup. Cancel or empty input does nothing.

The unified manager becomes the stable organization surface:

- Left pane: available independent personas, with search, same-name filter, and same-bound-character filter.
- Right pane: current branch structure, including the entry persona, root-level personas, and named subgroups.
- Persona actions: add to branch, set as entry, move to root, move to subgroup, remove from branch, duplicate.
- Subgroup actions: create, rename, delete, collapse or expand.

Drag-and-drop can still reorder or place items, but users can complete the same tasks through buttons and menus.

## Architecture

Keep `GroupManager` as the data authority. Prefer its existing APIs:

- `createSubgroup`
- `renameSubgroup`
- `deleteSubgroup`
- `movePersonaToSubgroup`
- `promoteToParent`
- `linkChild`
- `unlinkChild`
- `applyBranchLayoutSnapshot`

Refactor UI code out of `src/index.ts` only where it reduces local complexity. The likely first split is a manager-rendering helper module, while keeping SillyTavern API access and global plugin lifecycle in `index.ts`.

The implementation should avoid adding another drag state machine in this pass.

## Validation

Manual test paths:

- Create subgroup with a name.
- Cancel subgroup creation.
- Submit empty subgroup name.
- Add an independent persona to the branch from the manager.
- Move a persona into a subgroup without dragging.
- Move a persona back to root without dragging.
- Rename and delete a subgroup.
- Set another root persona as entry.
- Confirm drag still works as an enhancement.

Automated checks:

- Update focused tests for subgroup creation and panel strings.
- Run `pnpm test`.
- Run `pnpm run build`.
- Run `eslint src tests`.

## Rollback

All work stays on `codex/sortable-persona-layout` until tested. The remote stable release remains unchanged. The known rollback point before this design is commit `4d97dcb`.

# Stable Branch Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stable click/menu management paths for persona subgroups so drag-and-drop is optional.

**Architecture:** Keep `GroupManager` as the data authority and update the existing `src/index.ts` UI paths first. Extracting a separate manager module is allowed only if the local changes become hard to read; this pass should avoid broad reshaping.

**Tech Stack:** TypeScript, SillyTavern extension APIs, existing `Popup`, existing `GroupManager`, Vitest, ESLint, webpack.

---

### Task 1: Named Subgroup Creation

**Files:**
- Modify: `D:\SillyTavern\ST_projects\.worktrees\persona-collapse\sortable-persona-layout\src\index.ts`
- Test: `D:\SillyTavern\ST_projects\.worktrees\persona-collapse\sortable-persona-layout\tests\panel-rendering.test.ts`

- [ ] **Step 1: Add a small async prompt helper near `renderVariantsPanel`**

```ts
async function promptSubgroupName(initialName = ''): Promise<string | null> {
  const wrapper = document.createElement('div');
  wrapper.className = 'cp2-name-dialog';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text_pole cp2-name-dialog-input';
  input.value = initialName;
  input.placeholder = tUi('personaCollapse.subgroupNamePlaceholder', '输入分组名称');
  wrapper.appendChild(input);

  const popup = new Popup(wrapper, POPUP_TYPE.TEXT, '', {
    okButton: tUi('personaCollapse.create', '创建'),
    cancelButton: tUi('personaCollapse.cancel', '取消'),
  });
  const result = await popup.show();
  if (result === null) return null;
  const name = input.value.trim();
  return name.length > 0 ? name : null;
}
```

- [ ] **Step 2: Replace direct subgroup creation**

```ts
panel.querySelector('#cp2-create-subgroup')?.addEventListener('click', async e => {
  e.stopPropagation();
  const name = await promptSubgroupName();
  if (!name) return;
  manager.createSubgroup(parentId, name);
  renderVariantsPanel(true, currentId);
});
```

- [ ] **Step 3: Update the focused panel test**

Add expectations that `src/index.ts` contains `promptSubgroupName`, `POPUP_TYPE.TEXT`, and does not directly assign `editingSubgroupId = manager.createSubgroup(parentId).id`.

- [ ] **Step 4: Run test**

Run: `pnpm test tests/panel-rendering.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/panel-rendering.test.ts
git commit -m "feat: prompt for subgroup names"
```

### Task 2: Unified Manager Subgroup Actions

**Files:**
- Modify: `D:\SillyTavern\ST_projects\.worktrees\persona-collapse\sortable-persona-layout\src\index.ts`
- Modify: `D:\SillyTavern\ST_projects\.worktrees\persona-collapse\sortable-persona-layout\style.css`
- Test: `D:\SillyTavern\ST_projects\.worktrees\persona-collapse\sortable-persona-layout\tests\panel-rendering.test.ts`

- [ ] **Step 1: Render the right pane from branch layout**

In `openGroupManager`, replace the flat `rightHtml` member loop with layout-aware rendering:

```ts
const layout = manager.getBranchLayout(currentParentId, children);
const subgroups = manager.getSettings().subgroups[currentParentId] || [];
const subgroupById = new Map(subgroups.map(group => [group.id, group]));
```

Render root personas as manager items and render each subgroup as a named section with its members.

- [ ] **Step 2: Add stable persona move controls**

Each right-pane persona item should include:

```html
<button class="menu_button cp2-mgr-entry-btn" data-id="..."><i class="fa-solid fa-crown"></i></button>
<button class="menu_button cp2-mgr-root-btn" data-id="..."><i class="fa-solid fa-arrow-up"></i></button>
<select class="text_pole cp2-mgr-subgroup-select" data-id="...">...</select>
<button class="menu_button cp2-remove-btn" data-id="..."><i class="fa-solid fa-xmark"></i></button>
```

The select is acceptable inside the manager popup because this is a stable fallback surface, not the compact branch panel.

- [ ] **Step 3: Wire stable actions**

Use existing manager APIs:

```ts
manager.promoteToParent(currentParentId, id);
manager.movePersonaToSubgroup(currentParentId, id, null, children);
manager.movePersonaToSubgroup(currentParentId, id, subgroupId, children);
manager.unlinkChild(id);
```

After each action, update `currentParentId` when needed, then call `renderPanes()`.

- [ ] **Step 4: Add manager subgroup create/rename/delete buttons**

Add a top action row in the right pane:

```html
<button id="cp2-mgr-create-subgroup" class="menu_button"><i class="fa-solid fa-folder-plus"></i> 新建分组</button>
```

Use `promptSubgroupName` for create and rename. Use the existing `Popup(... POPUP_TYPE.CONFIRM ...)` pattern for delete.

- [ ] **Step 5: Add CSS for manager sections**

Add classes:

```css
.cp2-manager-branch { display: flex; flex-direction: column; gap: 6px; }
.cp2-manager-subgroup { border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; background: var(--black20a); overflow: hidden; }
.cp2-manager-subgroup-header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; }
.cp2-manager-subgroup-items { display: flex; flex-direction: column; gap: 4px; padding: 0 6px 6px 16px; }
.cp2-manager-item-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.cp2-mgr-subgroup-select { width: 100px; min-width: 80px; height: 28px; margin: 0; }
```

- [ ] **Step 6: Update tests**

Add expectations that panel source contains `cp2-mgr-create-subgroup`, `movePersonaToSubgroup`, `cp2-mgr-subgroup-select`, and `cp2-manager-subgroup`.

- [ ] **Step 7: Run focused tests**

Run: `pnpm test tests/panel-rendering.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts style.css tests/panel-rendering.test.ts
git commit -m "feat: add stable branch manager controls"
```

### Task 3: Verification and Runtime Build

**Files:**
- Modify: `D:\SillyTavern\ST_projects\.worktrees\persona-collapse\sortable-persona-layout\dist\index.js`
- Modify: `D:\SillyTavern\ST_projects\.worktrees\persona-collapse\sortable-persona-layout\dist\index.js.map`

- [ ] **Step 1: Run full tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 2: Run lint**

Run: `node_modules\.bin\eslint.cmd src tests`

Expected: exit code 0.

- [ ] **Step 3: Run production build**

Run: `pnpm run build`

Expected: webpack success and updated `dist/index.js`.

- [ ] **Step 4: Check working tree**

Run: `git status -sb`

Expected: only intended runtime build files changed, unless source files were not yet committed.

- [ ] **Step 5: Commit runtime build**

```bash
git add dist/index.js dist/index.js.map
git commit -m "chore: build stable branch manager"
```

- [ ] **Step 6: Push test branch**

```bash
git push
```

Expected: `codex/sortable-persona-layout` updates on GitHub.

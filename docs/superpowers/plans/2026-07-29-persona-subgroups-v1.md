# 人设分支一级分组 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有“人设分支”面板中加入一级可命名折叠组，同时保持分支、绑定、复制和发布分支语义兼容。

**Architecture:** `GroupManager` 继续作为唯一持久化状态入口，新增子组模型和纯状态操作；`renderVariantsPanel` 只消费 manager 给出的分区结果并绑定交互。测试集中验证迁移、唯一归属、复制落位和生命周期清理，UI 通过生产构建与浏览器检查验收。

**Tech Stack:** TypeScript、Vitest、SillyTavern Extension API、Webpack、CSS、PowerShell Compress-Archive

---

### Task 1: 设置迁移与只读分区模型

**Files:**
- Modify: `package.json`
- Modify: `src/manager.ts:7`
- Create: `tests/manager.subgroups.test.ts`

- [ ] **Step 1: 添加迁移与派生未分组的失败测试**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupManager, type GroupSettings } from '../src/manager';

const completeSettings = (overrides: Partial<GroupSettings> = {}): GroupSettings => ({
  enabled: true,
  manualGroups: { parent: ['a', 'b', 'c'] },
  collapsedParents: [],
  childMeta: {},
  groupNames: { parent: '旧标题' },
  excludedFromAuto: [],
  autoGroupByName: true,
  autoGroupByBinding: true,
  subgroups: {},
  ungroupedCollapsed: [],
  ...overrides,
});

describe('GroupManager subgroup migration', () => {
  beforeEach(() => vi.useFakeTimers());

  it('adds subgroup defaults without deleting legacy group names', () => {
    const save = vi.fn();
    const manager = new GroupManager({
      enabled: true,
      manualGroups: {},
      collapsedParents: [],
      childMeta: {},
      groupNames: { parent: '保留我' },
      excludedFromAuto: [],
      autoGroupByName: true,
      autoGroupByBinding: true,
    }, save);

    expect(manager.getSettings().subgroups).toEqual({});
    expect(manager.getSettings().ungroupedCollapsed).toEqual([]);
    expect(manager.getSettings().groupNames).toEqual({ parent: '保留我' });
    vi.runAllTimers();
    expect(save).toHaveBeenCalledOnce();
  });

  it('derives ungrouped members without duplicating grouped members', () => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b', 'missing'], collapsed: false }],
      },
    }), vi.fn());

    expect(manager.getSubgroupSections('parent', ['a', 'b', 'c'])).toEqual({
      groups: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      ungrouped: ['a', 'c'],
      ungroupedCollapsed: false,
    });
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.subgroups.test.ts`

Expected: FAIL，提示 `subgroups` / `getSubgroupSections` 尚不存在。

- [ ] **Step 3: 增加测试命令和最小模型实现**

在 `package.json` 的 `scripts` 中加入：

```json
"test": "vitest run"
```

在 `src/manager.ts` 中加入并接入构造函数默认值与迁移检测：

```ts
export interface PersonaSubgroup {
  id: string;
  name: string;
  personaIds: string[];
  collapsed: boolean;
}

export interface SubgroupSections {
  groups: PersonaSubgroup[];
  ungrouped: string[];
  ungroupedCollapsed: boolean;
}

export interface GroupSettings {
  enabled: boolean;
  manualGroups: Record<string, string[]>;
  collapsedParents: string[];
  childMeta: Record<string, ChildMeta>;
  groupNames: Record<string, string>;
  excludedFromAuto?: string[];
  autoGroupByName?: boolean;
  autoGroupByBinding?: boolean;
  subgroups: Record<string, PersonaSubgroup[]>;
  ungroupedCollapsed: string[];
}
```

```ts
subgroups: raw?.subgroups ?? {},
ungroupedCollapsed: raw?.ungroupedCollapsed ?? [],
```

迁移条件增加 `!raw.subgroups || !raw.ungroupedCollapsed`，并实现：

```ts
getSubgroupSections(parentId: string, effectiveChildren: string[]): SubgroupSections {
  const validIds = new Set(effectiveChildren);
  const claimed = new Set<string>();
  const groups = (this.settings.subgroups[parentId] || []).map(group => ({
    ...group,
    personaIds: group.personaIds.filter(id => {
      if (!validIds.has(id) || claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }),
  }));

  return {
    groups,
    ungrouped: effectiveChildren.filter(id => !claimed.has(id)),
    ungroupedCollapsed: this.settings.ungroupedCollapsed.includes(parentId),
  };
}
```

- [ ] **Step 4: 运行定向测试并确认 GREEN**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.subgroups.test.ts`

Expected: 2 tests PASS。

- [ ] **Step 5: 提交迁移与读取模型**

```bash
git add package.json src/manager.ts tests/manager.subgroups.test.ts
git commit -m "feat: add persona subgroup state model"
```

### Task 2: 子组增删改、折叠与唯一归属

**Files:**
- Modify: `src/manager.ts`
- Modify: `tests/manager.subgroups.test.ts`

- [ ] **Step 1: 添加状态操作失败测试**

```ts
describe('GroupManager subgroup operations', () => {
  it('creates, renames, folds and deletes a subgroup without changing branch links', () => {
    const save = vi.fn();
    const manager = new GroupManager(completeSettings(), save);
    const subgroup = manager.createSubgroup('parent', '  新分组  ');

    expect(subgroup.name).toBe('新分组');
    manager.renameSubgroup('parent', subgroup.id, '  温柔线  ');
    manager.setSubgroupCollapsed('parent', subgroup.id, true);
    manager.movePersonaToSubgroup('parent', 'b', subgroup.id, ['a', 'b', 'c']);
    manager.deleteSubgroup('parent', subgroup.id);

    expect(manager.getSettings().manualGroups.parent).toEqual(['a', 'b', 'c']);
    expect(manager.getSubgroupSections('parent', ['a', 'b', 'c']).ungrouped).toEqual(['a', 'b', 'c']);
    expect(save).toHaveBeenCalledTimes(5);
  });

  it('keeps one membership and follows effective branch order', () => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [
          { id: 'one', name: '一组', personaIds: ['c', 'a'], collapsed: false },
          { id: 'two', name: '二组', personaIds: ['a'], collapsed: false },
        ],
      },
    }), vi.fn());

    expect(manager.movePersonaToSubgroup('parent', 'b', 'one', ['a', 'b', 'c'])).toBe(true);
    expect(manager.movePersonaToSubgroup('parent', 'a', 'two', ['a', 'b', 'c'])).toBe(true);
    expect(manager.getSubgroupSections('parent', ['a', 'b', 'c']).groups).toEqual([
      { id: 'one', name: '一组', personaIds: ['b', 'c'], collapsed: false },
      { id: 'two', name: '二组', personaIds: ['a'], collapsed: false },
    ]);
  });

  it('stores the ungrouped fold state independently per parent', () => {
    const manager = new GroupManager(completeSettings(), vi.fn());
    manager.setUngroupedCollapsed('parent', true);
    expect(manager.getSubgroupSections('parent', ['a']).ungroupedCollapsed).toBe(true);
    manager.setUngroupedCollapsed('parent', false);
    expect(manager.getSettings().ungroupedCollapsed).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.subgroups.test.ts`

Expected: FAIL，提示 CRUD 与移动方法不存在。

- [ ] **Step 3: 实现最小状态操作 API**

在 `GroupManager` 中加入：

```ts
private createSubgroupId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `subgroup-${randomId}`;
}

createSubgroup(parentId: string, name = '新分组'): PersonaSubgroup {
  const subgroup: PersonaSubgroup = {
    id: this.createSubgroupId(),
    name: name.trim() || '新分组',
    personaIds: [],
    collapsed: false,
  };
  (this.settings.subgroups[parentId] ||= []).push(subgroup);
  this.saveCallback();
  return subgroup;
}

renameSubgroup(parentId: string, subgroupId: string, name: string): boolean {
  const subgroup = this.settings.subgroups[parentId]?.find(item => item.id === subgroupId);
  if (!subgroup) return false;
  subgroup.name = name.trim() || '新分组';
  this.saveCallback();
  return true;
}

setSubgroupCollapsed(parentId: string, subgroupId: string, collapsed: boolean): boolean {
  const subgroup = this.settings.subgroups[parentId]?.find(item => item.id === subgroupId);
  if (!subgroup) return false;
  subgroup.collapsed = collapsed;
  this.saveCallback();
  return true;
}

setUngroupedCollapsed(parentId: string, collapsed: boolean): void {
  this.settings.ungroupedCollapsed = this.settings.ungroupedCollapsed.filter(id => id !== parentId);
  if (collapsed) this.settings.ungroupedCollapsed.push(parentId);
  this.saveCallback();
}

deleteSubgroup(parentId: string, subgroupId: string): boolean {
  const groups = this.settings.subgroups[parentId];
  if (!groups) return false;
  const next = groups.filter(group => group.id !== subgroupId);
  if (next.length === groups.length) return false;
  if (next.length > 0) this.settings.subgroups[parentId] = next;
  else delete this.settings.subgroups[parentId];
  this.saveCallback();
  return true;
}

movePersonaToSubgroup(
  parentId: string,
  personaId: string,
  subgroupId: string | null,
  effectiveChildren: string[],
): boolean {
  if (!effectiveChildren.includes(personaId)) return false;
  const groups = this.settings.subgroups[parentId] || [];
  const target = subgroupId === null ? null : groups.find(group => group.id === subgroupId);
  if (subgroupId !== null && !target) return false;

  for (const group of groups) group.personaIds = group.personaIds.filter(id => id !== personaId);
  if (target) {
    target.personaIds.push(personaId);
    const order = new Map(effectiveChildren.map((id, index) => [id, index]));
    target.personaIds.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
  }
  this.saveCallback();
  return true;
}
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.subgroups.test.ts`

Expected: 5 tests PASS。

- [ ] **Step 5: 提交状态操作**

```bash
git add src/manager.ts tests/manager.subgroups.test.ts
git commit -m "feat: manage named persona subgroups"
```

### Task 3: 复制落位与生命周期清理

**Files:**
- Modify: `src/manager.ts`
- Modify: `tests/manager.subgroups.test.ts`

- [ ] **Step 1: 添加复制、解散、删除和主设提升失败测试**

```ts
describe('GroupManager subgroup lifecycle', () => {
  it('places a copy in the source subgroup and leaves ungrouped copies ungrouped', () => {
    const manager = new GroupManager(completeSettings({
      manualGroups: { parent: ['a', 'copy-a', 'b', 'copy-b'] },
      subgroups: {
        parent: [{ id: 'one', name: '一组', personaIds: ['a'], collapsed: false }],
      },
    }), vi.fn());

    manager.placeCopyInSourceSubgroup('parent', 'a', 'copy-a');
    manager.placeCopyInSourceSubgroup('parent', 'b', 'copy-b');
    expect(manager.getSettings().subgroups.parent[0].personaIds).toEqual(['a', 'copy-a']);
    expect(manager.getSubgroupSections('parent', ['a', 'copy-a', 'b', 'copy-b']).ungrouped).toEqual(['b', 'copy-b']);
  });

  it('cleans deleted personas and removes subgroup state when a branch disappears', () => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'one', name: '一组', personaIds: ['a', 'missing'], collapsed: true }],
      },
      ungroupedCollapsed: ['parent'],
    }), vi.fn());

    manager.cleanupDeletedPersonas(['parent', 'a', 'b', 'c']);
    expect(manager.getSettings().subgroups.parent[0].personaIds).toEqual(['a']);
    manager.disbandGroup('parent');
    expect(manager.getSettings().subgroups.parent).toBeUndefined();
    expect(manager.getSettings().ungroupedCollapsed).toEqual([]);
  });

  it('moves subgroup state to a promoted parent and leaves the former parent ungrouped', () => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'one', name: '一组', personaIds: ['a', 'b'], collapsed: false }],
      },
      ungroupedCollapsed: ['parent'],
    }), vi.fn());

    manager.promoteToParent('parent', 'a');
    expect(manager.getSettings().subgroups.a[0].personaIds).toEqual(['b']);
    expect(manager.getSettings().subgroups.parent).toBeUndefined();
    expect(manager.getSettings().ungroupedCollapsed).toEqual(['a']);
    expect(manager.getSubgroupSections('a', ['parent', 'b', 'c']).ungrouped).toContain('parent');
  });

  it('removes subgroup state when unlinking the final branch member', () => {
    const manager = new GroupManager(completeSettings({
      manualGroups: { parent: ['a'] },
      subgroups: {
        parent: [{ id: 'one', name: '一组', personaIds: ['a'], collapsed: false }],
      },
      ungroupedCollapsed: ['parent'],
    }), vi.fn());

    manager.unlinkChild('a');
    expect(manager.getSettings().subgroups.parent).toBeUndefined();
    expect(manager.getSettings().ungroupedCollapsed).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.subgroups.test.ts`

Expected: FAIL，复制落位不存在，生命周期方法尚未迁移子组状态。

- [ ] **Step 3: 实现复制落位和内部清理辅助方法**

在 `GroupManager` 中加入：

```ts
private removePersonaFromSubgroups(personaId: string, parentId?: string): boolean {
  let changed = false;
  const entries = parentId
    ? [[parentId, this.settings.subgroups[parentId] || []] as const]
    : Object.entries(this.settings.subgroups);
  for (const [, groups] of entries) {
    for (const group of groups) {
      const next = group.personaIds.filter(id => id !== personaId);
      if (next.length !== group.personaIds.length) {
        group.personaIds = next;
        changed = true;
      }
    }
  }
  return changed;
}

private clearSubgroupState(parentId: string): boolean {
  const hadGroups = this.settings.subgroups[parentId] !== undefined;
  delete this.settings.subgroups[parentId];
  const before = this.settings.ungroupedCollapsed.length;
  this.settings.ungroupedCollapsed = this.settings.ungroupedCollapsed.filter(id => id !== parentId);
  return hadGroups || before !== this.settings.ungroupedCollapsed.length;
}

placeCopyInSourceSubgroup(parentId: string, sourceId: string, copyId: string): void {
  this.removePersonaFromSubgroups(copyId, parentId);
  const sourceGroup = this.settings.subgroups[parentId]?.find(group => group.personaIds.includes(sourceId));
  if (sourceGroup) {
    const sourceIndex = sourceGroup.personaIds.indexOf(sourceId);
    sourceGroup.personaIds.splice(sourceIndex + 1, 0, copyId);
    this.saveCallback();
  }
}
```

随后在现有方法中接入：

```ts
// unlinkChild: 从分支移除 childId 时
if (this.removePersonaFromSubgroups(childId)) changed = true;

// linkChild / unlinkChild / cleanupDeletedPersonas 中删除空的 manualGroups[parentId] 时
this.clearSubgroupState(parentId);

// _disbandGroupInternal 和 disbandGroup: 分支消失时
this.clearSubgroupState(parentId);

// promoteToParent: 迁移键并移除新主设自身
const promotedSubgroups = this.settings.subgroups[oldParentId];
if (promotedSubgroups) {
  this.settings.subgroups[newParentId] = promotedSubgroups;
  delete this.settings.subgroups[oldParentId];
  this.removePersonaFromSubgroups(newParentId, newParentId);
}
const wasUngroupedCollapsed = this.settings.ungroupedCollapsed.includes(oldParentId);
this.settings.ungroupedCollapsed = this.settings.ungroupedCollapsed.filter(id => id !== oldParentId);
if (wasUngroupedCollapsed) this.settings.ungroupedCollapsed.push(newParentId);

// cleanupDeletedPersonas: 清理不存在的父 ID 与成员 ID
for (const parentId of Object.keys(this.settings.subgroups)) {
  if (!existing.has(parentId)) {
    if (this.clearSubgroupState(parentId)) changed = true;
    continue;
  }
  for (const group of this.settings.subgroups[parentId]) {
    const next = group.personaIds.filter(id => existing.has(id));
    if (next.length !== group.personaIds.length) {
      group.personaIds = next;
      changed = true;
    }
  }
}
```

- [ ] **Step 4: 运行全部 manager 测试并确认 GREEN**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.subgroups.test.ts`

Expected: 9 tests PASS。

- [ ] **Step 5: 提交生命周期兼容**

```bash
git add src/manager.ts tests/manager.subgroups.test.ts
git commit -m "feat: preserve subgroups across persona lifecycle"
```

### Task 4: 接入人设分支面板 UI

**Files:**
- Modify: `src/index.ts:75`
- Modify: `src/index.ts:386`
- Modify: `src/index.ts:448`
- Modify: `style.css:125`

- [ ] **Step 1: 添加 UI 所需状态断言测试**

在 `tests/manager.subgroups.test.ts` 增加：

```ts
it('rejects cross-section reorder and reorders within one section', () => {
  const manager = new GroupManager(completeSettings({
    subgroups: {
      parent: [{ id: 'one', name: '一组', personaIds: ['a', 'b'], collapsed: false }],
    },
  }), vi.fn());

  expect(manager.reorderWithinSubgroup('parent', 'a', 'b')).toBe(true);
  expect(manager.getSettings().subgroups.parent[0].personaIds).toEqual(['b', 'a']);
  expect(manager.canReorderWithinSection('parent', 'a', 'c')).toBe(false);
  expect(manager.canReorderWithinSection('parent', 'c', 'b')).toBe(false);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.subgroups.test.ts`

Expected: FAIL，提示同区拖拽辅助方法不存在。

- [ ] **Step 3: 实现拖拽边界 API**

```ts
private subgroupIdFor(parentId: string, personaId: string): string | null {
  return this.settings.subgroups[parentId]?.find(group => group.personaIds.includes(personaId))?.id ?? null;
}

canReorderWithinSection(parentId: string, sourceId: string, targetId: string): boolean {
  return this.subgroupIdFor(parentId, sourceId) === this.subgroupIdFor(parentId, targetId);
}

reorderWithinSubgroup(parentId: string, sourceId: string, targetId: string): boolean {
  const subgroupId = this.subgroupIdFor(parentId, sourceId);
  if (!subgroupId || subgroupId !== this.subgroupIdFor(parentId, targetId)) return false;
  const group = this.settings.subgroups[parentId].find(item => item.id === subgroupId)!;
  const sourceIndex = group.personaIds.indexOf(sourceId);
  const targetIndex = group.personaIds.indexOf(targetId);
  group.personaIds.splice(sourceIndex, 1);
  group.personaIds.splice(targetIndex, 0, sourceId);
  this.saveCallback();
  return true;
}
```

- [ ] **Step 4: 将面板标题固定并渲染分区**

删除 `getDisplayGroupTitle`、`editingGroupNameParentId` 和 `cp2-edit-group-title` 的全部事件代码；`groupNames` 仅保留在设置中用于回退兼容。面板缓存键改为：

```ts
const sections = manager.getSubgroupSections(parentId, children);
const groupKey = `${parentId}:${children.join(',')}:${JSON.stringify(sections)}`;
```

在面板状态旁声明 `let editingSubgroupId: string | null = null;`，并为新增文案使用带中文回退的翻译辅助函数：

```ts
function tUi(key: string, fallback: string): string {
  const translate = (globalThis as any).i18next?.t;
  if (typeof translate !== 'function') return fallback;
  const translated = translate(key, { defaultValue: fallback });
  return typeof translated === 'string' ? translated : fallback;
}
```

标题固定为：

```html
<span class="cp2-variants-header-title">🎭 人设分支 (${allMembers.length})</span>
<button class="cp2-icon-btn" id="cp2-create-subgroup" title="新建分组" aria-label="新建分组">
  <i class="fa-solid fa-folder-plus"></i>
</button>
```

创建组后调用 `manager.createSubgroup(parentId)`，保存新组 ID 到 `editingSubgroupId`，强制重绘并聚焦组名输入框。主设行先单独渲染；随后按 `sections.groups` 渲染 `.cp2-subgroup`，每个标题使用 `button` 折叠、铅笔内联编辑；最后按规则渲染“未分组”。所有组名进入模板前调用 `escapeHtml`。

垃圾桶按钮使用现有 Popup 确认样式，并且只删除组结构：

```ts
const content = `<p>${escapeHtml(tUi('personaCollapse.deleteSubgroupConfirm', `删除“${group.name}”分组？其中人设将移回未分组。`))}</p>`;
new Popup(content, POPUP_TYPE.CONFIRM, '', {
  okButton: tUi('personaCollapse.delete', '删除'),
  cancelButton: tUi('personaCollapse.cancel', '取消'),
  onOk: () => {
    manager.deleteSubgroup(parentId, group.id);
    if (editingSubgroupId === group.id) editingSubgroupId = null;
    renderVariantsPanel(true);
  },
}).show();
```

每个非主设成员的 actions 中加入原生菜单：

```ts
const moveSelect = document.createElement('select');
moveSelect.className = 'cp2-subgroup-select';
moveSelect.title = tUi('personaCollapse.moveToSubgroup', '移动到分组');
moveSelect.setAttribute('aria-label', tUi('personaCollapse.moveToSubgroup', '移动到分组'));
moveSelect.innerHTML = [
  `<option value="">${escapeHtml(tUi('personaCollapse.ungrouped', '未分组'))}</option>`,
  ...sections.groups.map(group =>
    `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`),
].join('');
moveSelect.value = sections.groups.find(group => group.personaIds.includes(memberId))?.id || '';
moveSelect.addEventListener('click', event => event.stopPropagation());
moveSelect.addEventListener('change', event => {
  event.stopPropagation();
  manager.movePersonaToSubgroup(parentId, memberId, moveSelect.value || null, children);
  renderVariantsPanel(true);
});
actions.appendChild(moveSelect);
```

复制成功并执行 `manager.linkChildAfter(parentId, avatarId, sourceId)` 后，追加：

```ts
manager.placeCopyInSourceSubgroup(parentId, sourceId, avatarId);
```

拖拽 drop 事件先调用 `manager.canReorderWithinSection`；命名组内同时调用 `reorderWithinSubgroup`，未分组内继续调用现有 `reorderChild`。跨区 drop 直接清理样式并返回。

- [ ] **Step 5: 增加紧凑响应式样式**

在 `style.css` 增加：

```css
.cp2-subgroup,
.cp2-ungrouped {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cp2-subgroup-header {
  min-height: 30px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-bottom: 1px solid var(--SmartThemeBorderColor);
}
.cp2-subgroup-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp2-subgroup-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 12px;
}
.cp2-subgroup-select {
  width: 88px;
  min-width: 0;
  height: 26px;
  color: var(--SmartThemeBodyColor);
  background: var(--black30a);
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 4px;
  text-overflow: ellipsis;
}
.cp2-subgroup-empty {
  padding: 6px 12px;
  opacity: 0.55;
  font-size: 0.8em;
}
@media (max-width: 520px) {
  .cp2-subgroup-select { width: 32px; }
  .cp2-variant-actions { gap: 2px; margin-left: 4px; }
}
```

- [ ] **Step 6: 运行测试与生产构建**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.subgroups.test.ts`

Expected: 10 tests PASS。

Run: `node node_modules/webpack-cli/bin/cli.js --mode production`

Expected: Webpack completes successfully and updates `dist/index.js` / `dist/index.js.map`。

- [ ] **Step 7: 手动检查面板**

在 SillyTavern 桌面宽度和约 390px 窄屏下确认：固定标题、主设、命名组、未分组、折叠、改名、删除、菜单、复制落位均正确；按钮和文本不重叠，组名 `<script>` 仅作为文本显示。

- [ ] **Step 8: 提交 UI 与构建产物**

```bash
git add src/index.ts style.css dist/index.js dist/index.js.map tests/manager.subgroups.test.ts
git commit -m "feat: add foldable persona subgroup UI"
```

### Task 5: 版本、发布包与双分支交付

**Files:**
- Modify: `manifest.json`
- Modify: `README.md`
- Modify: `releases/persona-collapse.zip`
- Verify: `pack.mjs`

- [ ] **Step 1: 更新版本与用户文档**

将 `manifest.json` 的版本从 `3.0.0` 提升到 `3.1.0`。在 README 功能列表增加“人设分支一级命名折叠组”，并明确“复制完整人设但不复制角色/聊天/群组绑定”。

- [ ] **Step 2: 运行完整定向验证**

Run: `node node_modules/vitest/vitest.mjs run`

Expected: 全部新增测试 PASS。

Run: `node node_modules/webpack-cli/bin/cli.js --mode production`

Expected: Webpack production build succeeds。

Run: `node pack.mjs`

Expected: 生成 `releases/persona-collapse.zip`。

- [ ] **Step 3: 校验压缩包只含运行文件**

Run:

```powershell
tar -tf releases/persona-collapse.zip
```

Expected exactly:

```text
persona-collapse/manifest.json
persona-collapse/dist/index.js
persona-collapse/style.css
```

- [ ] **Step 4: 提交 source 功能分支最终版本**

```bash
git add manifest.json README.md dist/index.js dist/index.js.map style.css releases/persona-collapse.zip
git commit -m "release: prepare persona collapse 3.1.0"
```

- [ ] **Step 5: 合入并推送 source**

在干净的 `source` 工作树中以 `--no-ff` 合并 `codex/persona-subgroups-v1`，再次运行测试、构建和压缩包内容校验，然后推送 `origin/source`。保留功能分支和合并提交作为双重回退点。

- [ ] **Step 6: 从 source 构建 main 纯发布提交**

在独立 `main` 发布工作树中只同步以下文件：

```text
manifest.json
dist/index.js
style.css
README.md
LICENSE
```

确认 `main` 不含 `src/`、`tests/`、源码映射、依赖、构建配置和 release zip，提交 `release: publish persona collapse 3.1.0` 后推送 `origin/main`。

- [ ] **Step 7: 最终远端核验**

确认 GitHub `source` 包含源码、测试和规格，`main` 只包含运行安装所需文件；记录两条远端提交 ID 和 `releases/persona-collapse.zip` 的 SHA-256，供回退与导入测试。

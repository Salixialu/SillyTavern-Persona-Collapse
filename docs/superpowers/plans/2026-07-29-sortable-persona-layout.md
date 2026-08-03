# 人设分支混合拖拽布局 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 SortableJS 实现人设、具名分组和组内成员的流畅混合拖拽，并让顶层第一位人设成为可动态更换的左侧列表入口。

**Architecture:** `GroupManager` 是布局状态的唯一写入口，负责旧数据推导、完整快照校验、入口迁移和一次保存；新增 `src/branch-sortable.ts` 管理 SortableJS 生命周期、DOM 快照和拖动态；`renderVariantsPanel` 只根据 manager 的布局结果生成带稳定数据属性的 DOM。旧 `manualGroups` 与 `subgroups` 继续保留，新增 `branchLayouts` 只记录顶层人设与分组的混合顺序。

**Tech Stack:** TypeScript、SortableJS、Vitest、SillyTavern Extension API、Webpack、CSS、PowerShell Compress-Archive

---

## 文件职责

- `src/manager.ts`：布局类型、旧数据推导、快照校验、入口迁移、生命周期清理。
- `src/branch-sortable.ts`：SortableJS 实例、DOM 布局读取、拖放限制、折叠组悬停展开、销毁函数。
- `src/index.ts`：面板 DOM 渲染、入口更新后的左侧列表刷新、折叠与操作按钮事件。
- `style.css`：混合布局、分组层级、折叠动画和 Sortable 状态。
- `tests/manager.layout.test.ts`：布局模型、快照事务、入口迁移和生命周期测试。
- `tests/panel-rendering.test.ts`：移除旧控件并接入新 DOM 契约。
- `README.md`、`manifest.json`、`dist/index.js`、`releases/persona-collapse.zip`：3.2.0 发布说明与产物。

---

### Task 0: 准备隔离工作树并确认基线

**Files:**
- No source changes

- [ ] **Step 1: 确认当前分支与工作树干净**

Run: `git status --short`

Run: `git branch --show-current`

Expected: 状态为空，分支为 `codex/sortable-persona-layout`。

- [ ] **Step 2: 复用已安装依赖**

若当前工作树没有 `node_modules`，在 PowerShell 执行：

```powershell
New-Item -ItemType Junction `
  -Path node_modules `
  -Target 'D:\SillyTavern\ST_projects\1-项目开发(Projects)\开发中(Active)\persona-collapse\node_modules'
```

Expected: `Test-Path node_modules\vitest\vitest.mjs` 返回 `True`。

- [ ] **Step 3: 运行 3.1.1 基线测试**

Run: `node node_modules/vitest/vitest.mjs run`

Expected: 2 个测试文件、13 个测试全部 PASS。

---

### Task 1: 建立布局类型与旧数据推导

**Files:**
- Modify: `src/manager.ts:7-105`
- Create: `tests/manager.layout.test.ts`
- Modify: `tests/manager.subgroups.test.ts:4-17`

- [ ] **Step 1: 为测试设置补齐 `branchLayouts`**

在 `tests/manager.subgroups.test.ts` 的 `completeSettings` 中加入：

```ts
branchLayouts: {},
```

- [ ] **Step 2: 写布局迁移与推导失败测试**

创建 `tests/manager.layout.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupManager, type GroupSettings } from '../src/manager';

const settings = (overrides: Partial<GroupSettings> = {}): GroupSettings => ({
  enabled: true,
  manualGroups: { parent: ['a', 'b', 'c'] },
  collapsedParents: [],
  childMeta: {},
  groupNames: { parent: '人设分支' },
  excludedFromAuto: [],
  autoGroupByName: true,
  autoGroupByBinding: true,
  subgroups: {
    parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
  },
  ungroupedCollapsed: [],
  branchLayouts: {},
  ...overrides,
});

describe('GroupManager branch layout migration', () => {
  beforeEach(() => vi.useFakeTimers());

  it('adds an empty layout map to legacy settings', () => {
    const save = vi.fn();
    const legacy = settings();
    delete (legacy as Partial<GroupSettings>).branchLayouts;
    const manager = new GroupManager(legacy, save);

    expect(manager.getSettings().branchLayouts).toEqual({});
    vi.runAllTimers();
    expect(save).toHaveBeenCalledOnce();
  });

  it('derives entry, root personas, then named groups without persisting', () => {
    const save = vi.fn();
    const manager = new GroupManager(settings(), save);

    expect(manager.getBranchLayout('parent', ['a', 'b', 'c'])).toEqual([
      { type: 'persona', id: 'parent' },
      { type: 'persona', id: 'a' },
      { type: 'persona', id: 'c' },
      { type: 'subgroup', id: 'warm' },
    ]);
    expect(manager.getSettings().branchLayouts).toEqual({});
    expect(save).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.layout.test.ts`

Expected: FAIL，提示 `branchLayouts` 与 `getBranchLayout` 不存在。

- [ ] **Step 4: 增加布局类型、默认值与只读推导**

在 `src/manager.ts` 增加：

```ts
export type BranchLayoutItem =
  | { type: 'persona'; id: string }
  | { type: 'subgroup'; id: string };

export interface BranchLayoutSnapshot {
  root: BranchLayoutItem[];
  subgroupMembers: Record<string, string[]>;
}
```

在 `GroupSettings` 中增加：

```ts
branchLayouts: Record<string, BranchLayoutItem[]>;
```

构造函数默认值和迁移检测分别增加：

```ts
branchLayouts: raw?.branchLayouts ?? {},
```

```ts
!raw.branchLayouts
```

实现只读推导：

```ts
getBranchLayout(parentId: string, effectiveChildren: string[]): BranchLayoutItem[] {
  const sections = this.getSubgroupSections(parentId, effectiveChildren);
  const validRootPersonas = new Set([parentId, ...sections.ungrouped]);
  const validGroups = new Set(sections.groups.map(group => group.id));
  const stored = this.settings.branchLayouts[parentId];

  if (stored) {
    const seenPersonas = new Set<string>();
    const seenGroups = new Set<string>();
    const clean = stored.filter(item => {
      if (item.type === 'persona') {
        if (!validRootPersonas.has(item.id) || seenPersonas.has(item.id)) return false;
        seenPersonas.add(item.id);
        return true;
      }
      if (!validGroups.has(item.id) || seenGroups.has(item.id)) return false;
      seenGroups.add(item.id);
      return true;
    });
    if (
      clean[0]?.type === 'persona'
      && clean[0].id === parentId
      && seenPersonas.size === validRootPersonas.size
      && seenGroups.size === validGroups.size
    ) return clean;
  }

  return [
    { type: 'persona', id: parentId },
    ...sections.ungrouped.map(id => ({ type: 'persona' as const, id })),
    ...sections.groups.map(group => ({ type: 'subgroup' as const, id: group.id })),
  ];
}
```

- [ ] **Step 5: 运行布局与既有测试**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.layout.test.ts tests/manager.subgroups.test.ts`

Expected: 全部 PASS。

- [ ] **Step 6: 提交布局读取模型**

```bash
git add src/manager.ts tests/manager.layout.test.ts tests/manager.subgroups.test.ts
git commit -m "feat: add mixed branch layout model"
```

---

### Task 2: 原子应用快照并动态迁移入口

**Files:**
- Modify: `src/manager.ts`
- Modify: `tests/manager.layout.test.ts`

- [ ] **Step 1: 写有效快照和入口迁移失败测试**

```ts
describe('GroupManager branch layout snapshots', () => {
  it('moves personas across sections and rekeys the branch once', () => {
    const save = vi.fn();
    const manager = new GroupManager(settings(), save);

    const newEntry = manager.applyBranchLayoutSnapshot('parent', {
      root: [
        { type: 'persona', id: 'b' },
        { type: 'subgroup', id: 'warm' },
        { type: 'persona', id: 'parent' },
      ],
      subgroupMembers: { warm: ['a', 'c'] },
    }, ['a', 'b', 'c']);

    expect(newEntry).toBe('b');
    expect(manager.getSettings().manualGroups).toEqual({ b: ['a', 'c', 'parent'] });
    expect(manager.getSettings().subgroups.b[0].personaIds).toEqual(['a', 'c']);
    expect(manager.getSettings().branchLayouts.b).toEqual([
      { type: 'persona', id: 'b' },
      { type: 'subgroup', id: 'warm' },
      { type: 'persona', id: 'parent' },
    ]);
    expect(manager.getSettings().manualGroups.parent).toBeUndefined();
    expect(manager.getSettings().subgroups.parent).toBeUndefined();
    expect(save).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 写无效快照原子拒绝测试**

```ts
it.each([
  {
    name: '分组占据第一位',
    snapshot: {
      root: [{ type: 'subgroup' as const, id: 'warm' }, { type: 'persona' as const, id: 'parent' }],
      subgroupMembers: { warm: ['a', 'b', 'c'] },
    },
  },
  {
    name: '人设重复出现',
    snapshot: {
      root: [{ type: 'persona' as const, id: 'parent' }, { type: 'persona' as const, id: 'a' }, { type: 'subgroup' as const, id: 'warm' }],
      subgroupMembers: { warm: ['a', 'b', 'c'] },
    },
  },
  {
    name: '遗漏成员',
    snapshot: {
      root: [{ type: 'persona' as const, id: 'parent' }, { type: 'subgroup' as const, id: 'warm' }],
      subgroupMembers: { warm: ['b'] },
    },
  },
])('rejects $name without saving', ({ snapshot }) => {
  const save = vi.fn();
  const manager = new GroupManager(settings(), save);
  const before = structuredClone(manager.getSettings());

  expect(manager.applyBranchLayoutSnapshot('parent', snapshot, ['a', 'b', 'c'])).toBeNull();
  expect(manager.getSettings()).toEqual(before);
  expect(save).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.layout.test.ts`

Expected: FAIL，提示 `applyBranchLayoutSnapshot` 不存在。

- [ ] **Step 4: 实现完整校验与单次提交**

在 `GroupManager` 中实现：

```ts
applyBranchLayoutSnapshot(
  parentId: string,
  snapshot: BranchLayoutSnapshot,
  effectiveChildren: string[],
): string | null {
  const validPersonas = new Set([parentId, ...effectiveChildren]);
  const groups = this.settings.subgroups[parentId] || [];
  const validGroups = new Set(groups.map(group => group.id));
  const seenPersonas = new Set<string>();
  const seenGroups = new Set<string>();

  if (snapshot.root[0]?.type !== 'persona') return null;

  for (const item of snapshot.root) {
    if (item.type === 'persona') {
      if (!validPersonas.has(item.id) || seenPersonas.has(item.id)) return null;
      seenPersonas.add(item.id);
    } else {
      if (!validGroups.has(item.id) || seenGroups.has(item.id)) return null;
      seenGroups.add(item.id);
    }
  }

  for (const group of groups) {
    const members = snapshot.subgroupMembers[group.id];
    if (!members || !seenGroups.has(group.id)) return null;
    for (const personaId of members) {
      if (!validPersonas.has(personaId) || seenPersonas.has(personaId)) return null;
      seenPersonas.add(personaId);
    }
  }

  if (seenPersonas.size !== validPersonas.size || seenGroups.size !== validGroups.size) return null;

  const newParentId = snapshot.root[0].id;
  const nextGroups = groups.map(group => ({
    ...group,
    personaIds: [...snapshot.subgroupMembers[group.id]],
  }));
  const membersByGroup = new Map(nextGroups.map(group => [group.id, group.personaIds]));
  const flattened = snapshot.root.flatMap(item =>
    item.type === 'persona' ? [item.id] : (membersByGroup.get(item.id) || []));
  const oldName = this.settings.groupNames[parentId];
  const wasCollapsed = this.settings.collapsedParents.includes(parentId);
  const wasUngroupedCollapsed = this.settings.ungroupedCollapsed.includes(parentId);

  delete this.settings.manualGroups[parentId];
  delete this.settings.groupNames[parentId];
  delete this.settings.subgroups[parentId];
  delete this.settings.branchLayouts[parentId];
  this.settings.collapsedParents = this.settings.collapsedParents.filter(id => id !== parentId);
  this.settings.ungroupedCollapsed = this.settings.ungroupedCollapsed.filter(id => id !== parentId);

  this.settings.manualGroups[newParentId] = flattened.filter(id => id !== newParentId);
  if (oldName) this.settings.groupNames[newParentId] = oldName;
  if (nextGroups.length > 0) this.settings.subgroups[newParentId] = nextGroups;
  this.settings.branchLayouts[newParentId] = structuredClone(snapshot.root);
  if (wasCollapsed) this.settings.collapsedParents.push(newParentId);
  if (wasUngroupedCollapsed) this.settings.ungroupedCollapsed.push(newParentId);

  this._effectiveCache = null;
  this.saveCallback();
  return newParentId;
}
```

实现时先完成全部校验再修改 `settings`，不得在校验循环中写状态。

- [ ] **Step 5: 运行布局测试并确认 GREEN**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.layout.test.ts`

Expected: 全部 PASS，入口迁移只保存一次。

- [ ] **Step 6: 提交快照事务**

```bash
git add src/manager.ts tests/manager.layout.test.ts
git commit -m "feat: apply branch layouts atomically"
```

---

### Task 3: 让分组与人设生命周期维护混合布局

**Files:**
- Modify: `src/manager.ts`
- Modify: `tests/manager.layout.test.ts`
- Modify: `tests/manager.subgroups.test.ts`

- [ ] **Step 1: 写新建与删除分组位置测试**

```ts
it('appends a new subgroup and expands deleted members in place', () => {
  const manager = new GroupManager(settings({
    branchLayouts: {
      parent: [
        { type: 'persona', id: 'parent' },
        { type: 'subgroup', id: 'warm' },
        { type: 'persona', id: 'a' },
        { type: 'persona', id: 'c' },
      ],
    },
  }), vi.fn());

  const created = manager.createSubgroup('parent', '新组', ['a', 'b', 'c']);
  expect(manager.getSettings().branchLayouts.parent.at(-1)).toEqual({ type: 'subgroup', id: created.id });

  manager.deleteSubgroup('parent', 'warm', ['a', 'b', 'c']);
  expect(manager.getSettings().branchLayouts.parent.slice(0, 4)).toEqual([
    { type: 'persona', id: 'parent' },
    { type: 'persona', id: 'b' },
    { type: 'persona', id: 'a' },
    { type: 'persona', id: 'c' },
  ]);
});
```

- [ ] **Step 2: 写复制、清理和重置测试**

```ts
it('places copies beside their source in root or subgroup layouts', () => {
  const manager = new GroupManager(settings({
    manualGroups: { parent: ['a', 'copy-a', 'b', 'copy-b', 'c'] },
    branchLayouts: {
      parent: [
        { type: 'persona', id: 'parent' },
        { type: 'persona', id: 'a' },
        { type: 'subgroup', id: 'warm' },
        { type: 'persona', id: 'c' },
      ],
    },
  }), vi.fn());

  manager.placeCopyInSourceSubgroup('parent', 'a', 'copy-a');
  manager.placeCopyInSourceSubgroup('parent', 'b', 'copy-b');
  expect(manager.getSettings().branchLayouts.parent.slice(1, 3).map(item => item.id)).toEqual(['a', 'copy-a']);
  expect(manager.getSettings().subgroups.parent[0].personaIds).toEqual(['b', 'copy-b']);
});

it('clears layout state on reset', () => {
  const manager = new GroupManager(settings({
    branchLayouts: { parent: [{ type: 'persona', id: 'parent' }] },
  }), vi.fn());
  manager.resetGroupingState();
  expect(manager.getSettings().branchLayouts).toEqual({});
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.layout.test.ts tests/manager.subgroups.test.ts`

Expected: FAIL，显示布局未随生命周期变化。

- [ ] **Step 4: 扩展生命周期方法**

按以下签名调整 manager 方法：

```ts
createSubgroup(parentId: string, name = '新分组', effectiveChildren: string[] = []): PersonaSubgroup
deleteSubgroup(parentId: string, subgroupId: string, effectiveChildren: string[] = []): boolean
```

实现一个内部保证函数：

```ts
private ensureBranchLayout(parentId: string, effectiveChildren: string[]): BranchLayoutItem[] {
  return (this.settings.branchLayouts[parentId] ||= this.getBranchLayout(parentId, effectiveChildren));
}
```

并落实以下规则：

```ts
// createSubgroup: 创建数据后追加分组节点
this.ensureBranchLayout(parentId, effectiveChildren).push({ type: 'subgroup', id: subgroup.id });

// deleteSubgroup: 用原成员替换原分组节点
const layout = this.ensureBranchLayout(parentId, effectiveChildren);
const layoutIndex = layout.findIndex(item => item.type === 'subgroup' && item.id === subgroupId);
if (layoutIndex >= 0) {
  layout.splice(layoutIndex, 1, ...deleted.personaIds.map(id => ({ type: 'persona' as const, id })));
}
```

同时更新：

- `placeCopyInSourceSubgroup`：组内副本插在源后；顶层副本在布局中插在源后。
- `removePersonaFromSubgroups` 的调用方：同步删除布局中的 persona 节点。
- `clearSubgroupState`：删除 `branchLayouts[parentId]`。
- `promoteToParent`：迁移 `branchLayouts` 并保证第一项为新入口。
- `cleanupDeletedPersonas`：清理失效 persona 与 subgroup 节点。
- `resetGroupingState`：设置 `branchLayouts = {}`。

- [ ] **Step 5: 运行全部 manager 测试**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.layout.test.ts tests/manager.subgroups.test.ts`

Expected: 全部 PASS。

- [ ] **Step 6: 提交生命周期兼容**

```bash
git add src/manager.ts tests/manager.layout.test.ts tests/manager.subgroups.test.ts
git commit -m "feat: preserve layouts through branch lifecycle"
```

---

### Task 4: 引入 SortableJS 并建立独立拖拽控制器

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/branch-sortable.ts`

- [ ] **Step 1: 安装最小直接依赖**

Run:

```bash
pnpm add sortablejs
pnpm add -D @types/sortablejs
```

Expected: `package.json` 出现 `sortablejs` 与 `@types/sortablejs`，锁文件只发生依赖解析变化。

- [ ] **Step 2: 创建 DOM 快照和控制器接口**

创建 `src/branch-sortable.ts`：

```ts
import Sortable, { type MoveEvent, type SortableEvent } from 'sortablejs';
import type { BranchLayoutItem, BranchLayoutSnapshot } from './manager';

export interface BranchSortableOptions {
  root: HTMLElement;
  onCommit: (snapshot: BranchLayoutSnapshot) => boolean;
  onExpandSubgroup: (subgroupId: string, section: HTMLElement) => void;
  onDragStateChange: (active: boolean) => void;
}

export function readBranchLayoutSnapshot(root: HTMLElement): BranchLayoutSnapshot {
  const rootItems: BranchLayoutItem[] = [];
  const subgroupMembers: Record<string, string[]> = {};

  for (const element of Array.from(root.querySelectorAll<HTMLElement>(':scope > .cp2-root-item'))) {
    if (element.dataset.layoutType === 'persona' && element.dataset.personaId) {
      rootItems.push({ type: 'persona', id: element.dataset.personaId });
      continue;
    }
    if (element.dataset.layoutType === 'subgroup' && element.dataset.subgroupId) {
      rootItems.push({ type: 'subgroup', id: element.dataset.subgroupId });
      subgroupMembers[element.dataset.subgroupId] = Array.from(
        element.querySelectorAll<HTMLElement>(':scope > .cp2-subgroup-body > .cp2-subgroup-items > .cp2-persona-sort-item'),
      ).map(item => item.dataset.personaId).filter((id): id is string => Boolean(id));
    }
  }

  return { root: rootItems, subgroupMembers };
}
```

- [ ] **Step 3: 实现 Sortable 实例与约束**

在同一文件实现：

```ts
export function mountBranchSortables(options: BranchSortableOptions): () => void {
  const instances: Sortable[] = [];
  let expandTimer: ReturnType<typeof setTimeout> | null = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const clearExpandTimer = () => {
    if (expandTimer) clearTimeout(expandTimer);
    expandTimer = null;
  };

  const finish = (_event: SortableEvent) => {
    clearExpandTimer();
    options.onDragStateChange(false);
    const accepted = options.onCommit(readBranchLayoutSnapshot(options.root));
    if (!accepted) options.root.dispatchEvent(new CustomEvent('cp2:layout-rejected'));
  };

  const canMove = (event: MoveEvent): boolean => {
    const dragged = event.dragged as HTMLElement;
    const target = event.to as HTMLElement;
    const isSubgroup = dragged.dataset.layoutType === 'subgroup';
    const firstRootPersona = options.root.querySelector<HTMLElement>(
      ':scope > .cp2-root-item[data-layout-type="persona"]',
    );
    if (isSubgroup && target !== options.root) return false;
    if (dragged === firstRootPersona && target !== options.root) return false;
    if (target === options.root && event.willInsertAfter === false && event.related === options.root.firstElementChild) {
      return dragged.dataset.layoutType === 'persona';
    }
    return true;
  };

  const common: Sortable.Options = {
    group: { name: 'cp2-branch-layout', pull: true, put: true },
    handle: '.cp2-sort-handle',
    animation: reducedMotion ? 0 : 150,
    forceFallback: true,
    fallbackOnBody: true,
    scroll: true,
    emptyInsertThreshold: 18,
    ghostClass: 'cp2-sort-ghost',
    chosenClass: 'cp2-sort-chosen',
    dragClass: 'cp2-sort-drag',
    onStart: () => options.onDragStateChange(true),
    onMove: canMove,
    onEnd: finish,
  };

  instances.push(new Sortable(options.root, {
    ...common,
    draggable: '.cp2-root-item',
  }));

  for (const container of options.root.querySelectorAll<HTMLElement>('.cp2-subgroup-items')) {
    instances.push(new Sortable(container, {
      ...common,
      draggable: '.cp2-persona-sort-item',
    }));
  }

  for (const header of options.root.querySelectorAll<HTMLElement>('.cp2-subgroup-header')) {
    header.addEventListener('pointerenter', () => {
      if (!options.root.classList.contains('cp2-drag-active')) return;
      const section = header.closest<HTMLElement>('.cp2-subgroup');
      const subgroupId = section?.dataset.subgroupId;
      if (!section || !subgroupId || !section.classList.contains('is-collapsed')) return;
      clearExpandTimer();
      expandTimer = setTimeout(() => options.onExpandSubgroup(subgroupId, section), 500);
    });
    header.addEventListener('pointerleave', clearExpandTimer);
  }

  return () => {
    clearExpandTimer();
    for (const instance of instances) instance.destroy();
  };
}
```

`canMove` 必须原样落实三条限制：分组只能留在顶层、当前入口不能直接进入组内、分组不能插到顶层第一项之前。对“拖动当前入口后导致分组暂时位于第一项”的剩余情况，由 manager 的完整快照校验拒绝并恢复界面。

- [ ] **Step 4: 运行类型与 lint 检查**

Run: `node node_modules/eslint/bin/eslint.js src/branch-sortable.ts`

Run: `node node_modules/typescript/bin/tsc --noEmit`

Expected: 0 errors。

- [ ] **Step 5: 提交拖拽控制器**

```bash
git add package.json pnpm-lock.yaml src/branch-sortable.ts
git commit -m "feat: add sortable branch controller"
```

---

### Task 5: 将面板改为混合布局并移除分组选框

**Files:**
- Modify: `src/index.ts:387-773`
- Modify: `tests/panel-rendering.test.ts`

- [ ] **Step 1: 将界面契约测试改为新行为**

用以下测试替换旧的“移出分组下拉项”断言：

```ts
describe('persona branch panel rendering', () => {
  it('renders sortable mixed layout without legacy parent or subgroup select controls', () => {
    expect(panelSource).toContain('manager.getBranchLayout(parentId, children)');
    expect(panelSource).toContain("dataset.layoutType = 'persona'");
    expect(panelSource).toContain("dataset.layoutType = 'subgroup'");
    expect(panelSource).toContain('mountBranchSortables({');
    expect(panelSource).toContain("'左侧列表入口'");
    expect(panelSource).not.toContain('cp2-subgroup-select');
    expect(panelSource).not.toContain("badge.textContent = '主卡'");
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node node_modules/vitest/vitest.mjs run tests/panel-rendering.test.ts`

Expected: FAIL，仍存在旧 select、主卡徽标与旧渲染顺序。

- [ ] **Step 3: 接入控制器生命周期**

在 `src/index.ts` 顶部加入：

```ts
import { mountBranchSortables } from './branch-sortable';
```

面板状态增加：

```ts
let destroyBranchSortables: (() => void) | null = null;
let panelDragActive = false;
```

在 `renderVariantsPanel` 开头阻止轮询打断拖动，并在真正重建面板前销毁旧实例：

```ts
if (panelDragActive && !force) return;
destroyBranchSortables?.();
destroyBranchSortables = null;
```

- [ ] **Step 4: 重构人设行 DOM**

将 `createMemberItem(memberId, isMainCard)` 改为：

```ts
const createMemberItem = (memberId: string, isEntry: boolean): HTMLElement => {
  const item = document.createElement('div');
  item.className = 'cp2-variant-item cp2-persona-sort-item';
  item.dataset.layoutType = 'persona';
  item.dataset.personaId = memberId;

  const dragHandle = document.createElement('i');
  dragHandle.className = 'fa-solid fa-grip-lines cp2-variant-drag-handle cp2-sort-handle';
  dragHandle.title = tUi('personaCollapse.dragToReorder', '拖动排序');
```

删除人设行上的原生 `draggable`、`dragstart`、`dragover`、`drop` 和 `dragend` 监听。删除整个 `moveSelect` 创建块。

入口状态改为：

```ts
if (isEntry) {
  const entryIcon = document.createElement('i');
  entryIcon.className = 'fa-solid fa-eye cp2-entry-indicator';
  entryIcon.title = tUi('personaCollapse.listEntry', '左侧列表入口');
  entryIcon.setAttribute('aria-label', entryIcon.title);
  actions.appendChild(entryIcon);
}
```

- [ ] **Step 5: 按 `branchLayout` 渲染混合顶层节点**

取得：

```ts
const branchLayout = manager.getBranchLayout(parentId, children);
const subgroupById = new Map(sections.groups.map(group => [group.id, group]));
```

顶层渲染改为：

```ts
for (const layoutItem of branchLayout) {
  if (layoutItem.type === 'persona') {
    const item = createMemberItem(layoutItem.id, layoutItem.id === parentId);
    item.classList.add('cp2-root-item');
    list.appendChild(item);
    continue;
  }

  const group = subgroupById.get(layoutItem.id);
  if (!group) continue;
  list.appendChild(createSubgroupElement(group));
}
```

将现有分组 DOM 创建逻辑提取为函数：

```ts
const createSubgroupElement = (group: PersonaSubgroup): HTMLElement => {
  const section = document.createElement('div');
  section.className = `cp2-subgroup cp2-root-item${group.collapsed ? ' is-collapsed' : ''}`;
  section.dataset.layoutType = 'subgroup';
  section.dataset.subgroupId = group.id;
  // 复用现有重命名、计数和删除逻辑，并增加分组拖拽柄与折叠 body。
  return section;
};
```

注意将函数定义放在首次调用之前，避免 `const` 暂时性死区。

同时更新分组操作调用，使 manager 能基于完整分支成员推导布局：

```ts
manager.createSubgroup(parentId, '新分组', children);
manager.deleteSubgroup(parentId, group.id, children);
```

- [ ] **Step 6: 提交快照并处理入口变化**

面板 DOM 完成后挂载：

```ts
destroyBranchSortables = mountBranchSortables({
  root: list as HTMLElement,
  onCommit: snapshot => {
    const newEntryId = manager.applyBranchLayoutSnapshot(parentId, snapshot, children);
    if (!newEntryId) {
      renderVariantsPanel(true);
      toastr.warning(tUi('personaCollapse.invalidLayout', '无法应用此次布局调整'));
      return false;
    }
    renderAvatarBlock();
    renderVariantsPanel(true, newEntryId);
    return true;
  },
  onExpandSubgroup: (subgroupId, section) => {
    manager.setSubgroupCollapsed(parentId, subgroupId, false);
    section.classList.remove('is-collapsed');
    section.querySelector('.cp2-subgroup-toggle')?.setAttribute('aria-expanded', 'true');
  },
  onDragStateChange: active => {
    panelDragActive = active;
    list.classList.toggle('cp2-drag-active', active);
  },
});
```

- [ ] **Step 7: 运行界面契约测试、完整测试与 lint**

Run: `node node_modules/vitest/vitest.mjs run`

Run: `node node_modules/eslint/bin/eslint.js src/index.ts src/manager.ts src/branch-sortable.ts tests/manager.layout.test.ts tests/manager.subgroups.test.ts tests/panel-rendering.test.ts`

Expected: 全部 PASS，0 lint errors。

- [ ] **Step 8: 提交混合面板**

```bash
git add src/index.ts tests/panel-rendering.test.ts
git commit -m "feat: render sortable mixed persona layout"
```

---

### Task 6: 完成整条折叠、悬停展开与视觉优化

**Files:**
- Modify: `src/index.ts`
- Modify: `style.css:205-406`

- [ ] **Step 1: 让分组标题整条可点击**

提取统一切换函数：

```ts
const toggleSubgroup = () => {
  manager.setSubgroupCollapsed(parentId, group.id, !group.collapsed);
  renderVariantsPanel(true);
};

toggle.addEventListener('click', event => {
  event.stopPropagation();
  toggleSubgroup();
});

header.addEventListener('click', event => {
  if ((event.target as Element).closest('button, input, .cp2-sort-handle')) return;
  toggleSubgroup();
});
```

在分组标题最前方增加：

```ts
const groupHandle = document.createElement('i');
groupHandle.className = 'fa-solid fa-grip-lines cp2-subgroup-drag-handle cp2-sort-handle';
groupHandle.title = tUi('personaCollapse.dragSubgroup', '拖动分组');
groupHandle.addEventListener('click', event => event.stopPropagation());
header.appendChild(groupHandle);
```

- [ ] **Step 2: 将瞬时 `hidden` 改为折叠容器**

分组结构使用：

```html
<div class="cp2-subgroup-body">
  <div class="cp2-subgroup-items">...</div>
</div>
```

删除 `items.hidden = group.collapsed`。折叠只通过 section 的 `is-collapsed` 类控制。

- [ ] **Step 3: 替换旧分组与 select 样式**

在 `style.css` 删除 `.cp2-main-persona`、`.cp2-subgroup-select` 及其移动端规则，增加：

```css
.cp2-subgroup {
  display: grid;
  gap: 0;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 6px;
  background: var(--black30a);
  overflow: hidden;
}

.cp2-subgroup-header {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  cursor: pointer;
}

.cp2-sort-handle {
  flex: 0 0 22px;
  cursor: grab;
  opacity: 0.55;
  text-align: center;
}

.cp2-sort-handle:active {
  cursor: grabbing;
}

.cp2-subgroup-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 160ms ease, opacity 160ms ease;
  opacity: 1;
}

.cp2-subgroup.is-collapsed .cp2-subgroup-body {
  grid-template-rows: 0fr;
  opacity: 0;
}

.cp2-subgroup-items {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-left: 15px;
  padding: 4px 6px 6px 10px;
  border-left: 1px solid var(--SmartThemeBorderColor);
  overflow: hidden;
}

.cp2-drag-active .cp2-subgroup-items:empty {
  min-height: 34px;
}

.cp2-sort-ghost {
  opacity: 0.3;
  border: 1px dashed var(--SmartThemeQuoteColor);
}

.cp2-sort-chosen {
  outline: 1px solid var(--SmartThemeQuoteColor);
}

.cp2-entry-indicator {
  width: 24px;
  text-align: center;
  opacity: 0.65;
}

@media (prefers-reduced-motion: reduce) {
  .cp2-subgroup-body {
    transition: none;
  }
}
```

- [ ] **Step 4: 运行测试、lint 与生产构建**

Run: `node node_modules/vitest/vitest.mjs run`

Run: `node node_modules/eslint/bin/eslint.js src/index.ts src/manager.ts src/branch-sortable.ts tests`

Run: `node node_modules/webpack-cli/bin/cli.js --mode production`

Expected: 测试与 lint 通过，Webpack 成功输出 `dist/index.js`。

- [ ] **Step 5: 提交折叠与视觉样式**

```bash
git add src/index.ts style.css dist/index.js dist/index.js.map
git commit -m "feat: polish draggable persona subgroups"
```

---

### Task 7: 回归入口切换与自动分支边界

**Files:**
- Modify: `src/manager.ts`
- Modify: `src/index.ts`
- Modify: `tests/manager.layout.test.ts`

- [ ] **Step 1: 增加自动分支实体化测试**

```ts
it('materializes an automatic branch after the first explicit layout change', () => {
  const manager = new GroupManager(settings({ manualGroups: {}, subgroups: {}, branchLayouts: {} }), vi.fn());
  manager.setAutoGroups({ parent: ['a', 'b'] });

  expect(manager.applyBranchLayoutSnapshot('parent', {
    root: [
      { type: 'persona', id: 'a' },
      { type: 'persona', id: 'parent' },
      { type: 'persona', id: 'b' },
    ],
    subgroupMembers: {},
  }, ['a', 'b'])).toBe('a');

  expect(manager.getSettings().manualGroups.a).toEqual(['parent', 'b']);
  expect(manager.getSettings().autoGroupByName).toBe(true);
  expect(manager.getSettings().autoGroupByBinding).toBe(true);
});
```

- [ ] **Step 2: 增加入口删除与重新关联测试**

测试必须断言：

```ts
expect(manager.getBranchLayout(newEntryId, remainingChildren)[0]).toEqual({
  type: 'persona',
  id: newEntryId,
});
expect(JSON.stringify(manager.getSettings().branchLayouts)).not.toContain(deletedPersonaId);
expect(JSON.stringify(manager.getSettings().branchLayouts[oldParentId] ?? '')).not.toContain(relinkedPersonaId);
```

- [ ] **Step 3: 运行测试并修复边界**

Run: `node node_modules/vitest/vitest.mjs run tests/manager.layout.test.ts tests/manager.subgroups.test.ts`

Expected: 全部 PASS。

实现约束：

- 入口删除时优先选择顶层下一位人设。
- 顶层没有人设时，从最靠前分组取出第一位成员作为入口。
- 重新关联前从旧布局和旧分组中移除该人设。
- `renderAvatarBlock()` 在入口变化后立即重建隐藏规则与角标。
- 当前实际使用的人设不因入口变化而调用 `switchToPersona`。

- [ ] **Step 4: 运行全量静态验证**

Run: `node node_modules/vitest/vitest.mjs run`

Run: `node node_modules/eslint/bin/eslint.js src/index.ts src/manager.ts src/branch-sortable.ts tests`

Run: `node node_modules/typescript/bin/tsc --noEmit`

Expected: 全部通过。

- [ ] **Step 5: 提交边界兼容**

```bash
git add src/manager.ts src/index.ts tests/manager.layout.test.ts
git commit -m "fix: preserve branch layout lifecycle invariants"
```

---

### Task 8: 浏览器交互验收

**Files:**
- Modify if defects are found: `src/index.ts`
- Modify if defects are found: `src/branch-sortable.ts`
- Modify if defects are found: `style.css`

- [ ] **Step 1: 在测试用 SillyTavern 安装开发构建**

使用项目现有同步方式或将以下运行文件放入测试扩展目录：

```text
manifest.json
style.css
dist/index.js
```

- [ ] **Step 2: 验收无分组平铺排序**

验证：所有人设自然平铺；没有“未分组”和分组选框；拖到第一位后左侧入口更新；原入口仍在分支中；当前使用人设不被强制切换。

- [ ] **Step 3: 验收混合布局和分组拖动**

验证：分组可以插入普通人设之间；分组不能越过入口；分组不能拖入分组；刷新页面后顺序保持。

- [ ] **Step 4: 验收人设跨容器移动**

验证：顶层入组、跨组、出组、空组接收、同组排序均显示稳定占位线，完成后没有重复或丢失。

- [ ] **Step 5: 验收折叠与触屏**

验证：标题和箭头均可折叠；操作按钮不误触；折叠组悬停 500 毫秒展开；移动端长按可拖动；面板边缘自动滚动。

- [ ] **Step 6: 验收异常恢复与减少动画**

验证：快速拖动、拖动取消、切换人设、删除分组和关闭插件不会留下 ghost；系统减少动画后折叠与排序不播放动画。

- [ ] **Step 7: 修复发现的问题并重复全量验证**

Run: `node node_modules/vitest/vitest.mjs run`

Run: `node node_modules/eslint/bin/eslint.js src/index.ts src/manager.ts src/branch-sortable.ts tests`

Run: `node node_modules/webpack-cli/bin/cli.js --mode production`

Expected: 所有检查通过，人工验收项无阻塞问题。

- [ ] **Step 8: 提交验收修复**

仅在发生修复时执行：

```bash
git add src/index.ts src/branch-sortable.ts style.css dist/index.js dist/index.js.map
git commit -m "fix: stabilize sortable branch interactions"
```

---

### Task 9: 文档、3.2.0 发布包与分支发布

**Files:**
- Modify: `README.md:16-19`
- Modify: `manifest.json:9`
- Modify: `dist/index.js`
- Modify: `dist/index.js.map`
- Modify: `releases/persona-collapse.zip`

- [ ] **Step 1: 更新 README 功能说明**

将分组说明更新为：

```markdown
### 📁 2. 分支内自由分组与排序
人设与具名折叠组可以自由混合排序；拖入分组即可收纳，拖回顶层即可移出。分组本身也能调整位置，点击整条标题或箭头可展开和收纳。

顶层第一位人设是该分支在左侧列表中的动态入口。将其他人设拖到第一位即可更换入口，不会修改角色、聊天或群组绑定关系。
```

- [ ] **Step 2: 将版本提升到 3.2.0**

在 `manifest.json` 修改：

```json
"version": "3.2.0"
```

- [ ] **Step 3: 运行最终测试、lint、类型检查与生产构建**

Run: `node node_modules/vitest/vitest.mjs run`

Run: `node node_modules/eslint/bin/eslint.js src/index.ts src/manager.ts src/branch-sortable.ts tests`

Run: `node node_modules/typescript/bin/tsc --noEmit`

Run: `node node_modules/webpack-cli/bin/cli.js --mode production`

Expected: 所有命令退出码为 0。

- [ ] **Step 4: 生成并核对 ZIP**

Run: `node pack.mjs`

PowerShell 清单检查：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path 'releases\persona-collapse.zip')).Entries |
  ForEach-Object FullName
```

Expected exactly:

```text
persona-collapse/manifest.json
persona-collapse/style.css
persona-collapse/dist/index.js
```

- [ ] **Step 5: 记录发布包哈希并提交 source 发布点**

Run: `Get-FileHash releases\persona-collapse.zip -Algorithm SHA256`

```bash
git add README.md manifest.json dist/index.js dist/index.js.map releases/persona-collapse.zip
git commit -m "chore: release v3.2.0"
```

- [ ] **Step 6: 更新 `source` 分支**

在 `source` 工作树执行快进合并：

```bash
git merge --ff-only codex/sortable-persona-layout
git push origin source
```

- [ ] **Step 7: 更新纯发布 `main`**

从最终 source 复制且只提交：

```text
LICENSE
README.md
dist/index.js
manifest.json
style.css
```

核对：

```bash
git ls-tree -r --name-only HEAD
```

Expected exactly the five files above, then push the release commit to `main`.

- [ ] **Step 8: 同步本地测试包并核对远端**

将最终 ZIP 复制到原项目：

```text
D:\SillyTavern\ST_projects\1-项目开发(Projects)\开发中(Active)\persona-collapse\releases\persona-collapse.zip
```

Run:

```bash
git ls-remote origin refs/heads/source refs/heads/main
```

Expected: `source` 指向完整 3.2.0 发布提交，`main` 指向只含五个发布文件的提交。

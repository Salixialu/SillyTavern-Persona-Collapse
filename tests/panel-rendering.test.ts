import { describe, expect, it } from 'vitest';
// Vite's raw loader exposes the file contents as a default export at test runtime.
// eslint-disable-next-line import-x/default
import panelSource from '../src/index.ts?raw';
import sortableSource from '../src/branch-sortable.ts?raw';
import managerSource from '../src/manager.ts?raw';

describe('persona branch panel rendering', () => {
  it('renders mixed root layouts through branch sortables', () => {
    expect(panelSource).toContain('manager.getBranchLayout(parentId, children)');
    expect(panelSource).toContain('for (const item of layout.root)');
    expect(panelSource).toContain('mountBranchSortables({');
    expect(panelSource).toContain("tUi('personaCollapse.leftListEntry', '左侧列表入口')");
    expect(panelSource).toContain("tUi('personaCollapse.renameSubgroup', '重命名分组')");
    expect(panelSource).toContain("tUi('personaCollapse.deleteSubgroup', '删除分组')");
    expect(panelSource).toContain('async function createPersonaInBranch');
    expect(panelSource).toContain('manager.linkChildAtEnd(parentId, avatarId)');
    expect(panelSource).toContain('async function editPersonaTags');
    expect(panelSource).toContain('cp2-persona-tags');
    expect(panelSource).toContain('fa-tags');
    expect(panelSource).toContain('cp2-surface-persona-slot');
    expect(panelSource).toContain('surface?: boolean');
    expect(panelSource).toContain('surface: true');
    expect(panelSource).toContain('if (item.id === parentId) continue;');
    expect(panelSource).toContain('入口固定在顶栏');
    expect(panelSource).toContain("subgroupId ? '' : ' cp2-root-item'");
    expect(panelSource).not.toContain('cp2-subgroup-select');
    expect(panelSource).not.toContain("tUi('personaCollapse.removeFromSubgroup', '移出分组')");
  });

  it('prompts for subgroup names before creating a subgroup', () => {
    expect(panelSource).toContain('async function promptSubgroupName');
    expect(panelSource).toContain('POPUP_TYPE.TEXT');
    expect(panelSource).toContain('manager.createSubgroup(parentId, name)');
    expect(panelSource).toContain('manager.createSubgroup(currentParentId, name)');
    expect(panelSource).not.toContain('editingSubgroupId = manager.createSubgroup(parentId).id');
  });

  it('renders stable subgroup controls in the manager popup', () => {
    expect(panelSource).toContain('cp2-mgr-create-subgroup');
    expect(panelSource).toContain('cp2-mgr-move-btn');
    expect(panelSource).toContain('cp2-mgr-order-btn');
    expect(panelSource).not.toContain('cp2-mgr-entry-btn');
    expect(panelSource).not.toContain('一键设为主卡');
    expect(panelSource).toContain('移动到分组');
    expect(panelSource).toContain('移动到顶层或其他分组');
    expect(panelSource).toContain('cp2-manager-subgroup');
    expect(panelSource).toContain('async function promptMovePersonaDestination');
    expect(panelSource).toContain('const subgroupId = await promptMovePersonaDestination');
    expect(panelSource).toContain('manager.movePersonaToSubgroup(currentParentId, id, subgroupId, children)');
    expect(panelSource).not.toContain('cp2-mgr-subgroup-select');
  });

  it('keeps both manager lists independently scrollable', () => {
    expect(panelSource).toContain('cp2-manager-list');
    expect(panelSource).toContain('cp2-manager-columns');
  });

  it('deletes a subgroup only after its confirmation popup resolves', () => {
    expect(panelSource).toContain('async function confirmSubgroupDeletion');
    expect(panelSource).toContain('const confirmed = await confirmSubgroupDeletion(subgroupName);');
    expect(panelSource).toContain('manager.deleteSubgroup(currentParentId, subgroupId);');
  });

  it('skips unchanged polling renders before rebuilding branch layout state', () => {
    expect(panelSource).toContain('let variantsPanelDirty = true;');
    expect(panelSource).toContain('!variantsPanelDirty && currentId === lastPanelPersonaId');
    expect(panelSource).toContain('variantsPanelDirty = true;');
    expect(panelSource).toContain('variantsPanelDirty = false;');
  });

  it('uses SortableJS as the only drag placement engine', () => {
    expect(panelSource).not.toContain("items.style.minHeight = '12px'");
    expect(sortableSource).toContain('readBranchLayoutSnapshot(options.root)');
    expect(sortableSource).not.toContain('cp2-manual-drop-indicator');
    expect(sortableSource).not.toContain('pointermove');
    expect(sortableSource).not.toContain('forceFallback: true');
  });

  it('keeps the first empty subgroup drop target reachable', () => {
    expect(sortableSource).toContain('emptyInsertThreshold: 48');
    expect(sortableSource).toContain('canMoveEntryIntoSubgroup');
    expect(sortableSource).toContain('item !== event.dragged && item.dataset.layoutType === \'persona\'');
    expect(panelSource).toContain('items.dataset.emptyLabel');
    expect(sortableSource).toContain('cp2-drop-target');
    expect(sortableSource).toContain('cp2-sort-insert-before');
    expect(sortableSource).toContain('willInsertAfter');
    expect(sortableSource).toContain('canMoveRootItemToStart');
    expect(sortableSource).toContain('onCancel: stopDrag');
    expect(sortableSource).toContain('delayOnTouchOnly: true');
    expect(sortableSource).toContain('pendingDrop');
    expect(sortableSource).toContain('return false;');
    expect(sortableSource).toContain('SOURCE_HIDDEN_CLASS');
    expect(sortableSource).toContain('to.insertBefore(draggedElement');
    expect(sortableSource).toContain('const isCrossContainer = event.to !== draggedElement?.parentElement;');
    expect(sortableSource).toContain('return isCrossContainer;');
    expect(sortableSource).toContain('dragWatchdog = setTimeout');
    expect(sortableSource).toContain('options.onReject();');
    expect(sortableSource).toContain('cp2-sort-source');
    expect(managerSource).toContain('if (firstPersonaIndex !== 0) return null;');
    expect(panelSource).toContain('let runtimeCleanup');
    expect(panelSource).toContain('runtimeCleanup?.();');
    expect(panelSource).toContain('clearInterval(panelInterval);');
    expect(panelSource).toContain('bodyObserver.disconnect();');
    expect(panelSource).toContain('pendingSubgroupFocusId');
    expect(panelSource).toContain('canMoveUp');
    expect(panelSource).toContain('disabled');
  });
});

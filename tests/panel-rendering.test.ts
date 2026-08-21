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
    expect(panelSource).not.toContain('cp2-surface-indicator');
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
    expect(panelSource).not.toContain('cp2-mgr-move-btn');
    expect(panelSource).not.toContain('cp2-mgr-order-btn');
    expect(panelSource).toContain('cp2-icon-btn cp2-remove-btn');
    expect(panelSource).toContain('移出分支，回到独立人设');
    expect(panelSource).not.toContain('cp2-mgr-entry-btn');
    expect(panelSource).not.toContain('一键设为主卡');
    expect(panelSource).toContain('cp2-manager-drag-handle');
    expect(panelSource).toContain('manager.applyBranchLayoutSnapshot(currentParentId, snapshot, children)');
    expect(panelSource).toContain('destroyManagerSortables?.();');
    expect(panelSource).toContain('data-id="${escapeHtml(id)}"');
    expect(panelSource).toContain('cp2-manager-subgroup');
    expect(panelSource).not.toContain('promptMovePersonaDestination');
    expect(panelSource).not.toContain('manager.movePersonaToSubgroup(currentParentId, id, subgroupId, children)');
    expect(panelSource).toContain('renderIndependentDestinationPane');
    expect(panelSource).toContain('manager.isIndependent(initialParentId)');
    expect(panelSource).toContain('cp2-manager-target-branch');
    expect(panelSource).toContain('cp2-manager-target-arrow');
    expect(panelSource).toContain('cp2-manager-target-arrow"></i>');
    expect(panelSource).toContain('manager.linkChild(targetId, independentSourceId)');
    expect(panelSource).toContain('cp2-mgr-create-current-group');
    expect(panelSource).toContain('目标分支');
    expect(panelSource).toContain("if (leftTitle) leftTitle.textContent = '当前人设';");
    expect(panelSource).toContain("if (rightTitle) rightTitle.innerHTML = '目标分支 (<span id=\"cp2-mgr-count\">0</span>)';");
    expect(panelSource).toContain("const managerHint = independentSourceId");
    expect(panelSource).toContain('targetPane.querySelectorAll<HTMLButtonElement>');
    expect(panelSource).toContain("let mode: 'add-to-current' | 'join-another-branch' | 'manage-current-branch'");
    expect(panelSource).toContain('const sourceParentId = manager.findParentOf(id);');
    expect(panelSource).toContain('来自分支：');
    expect(panelSource).toContain('转移到');
    expect(panelSource).toContain('cp2-mgr-left-title');
    expect(panelSource).toContain('搜索目标分支...');
    expect(panelSource).not.toContain('cp2-mgr-subgroup-select');
  });

  it('keeps both manager lists independently scrollable', () => {
    expect(panelSource).toContain('cp2-manager-list');
    expect(panelSource).toContain('cp2-manager-columns');
  });

  it('keeps join mode separate from current branch management', () => {
    expect(panelSource).toContain("mode = 'manage-current-branch';");
    expect(panelSource).toContain("if (mode === 'join-another-branch' && independentSourceId)");
    expect(panelSource).toContain("if (leftTitle) leftTitle.innerHTML = '可加入人设 (<span id=\"cp2-mgr-count\">0</span>)';");
    expect(panelSource).toContain("if (rightTitle) rightTitle.textContent = isAddingToCurrent ? '当前目标分支' : '当前分支';");
    expect(panelSource).toContain('manager.initGroup(currentParentId);');
    expect(panelSource).toContain('manager.linkChild(currentParentId, id);');
    expect(panelSource).toContain('data-manager-mode="add-to-current"');
    expect(panelSource).toContain('data-manager-mode="join-another-branch"');
  });

  it('supports replacing the branch entry by dragging it onto a member', () => {
    expect(panelSource).toContain("item.draggable = true;");
    expect(panelSource).toContain('拖动到分支成员以替换入口');
    expect(panelSource).toContain('cp2-entry-replace-target');
    expect(panelSource).toContain('const replaceEntryWith = (targetId: string): boolean =>');
    expect(panelSource).toContain('manager.applyBranchLayoutSnapshot(parentId, {');
    expect(panelSource).toContain('memberIds.filter(memberId => memberId !== targetId)');
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

  it('keeps the detail toolbar compact when no branch exists', () => {
    expect(panelSource).toContain("const hasBranchContent = children.length > 0 || layout.root.some(item => item.type === 'subgroup');");
    expect(panelSource).toContain("cp2-variants-header-no-branches");
    expect(panelSource).toContain("if (children.length > 0) {");
    expect(panelSource).toContain("children.length > 0 ? `<span class=\"cp2-variants-count\"");
  });

  it('uses SortableJS as the only drag placement engine', () => {
    expect(panelSource).not.toContain("items.style.minHeight = '12px'");
    expect(sortableSource).toContain('readBranchLayoutSnapshot(options.root)');
    expect(sortableSource).not.toContain('cp2-manual-drop-indicator');
    expect(sortableSource).not.toContain('pointermove');
    expect(sortableSource).toContain('filter: DRAG_FILTER');
    expect(sortableSource).toContain('preventOnFilter: true');
    expect(sortableSource).toContain('forceFallback: true');
    expect(sortableSource).toContain('fallbackOnBody: true');
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
    expect(sortableSource).toContain('const drop = pendingDrop;');
    expect(sortableSource).toContain('const accepted = placed && options.onCommit');
    expect(sortableSource).toContain('dragWatchdog = setTimeout');
    expect(sortableSource).toContain('options.onReject();');
    expect(sortableSource).toContain('cp2-sort-source');
    expect(managerSource).toContain('if (firstPersonaIndex !== 0) return null;');
    expect(panelSource).toContain('let runtimeCleanup');
    expect(panelSource).toContain('runtimeCleanup?.();');
    expect(panelSource).toContain('clearInterval(panelInterval);');
    expect(panelSource).toContain('bodyObserver.disconnect();');
    expect(panelSource).toContain('const cancelTouchDrag = (): void =>');
    expect(panelSource).toContain('evt.touches.length !== 1');
    expect(panelSource).toContain("window.addEventListener('pagehide', cancelTouchDrag");
    expect(panelSource).toContain("document.visibilityState !== 'visible'");
    expect(panelSource).toContain('pendingSubgroupFocusId');
    expect(panelSource).not.toContain('canMoveUp');
    expect(panelSource).not.toContain('cp2-mgr-order-btn');
  });
});

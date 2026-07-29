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
  branchLayouts: {},
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

  it('resets all grouping state without changing automatic grouping preferences', () => {
    const save = vi.fn();
    const manager = new GroupManager(completeSettings({
      collapsedParents: ['parent'],
      childMeta: { a: { note: 'x' } },
      excludedFromAuto: ['a'],
      subgroups: {
        parent: [{ id: 'one', name: '一组', personaIds: ['a'], collapsed: true }],
      },
      ungroupedCollapsed: ['parent'],
    }), save);

    manager.resetGroupingState();
    expect(manager.getSettings()).toMatchObject({
      manualGroups: {},
      collapsedParents: [],
      childMeta: {},
      groupNames: {},
      excludedFromAuto: [],
      subgroups: {},
      ungroupedCollapsed: [],
      branchLayouts: {},
      autoGroupByName: true,
      autoGroupByBinding: true,
    });
    expect(save).toHaveBeenCalledOnce();
  });
});

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

  it('removes stale subgroup membership when relinking to another parent', () => {
    const manager = new GroupManager(completeSettings({
      manualGroups: { old: ['a', 'b'], next: ['c'] },
      subgroups: {
        old: [{ id: 'one', name: '一组', personaIds: ['a', 'b'], collapsed: false }],
      },
    }), vi.fn());

    manager.linkChild('next', 'a');
    expect(manager.getSettings().subgroups.old[0].personaIds).toEqual(['b']);
    expect(manager.getSettings().manualGroups.next).toEqual(['c', 'a']);
  });
});

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

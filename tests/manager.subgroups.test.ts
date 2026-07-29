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

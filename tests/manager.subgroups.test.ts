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

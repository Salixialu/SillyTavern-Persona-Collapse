import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupManager, type GroupSettings } from '../src/manager';

const completeSettings = (overrides: Partial<GroupSettings> = {}): GroupSettings => ({
  enabled: true,
  manualGroups: { parent: ['a', 'b', 'c'] },
  collapsedParents: [],
  childMeta: {},
  groupNames: {},
  excludedFromAuto: [],
  autoGroupByName: true,
  autoGroupByBinding: true,
  subgroups: {},
  ungroupedCollapsed: [],
  branchLayouts: {},
  ...overrides,
});

describe('GroupManager branch layout migration', () => {
  beforeEach(() => vi.useFakeTimers());

  it('adds a missing branch layout field and saves the migration once', () => {
    const save = vi.fn();
    const manager = new GroupManager({
      enabled: true,
      manualGroups: {},
      collapsedParents: [],
      childMeta: {},
      groupNames: {},
      excludedFromAuto: [],
      autoGroupByName: true,
      autoGroupByBinding: true,
      subgroups: {},
      ungroupedCollapsed: [],
    }, save);

    expect(manager.getSettings().branchLayouts).toEqual({});
    expect(save).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(save).toHaveBeenCalledOnce();
  });
});

describe('GroupManager legacy branch layout', () => {
  it('derives parent, ungrouped personas and named subgroups without saving', () => {
    const save = vi.fn();
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
    }), save);

    expect(manager.getBranchLayout('parent', ['a', 'b', 'c'])).toEqual({
      root: [
        { type: 'persona', id: 'parent' },
        { type: 'persona', id: 'a' },
        { type: 'persona', id: 'c' },
        { type: 'subgroup', id: 'warm' },
      ],
      subgroupMembers: { warm: ['b'] },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('returns a complete stored mixed layout in its stored order', () => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'subgroup', id: 'warm' },
          { type: 'persona', id: 'c' },
          { type: 'persona', id: 'a' },
        ],
      },
    }), vi.fn());

    expect(manager.getBranchLayout('parent', ['a', 'b', 'c'])).toEqual({
      root: [
        { type: 'persona', id: 'parent' },
        { type: 'subgroup', id: 'warm' },
        { type: 'persona', id: 'c' },
        { type: 'persona', id: 'a' },
      ],
      subgroupMembers: { warm: ['b'] },
    });
  });

  it('returns detached copies for stored layouts', () => {
    const save = vi.fn();
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'subgroup', id: 'warm' },
          { type: 'persona', id: 'c' },
          { type: 'persona', id: 'a' },
        ],
      },
    }), save);
    const originalStored = JSON.parse(JSON.stringify(manager.getSettings().branchLayouts.parent));
    const layout = manager.getBranchLayout('parent', ['a', 'b', 'c']);

    layout.root.splice(1, 1);
    layout.root[0].id = 'mutated';
    layout.root.push({ type: 'persona', id: 'new' });
    layout.subgroupMembers.warm.splice(0, 1);

    expect(manager.getSettings().branchLayouts.parent).toEqual(originalStored);
    expect(manager.getSettings().subgroups.parent[0].personaIds).toEqual(['b']);
    expect(save).not.toHaveBeenCalled();
  });

  it('falls back completely when unknown and duplicate items hide a missing persona', () => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'subgroup', id: 'warm' },
          { type: 'persona', id: 'a' },
          { type: 'persona', id: 'a' },
          { type: 'persona', id: 'missing' },
        ],
      },
    }), vi.fn());

    expect(manager.getBranchLayout('parent', ['a', 'b', 'c']).root).toEqual([
      { type: 'persona', id: 'parent' },
      { type: 'persona', id: 'a' },
      { type: 'persona', id: 'c' },
      { type: 'subgroup', id: 'warm' },
    ]);
  });

  it('falls back when a subgroup member appears in the stored root', () => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'subgroup', id: 'warm' },
          { type: 'persona', id: 'c' },
          { type: 'persona', id: 'a' },
          { type: 'persona', id: 'b' },
        ],
      },
    }), vi.fn());

    expect(manager.getBranchLayout('parent', ['a', 'b', 'c']).root).toEqual([
      { type: 'persona', id: 'parent' },
      { type: 'persona', id: 'a' },
      { type: 'persona', id: 'c' },
      { type: 'subgroup', id: 'warm' },
    ]);
  });

  it('falls back when an otherwise complete stored layout has an unknown item', () => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'subgroup', id: 'warm' },
          { type: 'persona', id: 'missing' },
          { type: 'persona', id: 'c' },
          { type: 'persona', id: 'a' },
        ],
      },
    }), vi.fn());

    expect(manager.getBranchLayout('parent', ['a', 'b', 'c']).root).toEqual([
      { type: 'persona', id: 'parent' },
      { type: 'persona', id: 'a' },
      { type: 'persona', id: 'c' },
      { type: 'subgroup', id: 'warm' },
    ]);
  });

  it('falls back when an otherwise complete stored layout has a duplicate item', () => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'subgroup', id: 'warm' },
          { type: 'persona', id: 'a' },
          { type: 'persona', id: 'c' },
          { type: 'persona', id: 'a' },
        ],
      },
    }), vi.fn());

    expect(manager.getBranchLayout('parent', ['a', 'b', 'c']).root).toEqual([
      { type: 'persona', id: 'parent' },
      { type: 'persona', id: 'a' },
      { type: 'persona', id: 'c' },
      { type: 'subgroup', id: 'warm' },
    ]);
  });

  it.each([
    {
      name: 'does not start with the parent persona',
      stored: [
        { type: 'persona' as const, id: 'a' },
        { type: 'persona' as const, id: 'parent' },
        { type: 'persona' as const, id: 'c' },
        { type: 'subgroup' as const, id: 'warm' },
      ],
    },
    {
      name: 'is missing a valid subgroup',
      stored: [
        { type: 'persona' as const, id: 'parent' },
        { type: 'persona' as const, id: 'c' },
        { type: 'persona' as const, id: 'a' },
      ],
    },
  ])('falls back when stored layout $name', ({ stored }) => {
    const manager = new GroupManager(completeSettings({
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      branchLayouts: { parent: stored },
    }), vi.fn());

    expect(manager.getBranchLayout('parent', ['a', 'b', 'c']).root).toEqual([
      { type: 'persona', id: 'parent' },
      { type: 'persona', id: 'a' },
      { type: 'persona', id: 'c' },
      { type: 'subgroup', id: 'warm' },
    ]);
  });
});

describe('GroupManager applyBranchLayoutSnapshot', () => {
  it('atomically migrates layout state to the new entry persona', () => {
    const save = vi.fn();
    const manager = new GroupManager(completeSettings({
      manualGroups: { parent: ['a', 'b', 'c'] },
      groupNames: { parent: 'Main Branch' },
      collapsedParents: ['parent'],
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      ungroupedCollapsed: ['parent'],
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'persona', id: 'a' },
          { type: 'persona', id: 'c' },
          { type: 'subgroup', id: 'warm' },
        ],
      },
    }), save);

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
    expect(manager.getSettings().groupNames).toEqual({ b: 'Main Branch' });
    expect(manager.getSettings().collapsedParents).toEqual(['b']);
    expect(manager.getSettings().ungroupedCollapsed).toEqual(['b']);
    expect(manager.getSettings().subgroups.b).toEqual([
      { id: 'warm', name: '温柔线', personaIds: ['a', 'c'], collapsed: false },
    ]);
    expect(manager.getSettings().branchLayouts.b).toEqual([
      { type: 'persona', id: 'b' },
      { type: 'subgroup', id: 'warm' },
      { type: 'persona', id: 'parent' },
    ]);
    expect(manager.getSettings().manualGroups.parent).toBeUndefined();
    expect(manager.getSettings().groupNames.parent).toBeUndefined();
    expect(manager.getSettings().subgroups.parent).toBeUndefined();
    expect(manager.getSettings().branchLayouts.parent).toBeUndefined();
    expect(save).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'starts with a subgroup',
      snapshot: {
        root: [
          { type: 'subgroup' as const, id: 'warm' },
          { type: 'persona' as const, id: 'parent' },
          { type: 'persona' as const, id: 'b' },
        ],
        subgroupMembers: { warm: ['a', 'c'] },
      },
    },
    {
      name: 'duplicates a persona in root',
      snapshot: {
        root: [
          { type: 'persona' as const, id: 'parent' },
          { type: 'persona' as const, id: 'b' },
          { type: 'persona' as const, id: 'b' },
          { type: 'subgroup' as const, id: 'warm' },
        ],
        subgroupMembers: { warm: ['a', 'c'] },
      },
    },
    {
      name: 'misses a persona from root and subgroup members',
      snapshot: {
        root: [
          { type: 'persona' as const, id: 'parent' },
          { type: 'subgroup' as const, id: 'warm' },
        ],
        subgroupMembers: { warm: ['a'] },
      },
    },
    {
      name: 'references an unknown subgroup',
      snapshot: {
        root: [
          { type: 'persona' as const, id: 'parent' },
          { type: 'subgroup' as const, id: 'cool' },
          { type: 'persona' as const, id: 'b' },
        ],
        subgroupMembers: { cool: ['a', 'c'] },
      },
    },
  ])('returns null and leaves settings untouched when snapshot $name', ({ snapshot }) => {
    const initial = completeSettings({
      manualGroups: { parent: ['a', 'b', 'c'] },
      groupNames: { parent: 'Main Branch' },
      collapsedParents: ['parent'],
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      ungroupedCollapsed: ['parent'],
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'persona', id: 'a' },
          { type: 'persona', id: 'c' },
          { type: 'subgroup', id: 'warm' },
        ],
      },
    });
    const expected = JSON.parse(JSON.stringify(initial));
    const save = vi.fn();
    const manager = new GroupManager(initial, save);

    expect(manager.applyBranchLayoutSnapshot('parent', snapshot, ['a', 'b', 'c'])).toBeNull();
    expect(manager.getSettings()).toEqual(expected);
    expect(save).not.toHaveBeenCalled();
  });

  it('updates in place when the parent stays the same', () => {
    const save = vi.fn();
    const manager = new GroupManager(completeSettings({
      manualGroups: { parent: ['a', 'b', 'c'] },
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'persona', id: 'a' },
          { type: 'persona', id: 'c' },
          { type: 'subgroup', id: 'warm' },
        ],
      },
    }), save);

    const newEntry = manager.applyBranchLayoutSnapshot('parent', {
      root: [
        { type: 'persona', id: 'parent' },
        { type: 'subgroup', id: 'warm' },
        { type: 'persona', id: 'c' },
      ],
      subgroupMembers: { warm: ['a', 'b'] },
    }, ['a', 'b', 'c']);

    expect(newEntry).toBe('parent');
    expect(manager.getSettings().manualGroups).toEqual({ parent: ['a', 'b', 'c'] });
    expect(manager.getSettings().subgroups.parent).toEqual([
      { id: 'warm', name: '温柔线', personaIds: ['a', 'b'], collapsed: false },
    ]);
    expect(manager.getSettings().branchLayouts.parent).toEqual([
      { type: 'persona', id: 'parent' },
      { type: 'subgroup', id: 'warm' },
      { type: 'persona', id: 'c' },
    ]);
    expect(save).toHaveBeenCalledOnce();
  });
});

describe('GroupManager branch layout lifecycle', () => {
  it('materializes an automatic branch after the first explicit layout change', () => {
    const manager = new GroupManager(completeSettings({ manualGroups: {}, subgroups: {}, branchLayouts: {} }), vi.fn());
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

  it('promotes the next root persona when the current entry is deleted', () => {
    const manager = new GroupManager(completeSettings({
      manualGroups: { parent: ['a', 'b'] },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'persona', id: 'a' },
          { type: 'persona', id: 'b' },
        ],
      },
    }), vi.fn());

    expect(manager.cleanupDeletedPersonas(['a', 'b'])).toBe(true);
    expect(manager.getSettings().manualGroups.a).toEqual(['b']);
    expect(manager.getBranchLayout('a', ['b']).root[0]).toEqual({ type: 'persona', id: 'a' });
    expect(JSON.stringify(manager.getSettings().branchLayouts)).not.toContain('parent');
  });

  it('promotes the first member of the earliest subgroup when no root persona remains', () => {
    const manager = new GroupManager(completeSettings({
      manualGroups: { parent: ['a', 'b'] },
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['a', 'b'], collapsed: false }],
      },
      branchLayouts: {
        parent: [{ type: 'persona', id: 'parent' }, { type: 'subgroup', id: 'warm' }],
      },
    }), vi.fn());

    expect(manager.cleanupDeletedPersonas(['a', 'b'])).toBe(true);
    expect(manager.getSettings().manualGroups.a).toEqual(['b']);
    expect(manager.getSettings().subgroups.a[0].personaIds).toEqual(['b']);
    expect(manager.getBranchLayout('a', ['b']).root).toEqual([
      { type: 'persona', id: 'a' },
      { type: 'subgroup', id: 'warm' },
    ]);
  });

  it('keeps the new parent branch layout when a child is relinked away from the old parent', () => {
    const manager = new GroupManager(completeSettings({
      manualGroups: {
        parent: ['a'],
        next: ['b'],
      },
      branchLayouts: {
        parent: [{ type: 'persona', id: 'parent' }, { type: 'persona', id: 'a' }],
        next: [{ type: 'persona', id: 'next' }, { type: 'persona', id: 'b' }],
      },
    }), vi.fn());

    manager.linkChild('next', 'a');

    expect(manager.getSettings().manualGroups).toEqual({
      next: ['b', 'a'],
    });
    expect(manager.getSettings().branchLayouts.parent).toBeUndefined();
    expect(manager.getSettings().branchLayouts.next).toEqual([
      { type: 'persona', id: 'next' },
      { type: 'persona', id: 'b' },
      { type: 'persona', id: 'a' },
    ]);
  });

  it('removes deleted personas from stored layouts and clears deleted branch roots', () => {
    const manager = new GroupManager(completeSettings({
      manualGroups: {
        parent: ['a', 'b'],
        next: ['c'],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'persona', id: 'a' },
          { type: 'persona', id: 'b' },
        ],
        next: [
          { type: 'persona', id: 'next' },
          { type: 'persona', id: 'c' },
        ],
      },
    }), vi.fn());

    expect(manager.cleanupDeletedPersonas(['parent', 'a'])).toBe(true);
    expect(manager.getSettings().branchLayouts.parent).toEqual([
      { type: 'persona', id: 'parent' },
      { type: 'persona', id: 'a' },
    ]);
    expect(manager.getSettings().branchLayouts.next).toBeUndefined();
  });

  it('promotes the branch layout to the new parent persona', () => {
    const manager = new GroupManager(completeSettings({
      manualGroups: {
        parent: ['a', 'b', 'c', 'x'],
      },
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b', 'x'], collapsed: false }],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'persona', id: 'a' },
          { type: 'subgroup', id: 'warm' },
          { type: 'persona', id: 'c' },
        ],
      },
    }), vi.fn());

    manager.promoteToParent('parent', 'b');

    expect(manager.getSettings().manualGroups).toEqual({ b: ['parent', 'a', 'c', 'x'] });
    expect(manager.getSettings().subgroups.b).toEqual([
      { id: 'warm', name: '温柔线', personaIds: ['x'], collapsed: false },
    ]);
    expect(manager.getSettings().branchLayouts.parent).toBeUndefined();
    expect(manager.getSettings().branchLayouts.b[0]).toEqual({ type: 'persona', id: 'b' });
    expect(manager.getSettings().branchLayouts.b).toContainEqual({ type: 'subgroup', id: 'warm' });
  });

  it('places a root copy beside its source in the stored branch layout', () => {
    const manager = new GroupManager(completeSettings({
      manualGroups: {
        parent: ['a', 'b', 'c'],
      },
      subgroups: {
        parent: [{ id: 'warm', name: '温柔线', personaIds: ['b'], collapsed: false }],
      },
      branchLayouts: {
        parent: [
          { type: 'persona', id: 'parent' },
          { type: 'persona', id: 'a' },
          { type: 'subgroup', id: 'warm' },
          { type: 'persona', id: 'c' },
        ],
      },
    }), vi.fn());

    manager.linkChildAfter('parent', 'copy-a', 'a');

    expect(manager.getSettings().manualGroups.parent).toEqual(['a', 'copy-a', 'b', 'c']);
    expect(manager.getSettings().branchLayouts.parent).toEqual([
      { type: 'persona', id: 'parent' },
      { type: 'persona', id: 'a' },
      { type: 'persona', id: 'copy-a' },
      { type: 'subgroup', id: 'warm' },
      { type: 'persona', id: 'c' },
    ]);
  });
});

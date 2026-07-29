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

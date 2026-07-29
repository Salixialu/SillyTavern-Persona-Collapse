import { describe, expect, it } from 'vitest';
// Vite's raw loader exposes the file contents as a default export at test runtime.
// eslint-disable-next-line import-x/default
import panelSource from '../src/index.ts?raw';

describe('persona branch panel rendering', () => {
  it('renders mixed root layouts through branch sortables', () => {
    expect(panelSource).toContain('manager.getBranchLayout(parentId, children)');
    expect(panelSource).toContain('for (const item of layout.root)');
    expect(panelSource).toContain('mountBranchSortables({');
    expect(panelSource).toContain("tUi('personaCollapse.leftListEntry', '左侧列表入口')");
    expect(panelSource).not.toContain('cp2-subgroup-select');
    expect(panelSource).not.toContain("tUi('personaCollapse.removeFromSubgroup', '移出分组')");
  });
});

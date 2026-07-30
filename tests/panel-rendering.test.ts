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
    expect(panelSource).toContain("tUi('personaCollapse.renameSubgroup', '重命名分组')");
    expect(panelSource).toContain("tUi('personaCollapse.deleteSubgroup', '删除分组')");
    expect(panelSource).toContain("subgroupId ? '' : ' cp2-root-item'");
    expect(panelSource).not.toContain('cp2-subgroup-select');
    expect(panelSource).not.toContain("tUi('personaCollapse.removeFromSubgroup', '移出分组')");
  });

  it('skips unchanged polling renders before rebuilding branch layout state', () => {
    expect(panelSource).toContain('let variantsPanelDirty = true;');
    expect(panelSource).toContain('!variantsPanelDirty && currentId === lastPanelPersonaId');
    expect(panelSource).toContain('variantsPanelDirty = true;');
    expect(panelSource).toContain('variantsPanelDirty = false;');
  });
});

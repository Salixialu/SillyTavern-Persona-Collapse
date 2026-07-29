import { describe, expect, it } from 'vitest';
// Vite's raw loader exposes the file contents as a default export at test runtime.
// eslint-disable-next-line import-x/default
import panelSource from '../src/index.ts?raw';

describe('persona branch panel rendering', () => {
  it('keeps ungrouped personas flat and offers a remove-from-group action', () => {
    expect(panelSource).toContain(
      'for (const memberId of sections.ungrouped) list.appendChild(createMemberItem(memberId, false));',
    );
    expect(panelSource).not.toContain("section.className = 'cp2-ungrouped'");
    expect(panelSource).toContain("tUi('personaCollapse.removeFromSubgroup', '移出分组')");
  });
});

/**
 * GroupManager — 人设分组状态管理
 * 持有并操作 extension_settings 中的分组数据。
 */


export type ChildMeta = Record<string, unknown>;

export interface PersonaSubgroup {
  id: string;
  name: string;
  personaIds: string[];
  collapsed: boolean;
}

export interface SubgroupSections {
  groups: PersonaSubgroup[];
  ungrouped: string[];
  ungroupedCollapsed: boolean;
}

export interface GroupSettings {
  enabled: boolean;
  manualGroups: Record<string, string[]>;
  collapsedParents: string[];
  childMeta: Record<string, ChildMeta>;
  groupNames: Record<string, string>;
  excludedFromAuto?: string[];
  autoGroupByName?: boolean;
  autoGroupByBinding?: boolean;
  subgroups: Record<string, PersonaSubgroup[]>;
  ungroupedCollapsed: string[];
  branchLayouts: Record<string, BranchLayoutItem[]>;
}

export type BranchLayoutItem = { type: 'persona'; id: string } | { type: 'subgroup'; id: string };

export interface BranchLayoutSnapshot {
  root: BranchLayoutItem[];
  subgroupMembers: Record<string, string[]>;
}

export class GroupManager {
  settings: GroupSettings;
  private saveCallback: () => void;
  private autoGroups: Record<string, string[]> = {};
  private _effectiveCache: Record<string, string[]> | null = null;

  constructor(raw: Partial<GroupSettings> | undefined, saveCallback: () => void) {
    this.saveCallback = saveCallback;
    let needsSave = false;

    this.settings = {
      enabled: raw?.enabled ?? true,
      manualGroups: raw?.manualGroups ?? {},
      collapsedParents: raw?.collapsedParents ?? [],
      childMeta: raw?.childMeta ?? {},
      groupNames: raw?.groupNames ?? {},
      excludedFromAuto: raw?.excludedFromAuto ?? [],
      autoGroupByName: raw?.autoGroupByName ?? true,
      autoGroupByBinding: raw?.autoGroupByBinding ?? true,
      subgroups: raw?.subgroups ?? {},
      ungroupedCollapsed: raw?.ungroupedCollapsed ?? [],
      branchLayouts: raw?.branchLayouts ?? {},
    };

    // 迁移旧数据：若字段缺失则补齐并保存
    if (
      !raw ||
      !raw.manualGroups ||
      !raw.childMeta ||
      !raw.collapsedParents ||
      raw.enabled === undefined ||
      !raw.groupNames ||
      !raw.excludedFromAuto ||
      raw.autoGroupByName === undefined ||
      raw.autoGroupByBinding === undefined ||
      !raw.subgroups ||
      !raw.ungroupedCollapsed ||
      !raw.branchLayouts
    ) {
      needsSave = true;
    }

    if (needsSave) setTimeout(() => this.saveCallback(), 0);
  }

  getSettings(): GroupSettings {
    return this.settings;
  }

  resetGroupingState(): void {
    this.settings.manualGroups = {};
    this.settings.collapsedParents = [];
    this.settings.childMeta = {};
    this.settings.groupNames = {};
    this.settings.excludedFromAuto = [];
    this.settings.subgroups = {};
    this.settings.ungroupedCollapsed = [];
    this.settings.branchLayouts = {};
    this._effectiveCache = null;
    this.saveCallback();
  }

  getSubgroupSections(parentId: string, effectiveChildren: string[]): SubgroupSections {
    const validIds = new Set(effectiveChildren);
    const claimed = new Set<string>();
    const groups = (this.settings.subgroups[parentId] || []).map(group => ({
      ...group,
      personaIds: group.personaIds.filter(id => {
        if (!validIds.has(id) || claimed.has(id)) return false;
        claimed.add(id);
        return true;
      }),
    }));

    return {
      groups,
      ungrouped: effectiveChildren.filter(id => !claimed.has(id)),
      ungroupedCollapsed: this.settings.ungroupedCollapsed.includes(parentId),
    };
  }

  getBranchLayout(parentId: string, effectiveChildren: string[]): BranchLayoutSnapshot {
    const sections = this.getSubgroupSections(parentId, effectiveChildren);
    const stored = this.settings.branchLayouts[parentId];
    const legacyRoot: BranchLayoutItem[] = [
      { type: 'persona', id: parentId },
      ...sections.ungrouped.map(id => ({ type: 'persona' as const, id })),
      ...sections.groups.map(group => ({ type: 'subgroup' as const, id: group.id })),
    ];
    const validPersonas = new Set([parentId, ...sections.ungrouped]);
    const validSubgroups = new Set(sections.groups.map(group => group.id));
    const seenPersonas = new Set<string>();
    const seenSubgroups = new Set<string>();
    let hasInvalidItem = false;

    if (stored?.[0]?.type === 'persona' && stored[0].id === parentId) {
      for (const item of stored) {
        if (item.type === 'persona') {
          if (!validPersonas.has(item.id) || seenPersonas.has(item.id)) hasInvalidItem = true;
          else seenPersonas.add(item.id);
        } else if (item.type === 'subgroup') {
          if (!validSubgroups.has(item.id) || seenSubgroups.has(item.id)) hasInvalidItem = true;
          else seenSubgroups.add(item.id);
        } else {
          hasInvalidItem = true;
        }
      }
    }

    const storedIsValid =
      !hasInvalidItem &&
      seenPersonas.size === validPersonas.size &&
      seenSubgroups.size === validSubgroups.size;
    const root = (storedIsValid ? stored : legacyRoot).map(item => ({ ...item }));
    return {
      root,
      subgroupMembers: Object.fromEntries(
        sections.groups.map(group => [group.id, [...group.personaIds]]),
      ),
    };
  }

  private cloneBranchLayout(root: BranchLayoutItem[]): BranchLayoutItem[] {
    return root.map(item => ({ ...item }));
  }

  private ensureBranchLayout(parentId: string, effectiveChildren: string[]): BranchLayoutItem[] {
    const stored = this.settings.branchLayouts[parentId];
    if (stored) return stored;
    const derived = this.cloneBranchLayout(this.getBranchLayout(parentId, effectiveChildren).root);
    this.settings.branchLayouts[parentId] = derived;
    return derived;
  }

  private insertPersonaBeforeFirstGroup(root: BranchLayoutItem[], personaId: string): void {
    if (root.some(item => item.type === 'persona' && item.id === personaId)) return;
    const insertAt = root.findIndex(item => item.type === 'subgroup');
    root.splice(insertAt === -1 ? root.length : insertAt, 0, { type: 'persona', id: personaId });
  }

  private movePersonaAfter(root: BranchLayoutItem[], personaId: string, targetId: string): void {
    const targetIndex = root.findIndex(item => item.type === 'persona' && item.id === targetId);
    if (targetIndex === -1) return;
    const existingIndex = root.findIndex(item => item.type === 'persona' && item.id === personaId);
    if (existingIndex !== -1) {
      root.splice(existingIndex, 1);
    }
    root.splice(targetIndex + (existingIndex !== -1 && existingIndex < targetIndex ? 0 : 1), 0, {
      type: 'persona',
      id: personaId,
    });
  }

  private removePersonaFromBranchLayouts(personaId: string): boolean {
    let changed = false;
    for (const layout of Object.values(this.settings.branchLayouts)) {
      for (let i = layout.length - 1; i >= 0; i--) {
        if (layout[i].type === 'persona' && layout[i].id === personaId) {
          layout.splice(i, 1);
          changed = true;
        }
      }
    }
    return changed;
  }

  applyBranchLayoutSnapshot(
    parentId: string,
    snapshot: BranchLayoutSnapshot,
    effectiveChildren: string[],
  ): string | null {
    const validPersonaIds = new Set([parentId, ...effectiveChildren]);
    const currentSubgroups = this.settings.subgroups[parentId] || [];
    const subgroupById = new Map(currentSubgroups.map(group => [group.id, group]));
    const validSubgroupIds = new Set(currentSubgroups.map(group => group.id));
    const nextRoot = snapshot.root.map(item => ({ ...item }));

    if (nextRoot.length === 0 || nextRoot[0].type !== 'persona' || !validPersonaIds.has(nextRoot[0].id)) {
      return null;
    }

    const seenRootPersonas = new Set<string>();
    const seenRootSubgroups = new Set<string>();
    for (const item of nextRoot) {
      if (item.type === 'persona') {
        if (!validPersonaIds.has(item.id) || seenRootPersonas.has(item.id)) return null;
        seenRootPersonas.add(item.id);
        continue;
      }
      if (!validSubgroupIds.has(item.id) || seenRootSubgroups.has(item.id)) return null;
      seenRootSubgroups.add(item.id);
    }

    if (seenRootSubgroups.size !== validSubgroupIds.size) return null;
    for (const subgroupId of Object.keys(snapshot.subgroupMembers)) {
      if (!validSubgroupIds.has(subgroupId)) return null;
    }

    const assignedPersonas = new Set(seenRootPersonas);
    const nextSubgroups: PersonaSubgroup[] = [];
    for (const item of nextRoot) {
      if (item.type !== 'subgroup') continue;
      if (!(item.id in snapshot.subgroupMembers)) return null;
      const members = snapshot.subgroupMembers[item.id];
      const seenMembers = new Set<string>();
      for (const memberId of members) {
        if (!validPersonaIds.has(memberId) || seenMembers.has(memberId) || assignedPersonas.has(memberId)) {
          return null;
        }
        seenMembers.add(memberId);
        assignedPersonas.add(memberId);
      }
      nextSubgroups.push({
        ...subgroupById.get(item.id)!,
        personaIds: [...members],
      });
    }

    if (assignedPersonas.size !== validPersonaIds.size) return null;
    if (nextSubgroups.length !== currentSubgroups.length) return null;

    const newEntry = nextRoot[0].id;
    const nextManualChildren: string[] = [];
    for (const item of nextRoot) {
      if (item.type === 'persona') {
        if (item.id !== newEntry) nextManualChildren.push(item.id);
        continue;
      }
      nextManualChildren.push(...snapshot.subgroupMembers[item.id]);
    }

    const nextManualGroups = { ...this.settings.manualGroups, [newEntry]: nextManualChildren };
    const nextBranchLayouts = { ...this.settings.branchLayouts, [newEntry]: nextRoot.map(item => ({ ...item })) };
    const nextSubgroupMap = {
      ...this.settings.subgroups,
      [newEntry]: nextSubgroups.map(group => ({ ...group, personaIds: [...group.personaIds] })),
    };
    const nextGroupNames = { ...this.settings.groupNames };
    if (parentId !== newEntry) {
      delete nextManualGroups[parentId];
      delete nextBranchLayouts[parentId];
      delete nextSubgroupMap[parentId];
      if (Object.prototype.hasOwnProperty.call(nextGroupNames, parentId)) {
        nextGroupNames[newEntry] = nextGroupNames[parentId];
        delete nextGroupNames[parentId];
      }
    }

    const wasCollapsed = this.settings.collapsedParents.includes(parentId);
    const nextCollapsedParents = this.settings.collapsedParents.filter(id => id !== parentId && id !== newEntry);
    if (wasCollapsed) nextCollapsedParents.push(newEntry);

    const wasUngroupedCollapsed = this.settings.ungroupedCollapsed.includes(parentId);
    const nextUngroupedCollapsed = this.settings.ungroupedCollapsed.filter(
      id => id !== parentId && id !== newEntry,
    );
    if (wasUngroupedCollapsed) nextUngroupedCollapsed.push(newEntry);

    this.settings.manualGroups = nextManualGroups;
    this.settings.groupNames = nextGroupNames;
    this.settings.subgroups = nextSubgroupMap;
    this.settings.branchLayouts = nextBranchLayouts;
    this.settings.collapsedParents = nextCollapsedParents;
    this.settings.ungroupedCollapsed = nextUngroupedCollapsed;
    this._effectiveCache = null;
    this.saveCallback();
    return newEntry;
  }

  private createSubgroupId(): string {
    const randomId = globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `subgroup-${randomId}`;
  }

  createSubgroup(parentId: string, name = '新分组'): PersonaSubgroup {
    const subgroup: PersonaSubgroup = {
      id: this.createSubgroupId(),
      name: name.trim() || '新分组',
      personaIds: [],
      collapsed: false,
    };
    (this.settings.subgroups[parentId] ||= []).push(subgroup);
    this.ensureBranchLayout(parentId, this.getEffectiveGroups()[parentId] ?? this.settings.manualGroups[parentId] ?? []).push({
      type: 'subgroup',
      id: subgroup.id,
    });
    this.saveCallback();
    return subgroup;
  }

  renameSubgroup(parentId: string, subgroupId: string, name: string): boolean {
    const subgroup = this.settings.subgroups[parentId]?.find(item => item.id === subgroupId);
    if (!subgroup) return false;
    subgroup.name = name.trim() || '新分组';
    this.saveCallback();
    return true;
  }

  setSubgroupCollapsed(parentId: string, subgroupId: string, collapsed: boolean): boolean {
    const subgroup = this.settings.subgroups[parentId]?.find(item => item.id === subgroupId);
    if (!subgroup) return false;
    subgroup.collapsed = collapsed;
    this.saveCallback();
    return true;
  }

  setUngroupedCollapsed(parentId: string, collapsed: boolean): void {
    this.settings.ungroupedCollapsed = this.settings.ungroupedCollapsed.filter(id => id !== parentId);
    if (collapsed) this.settings.ungroupedCollapsed.push(parentId);
    this.saveCallback();
  }

  deleteSubgroup(parentId: string, subgroupId: string): boolean {
    const groups = this.settings.subgroups[parentId];
    if (!groups) return false;
    const groupIndex = groups.findIndex(group => group.id === subgroupId);
    if (groupIndex === -1) return false;
    const deleted = groups[groupIndex];
    const layout = this.ensureBranchLayout(parentId, this.getEffectiveGroups()[parentId] ?? this.settings.manualGroups[parentId] ?? []);
    const layoutIndex = layout.findIndex(item => item.type === 'subgroup' && item.id === subgroupId);
    const next = groups.filter(group => group.id !== subgroupId);
    if (layoutIndex === -1) return false;
    if (next.length > 0) this.settings.subgroups[parentId] = next;
    else delete this.settings.subgroups[parentId];
    layout.splice(layoutIndex, 1, ...deleted.personaIds.map(id => ({ type: 'persona' as const, id })));
    this.saveCallback();
    return true;
  }

  movePersonaToSubgroup(
    parentId: string,
    personaId: string,
    subgroupId: string | null,
    effectiveChildren: string[],
  ): boolean {
    if (!effectiveChildren.includes(personaId)) return false;
    const groups = this.settings.subgroups[parentId] || [];
    const target = subgroupId === null ? null : groups.find(group => group.id === subgroupId);
    if (subgroupId !== null && !target) return false;
    const layout = this.ensureBranchLayout(parentId, effectiveChildren);

    for (const group of groups) group.personaIds = group.personaIds.filter(id => id !== personaId);
    if (target) {
      target.personaIds.push(personaId);
      const order = new Map(effectiveChildren.map((id, index) => [id, index]));
      target.personaIds.sort((a, b) =>
        (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
      this.removePersonaFromBranchLayouts(personaId);
    } else {
      this.insertPersonaBeforeFirstGroup(layout, personaId);
    }
    this.saveCallback();
    return true;
  }

  private removePersonaFromSubgroups(personaId: string, parentId?: string): boolean {
    let changed = false;
    const entries: Array<[string, PersonaSubgroup[]]> = parentId
      ? [[parentId, this.settings.subgroups[parentId] || []]]
      : Object.entries(this.settings.subgroups);
    for (const [, groups] of entries) {
      for (const group of groups) {
        const next = group.personaIds.filter(id => id !== personaId);
        if (next.length !== group.personaIds.length) {
          group.personaIds = next;
          changed = true;
        }
      }
    }
    return changed;
  }

  private clearSubgroupState(parentId: string): boolean {
    const hadGroups = this.settings.subgroups[parentId] !== undefined;
    delete this.settings.subgroups[parentId];
    const before = this.settings.ungroupedCollapsed.length;
    this.settings.ungroupedCollapsed = this.settings.ungroupedCollapsed.filter(id => id !== parentId);
    const hadLayout = this.settings.branchLayouts[parentId] !== undefined;
    delete this.settings.branchLayouts[parentId];
    return hadGroups || before !== this.settings.ungroupedCollapsed.length || hadLayout;
  }

  placeCopyInSourceSubgroup(parentId: string, sourceId: string, copyId: string): void {
    const sourceGroup = this.settings.subgroups[parentId]?.find(group => group.personaIds.includes(sourceId));
    if (!sourceGroup) return;
    this.removePersonaFromSubgroups(copyId, parentId);
    this.removePersonaFromBranchLayouts(copyId);
    const sourceIndex = sourceGroup.personaIds.indexOf(sourceId);
    sourceGroup.personaIds.splice(sourceIndex + 1, 0, copyId);
    this.saveCallback();
  }

  private subgroupIdFor(parentId: string, personaId: string): string | null {
    return this.settings.subgroups[parentId]?.find(group => group.personaIds.includes(personaId))?.id ?? null;
  }

  canReorderWithinSection(parentId: string, sourceId: string, targetId: string): boolean {
    return this.subgroupIdFor(parentId, sourceId) === this.subgroupIdFor(parentId, targetId);
  }

  reorderWithinSubgroup(parentId: string, sourceId: string, targetId: string): boolean {
    const subgroupId = this.subgroupIdFor(parentId, sourceId);
    if (!subgroupId || subgroupId !== this.subgroupIdFor(parentId, targetId)) return false;
    const group = this.settings.subgroups[parentId].find(item => item.id === subgroupId)!;
    const sourceIndex = group.personaIds.indexOf(sourceId);
    const targetIndex = group.personaIds.indexOf(targetId);
    group.personaIds.splice(sourceIndex, 1);
    group.personaIds.splice(targetIndex, 0, sourceId);
    this.saveCallback();
    return true;
  }

  setAutoGroups(groups: Record<string, string[]>): void {
    this.autoGroups = groups;
    this._effectiveCache = null;
  }

  getEffectiveGroups(): Record<string, string[]> {
    if (this._effectiveCache) return this._effectiveCache;
    const effective: Record<string, string[]> = JSON.parse(JSON.stringify(this.settings.manualGroups));
    const excluded = this.settings.excludedFromAuto || [];

    for (const [parentId, children] of Object.entries(this.autoGroups)) {
      let parentIsManual = false;
      if (this.settings.manualGroups[parentId]) parentIsManual = true;
      for (const group of Object.values(this.settings.manualGroups)) {
        if (group.includes(parentId)) parentIsManual = true;
      }
      if (parentIsManual || excluded.includes(parentId)) continue;

      const validChildren = children.filter(c => {
        let isManual = false;
        if (this.settings.manualGroups[c]) isManual = true;
        for (const group of Object.values(this.settings.manualGroups)) {
          if (group.includes(c)) isManual = true;
        }
        return !isManual && !excluded.includes(c);
      });

      if (validChildren.length > 0) {
        if (!effective[parentId]) effective[parentId] = [];
        effective[parentId].push(...validChildren);
      }
    }
    this._effectiveCache = effective;
    return effective;
  }

  /** 判断 id 是否为独立人设（不是组长，也不是分支成员） */
  isIndependent(id: string): boolean {
    const effective = this.getEffectiveGroups();
    if (effective[id] !== undefined) return false;
    for (const children of Object.values(effective)) {
      if (children.includes(id)) return false;
    }
    return true;
  }

  /** 判断 id 是否为组长 */
  isParent(id: string): boolean {
    return this.getEffectiveGroups()[id] !== undefined;
  }

  /** 将 id 初始化为组长（空分支），无分支成员 */
  initGroup(parentId: string): void {
    if (this.settings.manualGroups[parentId] !== undefined) return;
    this.settings.manualGroups[parentId] = [];
    this._effectiveCache = null;
    this.saveCallback();
  }

  /** 将 childId 加入 parentId 的分支 */
  linkChild(parentId: string, childId: string): void {
    if (parentId === childId) return;

    if (this.settings.excludedFromAuto) {
      this.settings.excludedFromAuto = this.settings.excludedFromAuto.filter(x => x !== childId && x !== parentId);
    }

    // 若 childId 已是某组组长，先解散该组
    if (this.settings.manualGroups[childId]) {
      this._disbandGroupInternal(childId);
    }

    this.removePersonaFromSubgroups(childId);
    this.removePersonaFromBranchLayouts(childId);

    // 从其他分支中移除 childId
    for (const [pid, children] of Object.entries(this.settings.manualGroups)) {
      const idx = children.indexOf(childId);
      if (idx !== -1) {
        children.splice(idx, 1);
        if (children.length === 0) {
          delete this.settings.manualGroups[pid];
          delete this.settings.groupNames[pid];
          this.settings.collapsedParents = this.settings.collapsedParents.filter(p => p !== pid);
          this.clearSubgroupState(pid);
        }
      }
    }

    if (!this.settings.manualGroups[parentId]) {
      this.settings.manualGroups[parentId] = [];
    }
    if (!this.settings.manualGroups[parentId].includes(childId)) {
      this.settings.manualGroups[parentId].push(childId);
    }
    this.insertPersonaBeforeFirstGroup(this.ensureBranchLayout(parentId, this.settings.manualGroups[parentId]), childId);
    this._effectiveCache = null;
    this.saveCallback();
  }

  /** 将 childId 加入 parentId，并插入到 targetId 后面；targetId 为 parentId 时放到首位 */
  linkChildAfter(parentId: string, childId: string, targetId: string): void {
    if (parentId === childId) return;
    this.linkChild(parentId, childId);

    const children = this.settings.manualGroups[parentId];
    if (!children) return;

    const oldIdx = children.indexOf(childId);
    if (oldIdx !== -1) children.splice(oldIdx, 1);

    if (targetId === parentId) {
      children.unshift(childId);
    } else {
      const targetIdx = children.indexOf(targetId);
      if (targetIdx === -1) {
        children.push(childId);
      } else {
        children.splice(targetIdx + 1, 0, childId);
      }
    }

    const sourceGroupId = this.subgroupIdFor(parentId, targetId);
    if (!sourceGroupId) {
      this.movePersonaAfter(this.ensureBranchLayout(parentId, children), childId, targetId);
    }

    this._effectiveCache = null;
    this.saveCallback();
  }

  /** 将 childId 从所有分支中移除 */
  unlinkChild(childId: string): void {
    let changed = false;
    
    // 加入排除名单，防止被再次自动吸附
    if (!this.settings.excludedFromAuto) this.settings.excludedFromAuto = [];
    if (!this.settings.excludedFromAuto.includes(childId)) {
      this.settings.excludedFromAuto.push(childId);
      changed = true;
    }

    for (const [parentId, children] of Object.entries(this.settings.manualGroups)) {
      const idx = children.indexOf(childId);
      if (idx !== -1) {
        children.splice(idx, 1);
        if (children.length === 0) {
          delete this.settings.manualGroups[parentId];
          delete this.settings.groupNames[parentId];
          this.settings.collapsedParents = this.settings.collapsedParents.filter(p => p !== parentId);
          this.clearSubgroupState(parentId);
        }
        changed = true;
      }
    }
    if (this.removePersonaFromSubgroups(childId)) changed = true;
    if (this.removePersonaFromBranchLayouts(childId)) changed = true;
    if (this.settings.childMeta[childId]) {
      delete this.settings.childMeta[childId];
      changed = true;
    }
    if (changed) {
      this._effectiveCache = null;
      this.saveCallback();
    }
  }

  /** 在 parentId 的分支中，将 childId 移动到 targetId 的前面。若 targetId 为 null 则移到末尾 */
  reorderChild(parentId: string, childId: string, targetId: string | null): void {
    const children = this.settings.manualGroups[parentId];
    if (!children) return;
    const oldIdx = children.indexOf(childId);
    if (oldIdx === -1) return;
    children.splice(oldIdx, 1);

    if (targetId) {
      const newIdx = children.indexOf(targetId);
      if (newIdx !== -1) {
        children.splice(newIdx, 0, childId);
      } else {
        children.push(childId);
      }
    } else {
      children.push(childId);
    }
    this._effectiveCache = null;
    this.saveCallback();
  }

  /** 将某个分支成员提升为组长，原组长降级为分支成员 */
  promoteToParent(oldParentId: string, newParentId: string): void {
    const children = this.settings.manualGroups[oldParentId];
    if (!children) return;
    const idx = children.indexOf(newParentId);
    if (idx === -1) return;

    // Capture the mixed layout before moving subgroup ownership to the new entry.
    const promotedLayout = this.cloneBranchLayout(this.getBranchLayout(oldParentId, children).root);
    
    // 从子节点中移除新的组长，加入旧组长
    children.splice(idx, 1);
    // 默认放到子节点第一位
    children.unshift(oldParentId);
    
    // 移交组长权限
    this.settings.manualGroups[newParentId] = children;
    delete this.settings.manualGroups[oldParentId];
    
    // 迁移群组名
    if (this.settings.groupNames[oldParentId]) {
      this.settings.groupNames[newParentId] = this.settings.groupNames[oldParentId];
      delete this.settings.groupNames[oldParentId];
    }

    const promotedSubgroups = this.settings.subgroups[oldParentId];
    if (promotedSubgroups) {
      this.settings.subgroups[newParentId] = promotedSubgroups;
      delete this.settings.subgroups[oldParentId];
      this.removePersonaFromSubgroups(newParentId, newParentId);
    }
    const wasUngroupedCollapsed = this.settings.ungroupedCollapsed.includes(oldParentId);
    this.settings.ungroupedCollapsed = this.settings.ungroupedCollapsed.filter(id => id !== oldParentId);
    if (wasUngroupedCollapsed) this.settings.ungroupedCollapsed.push(newParentId);
    
    // 迁移折叠状态
    if (this.settings.collapsedParents.includes(oldParentId)) {
      this.settings.collapsedParents = this.settings.collapsedParents.filter(p => p !== oldParentId);
      this.settings.collapsedParents.push(newParentId);
    }

    const firstPersonaIndex = promotedLayout.findIndex(item => item.type === 'persona');
    if (firstPersonaIndex === -1) {
      promotedLayout.unshift({ type: 'persona', id: newParentId });
    } else {
      promotedLayout[firstPersonaIndex] = { type: 'persona', id: newParentId };
    }
    this.settings.branchLayouts[newParentId] = promotedLayout.filter(
      (item, index) => item.type !== 'persona' || item.id !== oldParentId || index === firstPersonaIndex,
    );
    delete this.settings.branchLayouts[oldParentId];
    
    this._effectiveCache = null;
    this.saveCallback();
  }

  /** 解散一个分组 */
  disbandGroup(parentId: string): void {
    const effective = this.getEffectiveGroups();
    const children = effective[parentId];
    if (children) {
      if (!this.settings.excludedFromAuto) this.settings.excludedFromAuto = [];
      if (!this.settings.excludedFromAuto.includes(parentId)) this.settings.excludedFromAuto.push(parentId);
      for (const child of children) {
         if (!this.settings.excludedFromAuto.includes(child)) this.settings.excludedFromAuto.push(child);
      }
    }
    this._disbandGroupInternal(parentId);
    this.clearSubgroupState(parentId);
    this._effectiveCache = null;
    this.saveCallback();
  }

  private _disbandGroupInternal(parentId: string): boolean {
    const children = this.settings.manualGroups[parentId];
    if (!children) return false;
    for (const child of children) {
      if (this.settings.childMeta[child]) delete this.settings.childMeta[child];
    }
    delete this.settings.manualGroups[parentId];
    delete this.settings.groupNames[parentId];
    this.settings.collapsedParents = this.settings.collapsedParents.filter(p => p !== parentId);
    this.clearSubgroupState(parentId);
    return true;
  }


  /** 设置分组名称 */
  setGroupName(parentId: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed === '') {
      delete this.settings.groupNames[parentId];
    } else {
      this.settings.groupNames[parentId] = trimmed;
    }
    this.saveCallback();
  }

  /** 获取分组名称（回退到人设显示名） */
  getGroupName(parentId: string, fallback: string): string {
    return this.settings.groupNames[parentId] || fallback;
  }

  /** 找到 childId 所属的组长 id，若无则返回 null */
  findParentOf(childId: string): string | null {
    const effective = this.getEffectiveGroups();
    for (const [parentId, children] of Object.entries(effective)) {
      if (children.includes(childId)) return parentId;
    }
    return null;
  }

  /** 清理已删除的人设 */
  cleanupDeletedPersonas(existingIds: string[]): boolean {
    let changed = false;
    const existing = new Set(existingIds);

    // 清理组长
    for (const parentId of Object.keys(this.settings.manualGroups)) {
      if (!existing.has(parentId)) {
        const children = this.settings.manualGroups[parentId];
        const layout = this.getBranchLayout(parentId, children);
        const rootReplacement = layout.root.find(
          item => item.type === 'persona' && item.id !== parentId && existing.has(item.id),
        );
        let replacementId = rootReplacement?.type === 'persona' ? rootReplacement.id : null;
        if (!replacementId) {
          for (const item of layout.root) {
            if (item.type !== 'subgroup') continue;
            replacementId = layout.subgroupMembers[item.id]?.find(id => existing.has(id)) ?? null;
            if (replacementId) break;
          }
        }
        if (replacementId) {
          this.promoteToParent(parentId, replacementId);
        } else {
          this._disbandGroupInternal(parentId);
        }
        changed = true;
      }
    }

    // 清理分支成员
    for (const parentId of Object.keys(this.settings.manualGroups)) {
      const children = this.settings.manualGroups[parentId];
      const before = children.length;
      this.settings.manualGroups[parentId] = children.filter(c => {
        if (!existing.has(c)) {
          if (this.settings.childMeta[c]) delete this.settings.childMeta[c];
          return false;
        }
        return true;
      });
      if (this.settings.manualGroups[parentId].length !== before) {
        changed = true;
        if (this.settings.manualGroups[parentId].length === 0) {
          delete this.settings.manualGroups[parentId];
          delete this.settings.groupNames[parentId];
          this.settings.collapsedParents = this.settings.collapsedParents.filter(p => p !== parentId);
          this.clearSubgroupState(parentId);
        }
      }
    }

    // 清理孤立 collapsedParents
    const before = this.settings.collapsedParents.length;
    this.settings.collapsedParents = this.settings.collapsedParents.filter(p => existing.has(p));
    if (this.settings.collapsedParents.length !== before) changed = true;

    // 清理孤立 childMeta
    for (const id of Object.keys(this.settings.childMeta)) {
      if (!existing.has(id)) { delete this.settings.childMeta[id]; changed = true; }
    }

    // 清理孤立 groupNames
    for (const id of Object.keys(this.settings.groupNames)) {
      if (!existing.has(id)) { delete this.settings.groupNames[id]; changed = true; }
    }

    for (const parentId of Object.keys(this.settings.subgroups)) {
      if (!existing.has(parentId)) {
        if (this.clearSubgroupState(parentId)) changed = true;
        continue;
      }
      for (const group of this.settings.subgroups[parentId]) {
        const next = group.personaIds.filter(id => existing.has(id));
        if (next.length !== group.personaIds.length) {
          group.personaIds = next;
          changed = true;
        }
      }
    }

    for (const [parentId, layout] of Object.entries(this.settings.branchLayouts)) {
      const before = layout.length;
      this.settings.branchLayouts[parentId] = layout.filter(
        item => item.type !== 'persona' || existing.has(item.id),
      );
      if (this.settings.branchLayouts[parentId].length !== before) changed = true;
    }

    if (changed) {
      this._effectiveCache = null;
      this.saveCallback();
    }
    return changed;
  }
}

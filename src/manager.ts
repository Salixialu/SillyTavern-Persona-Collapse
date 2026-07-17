/**
 * GroupManager — 人设分组状态管理
 * 持有并操作 extension_settings 中的分组数据。
 */


export type ChildMeta = Record<string, unknown>;

export interface GroupSettings {
  enabled: boolean;
  manualGroups: Record<string, string[]>;
  collapsedParents: string[];
  childMeta: Record<string, ChildMeta>;
  groupNames: Record<string, string>;
  excludedFromAuto?: string[];
  autoGroupByName?: boolean;
  autoGroupByBinding?: boolean;
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
      raw.autoGroupByBinding === undefined
    ) {
      needsSave = true;
    }

    if (needsSave) setTimeout(() => this.saveCallback(), 0);
  }

  getSettings(): GroupSettings {
    return this.settings;
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

    // 从其他分支中移除 childId
    for (const [pid, children] of Object.entries(this.settings.manualGroups)) {
      const idx = children.indexOf(childId);
      if (idx !== -1) {
        children.splice(idx, 1);
        if (children.length === 0) {
          delete this.settings.manualGroups[pid];
          delete this.settings.groupNames[pid];
          this.settings.collapsedParents = this.settings.collapsedParents.filter(p => p !== pid);
        }
      }
    }

    if (!this.settings.manualGroups[parentId]) {
      this.settings.manualGroups[parentId] = [];
    }
    if (!this.settings.manualGroups[parentId].includes(childId)) {
      this.settings.manualGroups[parentId].push(childId);
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
        }
        changed = true;
      }
    }
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
    
    // 迁移折叠状态
    if (this.settings.collapsedParents.includes(oldParentId)) {
      this.settings.collapsedParents = this.settings.collapsedParents.filter(p => p !== oldParentId);
      this.settings.collapsedParents.push(newParentId);
    }
    
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
    return true;
  }


  /** 设置分组名称 */
  setGroupName(parentId: string, name: string): void {
    if (!this.settings.manualGroups[parentId]) return;
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
        this._disbandGroupInternal(parentId);
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

    if (changed) {
      this._effectiveCache = null;
      this.saveCallback();
    }
    return changed;
  }
}

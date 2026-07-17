import { extension_settings } from 'sillytavern/extensions';
import { default_user_avatar, eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from 'sillytavern/script';
import { power_user } from 'sillytavern/power-user';
import { POPUP_TYPE, Popup } from 'sillytavern/popup';
import { GroupManager } from './manager';

// ==================== 常量 ====================

const SETTINGS_KEY = 'collapsible_personas_v3';
const LOG_PREFIX = '[PersonaCollapse]';

// ==================== 状态 ====================

let manager: GroupManager;
let setUserAvatarFn: ((id: string) => Promise<void>) | null = null;
/** personas.js 模块引用，通过 live binding 直接读 user_avatar */
let personasModule: {
  getUserAvatars?: (doRender?: boolean, openPageAt?: string) => Promise<string[]>;
  initPersona?: (
    avatarId: string,
    personaName: string,
    personaDescription: string,
    personaTitle: string,
    options?: Record<string, unknown>,
  ) => Promise<void>;
  setUserAvatar?: (id: string) => Promise<void>;
  user_avatar?: string;
  [k: string]: any;
} | null = null;

// ==================== ST API 懒加载 ====================

async function loadPersonasApi(): Promise<void> {
  if (personasModule) return;
  try {
    personasModule = await import(/* webpackIgnore: true */ '/scripts/personas.js' as any);
    setUserAvatarFn = personasModule!.setUserAvatar ?? null;
  } catch (e) {
    console.warn(LOG_PREFIX, '无法加载 personas.js:', e);
  }
}


// ==================== 人设工具函数 ====================

/** 从 avatar-container 中提取 avatar id */
function getAvatarId(el: Element): string | null {
  const inner = el.querySelector('[data-avatar-id]') as HTMLElement | null;
  if (inner?.dataset.avatarId) return inner.dataset.avatarId;
  return (el as HTMLElement).dataset?.avatarId || null;
}

/** 获取人设显示名 */
function getPersonaName(id: string): string {
  const name = (power_user.personas || {})[id];
  if (typeof name !== 'string' || name.length > 200 || name.includes('\n')) return id;
  return name || id;
}

/** 获取人设标题（persona_descriptions.title） */
function getPersonaTitle(id: string): string {
  return (power_user.persona_descriptions || {})[id]?.title || '';
}

/** 获取人设绑定的信息（角色、聊天、群组） */
function getPersonaBindings(id: string): Array<{ type: string; id: string }> {
  return (power_user.persona_descriptions || {})[id]?.connections ?? [];
}

/** 获取头像缩略图 URL */
function getThumbUrl(id: string): string {
  return '/thumbnail?type=persona&file=' + encodeURIComponent(id);
}

function getDefaultGroupTitle(): string {
  return '人设分支';
}

function getDisplayGroupTitle(parentId: string): string {
  return manager.getGroupName(parentId, getDefaultGroupTitle());
}

function buildCopyName(sourceName: string): string {
  const base = `${sourceName}_副本`;
  const existingNames = new Set(Object.values(power_user.personas || {}));
  if (!existingNames.has(base)) return base;

  let index = 2;
  while (existingNames.has(`${base}${index}`)) index++;
  return `${base}${index}`;
}

function buildAvatarId(personaName: string): string {
  const safeName = personaName.replace(/[^a-zA-Z0-9]/g, '') || 'persona';
  let avatarId = `${Date.now()}-${safeName}.png`;
  let index = 2;
  while (power_user.personas?.[avatarId]) {
    avatarId = `${Date.now()}-${safeName}-${index}.png`;
    index++;
  }
  return avatarId;
}

async function uploadPersonaAvatar(sourceUrl: string, avatarId: string): Promise<void> {
  const fetchResult = await fetch(sourceUrl);
  if (!fetchResult.ok) {
    throw new Error(`Failed to fetch avatar: ${fetchResult.statusText}`);
  }

  const blob = await fetchResult.blob();
  const file = new File([blob], 'avatar.png', { type: blob.type || 'image/png' });
  const formData = new FormData();
  formData.append('avatar', file);
  formData.append('overwrite_name', avatarId);

  const response = await fetch('/api/avatars/upload', {
    method: 'POST',
    headers: getRequestHeaders({ omitContentType: true }),
    cache: 'no-cache',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload avatar: ${response.statusText}`);
  }
}

async function createPersonaRecord(
  avatarId: string,
  sourceId: string,
  newName: string,
): Promise<void> {
  await loadPersonasApi();

  const source = (power_user.persona_descriptions || {})[sourceId] || {};
  const description = typeof source.description === 'string' ? source.description : '';
  const title = typeof source.title === 'string' ? source.title : '';
  const options = {
    depth: source.depth,
    lorebook: source.lorebook,
    position: source.position,
    role: source.role,
    silent: false,
  };

  if (personasModule?.initPersona) {
    await personasModule.initPersona(avatarId, newName, description, title, options);
  } else {
    power_user.personas[avatarId] = newName;
    power_user.persona_descriptions[avatarId] = {
      description,
      depth: source.depth,
      lorebook: source.lorebook || '',
      position: source.position,
      role: source.role,
      title,
    };
    saveSettingsDebounced();
    await eventSource.emit(event_types.PERSONA_CREATED, { avatarId, name: newName, description, title });
  }
}

async function duplicatePersonaIntoGroup(parentId: string, sourceId: string): Promise<void> {
  const sourceName = getPersonaName(sourceId);
  const newName = buildCopyName(sourceName);
  const avatarId = buildAvatarId(newName);
  let usedFallbackAvatar = false;

  try {
    await uploadPersonaAvatar(getThumbUrl(sourceId), avatarId);
  } catch (e) {
    console.warn(LOG_PREFIX, '复制头像失败，改用默认头像:', e);
    usedFallbackAvatar = true;
    try {
      await uploadPersonaAvatar(default_user_avatar, avatarId);
    } catch (fallbackError) {
      console.warn(LOG_PREFIX, '默认头像上传失败，将仅创建人设记录:', fallbackError);
    }
  }

  await createPersonaRecord(avatarId, sourceId, newName);
  manager.linkChildAfter(parentId, avatarId, sourceId);
  await personasModule?.getUserAvatars?.(true, parentId);
  renderAvatarBlock();
  renderVariantsPanel(true);

  const suffix = usedFallbackAvatar ? '，头像使用默认头像' : '';
  toastr.success(`已复制为【${newName}】并加入人设分支${suffix}`);
}

/** 切换到指定人设 */
async function switchToPersona(id: string): Promise<void> {
  await loadPersonasApi();
  if (setUserAvatarFn) {
    try {
      // 不使用 navigateToCurrent，避免 ST 重建头像列表导致闪烁
      await setUserAvatarFn(id);
      return;
    } catch (_) { /* fallthrough */ }
  }
  // 回退：临时移除隐藏类后模拟点击
  const el =
    document.querySelector(`#user_avatar_block .avatar-container[data-avatar-id="${CSS.escape(id)}"]`) ||
    [...document.querySelectorAll('#user_avatar_block .avatar-container')].find(c => getAvatarId(c) === id);
  if (el) {
    el.classList.remove('cp2-hidden-branch');
    if ((window as any).jQuery) {
      (window as any).jQuery(el).trigger('click');
    } else {
      (el as HTMLElement).click();
    }
  }
}


// ==================== 渲染：头像列表 ====================

let isRendering = false;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let branchStyleEl: HTMLStyleElement | null = null;
let lastBranchChildIds: string | null = null;

/**
 * 将分支成员的隐藏规则写入 <style> 标签。
 * 纴CSS 生效，完全不依赖 JS 时序——ST 重建头像列表时新元素刚插入即被隐藏，不会逗一前值顾闪烁。
 */
function updateBranchHideCSS(): void {
  if (!branchStyleEl) {
    branchStyleEl = document.createElement('style');
    branchStyleEl.id = 'cp2-branch-hide';
    document.head.appendChild(branchStyleEl);
  }

  const settings = manager?.getSettings();
  if (!settings?.enabled) {
    branchStyleEl.textContent = '';
    return;
  }

  const effectiveGroups = manager.getEffectiveGroups();
  const childIds = Object.values(effectiveGroups).flat();
  const key = childIds.join(',');
  if (key === lastBranchChildIds) return;
  lastBranchChildIds = key;

  branchStyleEl.textContent = childIds
    .map(id => `#user_avatar_block .avatar-container[data-avatar-id="${CSS.escape(id)}"] { display: none !important; }`)
    .join('\n');
}

function scheduleRender(): void {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(renderAvatarBlock, 80);
}

function updateAutoGroups(): void {
  const allIds = Array.from(document.querySelectorAll('#user_avatar_block .avatar-container'))
    .map(getAvatarId).filter(Boolean) as string[];

  const charMap: Record<string, string[]> = {};
  const prefixMap: Record<string, string[]> = {};

  if (!power_user.persona_descriptions || !power_user.personas) return;

  const s = manager.getSettings();

  for (const id of allIds) {
    if (s.excludedFromAuto?.includes(id)) continue;

    if (s.autoGroupByBinding ?? true) {
      const connections = power_user.persona_descriptions[id]?.connections || [];
      const charConns = connections.filter((c: any) => c.type === 'character').map((c: any) => c.id);
      if (charConns.length > 0) {
        const charId = charConns[0];
        if (!charMap[charId]) charMap[charId] = [];
        charMap[charId].push(id);
      }
    }

    if (s.autoGroupByName ?? true) {
      const name = power_user.personas[id] || '';
      // 1. 完全同名
      const baseName = name.trim();
      if (baseName.length > 0) {
        if (!prefixMap[baseName]) prefixMap[baseName] = [];
        if (!prefixMap[baseName].includes(id)) prefixMap[baseName].push(id);
      }
      
      // 2. 前缀（如 Alice - NSFW）
      const match = name.match(/^(.+?)\s*[-_]\s*.+$/);
      if (match) {
        const prefix = match[1].trim();
        if (prefix.length > 1) {
          if (!prefixMap[prefix]) prefixMap[prefix] = [];
          if (!prefixMap[prefix].includes(id)) prefixMap[prefix].push(id);
        }
      }
    }
  }

  const sortByCreation = (ids: string[]) => ids.sort((a, b) => {
    const ta = parseInt(a.split('-')[0]) || 0;
    const tb = parseInt(b.split('-')[0]) || 0;
    return ta - tb;
  });

  const autoGroups: Record<string, string[]> = {};

  for (const ids of Object.values(charMap)) {
    if (ids.length > 1) {
      sortByCreation(ids);
      const parentId = ids[0];
      if (!autoGroups[parentId]) autoGroups[parentId] = [];
      for (const child of ids.slice(1)) {
        if (!autoGroups[parentId].includes(child)) autoGroups[parentId].push(child);
      }
    }
  }

  for (const ids of Object.values(prefixMap)) {
    if (ids.length > 1) {
      sortByCreation(ids);
      const parentId = ids[0];
      if (!autoGroups[parentId]) autoGroups[parentId] = [];
      for (const child of ids.slice(1)) {
        let alreadyGrouped = false;
        for (const existing of Object.values(autoGroups)) {
          if (existing.includes(child)) alreadyGrouped = true;
        }
        if (!alreadyGrouped && !autoGroups[parentId].includes(child)) {
          autoGroups[parentId].push(child);
        }
      }
    }
  }

  manager.setAutoGroups(autoGroups);
}

function renderAvatarBlock(): void {
  const block = document.getElementById('user_avatar_block');
  if (!block || isRendering) return;
  const settings = manager?.getSettings();
  if (!settings) return;

  updateAutoGroups();

  // 先同步 CSS 隐藏规则（不依赖 DOM 时序）
  updateBranchHideCSS();

  isRendering = true;
  try {
    // 重置所有状态（仅需处理角标，隐藏由 CSS 负责）
    block.querySelectorAll('.avatar-container').forEach(el => {
      el.classList.remove('cp2-parent-badge');
      el.removeAttribute('data-branch-count');
      el.setAttribute('draggable', 'true');
    });

    if (!settings.enabled) return;

    manager.cleanupDeletedPersonas(Object.keys(power_user.personas || {}));

    const containers = Array.from(block.querySelectorAll(':scope > .avatar-container'));
    const idToEl = new Map<string, Element>();
    for (const el of containers) {
      const id = getAvatarId(el);
      if (id && !idToEl.has(id)) idToEl.set(id, el);
    }

    // 角标基于数据层，不依赖 DOM 存在
    const effectiveGroups = manager.getEffectiveGroups();
    for (const [parentId, children] of Object.entries(effectiveGroups)) {
      const parentEl = idToEl.get(parentId);
      if (parentEl && children.length > 0) {
        parentEl.classList.add('cp2-parent-badge');
        parentEl.setAttribute('data-branch-count', String(children.length));
      }
    }
  } finally {
    requestAnimationFrame(() => { isRendering = false; });
  }
}

// ==================== 渲染：详情页马甲面板 ====================

let lastPanelPersonaId: string | null = null;
let lastPanelGroupKey: string | null = null;
let editingGroupNameParentId: string | null = null;

function renderVariantsPanel(force = false, currentIdOverride: string | null = null): void {
  const selectedEl = document.querySelector('#user_avatar_block .avatar-container.selected');
  // 优先级： override > DOM .selected > ST 模块 user_avatar live binding
  // 后者确保分页切换后、分支成员在其他页时，500ms 轮询仍能就地读取当前人设
  const currentId = currentIdOverride
    ?? (selectedEl ? getAvatarId(selectedEl) : null)
    ?? (personasModule?.user_avatar || null);

  // --- 确保面板容器存在 ---
  let panel = document.getElementById('cp2-variants-panel');
  if (!panel) {
    const area = document.querySelector('.persona_management_current_persona');
    if (!area) return;
    panel = document.createElement('div');
    panel.id = 'cp2-variants-panel';
    const controls = document.getElementById('persona_controls');
    if (controls) {
      area.insertBefore(panel, controls.nextSibling);
    } else {
      area.appendChild(panel);
    }
  }

  const settings = manager?.getSettings();
  if (!settings?.enabled || !currentId) {
    panel.style.display = 'none';
    return;
  }

  // 找到该人设的分组上下文
  const effectiveGroups = manager.getEffectiveGroups();
  const parentId = manager.findParentOf(currentId) || currentId;
  const children = effectiveGroups[parentId];

  // 独立人设：隐藏马甲面板

  if (!children || children.length === 0) {
    // 独立人设：只显示管理按钮，方便快速组建分支
    panel.style.display = 'block';
    panel.innerHTML = `
      <div class="cp2-variants-header" style="justify-content: center; padding: 5px;">
        <button class="menu_button cp2-variants-add-btn" id="cp2-add-branch-btn" style="width:100%; margin:0; display:flex; justify-content:center; align-items:center; gap:8px;" title="组建或管理当前角色的分支">
          <i class="fa-solid fa-users-gear"></i> 管理分支卡片
        </button>
      </div>
    `;
    
    panel.querySelector('#cp2-add-branch-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openGroupManager(parentId);
    });

    lastPanelPersonaId = currentId;
    lastPanelGroupKey = null;
    return;
  }

  const groupTitle = getDisplayGroupTitle(parentId);
  const groupKey = `${parentId}:${groupTitle}:${children.join(',')}`;
  if (!force && currentId === lastPanelPersonaId && groupKey === lastPanelGroupKey) return;

  panel.style.display = 'block';

  const allMembers = [parentId, ...(effectiveGroups[parentId] || [])];
  const isEditingTitle = editingGroupNameParentId === parentId;

  // 构建 header
  const headerHTML = `
    <div class="cp2-variants-header">
      <div class="cp2-variants-title-wrap">
        ${isEditingTitle ? `
          <input class="text_pole cp2-group-title-input" id="cp2-group-title-input" value="${escapeHtml(groupTitle === getDefaultGroupTitle() ? '' : groupTitle)}" placeholder="${getDefaultGroupTitle()}">
          <button class="cp2-icon-btn" id="cp2-save-group-title" title="保存标题"><i class="fa-solid fa-check"></i></button>
          <button class="cp2-icon-btn" id="cp2-cancel-group-title" title="取消"><i class="fa-solid fa-xmark"></i></button>
        ` : `
          <span class="cp2-variants-header-title">🎭 ${escapeHtml(groupTitle)} (${allMembers.length})</span>
          <button class="cp2-icon-btn" id="cp2-edit-group-title" title="重命名人设分支"><i class="fa-solid fa-pencil"></i></button>
        `}
      </div>
      <div class="cp2-variants-header-actions">
        <button class="cp2-variants-add-btn" id="cp2-add-branch-btn" title="批量管理此分支" style="border-radius: 4px; padding: 2px 8px;">
          <i class="fa-solid fa-users-gear"></i> 管理
        </button>
      </div>
    </div>
    <div class="cp2-variants-list"></div>
  `;
  panel.innerHTML = headerHTML;

  // ➕ 按钮事件（打开批量管理面板）
  panel.querySelector('#cp2-add-branch-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    openGroupManager(parentId);
  });

  panel.querySelector('#cp2-edit-group-title')?.addEventListener('click', e => {
    e.stopPropagation();
    editingGroupNameParentId = parentId;
    renderVariantsPanel(true);
  });

  const titleInput = panel.querySelector<HTMLInputElement>('#cp2-group-title-input');
  const saveTitle = () => {
    manager.setGroupName(parentId, titleInput?.value || '');
    editingGroupNameParentId = null;
    renderVariantsPanel(true);
  };
  const cancelTitle = () => {
    editingGroupNameParentId = null;
    renderVariantsPanel(true);
  };
  panel.querySelector('#cp2-save-group-title')?.addEventListener('click', e => {
    e.stopPropagation();
    saveTitle();
  });
  panel.querySelector('#cp2-cancel-group-title')?.addEventListener('click', e => {
    e.stopPropagation();
    cancelTitle();
  });
  titleInput?.addEventListener('click', e => e.stopPropagation());
  titleInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelTitle();
    }
  });
  titleInput?.focus();

  // 渲染成员列表
  const list = panel.querySelector('.cp2-variants-list')!;
  for (const memberId of allMembers) {
    const isCurrentUser = memberId === currentId;
    const isMainCard = memberId === parentId;

    const item = document.createElement('div');
    item.className = 'cp2-variant-item' + (isCurrentUser ? ' active' : '');

    const avatar = document.createElement('img');
    avatar.src = getThumbUrl(memberId);
    avatar.className = 'cp2-variant-avatar';
    avatar.onerror = () => { avatar.src = '/img/ai4.png'; };

    const dragHandle = document.createElement('i');
    dragHandle.className = 'fa-solid fa-bars cp2-variant-drag-handle';
    dragHandle.title = '拖拽排序';
    if (isMainCard) {
      dragHandle.style.visibility = 'hidden'; // 主卡固定在第一位，不可拖拽
    } else {
      item.draggable = true;
      item.dataset.variantId = memberId;
      item.addEventListener('dragstart', e => {
        e.dataTransfer?.setData('text/plain', memberId);
        item.style.opacity = '0.5';
      });
      item.addEventListener('dragend', () => {
        item.style.opacity = '1';
        document.querySelectorAll('.cp2-variant-item').forEach((el: any) => el.style.borderTop = '');
      });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        item.style.borderTop = '2px solid var(--SmartThemeQuoteColor)';
      });
      item.addEventListener('dragleave', () => {
        item.style.borderTop = '';
      });
      item.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        item.style.borderTop = '';
        const draggingId = e.dataTransfer?.getData('text/plain');
        if (draggingId && draggingId !== memberId && !manager.isParent(draggingId)) {
          // 将 draggingId 移动到 memberId 之前
          manager.reorderChild(parentId, draggingId, memberId);
          renderVariantsPanel(true);
        }
      });
    }

    item.appendChild(dragHandle);

    const name = getPersonaName(memberId);
    const title = getPersonaTitle(memberId);

    const textDiv = document.createElement('div');
    textDiv.className = 'cp2-variant-text';
    textDiv.innerHTML = `
      <div class="cp2-variant-name">${escapeHtml(name)}</div>
      ${title ? `<div class="cp2-variant-title">${escapeHtml(title)}</div>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'cp2-variant-actions';

    // 🔗 角色/聊天绑定状态展示（ST 原生 connections）
    const bindings = getPersonaBindings(memberId);
    if (bindings.length > 0) {
      const bindingWrap = document.createElement('div');
      bindingWrap.className = 'cp2-variant-bindings';
      for (const c of bindings) {
        if (c.type === 'character') {
          const charImg = document.createElement('img');
          charImg.src = `/thumbnail?type=avatar&file=${encodeURIComponent(c.id)}`;
          charImg.className = 'cp2-variant-binding-avatar';
          charImg.title = '已绑定角色';
          charImg.onerror = () => { charImg.style.display = 'none'; };
          charImg.onclick = e => e.stopPropagation();
          bindingWrap.appendChild(charImg);
        } else if (c.type === 'chat') {
          const chatIcon = document.createElement('i');
          chatIcon.className = 'fa-solid fa-comments cp2-variant-binding-icon';
          chatIcon.title = '已绑定聊天';
          chatIcon.onclick = e => e.stopPropagation();
          bindingWrap.appendChild(chatIcon);
        } else if (c.type === 'group') {
          const groupIcon = document.createElement('i');
          groupIcon.className = 'fa-solid fa-users cp2-variant-binding-icon';
          groupIcon.title = '已绑定群组';
          groupIcon.onclick = e => e.stopPropagation();
          bindingWrap.appendChild(groupIcon);
        }
      }
      actions.appendChild(bindingWrap);
    }

    const copyBtn = document.createElement('i');
    copyBtn.className = 'fa-solid fa-copy cp2-variant-action-btn';
    copyBtn.title = '复制此人设并加入当前分支';
    copyBtn.onclick = async evt => {
      evt.stopPropagation();
      copyBtn.classList.add('cp2-action-pending');
      try {
        await duplicatePersonaIntoGroup(parentId, memberId);
      } catch (e) {
        console.error(LOG_PREFIX, '复制人设失败:', e);
        toastr.error(`复制【${name}】失败，请稍后重试`);
      } finally {
        copyBtn.classList.remove('cp2-action-pending');
      }
    };
    actions.appendChild(copyBtn);

    if (isMainCard) {
      const badge = document.createElement('span');
      badge.className = 'cp2-variant-parent-badge';
      badge.textContent = '主卡';
      actions.appendChild(badge);
    } else {
      // ❌ 移出分支按钮
      const unlinkBtn = document.createElement('i');
      unlinkBtn.className = 'fa-solid fa-xmark cp2-variant-action-btn';
      unlinkBtn.title = '移出该分支';
      unlinkBtn.onclick = evt => {
        evt.stopPropagation();
        manager.unlinkChild(memberId);
        toastr.success(`已将【${name}】移出分支`);
        renderAvatarBlock();
        renderVariantsPanel(true);
      };
      actions.appendChild(unlinkBtn);
    }

    item.appendChild(avatar);
    item.appendChild(textDiv);
    item.appendChild(actions);
    item.onclick = () => {
      if (!isCurrentUser) {
        switchToPersona(memberId).then(() =>
          // 直接传入 memberId，不依赖 DOM .selected 查找
          setTimeout(() => renderVariantsPanel(true, memberId), 150)
        );
      }
    };
    list.appendChild(item);
  }

  lastPanelPersonaId = currentId;
  lastPanelGroupKey = groupKey;
}

/** 弹出批量管理面板：双栏 UI 管理分组及主卡 */
function openGroupManager(initialParentId: string): void {
  let currentParentId = initialParentId;
  let searchQuery = '';
  let filterMode: 'all' | 'samename' | 'samechar' = 'all';

  const allIds = Array.from(document.querySelectorAll('#user_avatar_block .avatar-container'))
    .map(getAvatarId).filter(Boolean) as string[];

  function renderPanes() {
    const effectiveGroups = manager.getEffectiveGroups();
    const children = effectiveGroups[currentParentId] || [];
    const groupedIds = new Set<string>();
    for (const [pid, cids] of Object.entries(effectiveGroups)) {
      groupedIds.add(pid);
      for (const c of cids) groupedIds.add(c);
    }
    let availableIds = allIds.filter(id => id !== currentParentId && !groupedIds.has(id));

    const currentParentName = getPersonaName(currentParentId);
    const parentBaseName = currentParentName.match(/^(.+?)\s*[-_]\s*.+$/)?.[1].trim() || currentParentName.trim();
    const parentBindings = getPersonaBindings(currentParentId).filter(c => c.type === 'character').map(c => c.id);

    // 应用过滤
    if (searchQuery) {
      availableIds = availableIds.filter(id => getPersonaName(id).toLowerCase().includes(searchQuery.toLowerCase()));
    }
    if (filterMode === 'samename') {
      availableIds = availableIds.filter(id => {
        const name = getPersonaName(id);
        const match = name.match(/^(.+?)\s*[-_]\s*.+$/);
        const base = match ? match[1].trim() : name.trim();
        return base === parentBaseName;
      });
    } else if (filterMode === 'samechar') {
      availableIds = availableIds.filter(id => {
        const bindings = getPersonaBindings(id).filter(c => c.type === 'character').map(c => c.id);
        return bindings.some(b => parentBindings.includes(b));
      });
    }

    let leftHtml = '';
    for (const id of availableIds) {
      const name = getPersonaName(id);
      const thumbUrl = getThumbUrl(id);
      leftHtml += `
        <div class="cp2-picker-item" data-id="${id}" title="点击移入分支">
          <img class="cp2-picker-avatar" src="${thumbUrl}" />
          <span class="cp2-picker-name">${escapeHtml(name)}</span>
          <i class="fa-solid fa-arrow-right" style="opacity: 0.5;"></i>
        </div>
      `;
    }
    if (availableIds.length === 0) leftHtml = '<div style="opacity:0.5;text-align:center;padding:20px;">没有可用的独立人设</div>';

    let rightHtml = `
      <div class="cp2-picker-item cp2-manager-parent" data-id="${currentParentId}" style="background: rgba(var(--SmartThemeQuoteColorRGB, 52, 152, 219), 0.15); border-color: var(--SmartThemeQuoteColor, #3498db);">
        <img class="cp2-picker-avatar" src="${getThumbUrl(currentParentId)}" />
        <span class="cp2-picker-name"><b>${escapeHtml(getPersonaName(currentParentId))}</b> (主卡)</span>
      </div>
    `;
    for (const id of children) {
      const name = getPersonaName(id);
      const thumbUrl = getThumbUrl(id);
      rightHtml += `
        <div class="cp2-picker-item" data-id="${id}" style="cursor: default;">
          <img class="cp2-picker-avatar" src="${thumbUrl}" />
          <span class="cp2-picker-name">${escapeHtml(name)}</span>
          <div style="display:flex; gap:6px; flex-shrink:0;">
            <button class="menu_button cp2-promote-btn" data-id="${id}" title="设为主卡" style="padding:2px 6px; font-size:0.8em; margin:0;"><i class="fa-solid fa-crown"></i></button>
            <button class="menu_button cp2-remove-btn" data-id="${id}" title="移出分支" style="padding:2px 6px; font-size:0.8em; margin:0;"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </div>
      `;
    }

    const leftPane = document.getElementById('cp2-mgr-left');
    const rightPane = document.getElementById('cp2-mgr-right');
    if (!leftPane || !rightPane) return;

    leftPane.innerHTML = leftHtml;
    rightPane.innerHTML = rightHtml;

    // 左侧点击加入
    leftPane.querySelectorAll('.cp2-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.id;
        if (id) {
          manager.initGroup(currentParentId);
          manager.linkChild(currentParentId, id);
          renderPanes();
        }
      });
    });

    // 右侧移除
    rightPane.querySelectorAll('.cp2-remove-btn').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const id = (el as HTMLElement).dataset.id;
        if (id) {
          manager.unlinkChild(id);
          renderPanes();
        }
      });
    });

    // 右侧设为主卡
    rightPane.querySelectorAll('.cp2-promote-btn').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const id = (el as HTMLElement).dataset.id;
        if (id) {
          manager.promoteToParent(currentParentId, id);
          currentParentId = id; // 切换当前管理的主卡上下文
          renderPanes();
        }
      });
    });
  }

  const popupContent = `
    <div style="margin-bottom: 10px; opacity: 0.8; font-size: 0.9em; text-align: left;">
      <i class="fa-solid fa-users"></i> 批量管理分组。你可以将左侧的独立人设点击加入右侧，也可以在右侧一键设为主卡。
    </div>
    <div style="display: flex; gap: 6px; margin-bottom: 10px;">
      <input type="text" id="cp2-mgr-search" class="text_pole" placeholder="搜索独立人设..." style="flex:1;">
      <button class="menu_button cp2-filter-btn" data-mode="all" style="flex:0;">全部</button>
      <button class="menu_button cp2-filter-btn" data-mode="samename" style="flex:0; white-space:nowrap;">同名</button>
      <button class="menu_button cp2-filter-btn" data-mode="samechar" style="flex:0; white-space:nowrap;">同绑定</button>
    </div>
    <div style="display: flex; gap: 10px; height: 350px; text-align: left;">
      <div style="flex: 1; display: flex; flex-direction: column; border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; background: var(--black10a); overflow: hidden;">
        <div style="padding: 8px; font-weight: bold; border-bottom: 1px solid var(--SmartThemeBorderColor); text-align: center; background: var(--black20a);">可选独立人设 (<span id="cp2-mgr-count">0</span>)</div>
        <div id="cp2-mgr-left" class="cp2-picker-list" style="flex: 1; padding: 6px; overflow-y: auto;"></div>
      </div>
      <div style="display: flex; align-items: center; font-size: 1.2em; opacity: 0.5;">
        <i class="fa-solid fa-right-left"></i>
      </div>
      <div style="flex: 1; display: flex; flex-direction: column; border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; background: var(--black10a); overflow: hidden;">
        <div style="padding: 8px; font-weight: bold; border-bottom: 1px solid var(--SmartThemeBorderColor); text-align: center; background: var(--black20a);">当前分支列表</div>
        <div id="cp2-mgr-right" class="cp2-picker-list" style="flex: 1; padding: 6px; overflow-y: auto;"></div>
        <div style="padding: 8px; border-top: 1px solid var(--SmartThemeBorderColor); background: var(--black20a);">
          <button id="cp2-mgr-disband" class="menu_button" style="width: 100%; color: #e74c3c; margin: 0;">一键解散该分组</button>
        </div>
      </div>
    </div>
  `;

  const popup = new Popup(popupContent, POPUP_TYPE.CONFIRM, '', {
    okButton: '完成',
    cancelButton: '关闭',
    onOk: () => {
      renderAvatarBlock();
      renderVariantsPanel(true);
    }
  });
  popup.show();

  setTimeout(() => {
    renderPanes();
    const disbandBtn = document.getElementById('cp2-mgr-disband');
    if (disbandBtn) {
      disbandBtn.addEventListener('click', () => {
        if (confirm('确定要解散该分组吗？所有成员将恢复为独立人设。')) {
          manager.disbandGroup(currentParentId);
          renderPanes();
        }
      });
    }

    const searchInput = document.getElementById('cp2-mgr-search') as HTMLInputElement;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        renderPanes();
      });
    }

    document.querySelectorAll('.cp2-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        filterMode = (btn as HTMLElement).dataset.mode as any;
        document.querySelectorAll('.cp2-filter-btn').forEach(b => (b as HTMLElement).style.opacity = '0.5');
        (btn as HTMLElement).style.opacity = '1';
        renderPanes();
      });
    });
    
    // 初始化过滤器样式
    const initialFilterBtn = document.querySelector(`.cp2-filter-btn[data-mode="${filterMode}"]`) as HTMLElement;
    if (initialFilterBtn) {
      document.querySelectorAll('.cp2-filter-btn').forEach(b => (b as HTMLElement).style.opacity = '0.5');
      initialFilterBtn.style.opacity = '1';
    }
  }, 100);
}



// ==================== 右键菜单 ====================

let contextMenuEl: HTMLElement | null = null;

function closeContextMenu(): void {
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
}

function showContextMenu(x: number, y: number, items: Array<{ label: string; action: () => void } | 'sep'>): void {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'cp2-context-menu';
  menu.style.cssText = `left:${x}px;top:${y}px`;

  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'cp2-context-menu-separator';
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'cp2-context-menu-item';
    el.textContent = item.label;
    el.addEventListener('click', evt => { evt.stopPropagation(); closeContextMenu(); item.action(); });
    menu.appendChild(el);
  }

  // 阻止菜单自身的鼠标事件冒泡到 document
  for (const ev of ['mousedown', 'pointerdown', 'mouseup', 'pointerup', 'click'] as const) {
    menu.addEventListener(ev, e => e.stopPropagation());
  }

  document.body.appendChild(menu);
  contextMenuEl = menu;

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = window.innerWidth - rect.width - 8 + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = window.innerHeight - rect.height - 8 + 'px';
  });
}

function setupContextMenu(): void {
  const block = document.getElementById('user_avatar_block');
  if (!block) return;

  block.addEventListener('contextmenu', async evt => {
    const settings = manager?.getSettings();
    if (!settings?.enabled) return;

    const container = (evt.target as Element).closest('.avatar-container');
    if (!container) return;
    const id = getAvatarId(container);
    if (!id) return;

    evt.preventDefault();
    evt.stopPropagation();

    const items: Array<{ label: string; action: () => void } | 'sep'> = [];
    const isParent = manager.isParent(id);

    if (isParent) {

      items.push({
        label: '💥 解散此分组',
        action: () => { manager.disbandGroup(id); renderAvatarBlock(); renderVariantsPanel(true); },
      });
    }

    if (items.length > 0) {
      showContextMenu(evt.clientX, evt.clientY, items);
    }
  });

  document.addEventListener('click', evt => {
    if (contextMenuEl && !(evt.target as Element).closest('.cp2-context-menu')) closeContextMenu();
  });
}

// ==================== 拖拽：桌面鼠标 ====================

let draggingId: string | null = null;
let lastDropTime = 0;

function setupMouseDrag(): void {
  const block = document.getElementById('user_avatar_block');
  if (!block) return;

  block.addEventListener('dragstart', evt => {
    const settings = manager?.getSettings();
    if (!settings?.enabled) return;
    const container = (evt.target as Element).closest('.avatar-container');
    if (!container) return;
    draggingId = getAvatarId(container);
    if (draggingId) container.classList.add('cp2-dragging');
  });

  block.addEventListener('dragover', evt => {
    if (!draggingId) return;
    // 阯止冒泡：防止 ST 全局 drop 处理器触发「不支持的文件类型」警告
    evt.preventDefault();
    evt.stopPropagation();
    const container = (evt.target as Element).closest('.avatar-container');
    if (!container) return;
    const targetId = getAvatarId(container);
    if (targetId && targetId !== draggingId) {
      container.classList.add('cp2-drag-target');
    }
  });

  block.addEventListener('dragenter', evt => {
    if (!draggingId) return;
    const container = (evt.target as Element).closest('.avatar-container');
    if (container && getAvatarId(container) !== draggingId) container.classList.add('cp2-drag-target');
  });

  block.addEventListener('dragleave', evt => {
    const container = (evt.target as Element).closest('.avatar-container');
    container?.classList.remove('cp2-drag-target');
  });

  block.addEventListener('drop', evt => {
    if (!draggingId) return;
    // 立即停止冒泡和默认行为，无论是否命中目标
    evt.preventDefault();
    evt.stopPropagation();
    const container = (evt.target as Element).closest('.avatar-container');
    if (container) {
      container.classList.remove('cp2-drag-target');
      const targetId = getAvatarId(container);
      if (targetId && targetId !== draggingId) {
        if (Date.now() - lastDropTime < 300) { draggingId = null; return; }
        lastDropTime = Date.now();
        const finalParentId = manager.findParentOf(targetId) || targetId;
        manager.linkChild(finalParentId, draggingId);
        toastr.success(`已将【${getPersonaName(draggingId)}】纳入【${getPersonaName(finalParentId)}】的分支`);
        renderAvatarBlock();
        renderVariantsPanel(true);
      }
    }
    draggingId = null;
  });

  block.addEventListener('dragend', evt => {
    const container = (evt.target as Element).closest('.avatar-container');
    container?.classList.remove('cp2-dragging');
    block.querySelectorAll('.cp2-drag-target').forEach(el => el.classList.remove('cp2-drag-target'));
    draggingId = null;
  });
}

// ==================== 拖拽：触屏长按 ====================

let touchDragging = false;
let touchDragId: string | null = null;
let touchDragEl: Element | null = null;
let touchTimer: ReturnType<typeof setTimeout> | null = null;
let touchStartX = 0;
let touchStartY = 0;
let lastTouchTarget: Element | null = null;

function setupTouchDrag(): void {
  const block = document.getElementById('user_avatar_block');
  if (!block) return;

  block.addEventListener('touchstart', evt => {
    const settings = manager?.getSettings();
    if (!settings?.enabled) return;

    const container = (evt.target as Element).closest('.avatar-container');
    if (!container) return;

    const id = getAvatarId(container);
    if (!id) return;

    const touch = evt.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;

    touchTimer = setTimeout(() => {
      touchDragging = true;
      touchDragId = id;
      touchDragEl = container;
      container.classList.add('cp2-dragging');
      // 震动反馈（若支持）
      if (navigator.vibrate) navigator.vibrate(50);
    }, 500);
  }, { passive: true });

  block.addEventListener('touchmove', evt => {
    const touch = evt.touches[0];
    const dx = Math.abs(touch.clientX - touchStartX);
    const dy = Math.abs(touch.clientY - touchStartY);

    if (!touchDragging) {
      // 若移动超 5px 则取消长按计时（视为滚动）
      if (dx > 5 || dy > 5) {
        if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
      }
      return;
    }

    evt.preventDefault(); // 阻止滚动

    // 计算当前手指下的元素
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const container = el?.closest('.avatar-container') ?? null;

    if (lastTouchTarget && lastTouchTarget !== container) {
      lastTouchTarget.classList.remove('cp2-drag-target');
    }

    if (container && getAvatarId(container) !== touchDragId) {
      container.classList.add('cp2-drag-target');
      lastTouchTarget = container;
    } else {
      lastTouchTarget = null;
    }
  }, { passive: false });

  block.addEventListener('touchend', evt => {
    if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }

    if (touchDragging && touchDragId) {
      const touch = evt.changedTouches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const container = el?.closest('.avatar-container') ?? null;
      const targetId = container ? getAvatarId(container) : null;

      if (targetId && targetId !== touchDragId) {
        if (Date.now() - lastDropTime < 300) {
          touchDragEl?.classList.remove('cp2-dragging');
          lastTouchTarget?.classList.remove('cp2-drag-target');
          touchDragging = false;
          touchDragId = null;
          return;
        }
        lastDropTime = Date.now();
        const finalParentId = manager.findParentOf(targetId) || targetId;
        manager.linkChild(finalParentId, touchDragId);
        toastr.success(`已将【${getPersonaName(touchDragId)}】纳入【${getPersonaName(finalParentId)}】的分支`);
        renderAvatarBlock();
        renderVariantsPanel(true);
      }

      touchDragEl?.classList.remove('cp2-dragging');
      lastTouchTarget?.classList.remove('cp2-drag-target');
    }

    touchDragging = false;
    touchDragId = null;
    touchDragEl = null;
    lastTouchTarget = null;
  });
}

// ==================== 全局弹窗视觉分组 ====================

function applyPopupVisualGrouping(popupEl: HTMLElement): void {
  const settings = manager?.getSettings();
  if (!settings?.enabled) return;

  const effectiveGroups = manager.getEffectiveGroups();
  const containers = Array.from(popupEl.querySelectorAll('.avatar-container, .character_select')) as HTMLElement[];
  if (containers.length === 0) return;

  const parentNode = containers[0].parentNode;
  if (!parentNode) return;

  for (const [parentId, children] of Object.entries(effectiveGroups)) {
    if (children.length === 0) continue;
    
    const parentEl = containers.find(c => {
      const id = c.getAttribute('avatar-id') || c.dataset.avatarId || c.getAttribute('chid');
      return id === parentId;
    });
    if (!parentEl) continue;

    parentEl.style.position = 'relative';

    const childEls: HTMLElement[] = [];
    let insertAfterTarget = parentEl;
    for (const childId of children) {
      const childEl = containers.find(c => {
        const id = c.getAttribute('avatar-id') || c.dataset.avatarId || c.getAttribute('chid');
        return id === childId;
      });
      if (childEl) {
        childEl.style.display = 'none'; // 默认折叠
        childEl.style.marginLeft = '15px'; // 视觉缩进
        childEl.classList.add('cp2-popup-variant');
        parentNode.insertBefore(childEl, insertAfterTarget.nextSibling);
        insertAfterTarget = childEl;
        childEls.push(childEl);
      }
    }

    if (childEls.length > 0) {
      // 若原先已有，先移除防止重复
      const existingBadge = parentEl.querySelector('.cp2-popup-badge');
      if (existingBadge) existingBadge.remove();

      const badge = document.createElement('div');
      badge.className = 'cp2-parent-badge cp2-popup-badge';
      badge.innerHTML = `<i class="fa-solid fa-users"></i> ${childEls.length}`;
      parentEl.appendChild(badge);

      let expanded = false;
      badge.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        expanded = !expanded;
        for (const c of childEls) {
          c.style.display = expanded ? '' : 'none';
        }
      });
    }
  }
}

function setupBodyObserver(): void {
  const bodyObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLElement && node.classList.contains('popup')) {
          setTimeout(() => applyPopupVisualGrouping(node), 100);
        }
      }
    }
  });
  bodyObserver.observe(document.body, { childList: true });
}

// ==================== 扩展设置面板 ====================

function initExtensionSettings(): void {
  const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (!container || document.getElementById('cp2-extension-settings')) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'cp2-extension-settings';
  wrapper.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>人设折叠</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="cp2-setting-row">
          <label class="checkbox_label" for="cp2-setting-enabled">
            <input type="checkbox" id="cp2-setting-enabled">
            <span>启用人设折叠功能</span>
          </label>
        </div>
        <div class="cp2-setting-row">
          <label class="checkbox_label" for="cp2-setting-autoname">
            <input type="checkbox" id="cp2-setting-autoname">
            <span>自动收纳同名前缀的人设</span>
          </label>
        </div>
        <div class="cp2-setting-row">
          <label class="checkbox_label" for="cp2-setting-autobind">
            <input type="checkbox" id="cp2-setting-autobind">
            <span>自动收纳绑定同一角色的卡片</span>
          </label>
        </div>
        <div class="cp2-setting-row" style="margin-top:8px; display: flex; gap: 8px;">
          <button class="menu_button" id="cp2-btn-manage-global" style="white-space: nowrap; width: fit-content; padding: 5px 15px;"><i class="fa-solid fa-users-gear"></i> 批量管理分支</button>
          <button class="menu_button" id="cp2-btn-reset" style="white-space: nowrap; width: fit-content; padding: 5px 15px;"><i class="fa-solid fa-trash-can"></i> 重置所有分组</button>
        </div>
      </div>
    </div>
  `;
  container.appendChild(wrapper);

  const checkbox = wrapper.querySelector<HTMLInputElement>('#cp2-setting-enabled')!;
  checkbox.checked = manager.getSettings().enabled;
  checkbox.addEventListener('change', () => {
    manager.getSettings().enabled = checkbox.checked;
    saveSettingsDebounced();
    renderAvatarBlock();
  });

  const cbName = wrapper.querySelector<HTMLInputElement>('#cp2-setting-autoname')!;
  cbName.checked = manager.getSettings().autoGroupByName ?? true;
  cbName.addEventListener('change', () => {
    manager.getSettings().autoGroupByName = cbName.checked;
    saveSettingsDebounced();
    scheduleRender();
  });

  const cbBind = wrapper.querySelector<HTMLInputElement>('#cp2-setting-autobind')!;
  cbBind.checked = manager.getSettings().autoGroupByBinding ?? true;
  cbBind.addEventListener('change', () => {
    manager.getSettings().autoGroupByBinding = cbBind.checked;
    saveSettingsDebounced();
    scheduleRender();
  });


  wrapper.querySelector('#cp2-btn-manage-global')?.addEventListener('click', () => {
    // 寻找当前选中的角色，如果没有，随便找一个 parentId，或者干脆空串
    const selectedEl = document.querySelector('#user_avatar_block .avatar-container.selected');
    let currentId = (selectedEl ? getAvatarId(selectedEl) : null) ?? personasModule?.user_avatar ?? null;
    
    if (!currentId) {
      // 找不到则随便取一个有效ID作为主卡上下文
      const allIds = Array.from(document.querySelectorAll('#user_avatar_block .avatar-container')).map(getAvatarId).filter(Boolean) as string[];
      currentId = allIds[0] || '';
    }
    
    if (currentId) {
      const parentId = manager.findParentOf(currentId) || currentId;
      openGroupManager(parentId);
    } else {
      toastr.warning('未找到任何独立角色卡');
    }
  });

  wrapper.querySelector('#cp2-btn-reset')?.addEventListener('click', () => {
    const s = manager.getSettings();
    s.manualGroups = {};
    saveSettingsDebounced();
    updateAutoGroups();
    renderAvatarBlock();
    renderVariantsPanel(true);
    toastr.success('已清空所有手动分组');
  });
}

// ==================== MutationObserver ====================

let observer: MutationObserver | null = null;

function setupMutationObserver(): void {
  const block = document.getElementById('user_avatar_block');
  if (!block || observer) return;
  observer = new MutationObserver(() => { if (!isRendering) scheduleRender(); });
  observer.observe(block, { childList: true, subtree: false });
}

// ==================== 工具函数 ====================

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ==================== 入口 ====================

if (typeof jQuery !== 'undefined') {
  jQuery(async () => {
    console.log(`${LOG_PREFIX} 启动中...`);

    // 初始化设置
    const rawSettings = (extension_settings as any)[SETTINGS_KEY];
    manager = new GroupManager(rawSettings, () => {
      (extension_settings as any)[SETTINGS_KEY] = manager.getSettings();
      saveSettingsDebounced();
    });
    (extension_settings as any)[SETTINGS_KEY] = manager.getSettings();

    await loadPersonasApi();

    eventSource.on(event_types.APP_READY, () => {
      initExtensionSettings();
      renderAvatarBlock();
      setupContextMenu();
      setupMouseDrag();
      setupTouchDrag();
      setupMutationObserver();
      setupBodyObserver();
      renderVariantsPanel(true);
    });

    eventSource.on(event_types.SETTINGS_UPDATED, () => {
      scheduleRender();
      renderVariantsPanel(true);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
      scheduleRender();
    });

    // 轮询详情页刷新（ST 的人设切换不总是触发事件）
    setInterval(() => renderVariantsPanel(), 500);

    console.log(`${LOG_PREFIX} 初始化完成`);
  });
}

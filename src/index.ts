import { extension_settings } from 'sillytavern/extensions';
import { default_user_avatar, eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from 'sillytavern/script';
import { power_user } from 'sillytavern/power-user';
import { POPUP_TYPE, Popup } from 'sillytavern/popup';
import { mountBranchSortables } from './branch-sortable';
import { GroupManager } from './manager';

// ==================== 常量 ====================

const SETTINGS_KEY = 'collapsible_personas_v3';
const LOG_PREFIX = '[PersonaCollapse]';
const SUBGROUP_ACCENT_COLORS = ['#70c7bd', '#e6a86b', '#8fa9e6', '#d78fb7', '#9bc77a', '#c59ee6'];

// ==================== 状态 ====================

let manager: GroupManager;
let setUserAvatarFn: ((id: string) => Promise<void>) | null = null;
let destroyBranchSortables: (() => void) | null = null;
let branchSortableDragging = false;
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

function teardownBranchSortables(): void {
  destroyBranchSortables?.();
  destroyBranchSortables = null;
  branchSortableDragging = false;
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

function tUi(key: string, fallback: string): string {
  const translate = (globalThis as any).i18next?.t;
  if (typeof translate !== 'function') return fallback;
  const translated = translate(key, { defaultValue: fallback });
  return typeof translated === 'string' ? translated : fallback;
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

function parsePersonaTags(value: string): string[] {
  return value
    .split(/[,，]/)
    .map(tag => tag.trim())
    .filter(Boolean);
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

async function createPersonaInBranch(parentId: string): Promise<void> {
  await loadPersonasApi();
  let personaTitle = '';
  const personaName = await Popup.show.input(
    tUi('personaCollapse.createPersona', '新建人设'),
    tUi('personaCollapse.personaNamePrompt', '输入此用户设定的名称：'),
    '',
    {
      customInputs: [{
        id: 'cp2-persona-title',
        type: 'text',
        label: tUi('personaCollapse.personaTitle', '用户设定标题（可选，仅显示）'),
        defaultState: '',
      }],
      onClose: (popup: { inputResults?: Map<string, unknown> }) => {
        personaTitle = String(popup.inputResults?.get('cp2-persona-title') ?? '').trim();
      },
    },
  );
  if (!personaName || typeof personaName !== 'string' || !personaName.trim()) return;

  const trimmedName = personaName.trim();
  const avatarId = buildAvatarId(trimmedName);
  if (personasModule?.initPersona) {
    await personasModule.initPersona(avatarId, trimmedName, '', personaTitle);
  } else {
    power_user.personas[avatarId] = trimmedName;
    power_user.persona_descriptions[avatarId] = { description: '', title: personaTitle };
    saveSettingsDebounced();
    await eventSource.emit(event_types.PERSONA_CREATED, {
      avatarId,
      name: trimmedName,
      description: '',
      title: personaTitle,
    });
  }

  try {
    await uploadPersonaAvatar(default_user_avatar, avatarId);
  } catch (error) {
    console.warn(LOG_PREFIX, '新建人设头像上传失败，将使用酒馆默认头像:', error);
  }

  manager.initGroup(parentId);
  manager.linkChildAtEnd(parentId, avatarId);
  await personasModule?.getUserAvatars?.(true, parentId);
  renderAvatarBlock();
  renderVariantsPanel(true);
  toastr.success(`已新建【${trimmedName}】并追加到当前分支`);
}

async function editPersonaTags(personaId: string): Promise<void> {
  const currentTags = manager.getPersonaTags(personaId);
  const value = await Popup.show.input(
    tUi('personaCollapse.editTags', '编辑人设标签'),
    tUi('personaCollapse.tagsPrompt', '多个标签请用逗号分隔：'),
    currentTags.join(', '),
  );
  if (value === null) return;
  manager.setPersonaTags(personaId, parsePersonaTags(value || ''));
  renderVariantsPanel(true);
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
  manager.placeCopyInSourceSubgroup(parentId, sourceId, avatarId);
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
let editingSubgroupId: string | null = null;
let pendingSubgroupFocusId: string | null = null;
let variantsPanelDirty = true;

async function promptSubgroupName(initialName = ''): Promise<string | null> {
  const wrapper = document.createElement('div');
  wrapper.className = 'cp2-name-dialog';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text_pole cp2-name-dialog-input';
  input.value = initialName;
  input.placeholder = tUi('personaCollapse.subgroupNamePlaceholder', '输入分组名称');
  wrapper.appendChild(input);

  const popup = new Popup(wrapper, POPUP_TYPE.TEXT, '', {
    okButton: tUi('personaCollapse.create', '创建'),
    cancelButton: tUi('personaCollapse.cancel', '取消'),
  });

  setTimeout(() => input.focus(), 0);
  const result = await popup.show();
  if (result === null) return null;

  const name = input.value.trim();
  return name.length > 0 ? name : null;
}

async function confirmSubgroupDeletion(subgroupName: string): Promise<boolean> {
  const message = tUi(
    'personaCollapse.deleteSubgroupConfirm',
    `删除“${subgroupName}”分组？其中人设将移回未分组。`,
  );
  const popup = new Popup(`<p>${escapeHtml(message)}</p>`, POPUP_TYPE.CONFIRM, '', {
    okButton: tUi('personaCollapse.delete', '删除'),
    cancelButton: tUi('personaCollapse.cancel', '取消'),
  });
  return (await popup.show()) !== null;
}

function renderVariantsPanel(force = false, currentIdOverride: string | null = null): void {
  if (branchSortableDragging && !force) return;
  const selectedEl = document.querySelector('#user_avatar_block .avatar-container.selected');
  // 优先级： override > DOM .selected > ST 模块 user_avatar live binding
  // 后者确保分页切换后、分支成员在其他页时，500ms 轮询仍能就地读取当前人设
  const currentId = currentIdOverride
    ?? (selectedEl ? getAvatarId(selectedEl) : null)
    ?? (personasModule?.user_avatar || null);

  // --- 确保面板容器存在 ---
  let panel = document.getElementById('cp2-variants-panel');
  const hadPanel = !!panel;
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

  if (!force && hadPanel && !variantsPanelDirty && currentId === lastPanelPersonaId) return;

  const settings = manager?.getSettings();
  if (!settings?.enabled || !currentId) {
    teardownBranchSortables();
    panel.style.display = 'none';
    lastPanelPersonaId = null;
    lastPanelGroupKey = null;
    variantsPanelDirty = false;
    return;
  }

  // 找到该人设的分组上下文
  const effectiveGroups = manager.getEffectiveGroups();
  const parentId = manager.findParentOf(currentId) || currentId;
  const children = effectiveGroups[parentId] || [];

  const layout = manager.getBranchLayout(parentId, children);
  const hasBranchContent = children.length > 0 || layout.root.some(item => item.type === 'subgroup');
  const subgroupEntries = manager.getSettings().subgroups[parentId] || [];
  const subgroupById = new Map(subgroupEntries.map(group => [group.id, group]));
  const subgroupAccentById = new Map(
    subgroupEntries.map((group, index) => [group.id, SUBGROUP_ACCENT_COLORS[index % SUBGROUP_ACCENT_COLORS.length]]),
  );
  const groupKey = JSON.stringify({
    parentId,
    currentId,
    layout: layout.root,
    members: layout.subgroupMembers,
    subgroups: subgroupEntries.map(group => ({
      id: group.id,
      name: group.name,
      collapsed: group.collapsed,
      count: layout.subgroupMembers[group.id]?.length ?? 0,
    })),
  });
  if (!force && currentId === lastPanelPersonaId && groupKey === lastPanelGroupKey) return;

  teardownBranchSortables();
  panel.style.display = 'block';

  // 使用原生风格工具栏，避免额外标题占用列表空间。
  const headerHTML = `
    <div class="cp2-variants-header${hasBranchContent ? '' : ' cp2-variants-header-no-branches'}" role="toolbar" aria-label="${escapeHtml(tUi('personaCollapse.branchActions', '人设分支操作'))}">
      <div class="cp2-surface-persona-slot"></div>
      <div class="cp2-variants-header-actions">
        <button class="menu_button cp2-toolbar-btn" id="cp2-create-persona" title="新建人设" aria-label="新建人设">
          <i class="fa-solid fa-user-plus"></i>
        </button>
        <button class="menu_button cp2-toolbar-btn" id="cp2-create-subgroup" title="${escapeHtml(tUi('personaCollapse.createSubgroup', '新建分组'))}" aria-label="${escapeHtml(tUi('personaCollapse.createSubgroup', '新建分组'))}">
          <i class="fa-solid fa-folder-plus"></i>
        </button>
        <button class="menu_button cp2-toolbar-btn" id="cp2-add-branch-btn" title="批量管理此分支" aria-label="批量管理此分支">
          <i class="fa-solid fa-users-gear"></i>
        </button>
      </div>
      ${children.length > 0 ? `<span class="cp2-variants-count" title="${escapeHtml(tUi('personaCollapse.branchCount', '分支内人设数量'))}">${children.length + 1}</span>` : ''}
    </div>
    <div class="cp2-variants-list"></div>
  `;
  panel.innerHTML = headerHTML;

  // ➕ 按钮事件（打开批量管理面板）
  panel.querySelector('#cp2-add-branch-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    openGroupManager(parentId);
  });

  panel.querySelector('#cp2-create-persona')?.addEventListener('click', async e => {
    e.stopPropagation();
    await createPersonaInBranch(parentId);
  });

  panel.querySelector('#cp2-create-subgroup')?.addEventListener('click', async e => {
    e.stopPropagation();
    const name = await promptSubgroupName();
    if (!name) return;
    pendingSubgroupFocusId = manager.createSubgroup(parentId, name).id;
    renderVariantsPanel(true, currentId);
  });

  // 渲染成员列表
  const list = panel.querySelector<HTMLElement>('.cp2-variants-list')!;
  const createPersonaItem = (
    memberId: string,
    options: {
      isEntry?: boolean;
      subgroupId?: string | null;
      surface?: boolean;
    } = {},
  ): HTMLElement => {
    const { isEntry = false, subgroupId = null, surface = false } = options;
    const isCurrentUser = memberId === currentId;

    const item = document.createElement('div');
    item.className = `cp2-variant-item cp2-persona-sort-item${subgroupId ? '' : ' cp2-root-item'}${surface ? ' cp2-surface-persona' : ''}${isCurrentUser ? ' active' : ''}`;
    item.dataset.personaId = memberId;
    item.dataset.layoutType = 'persona';
    if (subgroupId) item.dataset.subgroupId = subgroupId;

    const avatar = document.createElement('img');
    avatar.src = getThumbUrl(memberId);
    avatar.className = 'cp2-variant-avatar';
    avatar.onerror = () => { avatar.src = '/img/ai4.png'; };

    if (!surface) {
      const dragHandle = document.createElement('i');
      dragHandle.className = 'fa-solid fa-grip-lines cp2-sort-handle cp2-variant-drag-handle';
      dragHandle.title = '拖拽排序';
      dragHandle.style.setProperty('--cp2-drag-accent', subgroupAccentById.get(subgroupId || '') || 'var(--SmartThemeBodyColor)');
      item.appendChild(dragHandle);
    }

    const name = getPersonaName(memberId);
    const title = getPersonaTitle(memberId);

    const textDiv = document.createElement('div');
    textDiv.className = 'cp2-variant-text';
    const tags = manager.getPersonaTags(memberId);
    textDiv.innerHTML = `
      <div class="cp2-variant-name-row">
        <span class="cp2-variant-name">${escapeHtml(name)}</span>
        ${tags.length > 0 ? `<span class="cp2-persona-tags">${tags.map(tag => `<span class="cp2-persona-tag" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
      </div>
      ${title ? `<div class="cp2-variant-title">${escapeHtml(title)}</div>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'cp2-variant-actions';

    const tagBtn = document.createElement('i');
    tagBtn.className = 'fa-solid fa-tags cp2-variant-action-btn';
    tagBtn.title = '添加或编辑标签';
    tagBtn.setAttribute('aria-label', tagBtn.title);
    tagBtn.onclick = async evt => {
      evt.stopPropagation();
      await editPersonaTags(memberId);
    };
    actions.appendChild(tagBtn);

    // 🔗 角色/聊天绑定状态展示（ST 原生 connections）
    const bindings = getPersonaBindings(memberId);
    if (manager.getSettings().showBindingAvatars && bindings.length > 0) {
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

    if (isEntry && !surface) {
      const entryIcon = document.createElement('i');
      entryIcon.className = 'fa-solid fa-eye cp2-entry-indicator';
      entryIcon.title = tUi('personaCollapse.leftListEntry', '左侧列表入口');
      entryIcon.setAttribute('aria-label', entryIcon.title);
      actions.appendChild(entryIcon);
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

    if (!isEntry) {
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
    return item;
  };

  const surfaceSlot = panel.querySelector<HTMLElement>('.cp2-surface-persona-slot');
  if (children.length > 0) {
    surfaceSlot?.appendChild(createPersonaItem(parentId, { isEntry: true, surface: true }));
  }

  const createSubgroupSection = (groupId: string): HTMLElement => {
    const subgroup = subgroupById.get(groupId);
    const memberIds = layout.subgroupMembers[groupId] || subgroup?.personaIds || [];
    const section = document.createElement('div');
    section.className = `cp2-subgroup cp2-root-item${subgroup?.collapsed ? ' is-collapsed' : ''}`;
    section.dataset.layoutType = 'subgroup';
    section.dataset.subgroupId = groupId;

    const header = document.createElement('div');
    header.className = 'cp2-subgroup-header';

    const handle = document.createElement('i');
    handle.className = 'fa-solid fa-grip-lines cp2-sort-handle cp2-subgroup-handle';
    handle.title = '拖拽排序';
    handle.style.setProperty('--cp2-drag-accent', subgroupAccentById.get(groupId) || 'var(--SmartThemeBodyColor)');
    header.appendChild(handle);

    const toggle = document.createElement('button');
    toggle.className = 'cp2-subgroup-toggle cp2-icon-btn';
    toggle.title = subgroup?.collapsed
      ? tUi('personaCollapse.expandSubgroup', '展开分组')
      : tUi('personaCollapse.collapseSubgroup', '折叠分组');
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(!(subgroup?.collapsed ?? false)));
    toggle.innerHTML = `<i class="fa-solid fa-chevron-${subgroup?.collapsed ? 'right' : 'down'}"></i>`;
    toggle.addEventListener('click', event => {
      event.stopPropagation();
      manager.setSubgroupCollapsed(parentId, groupId, !(subgroup?.collapsed ?? false));
      renderVariantsPanel(true, currentId);
    });
    header.appendChild(toggle);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'cp2-subgroup-title-wrap';
    if (editingSubgroupId === groupId) {
      const input = document.createElement('input');
      input.className = 'text_pole cp2-subgroup-name-input';
      input.value = subgroup?.name || '';
      input.placeholder = tUi('personaCollapse.newSubgroup', '新分组');
      let finished = false;
      const finishEditing = (save: boolean): void => {
        if (finished) return;
        finished = true;
        if (save) manager.renameSubgroup(parentId, groupId, input.value);
        editingSubgroupId = null;
        renderVariantsPanel(true, currentId);
      };
      input.addEventListener('click', event => event.stopPropagation());
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') finishEditing(true);
        if (event.key === 'Escape') finishEditing(false);
      });
      input.addEventListener('blur', () => finishEditing(true), { once: true });
      titleWrap.appendChild(input);
      setTimeout(() => input.focus(), 0);
    } else {
      const name = document.createElement('span');
      name.className = 'cp2-subgroup-name';
      name.textContent = subgroup?.name || groupId;
      name.title = subgroup?.name || groupId;
      titleWrap.appendChild(name);

      const count = document.createElement('span');
      count.className = 'cp2-subgroup-count';
      count.textContent = String(memberIds.length);
      titleWrap.appendChild(count);
    }
    header.appendChild(titleWrap);

    const edit = document.createElement('button');
    edit.className = 'cp2-icon-btn';
    edit.title = tUi('personaCollapse.renameSubgroup', '重命名分组');
    edit.setAttribute('aria-label', edit.title);
    edit.innerHTML = '<i class="fa-solid fa-pencil"></i>';
    edit.addEventListener('click', event => {
      event.stopPropagation();
      editingSubgroupId = groupId;
      renderVariantsPanel(true, currentId);
    });
    header.appendChild(edit);

    const remove = document.createElement('button');
    remove.className = 'cp2-icon-btn cp2-subgroup-delete';
    remove.title = tUi('personaCollapse.deleteSubgroup', '删除分组');
    remove.setAttribute('aria-label', remove.title);
    remove.innerHTML = '<i class="fa-solid fa-trash"></i>';
    remove.addEventListener('click', async event => {
      event.stopPropagation();
      const groupName = subgroup?.name || groupId;
      if (!(await confirmSubgroupDeletion(groupName))) return;
      manager.deleteSubgroup(parentId, groupId);
      if (editingSubgroupId === groupId) editingSubgroupId = null;
      renderVariantsPanel(true, currentId);
    });
    header.appendChild(remove);

    header.addEventListener('click', event => {
      if ((event.target as Element).closest('button, input, .cp2-sort-handle')) return;
      manager.setSubgroupCollapsed(parentId, groupId, !(subgroup?.collapsed ?? false));
      renderVariantsPanel(true, currentId);
    });

    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'cp2-subgroup-body';

    const items = document.createElement('div');
    items.className = 'cp2-subgroup-items';
    items.dataset.emptyLabel = tUi('personaCollapse.dropPersonaHere', '拖入人设');
    for (const memberId of memberIds) {
      items.appendChild(createPersonaItem(memberId, { subgroupId: groupId }));
    }
    body.appendChild(items);
    section.appendChild(body);

    return section;
  };

  for (const item of layout.root) {
    if (item.type === 'persona') {
      if (item.id === parentId) continue;
      list.appendChild(createPersonaItem(item.id));
    } else {
      list.appendChild(createSubgroupSection(item.id));
    }
  }

  if (pendingSubgroupFocusId) {
    const focusId = pendingSubgroupFocusId;
    pendingSubgroupFocusId = null;
    requestAnimationFrame(() => {
      const section = list.querySelector<HTMLElement>(`[data-subgroup-id="${CSS.escape(focusId)}"]`);
      if (!section) return;
      section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      section.classList.add('cp2-new-subgroup');
      window.setTimeout(() => section.classList.remove('cp2-new-subgroup'), 900);
    });
  }

  destroyBranchSortables = mountBranchSortables({
    root: list,
    onCommit: snapshot => {
      // 入口固定在顶栏，不参与拖拽；补回快照首位后复用原有布局校验。
      const nextSnapshot = {
        ...snapshot,
        root: [{ type: 'persona' as const, id: parentId }, ...snapshot.root],
      };
      const newEntryId = manager.applyBranchLayoutSnapshot(parentId, nextSnapshot, children);
      if (!newEntryId) return false;
      queueMicrotask(() => {
        renderAvatarBlock();
        renderVariantsPanel(true, newEntryId);
      });
      return true;
    },
    onReject: () => renderVariantsPanel(true, currentId),
    onExpandSubgroup: (subgroupId, section) => {
      if (manager.setSubgroupCollapsed(parentId, subgroupId, false)) {
        section.classList.remove('is-collapsed');
        const toggle = section.querySelector<HTMLElement>('.cp2-subgroup-toggle');
        if (toggle) {
          toggle.setAttribute('aria-expanded', 'true');
          toggle.title = tUi('personaCollapse.collapseSubgroup', '折叠分组');
          toggle.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        }
      }
    },
    onDragStateChange: active => {
      branchSortableDragging = active;
    },
  });

  lastPanelPersonaId = currentId;
  lastPanelGroupKey = groupKey;
  variantsPanelDirty = false;
}

/** 弹出批量管理面板：双栏 UI 管理分组及主卡 */
function openGroupManager(initialParentId: string): void {
  let currentParentId = initialParentId;
  let searchQuery = '';
  let filterMode: 'all' | 'samename' | 'samechar' = 'all';
  let pendingManagerSubgroupFocusId: string | null = null;
  let destroyManagerSortables: (() => void) | null = null;
  const independentSourceId = manager.isIndependent(initialParentId) ? initialParentId : null;
  let selectedDestinationId: string | null = null;

  const allIds = Array.from(document.querySelectorAll('#user_avatar_block .avatar-container'))
    .map(getAvatarId).filter(Boolean) as string[];

  function renderManagerPersonaItem(
    id: string,
    options: {
      isEntry?: boolean;
      subgroupId?: string | null;
    } = {},
  ): string {
    const {
      isEntry = false,
      subgroupId = null,
    } = options;
    const name = getPersonaName(id);
    const controls = isEntry ? `
      <span class="cp2-manager-entry-label"><i class="fa-solid fa-eye"></i> 入口</span>
    ` : `
      <button class="cp2-icon-btn cp2-remove-btn" data-id="${escapeHtml(id)}" title="移出分支，回到独立人设" aria-label="移出分支，回到独立人设"><i class="fa-solid fa-xmark"></i></button>
    `;
    const tags = manager.getPersonaTags(id);
    const tagHtml = tags.length > 0
      ? `<span class="cp2-persona-tags">${tags.map(tag => `<span class="cp2-persona-tag" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join('')}</span>`
      : '';

    return `
      <div class="cp2-picker-item cp2-manager-persona-item cp2-persona-sort-item${subgroupId ? '' : ' cp2-root-item'}${isEntry ? ' cp2-manager-parent' : ''}" data-id="${escapeHtml(id)}" data-persona-id="${escapeHtml(id)}" data-layout-type="persona"${subgroupId ? ` data-subgroup-id="${escapeHtml(subgroupId)}"` : ''}>
        <i class="fa-solid fa-grip-lines cp2-sort-handle cp2-manager-drag-handle" title="拖拽排序、移入或移出分组"></i>
        <img class="cp2-picker-avatar" src="${getThumbUrl(id)}" />
        <span class="cp2-picker-name">${isEntry ? `<b>${escapeHtml(name)}</b>` : escapeHtml(name)}${tagHtml}</span>
        <div class="cp2-manager-item-actions">${controls}</div>
      </div>
    `;
  }

  function getBranchBaseName(id: string): string {
    const name = getPersonaName(id);
    return name.match(/^(.+?)\s*[-_]\s*.+$/)?.[1].trim() || name.trim();
  }

  function renderIndependentDestinationPane(
    leftPane: HTMLElement,
    rightPane: HTMLElement,
    countEl: HTMLElement | null,
  ): void {
    if (!independentSourceId) return;

    const sourceName = getPersonaName(independentSourceId);
    const sourceBindings = getPersonaBindings(independentSourceId)
      .filter(connection => connection.type === 'character')
      .map(connection => connection.id);
    const branchIds = Array.from(new Set(
      Object.keys(manager.getEffectiveGroups()).filter(id =>
        id !== independentSourceId && manager.findParentOf(id) === null,
      ),
    )).filter(id => {
      if (!searchQuery) return true;
      return getPersonaName(id).toLowerCase().includes(searchQuery.toLowerCase());
    }).filter(id => {
      if (filterMode === 'samename') return getBranchBaseName(id) === getBranchBaseName(independentSourceId);
      if (filterMode === 'samechar') {
        const bindings = getPersonaBindings(id)
          .filter(connection => connection.type === 'character')
          .map(connection => connection.id);
        return bindings.some(binding => sourceBindings.includes(binding));
      }
      return true;
    });

    leftPane.innerHTML = `
      <div class="cp2-manager-source-card">
        <img class="cp2-picker-avatar" src="${getThumbUrl(independentSourceId)}" />
        <div class="cp2-manager-source-copy">
          <strong>${escapeHtml(sourceName)}</strong>
          <span>当前为独立人设</span>
        </div>
      </div>
      <button id="cp2-mgr-create-current-group" class="menu_button cp2-manager-primary-action">
        <i class="fa-solid fa-folder-plus"></i> 以此人设建立新分支
      </button>
    `;
    rightPane.innerHTML = branchIds.length > 0
      ? branchIds.map(id => {
        const count = manager.getEffectiveGroups()[id]?.length ?? 0;
        return `
          <button class="cp2-manager-target-branch" data-id="${escapeHtml(id)}" title="将${escapeHtml(sourceName)}移入此分支">
            <img class="cp2-picker-avatar" src="${getThumbUrl(id)}" />
            <span class="cp2-manager-target-copy">
              <strong>${escapeHtml(manager.getGroupName(id, getPersonaName(id)))}</strong>
              <span>${count} 个人设 · ${escapeHtml(getPersonaName(id))}</span>
            </span>
            <i class="fa-solid fa-arrow-right"></i>
          </button>
        `;
      }).join('')
      : '<div class="cp2-manager-empty-state">没有符合条件的已有分支</div>';

    if (countEl) countEl.textContent = String(branchIds.length);

    leftPane.querySelector('#cp2-mgr-create-current-group')?.addEventListener('click', e => {
      e.stopPropagation();
      manager.initGroup(independentSourceId);
      currentParentId = independentSourceId;
      selectedDestinationId = independentSourceId;
      renderPanes();
    });

    rightPane.querySelectorAll<HTMLButtonElement>('.cp2-manager-target-branch').forEach(button => {
      button.addEventListener('click', e => {
        e.stopPropagation();
        const targetId = button.dataset.id;
        if (!targetId) return;
        manager.linkChild(targetId, independentSourceId);
        currentParentId = targetId;
        selectedDestinationId = targetId;
        toastr.success(`已将【${sourceName}】移入【${getPersonaName(targetId)}】分支`);
        renderAvatarBlock();
        renderVariantsPanel(true, targetId);
        renderPanes();
      });
    });
  }

  function renderPanes() {
    const leftPane = document.getElementById('cp2-mgr-left');
    const rightPane = document.getElementById('cp2-mgr-right');
    const countEl = document.getElementById('cp2-mgr-count');
    const leftTitle = document.getElementById('cp2-mgr-left-title');
    const rightTitle = document.getElementById('cp2-mgr-right-title');
    const searchInput = document.getElementById('cp2-mgr-search') as HTMLInputElement | null;
    if (!leftPane || !rightPane) return;

    if (independentSourceId && !selectedDestinationId) {
      destroyManagerSortables?.();
      destroyManagerSortables = null;
      if (leftTitle) leftTitle.textContent = '当前独立人设';
      if (rightTitle) rightTitle.textContent = '选择目标分支';
      if (searchInput) searchInput.placeholder = '搜索目标分支...';
      renderIndependentDestinationPane(leftPane, rightPane, countEl);
      return;
    }

    if (leftTitle) leftTitle.innerHTML = '可选独立人设 (<span id="cp2-mgr-count">0</span>)';
    if (rightTitle) rightTitle.textContent = '当前分支列表';
    if (searchInput) searchInput.placeholder = '搜索独立人设...';

    const effectiveGroups = manager.getEffectiveGroups();
    const children = effectiveGroups[currentParentId] || [];
    const layout = manager.getBranchLayout(currentParentId, children);
    const subgroups = manager.getSettings().subgroups[currentParentId] || [];
    const subgroupById = new Map(subgroups.map(group => [group.id, group]));
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
      const tags = manager.getPersonaTags(id);
      const tagHtml = tags.length > 0
        ? `<span class="cp2-persona-tags">${tags.map(tag => `<span class="cp2-persona-tag" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join('')}</span>`
        : '';
      leftHtml += `
        <div class="cp2-picker-item" data-id="${escapeHtml(id)}" title="点击移入分支">
          <img class="cp2-picker-avatar" src="${thumbUrl}" />
          <span class="cp2-picker-name">${escapeHtml(name)}${tagHtml}</span>
          <i class="fa-solid fa-arrow-right" style="opacity: 0.5;"></i>
        </div>
      `;
    }
    if (availableIds.length === 0) {
      leftHtml = '<div style="opacity:0.5;text-align:center;padding:20px;">没有可用的独立人设</div>';
    }

    let rightHtml = `
      <div class="cp2-manager-toolbar">
        <button id="cp2-mgr-create-subgroup" class="menu_button"><i class="fa-solid fa-folder-plus"></i> 新建分组</button>
        <button id="cp2-mgr-disband" class="menu_button cp2-manager-disband"><i class="fa-solid fa-link-slash"></i> 解散分组</button>
      </div>
      <div class="cp2-manager-branch">
    `;

    for (const item of layout.root) {
      if (item.type === 'persona') {
        rightHtml += renderManagerPersonaItem(item.id, {
          isEntry: item.id === currentParentId,
          subgroupId: null,
        });
        continue;
      }

      const subgroup = subgroupById.get(item.id);
      const memberIds = layout.subgroupMembers[item.id] || [];
      const groupName = subgroup?.name || item.id;
      const collapsed = subgroup?.collapsed ?? false;
      rightHtml += `
        <div class="cp2-manager-subgroup cp2-subgroup cp2-root-item${collapsed ? ' is-collapsed' : ''}" data-subgroup-id="${escapeHtml(item.id)}" data-layout-type="subgroup">
          <div class="cp2-manager-subgroup-header">
            <button class="cp2-icon-btn cp2-mgr-toggle-subgroup" data-subgroup-id="${escapeHtml(item.id)}" title="${collapsed ? '展开分组' : '折叠分组'}">
              <i class="fa-solid fa-chevron-${collapsed ? 'right' : 'down'}"></i>
            </button>
            <span class="cp2-manager-subgroup-name">${escapeHtml(groupName)}</span>
            <span class="cp2-subgroup-count">${memberIds.length}</span>
            <button class="cp2-icon-btn cp2-mgr-rename-subgroup" data-subgroup-id="${escapeHtml(item.id)}" title="重命名分组"><i class="fa-solid fa-pencil"></i></button>
            <button class="cp2-icon-btn cp2-subgroup-delete cp2-mgr-delete-subgroup" data-subgroup-id="${escapeHtml(item.id)}" title="删除分组"><i class="fa-solid fa-trash"></i></button>
          </div>
          <div class="cp2-subgroup-body"><div class="cp2-manager-subgroup-items cp2-subgroup-items">
            ${memberIds.map(id => renderManagerPersonaItem(id, {
              subgroupId: item.id,
            })).join('')}
          </div></div>
        </div>
      `;
    }
    rightHtml += '</div>';

    leftPane.innerHTML = leftHtml;
    rightPane.innerHTML = rightHtml;
    destroyManagerSortables?.();
    destroyManagerSortables = null;
    if (pendingManagerSubgroupFocusId) {
      const focusId = pendingManagerSubgroupFocusId;
      pendingManagerSubgroupFocusId = null;
      requestAnimationFrame(() => {
        const subgroup = rightPane.querySelector<HTMLElement>(`[data-subgroup-id="${CSS.escape(focusId)}"]`);
        if (!subgroup) return;
        subgroup.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        subgroup.classList.add('cp2-new-subgroup');
        window.setTimeout(() => subgroup.classList.remove('cp2-new-subgroup'), 900);
      });
    }
    const currentCountEl = document.getElementById('cp2-mgr-count');
    if (currentCountEl) currentCountEl.textContent = String(availableIds.length);

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

    const managerBranch = rightPane.querySelector<HTMLElement>('.cp2-manager-branch');
    if (managerBranch) {
      destroyManagerSortables = mountBranchSortables({
        root: managerBranch,
        onCommit: snapshot => {
          const newEntryId = manager.applyBranchLayoutSnapshot(currentParentId, snapshot, children);
          if (!newEntryId) return false;
          currentParentId = newEntryId;
          queueMicrotask(() => {
            renderAvatarBlock();
            renderVariantsPanel(true, newEntryId);
            renderPanes();
          });
          return true;
        },
        onReject: () => renderPanes(),
        onExpandSubgroup: (subgroupId, section) => {
          if (manager.setSubgroupCollapsed(currentParentId, subgroupId, false)) {
            section.classList.remove('is-collapsed');
            const toggle = section.querySelector<HTMLElement>('.cp2-mgr-toggle-subgroup');
            if (toggle) {
              toggle.title = '折叠分组';
              toggle.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
            }
          }
        },
        onDragStateChange: () => undefined,
      });
    }

    rightPane.querySelector('#cp2-mgr-create-subgroup')?.addEventListener('click', async e => {
      e.stopPropagation();
      const name = await promptSubgroupName();
      if (!name) return;
      pendingManagerSubgroupFocusId = manager.createSubgroup(currentParentId, name).id;
      renderPanes();
    });

    rightPane.querySelector('#cp2-mgr-disband')?.addEventListener('click', () => {
      if (!confirm('确定要解散该分组吗？所有成员将恢复为独立人设。')) return;
      manager.disbandGroup(currentParentId);
      renderPanes();
    });

    rightPane.querySelectorAll('.cp2-mgr-rename-subgroup').forEach(el => {
      el.addEventListener('click', async e => {
        e.stopPropagation();
        const subgroupId = (el as HTMLElement).dataset.subgroupId;
        if (!subgroupId) return;
        const currentName = subgroupById.get(subgroupId)?.name || '';
        const name = await promptSubgroupName(currentName);
        if (!name) return;
        manager.renameSubgroup(currentParentId, subgroupId, name);
        renderPanes();
      });
    });

    rightPane.querySelectorAll('.cp2-mgr-delete-subgroup').forEach(el => {
      el.addEventListener('click', async e => {
        e.stopPropagation();
        const subgroupId = (el as HTMLElement).dataset.subgroupId;
        if (!subgroupId) return;
        const subgroupName = subgroupById.get(subgroupId)?.name || subgroupId;
        const confirmed = await confirmSubgroupDeletion(subgroupName);
        if (!confirmed) return;
        manager.deleteSubgroup(currentParentId, subgroupId);
        renderPanes();
      });
    });

    rightPane.querySelectorAll('.cp2-mgr-toggle-subgroup').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const subgroupId = (el as HTMLElement).dataset.subgroupId;
        if (!subgroupId) return;
        const collapsed = subgroupById.get(subgroupId)?.collapsed ?? false;
        manager.setSubgroupCollapsed(currentParentId, subgroupId, !collapsed);
        renderPanes();
      });
    });
  }

  const popupContent = `
    <div class="cp2-manager-dialog">
    <div class="cp2-manager-hint">
      <i class="fa-solid fa-users"></i> 批量管理分组。你可以将左侧的独立人设点击加入右侧，也可以在右侧调整顺序、移入分组或移出分支。
    </div>
    <div class="cp2-manager-searchbar">
      <input type="text" id="cp2-mgr-search" class="text_pole" placeholder="搜索独立人设...">
      <button class="menu_button cp2-filter-btn" data-mode="all">全部</button>
      <button class="menu_button cp2-filter-btn" data-mode="samename">同名</button>
      <button class="menu_button cp2-filter-btn" data-mode="samechar">同绑定</button>
    </div>
    <div class="cp2-manager-columns">
      <div class="cp2-manager-pane">
        <div id="cp2-mgr-left-title" class="cp2-manager-pane-title">可选独立人设 (<span id="cp2-mgr-count">0</span>)</div>
        <div id="cp2-mgr-left" class="cp2-picker-list cp2-manager-list"></div>
      </div>
      <div class="cp2-manager-transfer-icon">
        <i class="fa-solid fa-right-left"></i>
      </div>
      <div class="cp2-manager-pane">
        <div id="cp2-mgr-right-title" class="cp2-manager-pane-title">当前分支列表</div>
        <div id="cp2-mgr-right" class="cp2-picker-list cp2-manager-list"></div>
      </div>
    </div>
    </div>
  `;

  const popup = new Popup(popupContent, POPUP_TYPE.CONFIRM, '', {
    okButton: '完成',
    cancelButton: '关闭',
    wider: true,
    onOk: () => {
      renderAvatarBlock();
      renderVariantsPanel(true);
    }
  });
  void popup.show().finally(() => {
    destroyManagerSortables?.();
    destroyManagerSortables = null;
  });

  setTimeout(() => {
    renderPanes();
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

function setupContextMenu(): () => void {
  const block = document.getElementById('user_avatar_block');
  if (!block) return () => undefined;
  const controller = new AbortController();

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
  }, { signal: controller.signal });

  document.addEventListener('click', evt => {
    if (contextMenuEl && !(evt.target as Element).closest('.cp2-context-menu')) closeContextMenu();
  }, { signal: controller.signal });

  return () => {
    controller.abort();
    closeContextMenu();
  };
}

// ==================== 拖拽：桌面鼠标 ====================

let draggingId: string | null = null;
let lastDropTime = 0;

function setupMouseDrag(): () => void {
  const block = document.getElementById('user_avatar_block');
  if (!block) return () => undefined;
  const controller = new AbortController();

  block.addEventListener('dragstart', evt => {
    const settings = manager?.getSettings();
    if (!settings?.enabled) return;
    const container = (evt.target as Element).closest('.avatar-container');
    if (!container) return;
    draggingId = getAvatarId(container);
    if (draggingId) container.classList.add('cp2-dragging');
  }, { signal: controller.signal });

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
  }, { signal: controller.signal });

  block.addEventListener('dragenter', evt => {
    if (!draggingId) return;
    const container = (evt.target as Element).closest('.avatar-container');
    if (container && getAvatarId(container) !== draggingId) container.classList.add('cp2-drag-target');
  }, { signal: controller.signal });

  block.addEventListener('dragleave', evt => {
    const container = (evt.target as Element).closest('.avatar-container');
    container?.classList.remove('cp2-drag-target');
  }, { signal: controller.signal });

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
  }, { signal: controller.signal });

  block.addEventListener('dragend', evt => {
    const container = (evt.target as Element).closest('.avatar-container');
    container?.classList.remove('cp2-dragging');
    block.querySelectorAll('.cp2-drag-target').forEach(el => el.classList.remove('cp2-drag-target'));
    draggingId = null;
  }, { signal: controller.signal });

  return () => {
    controller.abort();
    block.querySelectorAll('.cp2-dragging, .cp2-drag-target').forEach(el => {
      el.classList.remove('cp2-dragging', 'cp2-drag-target');
    });
    draggingId = null;
  };
}

// ==================== 拖拽：触屏长按 ====================

let touchDragging = false;
let touchDragId: string | null = null;
let touchDragEl: Element | null = null;
let touchTimer: ReturnType<typeof setTimeout> | null = null;
let touchStartX = 0;
let touchStartY = 0;
let lastTouchTarget: Element | null = null;

function setupTouchDrag(): () => void {
  const block = document.getElementById('user_avatar_block');
  if (!block) return () => undefined;
  const controller = new AbortController();

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
  }, { passive: true, signal: controller.signal });

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
  }, { passive: false, signal: controller.signal });

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
  }, { signal: controller.signal });

  block.addEventListener('touchcancel', () => {
    if (touchTimer) clearTimeout(touchTimer);
    touchTimer = null;
    touchDragEl?.classList.remove('cp2-dragging');
    lastTouchTarget?.classList.remove('cp2-drag-target');
    touchDragging = false;
    touchDragId = null;
    touchDragEl = null;
    lastTouchTarget = null;
  }, { signal: controller.signal });

  return () => {
    controller.abort();
    if (touchTimer) clearTimeout(touchTimer);
    touchTimer = null;
    touchDragEl?.classList.remove('cp2-dragging');
    lastTouchTarget?.classList.remove('cp2-drag-target');
    touchDragging = false;
    touchDragId = null;
    touchDragEl = null;
    lastTouchTarget = null;
  };
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

function setupBodyObserver(): () => void {
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const bodyObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLElement && node.classList.contains('popup')) {
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            applyPopupVisualGrouping(node);
          }, 100);
          pendingTimers.add(timer);
        }
      }
    }
  });
  bodyObserver.observe(document.body, { childList: true });
  return () => {
    bodyObserver.disconnect();
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
  };
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
        <div class="cp2-setting-row">
          <label class="checkbox_label" for="cp2-setting-show-binding-avatars">
            <input type="checkbox" id="cp2-setting-show-binding-avatars">
            <span>在分支列表显示绑定角色头像</span>
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

  const cbBindingAvatars = wrapper.querySelector<HTMLInputElement>('#cp2-setting-show-binding-avatars')!;
  cbBindingAvatars.checked = manager.getSettings().showBindingAvatars ?? true;
  cbBindingAvatars.addEventListener('change', () => {
    manager.getSettings().showBindingAvatars = cbBindingAvatars.checked;
    saveSettingsDebounced();
    renderVariantsPanel(true);
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
    manager.resetGroupingState();
    updateAutoGroups();
    renderAvatarBlock();
    renderVariantsPanel(true);
    toastr.success(tUi('personaCollapse.resetComplete', '已重置所有分组'));
  });
}

// ==================== MutationObserver ====================

function setupMutationObserver(): () => void {
  const block = document.getElementById('user_avatar_block');
  if (!block) return () => undefined;
  const observer = new MutationObserver(() => { if (!isRendering) scheduleRender(); });
  observer.observe(block, { childList: true, subtree: false });
  return () => observer.disconnect();
}

let runtimeCleanup: (() => void) | null = null;

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
      variantsPanelDirty = true;
      saveSettingsDebounced();
    });
    (extension_settings as any)[SETTINGS_KEY] = manager.getSettings();

    await loadPersonasApi();

    eventSource.on(event_types.APP_READY, () => {
      runtimeCleanup?.();
      const disposers = [
        setupContextMenu(),
        setupMouseDrag(),
        setupTouchDrag(),
        setupMutationObserver(),
        setupBodyObserver(),
      ];
      const panelInterval = setInterval(() => renderVariantsPanel(), 500);
      runtimeCleanup = () => {
        for (const dispose of disposers) dispose();
        clearInterval(panelInterval);
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = null;
      };

      initExtensionSettings();
      renderAvatarBlock();
      renderVariantsPanel(true);
    });

    eventSource.on(event_types.SETTINGS_UPDATED, () => {
      variantsPanelDirty = true;
      scheduleRender();
      renderVariantsPanel(true);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
      scheduleRender();
    });

    console.log(`${LOG_PREFIX} 初始化完成`);
  });
}

import Sortable from 'sortablejs';

import type { BranchLayoutItem, BranchLayoutSnapshot } from './manager';

export interface BranchSortableOptions {
  root: HTMLElement;
  onCommit: (snapshot: BranchLayoutSnapshot) => boolean;
  onReject: () => void;
  onExpandSubgroup: (subgroupId: string, section: HTMLElement) => void;
  onDragStateChange: (active: boolean) => void;
}

const ROOT_ITEM_SELECTOR = '.cp2-root-item';
const PERSONA_ITEM_SELECTOR = '.cp2-persona-sort-item';
const SUBGROUP_SELECTOR = '.cp2-subgroup';
const SUBGROUP_HEADER_SELECTOR = '.cp2-subgroup-header';
const SUBGROUP_ITEMS_SELECTOR = '.cp2-subgroup-items';
const COLLAPSED_CLASS = 'is-collapsed';
const DRAG_ACTIVE_CLASS = 'cp2-drag-active';
const DROP_TARGET_CLASS = 'cp2-drop-target';
const INSERT_BEFORE_CLASS = 'cp2-sort-insert-before';
const INSERT_AFTER_CLASS = 'cp2-sort-insert-after';
const SOURCE_HIDDEN_CLASS = 'cp2-sort-source';
const HOVER_EXPAND_DELAY_MS = 500;

interface PendingDrop {
  to: HTMLElement;
  related: HTMLElement | null;
  willInsertAfter: boolean;
}

function isHTMLElement(value: Element | null | undefined): value is HTMLElement {
  return value instanceof HTMLElement;
}

function getDirectChildren(parent: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(parent.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.matches(selector),
  );
}

function getRootSubgroupItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SUBGROUP_ITEMS_SELECTOR));
}

function canMoveEntryIntoSubgroup(root: HTMLElement, event: Sortable.MoveEvent): boolean {
  if (event.to === root || !(event.dragged instanceof HTMLElement)) return true;
  if (event.dragged.dataset.layoutType !== 'persona') return false;
  const entry = getDirectChildren(root, ROOT_ITEM_SELECTOR)[0];
  if (entry?.dataset.layoutType !== 'persona' || event.dragged !== entry) return true;
  return getDirectChildren(root, ROOT_ITEM_SELECTOR).some(
    item => item !== event.dragged && item.dataset.layoutType === 'persona',
  );
}

function canMoveRootItemToStart(root: HTMLElement, event: Sortable.MoveEvent): boolean {
  if (event.to !== root || !(event.dragged instanceof HTMLElement)) return true;
  if (event.dragged.dataset.layoutType !== 'subgroup' || event.willInsertAfter) return true;
  const firstItem = getDirectChildren(root, ROOT_ITEM_SELECTOR)[0];
  return event.related !== firstItem;
}

export function readBranchLayoutSnapshot(root: HTMLElement): BranchLayoutSnapshot {
  const rootItems: BranchLayoutItem[] = [];
  const subgroupMembers: Record<string, string[]> = {};

  // SortableJS 保留被跨区拖入项的原始类名，顶层快照也必须识别 persona 项。
  for (const item of getDirectChildren(root, `${ROOT_ITEM_SELECTOR}, ${PERSONA_ITEM_SELECTOR}`)) {
    const layoutType = item.dataset.layoutType;
    if (layoutType === 'persona') {
      const personaId = item.dataset.personaId;
      if (personaId) rootItems.push({ type: 'persona', id: personaId });
      continue;
    }

    if (layoutType !== 'subgroup') continue;

    const subgroupId = item.dataset.subgroupId;
    if (!subgroupId) continue;

    rootItems.push({ type: 'subgroup', id: subgroupId });
    const items = item.querySelector<HTMLElement>(`:scope > .cp2-subgroup-body > .cp2-subgroup-items`);
    subgroupMembers[subgroupId] = items
      ? getDirectChildren(items, PERSONA_ITEM_SELECTOR)
        .map(personaItem => personaItem.dataset.personaId)
        .filter((personaId): personaId is string => Boolean(personaId))
      : [];
  }

  return { root: rootItems, subgroupMembers };
}

export function mountBranchSortables(options: BranchSortableOptions): () => void {
  const instances: Sortable[] = [];
  const disposers: Array<() => void> = [];
  let destroyed = false;
  let dragActive = false;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let activeDropSection: HTMLElement | null = null;
  let activeInsertElement: HTMLElement | null = null;
  let draggedElement: HTMLElement | null = null;
  let pendingDrop: PendingDrop | null = null;
  let dragWatchdog: ReturnType<typeof setTimeout> | null = null;
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const clearHoverTimer = (): void => {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
  };

  const stopDrag = (): void => {
    const wasActive = dragActive;
    dragActive = false;
    options.root.classList.remove(DRAG_ACTIVE_CLASS);
    activeDropSection?.classList.remove(DROP_TARGET_CLASS);
    activeDropSection = null;
    activeInsertElement?.classList.remove(INSERT_BEFORE_CLASS, INSERT_AFTER_CLASS);
    activeInsertElement = null;
    draggedElement?.classList.remove(SOURCE_HIDDEN_CLASS);
    draggedElement = null;
    pendingDrop = null;
    if (dragWatchdog) clearTimeout(dragWatchdog);
    dragWatchdog = null;
    if (wasActive) options.onDragStateChange(false);
    clearHoverTimer();
  };

  const clearInsertMarker = (): void => {
    activeInsertElement?.classList.remove(INSERT_BEFORE_CLASS, INSERT_AFTER_CLASS);
    activeInsertElement = null;
  };

  const updateDropTarget = (event: Sortable.MoveEvent): void => {
    const nextSection = event.to.closest<HTMLElement>(SUBGROUP_SELECTOR);
    if (nextSection === activeDropSection) return;
    activeDropSection?.classList.remove(DROP_TARGET_CLASS);
    activeDropSection = nextSection;
    activeDropSection?.classList.add(DROP_TARGET_CLASS);
  };

  const clearDropTarget = (): void => {
    activeDropSection?.classList.remove(DROP_TARGET_CLASS);
    activeDropSection = null;
  };

  const updateInsertMarker = (event: Sortable.MoveEvent): void => {
    const nextElement = event.related instanceof HTMLElement && event.related.matches(
      `${ROOT_ITEM_SELECTOR}, ${PERSONA_ITEM_SELECTOR}`,
    ) && event.related !== draggedElement
      ? event.related
      : null;
    if (nextElement === activeInsertElement) {
      if (nextElement) {
        nextElement.classList.toggle(INSERT_AFTER_CLASS, Boolean(event.willInsertAfter));
        nextElement.classList.toggle(INSERT_BEFORE_CLASS, !event.willInsertAfter);
      }
      return;
    }
    activeInsertElement?.classList.remove(INSERT_BEFORE_CLASS, INSERT_AFTER_CLASS);
    activeInsertElement = nextElement;
    if (activeInsertElement) {
      activeInsertElement.classList.toggle(INSERT_AFTER_CLASS, Boolean(event.willInsertAfter));
      activeInsertElement.classList.toggle(INSERT_BEFORE_CLASS, !event.willInsertAfter);
    }
  };

  const sharedOptions: Sortable.Options = {
    group: 'cp2-branch-layout',
    animation: reducedMotion ? 0 : 120,
    handle: '.cp2-sort-handle',
    draggable: ROOT_ITEM_SELECTOR,
    emptyInsertThreshold: 48,
    ghostClass: 'cp2-sort-ghost',
    chosenClass: 'cp2-sort-chosen',
    dragClass: 'cp2-sort-drag',
    onMove: event => {
      const allowed = canMoveEntryIntoSubgroup(options.root, event)
        && canMoveRootItemToStart(options.root, event);
      if (allowed) {
        const isCrossContainer = event.to !== draggedElement?.parentElement;
        updateDropTarget(event);
        updateInsertMarker(event);
        pendingDrop = {
          to: event.to,
          related: event.related instanceof HTMLElement && event.related !== draggedElement
            ? event.related
            : null,
          willInsertAfter: Boolean(event.willInsertAfter),
        };
        // 跨容器必须让 SortableJS 完成一次接管，否则目标分组不会收到项目；
        // 进入同一容器后停止实时排序，最终位置由 onEnd 的 pendingDrop 一次提交。
        return isCrossContainer;
      } else {
        clearDropTarget();
        clearInsertMarker();
        pendingDrop = null;
      }
      // 同一容器内只预览落点，禁止 SortableJS 持续改写列表布局。
      return false;
    },
    delay: 180,
    delayOnTouchOnly: true,
    touchStartThreshold: 5,
    fallbackTolerance: 4,
    scroll: true,
    scrollSensitivity: 60,
    scrollSpeed: 16,
    onStart: event => {
      if (destroyed) return;
      dragActive = true;
      draggedElement = event.item;
      pendingDrop = null;
      draggedElement.classList.add(SOURCE_HIDDEN_CLASS);
      options.root.classList.add(DRAG_ACTIVE_CLASS);
      options.onDragStateChange(true);
      dragWatchdog = setTimeout(() => {
        if (!dragActive) return;
        stopDrag();
        options.onReject();
      }, 30000);
    },
    onEnd: () => {
      if (draggedElement && pendingDrop) {
        const { to, related, willInsertAfter } = pendingDrop;
        if (to.isConnected && (!related || related.parentElement === to) && related !== draggedElement) {
          if (related) {
            to.insertBefore(draggedElement, willInsertAfter ? related.nextSibling : related);
          } else {
            to.appendChild(draggedElement);
          }
        }
      }
      const accepted = options.onCommit(readBranchLayoutSnapshot(options.root));
      stopDrag();
      if (!accepted) queueMicrotask(options.onReject);
    },
    onCancel: stopDrag,
  };

  instances.push(Sortable.create(options.root, sharedOptions));
  for (const items of getRootSubgroupItems(options.root)) {
    instances.push(Sortable.create(items, { ...sharedOptions, draggable: PERSONA_ITEM_SELECTOR }));
  }

  for (const header of Array.from(options.root.querySelectorAll<HTMLElement>(SUBGROUP_HEADER_SELECTOR))) {
    const section = header.closest(SUBGROUP_SELECTOR);
    if (!isHTMLElement(section)) continue;

    const scheduleExpand = (): void => {
      if (!dragActive || !section.classList.contains(COLLAPSED_CLASS)) return;
      clearHoverTimer();
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        if (destroyed || !dragActive || !section.isConnected || !section.classList.contains(COLLAPSED_CLASS)) return;
        const subgroupId = section.dataset.subgroupId;
        if (subgroupId) options.onExpandSubgroup(subgroupId, section);
      }, HOVER_EXPAND_DELAY_MS);
    };

    header.addEventListener('pointerenter', scheduleExpand);
    header.addEventListener('pointerleave', clearHoverTimer);
    header.addEventListener('pointercancel', clearHoverTimer);
    disposers.push(() => {
      header.removeEventListener('pointerenter', scheduleExpand);
      header.removeEventListener('pointerleave', clearHoverTimer);
      header.removeEventListener('pointercancel', clearHoverTimer);
    });
  }

  return () => {
    destroyed = true;
    stopDrag();
    clearHoverTimer();
    for (const dispose of disposers.splice(0)) dispose();
    for (const instance of instances.splice(0)) instance.destroy();
  };
}

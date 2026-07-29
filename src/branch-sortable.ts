import Sortable from 'sortablejs';

import type { BranchLayoutItem, BranchLayoutSnapshot } from './manager';

export interface BranchSortableOptions {
  root: HTMLElement;
  onCommit: (snapshot: BranchLayoutSnapshot) => boolean;
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
const HOVER_EXPAND_DELAY_MS = 500;

type BranchMoveEventHandler = (event: Sortable.MoveEvent, originalEvent: Event) => boolean | -1 | 1 | void;

function isHTMLElement(value: Element | null | undefined): value is HTMLElement {
  return value instanceof HTMLElement;
}

function getDirectChildren(parent: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(parent.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.matches(selector),
  );
}

function getFirstRootPersona(root: HTMLElement): HTMLElement | null {
  for (const item of getDirectChildren(root, ROOT_ITEM_SELECTOR)) {
    if (item.dataset.layoutType === 'persona') return item;
  }
  return null;
}

function getRootSubgroupItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SUBGROUP_ITEMS_SELECTOR));
}

export function readBranchLayoutSnapshot(root: HTMLElement): BranchLayoutSnapshot {
  const rootItems: BranchLayoutItem[] = [];
  const subgroupMembers: Record<string, string[]> = {};

  for (const item of getDirectChildren(root, ROOT_ITEM_SELECTOR)) {
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

    const itemsContainer = item.querySelector<HTMLElement>(`:scope > .cp2-subgroup-body > .cp2-subgroup-items`);
    const members: string[] = [];
    if (itemsContainer) {
      for (const personaItem of getDirectChildren(itemsContainer, PERSONA_ITEM_SELECTOR)) {
        const personaId = personaItem.dataset.personaId;
        if (personaId) members.push(personaId);
      }
    }
    subgroupMembers[subgroupId] = members;
  }

  return { root: rootItems, subgroupMembers };
}

export function mountBranchSortables(options: BranchSortableOptions): () => void {
  const instances: Sortable[] = [];
  const disposers: Array<() => void> = [];
  let destroyed = false;
  let dragActive = false;
  let commitQueued = false;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverSection: HTMLElement | null = null;
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const clearHoverTimer = (): void => {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverSection = null;
  };

  const addListener = (
    element: HTMLElement,
    type: string,
    listener: (event: Event) => void,
  ): void => {
    element.addEventListener(type, listener);
    disposers.push(() => element.removeEventListener(type, listener));
  };

  const queueCommit = (): void => {
    if (destroyed || commitQueued) return;
    commitQueued = true;
    queueMicrotask(() => {
      commitQueued = false;
      if (destroyed) return;
      const snapshot = readBranchLayoutSnapshot(options.root);
      const accepted = options.onCommit(snapshot);
      if (!accepted) {
        options.root.dispatchEvent(new CustomEvent('cp2:layout-rejected', { detail: snapshot }));
      }
    });
  };

  const stopDrag = (): void => {
    if (!dragActive) return;
    dragActive = false;
    options.root.classList.remove(DRAG_ACTIVE_CLASS);
    options.onDragStateChange(false);
    clearHoverTimer();
  };

  const onMove: BranchMoveEventHandler = event => {
    const dragged = event.dragged;
    if (!(dragged instanceof HTMLElement)) return true;

    const draggedType = dragged.dataset.layoutType;
    if (draggedType === 'subgroup' && event.to !== options.root) return false;

    if (draggedType === 'persona') {
      const entryPersona = getFirstRootPersona(options.root);
      if (entryPersona && dragged.dataset.personaId === entryPersona.dataset.personaId && event.to !== options.root) {
        return false;
      }
    }

    if (draggedType === 'subgroup' && event.to === options.root) {
      const firstRootItem = getDirectChildren(options.root, ROOT_ITEM_SELECTOR)[0] ?? null;
      if (
        firstRootItem
        && event.related === firstRootItem
        && event.willInsertAfter !== true
      ) {
        return false;
      }
    }

    return true;
  };

  const sharedOptions: Sortable.Options = {
    group: {
      name: 'cp2-branch-layout',
      pull: true,
      put: true,
    },
    animation: reducedMotion ? 0 : 150,
    handle: '.cp2-sort-handle',
    draggable: ROOT_ITEM_SELECTOR,
    dragoverBubble: true,
    emptyInsertThreshold: 18,
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    ghostClass: 'cp2-sort-ghost',
    chosenClass: 'cp2-sort-chosen',
    dragClass: 'cp2-sort-drag',
    onMove,
    onStart: () => {
      if (destroyed) return;
      dragActive = true;
      options.root.classList.add(DRAG_ACTIVE_CLASS);
      options.onDragStateChange(true);
    },
    onEnd: () => {
      stopDrag();
      queueCommit();
    },
  };

  instances.push(Sortable.create(options.root, sharedOptions));

  for (const items of getRootSubgroupItems(options.root)) {
    instances.push(
      Sortable.create(items, {
        ...sharedOptions,
        draggable: PERSONA_ITEM_SELECTOR,
      }),
    );
  }

  for (const header of Array.from(options.root.querySelectorAll<HTMLElement>(SUBGROUP_HEADER_SELECTOR))) {
    const section = header.closest(SUBGROUP_SELECTOR);
    if (!isHTMLElement(section)) continue;
    const subgroupId = section.dataset.subgroupId;
    if (!subgroupId) continue;

    const scheduleExpand = (): void => {
      if (!dragActive || !section.classList.contains(COLLAPSED_CLASS)) return;
      clearHoverTimer();
      hoverSection = section;
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        const currentSection = hoverSection;
        hoverSection = null;
        if (!currentSection || destroyed || !dragActive) return;
        if (!currentSection.isConnected || !currentSection.classList.contains(COLLAPSED_CLASS)) return;
        const currentId = currentSection.dataset.subgroupId;
        if (!currentId) return;
        options.onExpandSubgroup(currentId, currentSection);
      }, HOVER_EXPAND_DELAY_MS);
    };

    const cancelExpand = (): void => {
      clearHoverTimer();
    };

    addListener(header, 'pointerenter', scheduleExpand);
    addListener(header, 'pointerleave', cancelExpand);
    addListener(header, 'pointercancel', cancelExpand);
  }

  return () => {
    destroyed = true;
    stopDrag();
    clearHoverTimer();
    for (const dispose of disposers.splice(0)) dispose();
    for (const instance of instances.splice(0)) instance.destroy();
  };
}

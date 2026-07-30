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
const DROP_TARGET_CLASS = 'cp2-drop-target';
const DROP_INDICATOR_CLASS = 'cp2-manual-drop-indicator';
const HOVER_EXPAND_DELAY_MS = 500;
const DROP_HIT_MARGIN_PX = 40;

type BranchMoveEventHandler = (event: Sortable.MoveEvent, originalEvent: Event) => boolean | -1 | 1 | void;

interface DragPoint {
  clientX: number;
  clientY: number;
}

interface ElementRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface LayoutChild {
  element: HTMLElement;
  rect: ElementRect;
}

interface ContainerLayout {
  element: HTMLElement;
  rect: ElementRect;
  children: LayoutChild[];
}

interface GroupLayout extends ContainerLayout {
  subgroupId: string;
  section: HTMLElement;
  hitRect: ElementRect;
}

type DraggedItem =
  | { type: 'persona'; id: string }
  | { type: 'subgroup'; id: string };

type DragPlacement =
  | {
      targetType: 'root';
      index: number;
      indicatorRect: ElementRect;
    }
  | {
      targetType: 'group';
      subgroupId: string;
      index: number;
      section: HTMLElement;
      indicatorRect: ElementRect;
    };

interface ManualDragState {
  dragged: DraggedItem;
  draggedElement: HTMLElement;
  sourceSnapshot: BranchLayoutSnapshot;
  indicator: HTMLElement;
  frame: ReturnType<typeof requestAnimationFrame> | null;
  lastPoint: DragPoint | null;
  placement: DragPlacement | null;
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

function getPoint(event: Event | null | undefined): DragPoint | null {
  const touchEvent = event as TouchEvent | undefined;
  const touch = touchEvent?.touches?.[0] ?? touchEvent?.changedTouches?.[0];
  if (touch) return { clientX: touch.clientX, clientY: touch.clientY };

  const pointerEvent = event as MouseEvent | PointerEvent | undefined;
  if (
    typeof pointerEvent?.clientX === 'number'
    && typeof pointerEvent.clientY === 'number'
  ) {
    return { clientX: pointerEvent.clientX, clientY: pointerEvent.clientY };
  }

  return null;
}

function getSortableOriginalEvent(event: Sortable.SortableEvent): Event | null {
  const originalEvent = (event as Sortable.SortableEvent & { originalEvent?: Event }).originalEvent;
  return originalEvent ?? null;
}

function getElementRect(element: HTMLElement): ElementRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function createDropIndicator(): HTMLElement {
  const indicator = document.createElement('div');
  indicator.className = DROP_INDICATOR_CLASS;
  indicator.style.display = 'none';
  document.body.appendChild(indicator);
  return indicator;
}

function readDraggedItem(element: HTMLElement): DraggedItem | null {
  const layoutType = element.dataset.layoutType;
  if (layoutType === 'persona' && element.dataset.personaId) {
    return { type: 'persona', id: element.dataset.personaId };
  }
  if (layoutType === 'subgroup' && element.dataset.subgroupId) {
    return { type: 'subgroup', id: element.dataset.subgroupId };
  }
  return null;
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

function removeDraggedFromSnapshot(snapshot: BranchLayoutSnapshot, dragged: DraggedItem): BranchLayoutSnapshot {
  const next: BranchLayoutSnapshot = {
    root: snapshot.root
      .filter(item => item.type !== dragged.type || item.id !== dragged.id)
      .map(item => ({ ...item })),
    subgroupMembers: Object.fromEntries(
      Object.entries(snapshot.subgroupMembers).map(([subgroupId, members]) => [
        subgroupId,
        dragged.type === 'persona' ? members.filter(id => id !== dragged.id) : [...members],
      ]),
    ),
  };
  return next;
}

function insertRootItem(root: BranchLayoutItem[], item: BranchLayoutItem, index: number): void {
  const clampedIndex = Math.max(0, Math.min(index, root.length));
  root.splice(clampedIndex, 0, item);
}

function buildSnapshotFromPlacement(
  sourceSnapshot: BranchLayoutSnapshot,
  dragged: DraggedItem,
  placement: DragPlacement,
): BranchLayoutSnapshot | null {
  const next = removeDraggedFromSnapshot(sourceSnapshot, dragged);

  if (dragged.type === 'subgroup') {
    if (placement.targetType !== 'root') return null;
    insertRootItem(next.root, { type: 'subgroup', id: dragged.id }, placement.index);
    return next;
  }

  if (placement.targetType === 'group') {
    const members = next.subgroupMembers[placement.subgroupId];
    if (!members) return null;
    const clampedIndex = Math.max(0, Math.min(placement.index, members.length));
    members.splice(clampedIndex, 0, dragged.id);
    return next;
  }

  insertRootItem(next.root, { type: 'persona', id: dragged.id }, placement.index);
  return next;
}

function getDropIndex(children: LayoutChild[], point: DragPoint): number {
  for (let index = 0; index < children.length; index++) {
    const rect = children[index].rect;
    if (point.clientY < rect.top + rect.height / 2) return index;
  }
  return children.length;
}

function getIndicatorRect(container: ContainerLayout, index: number): ElementRect {
  const child = container.children[index];
  const previous = container.children[index - 1];
  const top = child?.rect.top ?? previous?.rect.bottom ?? container.rect.top;
  return {
    left: container.rect.left,
    right: container.rect.right,
    top,
    bottom: top,
    width: container.rect.width,
    height: 0,
  };
}

function getExpandedRect(rect: ElementRect, margin = DROP_HIT_MARGIN_PX): ElementRect {
  return {
    left: rect.left - margin,
    right: rect.right + margin,
    top: rect.top - margin / 2,
    bottom: rect.bottom + margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 1.5,
  };
}

function pointInRect(point: DragPoint, rect: ElementRect): boolean {
  return (
    point.clientX >= rect.left
    && point.clientX <= rect.right
    && point.clientY >= rect.top
    && point.clientY <= rect.bottom
  );
}

function createContainerLayout(
  element: HTMLElement,
  childSelector: string,
  draggedElement: HTMLElement,
): ContainerLayout {
  return {
    element,
    rect: getElementRect(element),
    children: getDirectChildren(element, childSelector)
      .filter(child => child !== draggedElement)
      .map(child => ({
        element: child,
        rect: getElementRect(child),
      })),
  };
}

function createGroupLayouts(root: HTMLElement, draggedElement: HTMLElement): GroupLayout[] {
  const groups: GroupLayout[] = [];

  for (const section of root.querySelectorAll<HTMLElement>(SUBGROUP_SELECTOR)) {
    if (section.classList.contains(COLLAPSED_CLASS)) continue;
    const subgroupId = section.dataset.subgroupId;
    const container = section.querySelector<HTMLElement>(`:scope > .cp2-subgroup-body > .cp2-subgroup-items`);
    const body = section.querySelector<HTMLElement>(`:scope > .cp2-subgroup-body`);
    if (!subgroupId || !container || !body) continue;

    const layout = createContainerLayout(container, PERSONA_ITEM_SELECTOR, draggedElement);
    groups.push({
      ...layout,
      subgroupId,
      section,
      hitRect: getExpandedRect(getElementRect(body)),
    });
  }

  return groups;
}

function findGroupPlacement(
  root: HTMLElement,
  draggedElement: HTMLElement,
  point: DragPoint,
): DragPlacement | null {
  for (const layout of createGroupLayouts(root, draggedElement)) {
    if (!pointInRect(point, layout.hitRect)) continue;
    const index = getDropIndex(layout.children, point);
    return {
      targetType: 'group',
      subgroupId: layout.subgroupId,
      index,
      section: layout.section,
      indicatorRect: getIndicatorRect(layout, index),
    };
  }

  return null;
}

function findRootPlacement(
  root: HTMLElement,
  draggedElement: HTMLElement,
  point: DragPoint,
): DragPlacement | null {
  const layout = createContainerLayout(root, ROOT_ITEM_SELECTOR, draggedElement);
  const hitRect = getExpandedRect(layout.rect);
  if (!pointInRect(point, hitRect)) return null;

  const index = getDropIndex(layout.children, point);
  return {
    targetType: 'root',
    index,
    indicatorRect: getIndicatorRect(layout, index),
  };
}

function findPlacement(
  root: HTMLElement,
  draggedElement: HTMLElement,
  dragged: DraggedItem,
  point: DragPoint,
): DragPlacement | null {
  if (dragged.type === 'persona') {
    const groupPlacement = findGroupPlacement(root, draggedElement, point);
    if (groupPlacement) return groupPlacement;
  }

  return findRootPlacement(root, draggedElement, point);
}

function renderDropIndicator(state: ManualDragState): void {
  const placement = state.placement;
  if (!placement) {
    state.indicator.style.display = 'none';
    return;
  }

  const { indicatorRect } = placement;
  state.indicator.style.display = 'block';
  state.indicator.style.left = `${Math.round(indicatorRect.left)}px`;
  state.indicator.style.top = `${Math.round(indicatorRect.top - 1)}px`;
  state.indicator.style.width = `${Math.round(indicatorRect.width)}px`;
}

function clearDropTargets(root: HTMLElement): void {
  root.querySelectorAll(`.${DROP_TARGET_CLASS}`).forEach(element => {
    element.classList.remove(DROP_TARGET_CLASS);
  });
}

function renderDropTarget(root: HTMLElement, placement: DragPlacement | null): void {
  clearDropTargets(root);
  if (placement?.targetType === 'group') {
    placement.section.classList.add(DROP_TARGET_CLASS);
  }
}

export function mountBranchSortables(options: BranchSortableOptions): () => void {
  const instances: Sortable[] = [];
  const disposers: Array<() => void> = [];
  let destroyed = false;
  let dragActive = false;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverSection: HTMLElement | null = null;
  let manualDragState: ManualDragState | null = null;
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const clearHoverTimer = (): void => {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverSection = null;
  };

  const addListener = (
    element: HTMLElement | Document,
    type: string,
    listener: (event: Event) => void,
    optionsArg?: AddEventListenerOptions | boolean,
  ): void => {
    element.addEventListener(type, listener, optionsArg);
    disposers.push(() => element.removeEventListener(type, listener, optionsArg));
  };

  const stopDrag = (): void => {
    if (!dragActive) return;
    dragActive = false;
    options.root.classList.remove(DRAG_ACTIVE_CLASS);
    options.onDragStateChange(false);
    clearHoverTimer();
  };

  const clearManualDragState = (): void => {
    if (manualDragState?.frame) cancelAnimationFrame(manualDragState.frame);
    manualDragState?.indicator.remove();
    manualDragState = null;
    clearDropTargets(options.root);
  };

  const updateManualDragFrame = (): void => {
    const state = manualDragState;
    if (!state) return;
    state.frame = null;
    if (!state.lastPoint) return;

    const placement = findPlacement(options.root, state.draggedElement, state.dragged, state.lastPoint);
    state.placement = placement;
    renderDropIndicator(state);
    renderDropTarget(options.root, placement);
  };

  const scheduleManualDragFrame = (): void => {
    const state = manualDragState;
    if (!state || state.frame) return;
    state.frame = requestAnimationFrame(updateManualDragFrame);
  };

  const updateManualDragFromEvent = (event: Event | null | undefined): void => {
    const point = getPoint(event);
    if (!manualDragState || !point) return;
    manualDragState.lastPoint = point;
    scheduleManualDragFrame();
  };

  const onDocumentMove = (event: Event): void => {
    if (!manualDragState) return;
    updateManualDragFromEvent(event);
  };

  const commitManualDrop = (event: Event | null | undefined): void => {
    if (!manualDragState) return;
    updateManualDragFromEvent(event);
    if (manualDragState.frame) {
      cancelAnimationFrame(manualDragState.frame);
      manualDragState.frame = null;
      updateManualDragFrame();
    }

    const state = manualDragState;
    const placement = state.placement;
    if (!placement) {
      clearManualDragState();
      return;
    }

    const snapshot = buildSnapshotFromPlacement(state.sourceSnapshot, state.dragged, placement);
    clearManualDragState();

    if (!snapshot) return;
    const accepted = options.onCommit(snapshot);
    if (!accepted) {
      options.root.dispatchEvent(new CustomEvent('cp2:layout-rejected', { detail: snapshot }));
    }
  };

  const onMove: BranchMoveEventHandler = (_event, originalEvent) => {
    if (!manualDragState) return false;
    updateManualDragFromEvent(originalEvent);
    return false;
  };

  const sharedOptions: Sortable.Options = {
    group: {
      name: 'cp2-branch-layout',
      pull: true,
      put: true,
    },
    animation: reducedMotion ? 0 : 120,
    handle: '.cp2-sort-handle',
    draggable: ROOT_ITEM_SELECTOR,
    dragoverBubble: true,
    emptyInsertThreshold: DROP_HIT_MARGIN_PX,
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    ghostClass: 'cp2-sort-ghost',
    chosenClass: 'cp2-sort-chosen',
    dragClass: 'cp2-sort-drag',
    onMove,
    onStart: event => {
      if (destroyed || !(event.item instanceof HTMLElement)) return;
      const dragged = readDraggedItem(event.item);
      if (!dragged) return;

      dragActive = true;
      options.root.classList.add(DRAG_ACTIVE_CLASS);
      options.onDragStateChange(true);
      manualDragState = {
        dragged,
        draggedElement: event.item,
        sourceSnapshot: readBranchLayoutSnapshot(options.root),
        indicator: createDropIndicator(),
        frame: null,
        lastPoint: getPoint(getSortableOriginalEvent(event)),
        placement: null,
      };
      scheduleManualDragFrame();
    },
    onEnd: event => {
      commitManualDrop(getSortableOriginalEvent(event));
      stopDrag();
    },
  };

  addListener(document, 'pointermove', onDocumentMove, true);
  addListener(document, 'mousemove', onDocumentMove, true);
  addListener(document, 'touchmove', onDocumentMove, { capture: true, passive: true });

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
    clearManualDragState();
    for (const dispose of disposers.splice(0)) dispose();
    for (const instance of instances.splice(0)) instance.destroy();
  };
}

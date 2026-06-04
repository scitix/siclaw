/**
 * Pure state model for scroll-to-select message copying.
 *
 * Auto-select by visibility: in select mode, every message that is (or scrolls)
 * into the viewport is selected automatically — no clicking. Selection
 * accumulates as you scroll up or down, so you "paint" a range just by scrolling
 * through it (mouse wheel or scrollbar, either direction). Checkboxes still let
 * you fine-tune: un-checking a message records it in `excluded` so a later scroll
 * past it won't re-select it.
 */

export interface SelectionState {
  /** Currently selected message ids. */
  selected: ReadonlySet<string>
  /** Ids the user explicitly un-checked — never auto-re-selected on scroll. */
  excluded: ReadonlySet<string>
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), excluded: new Set() }

export function isSelected(state: SelectionState, id: string): boolean {
  return state.selected.has(id)
}

/**
 * Auto-select every currently-visible id, skipping ones the user un-checked.
 * Returns the SAME state object when nothing changed, so React skips the
 * re-render — cheap to call on every scroll tick.
 */
export function selectVisible(state: SelectionState, visibleIds: readonly string[]): SelectionState {
  let added = false
  const selected = new Set(state.selected)
  for (const id of visibleIds) {
    if (state.excluded.has(id) || selected.has(id)) continue
    selected.add(id)
    added = true
  }
  return added ? { selected, excluded: state.excluded } : state
}

/**
 * Toggle one message via its checkbox (or a click on the bubble). Un-checking
 * records the id in `excluded` so scrolling past it again won't re-select it;
 * re-checking clears that.
 */
export function toggleMessage(state: SelectionState, id: string): SelectionState {
  const selected = new Set(state.selected)
  const excluded = new Set(state.excluded)
  if (selected.has(id)) {
    selected.delete(id)
    excluded.add(id)
  } else {
    selected.add(id)
    excluded.delete(id)
  }
  return { selected, excluded }
}

/** Select every message (toolbar "All"); clears any manual exclusions. */
export function selectAll(ids: readonly string[]): SelectionState {
  return { selected: new Set(ids), excluded: new Set() }
}

export function selectedIds(state: SelectionState): Set<string> {
  return new Set(state.selected)
}

export function selectedCount(state: SelectionState): number {
  return state.selected.size
}

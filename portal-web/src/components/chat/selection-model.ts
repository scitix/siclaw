/**
 * Pure state model for message-range copying.
 *
 * Selection starts from one sticky "Select following" boundary, then checkboxes
 * let the user fine-tune individual messages.
 */

export interface SelectionState {
  /** Currently selected message ids. */
  selected: ReadonlySet<string>
  /** Ids the user explicitly removed from the current selected range. */
  excluded: ReadonlySet<string>
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), excluded: new Set() }

export function isSelected(state: SelectionState, id: string): boolean {
  return state.selected.has(id)
}

/** Select a contiguous loaded range from `startIndex` through the end. */
export function selectFollowing(ids: readonly string[], startIndex: number): SelectionState {
  const safeStart = Math.max(0, Math.min(startIndex, ids.length))
  return { selected: new Set(ids.slice(safeStart)), excluded: new Set() }
}

/**
 * Toggle the current boundary range: selecting a new boundary replaces the
 * range, while clicking the same fully-selected range clears it.
 */
export function toggleFollowing(ids: readonly string[], startIndex: number, state: SelectionState): SelectionState {
  const next = selectFollowing(ids, startIndex)
  if (sameSelectedIds(next.selected, state.selected)) return EMPTY_SELECTION
  return next
}

/**
 * Toggle one message via its checkbox (or a click on the bubble). Exclusions are
 * kept so the state still records which selected range items were manually
 * removed.
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

export function selectedIds(state: SelectionState): Set<string> {
  return new Set(state.selected)
}

export function selectedCount(state: SelectionState): number {
  return state.selected.size
}

function sameSelectedIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) {
    if (!b.has(id)) return false
  }
  return true
}

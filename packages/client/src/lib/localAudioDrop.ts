export interface FileDropState {
  depth: number
  active: boolean
}

export type FileDropAction = { type: 'enter' } | { type: 'leave' } | { type: 'reset' }

export const INITIAL_FILE_DROP_STATE: FileDropState = { depth: 0, active: false }

export function reduceFileDropState(state: FileDropState, action: FileDropAction): FileDropState {
  if (action.type === 'reset') return INITIAL_FILE_DROP_STATE
  if (action.type === 'enter') {
    const depth = state.depth + 1
    return { depth, active: true }
  }
  const depth = Math.max(0, state.depth - 1)
  return { depth, active: depth > 0 }
}

export function hasFileDragPayload(dataTransfer: Pick<DataTransfer, 'types' | 'items'>): boolean {
  const types = Array.from(dataTransfer.types ?? [])
  if (!types.some((type) => type.toLowerCase() === 'files')) return false
  const items = dataTransfer.items
  if (!items || items.length === 0) return true
  return Array.from(items).some((item) => item.kind === 'file')
}

export function getDroppedFiles(dataTransfer: DataTransfer): File[] {
  if (!hasFileDragPayload(dataTransfer)) return []
  return Array.from(dataTransfer.files)
}

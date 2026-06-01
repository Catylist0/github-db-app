import type { Node, Edge, NodeStatus } from '../types'

export type MoveRecord = {
  id: string
  from: { x: number; y: number }
  to: { x: number; y: number }
}

export type HistoryEntry =
  | { type: 'create-node'; node: Node }
  | { type: 'delete-node'; node: Node; edges: Edge[] }
  | { type: 'move-nodes'; moves: MoveRecord[] }
  | { type: 'rename-node'; id: string; from: string; to: string }
  | { type: 'status-node'; id: string; from: NodeStatus; to: NodeStatus }
  | { type: 'description-node'; id: string; from: string | undefined; to: string | undefined }
  | { type: 'create-edge'; edge: Edge }
  | { type: 'delete-edge'; edge: Edge }

const MAX = 100
const undoStack: HistoryEntry[] = []
const redoStack: HistoryEntry[] = []

export function record(entry: HistoryEntry): void {
  undoStack.push(entry)
  if (undoStack.length > MAX) undoStack.shift()
  redoStack.length = 0
}

export function popUndo(): HistoryEntry | undefined {
  return undoStack.pop()
}

export function pushRedo(entry: HistoryEntry): void {
  redoStack.push(entry)
}

export function popRedo(): HistoryEntry | undefined {
  return redoStack.pop()
}

export function pushUndo(entry: HistoryEntry): void {
  undoStack.push(entry)
}

export function clearHistory(): void {
  undoStack.length = 0
  redoStack.length = 0
}

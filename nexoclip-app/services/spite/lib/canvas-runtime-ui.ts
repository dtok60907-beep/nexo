import type { RealtimeCanvasCommands } from '@/hooks/use-realtime-canvas'
import type { ProjectRuntimeState } from '@/realtime/project-runtime'

export type CanvasSaveIndicator = {
  label: 'Saved' | 'Pending' | 'Saving' | 'Degraded' | 'Read-only'
  persisted: boolean
}

export type CanvasRuntimeControls = {
  commands: RealtimeCanvasCommands
  undo: () => void
  redo: () => void
}

export type GenerationPersistenceGuard = {
  allowed: boolean
  message?: string
}

const READ_ONLY_COMMANDS: RealtimeCanvasCommands = {
  applyNodeChanges: () => {},
  applyEdgeChanges: () => {},
  createNode: () => {},
  patchNode: () => {},
  patchNodeData: () => {},
  updateNodeData: () => {},
  replaceShot: () => {},
  createNextShot: () => null,
  deleteNode: () => {},
  createEdge: () => {},
  deleteEdge: () => {},
  duplicateNodes: () => [],
  connect: () => null,
  createScene: () => 'scene-1',
  deleteScene: () => {},
  switchScene: () => {},
  setProjectName: () => {},
  batch: () => {},
}

export function getCanvasSaveIndicator(status: ProjectRuntimeState): CanvasSaveIndicator {
  switch (status) {
    case 'PERSISTED':
      return { label: 'Saved', persisted: true }
    case 'PERSISTING':
      return { label: 'Saving', persisted: false }
    case 'DEGRADED':
      return { label: 'Degraded', persisted: false }
    case 'READ_ONLY':
      return { label: 'Read-only', persisted: false }
    case 'SYNCED':
    default:
      return { label: 'Pending', persisted: false }
  }
}

export function shouldWarnBeforeCanvasUnload(status: ProjectRuntimeState): boolean {
  return status === 'PERSISTING' || status === 'DEGRADED' || status === 'READ_ONLY'
}

export function getGenerationPersistenceGuard(status: ProjectRuntimeState): GenerationPersistenceGuard {
  switch (status) {
    case 'PERSISTING':
      return { allowed: false, message: 'Prompt is still saving. Try again in a moment.' }
    case 'DEGRADED':
      return { allowed: false, message: 'Canvas saving is degraded. Reconnect before generating.' }
    case 'READ_ONLY':
      return { allowed: false, message: 'Canvas is read-only. Reconnect before generating.' }
    case 'SYNCED':
    case 'PERSISTED':
    default:
      return { allowed: true }
  }
}

export function getCanvasRuntimeCapabilities(status: ProjectRuntimeState): {
  allowDocumentMutation: boolean
  allowPresence: true
} {
  return {
    allowDocumentMutation: status !== 'READ_ONLY',
    allowPresence: true,
  }
}

export function guardCanvasRuntimeControls<T extends CanvasRuntimeControls>(
  controls: T,
  status: ProjectRuntimeState,
): T {
  if (status !== 'READ_ONLY') {
    return controls
  }

  return {
    ...controls,
    commands: {
      ...READ_ONLY_COMMANDS,
      switchScene: controls.commands.switchScene,
    },
    undo: () => {},
    redo: () => {},
  }
}

export function createInvocationTimeRuntimeControls<T extends CanvasRuntimeControls>(
  controlsRef: { current: T },
  statusRef: { current: ProjectRuntimeState },
): T {
  const invoke = <R>(call: (controls: T) => R, fallback: () => R): R => {
    if (statusRef.current === 'READ_ONLY') {
      return fallback()
    }
    return call(controlsRef.current)
  }

  return {
    ...controlsRef.current,
    commands: {
      applyNodeChanges: (...args) => invoke((controls) => controls.commands.applyNodeChanges(...args), () => undefined),
      applyEdgeChanges: (...args) => invoke((controls) => controls.commands.applyEdgeChanges(...args), () => undefined),
      createNode: (...args) => invoke((controls) => controls.commands.createNode(...args), () => undefined),
      patchNode: (...args) => invoke((controls) => controls.commands.patchNode(...args), () => undefined),
      patchNodeData: (...args) => invoke((controls) => controls.commands.patchNodeData(...args), () => undefined),
      updateNodeData: (...args) => invoke((controls) => controls.commands.updateNodeData(...args), () => undefined),
      replaceShot: (...args) => invoke((controls) => controls.commands.replaceShot(...args), () => undefined),
      createNextShot: (...args) => invoke((controls) => controls.commands.createNextShot(...args), () => null),
      deleteNode: (...args) => invoke((controls) => controls.commands.deleteNode(...args), () => undefined),
      createEdge: (...args) => invoke((controls) => controls.commands.createEdge(...args), () => undefined),
      deleteEdge: (...args) => invoke((controls) => controls.commands.deleteEdge(...args), () => undefined),
      duplicateNodes: (...args) => invoke((controls) => controls.commands.duplicateNodes(...args), () => []),
      connect: (...args) => invoke((controls) => controls.commands.connect(...args), () => null),
      createScene: (...args) => invoke((controls) => controls.commands.createScene(...args), () => 'scene-1'),
      deleteScene: (...args) => invoke((controls) => controls.commands.deleteScene(...args), () => undefined),
      switchScene: (...args) => controlsRef.current.commands.switchScene(...args),
      setProjectName: (...args) => invoke((controls) => controls.commands.setProjectName(...args), () => undefined),
      batch: (...args) => invoke((controls) => controls.commands.batch(...args), () => undefined),
    },
    undo: () => invoke((controls) => controls.undo(), () => undefined),
    redo: () => invoke((controls) => controls.redo(), () => undefined),
  } as T
}

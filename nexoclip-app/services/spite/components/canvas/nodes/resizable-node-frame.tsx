'use client'

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

import { useCanvasCollaboration } from '../canvas-collaboration'
import { clampNodeSize } from '@/lib/canvas-node-interactions'

type NodeData = Record<string, unknown>
type NodeSize = { width: number; height: number }
type ResizeSession = { pointerId: number; startX: number; startY: number; size: NodeSize }
type NodeSizeBounds = {
  minWidth: number
  minHeight: number
  maxWidth: number
  maxHeight: number
}

export function createResizeSession(pointerId: number, startX: number, startY: number, size: NodeSize): ResizeSession {
  return { pointerId, startX, startY, size }
}

export function finalizeResize(session: ResizeSession | null, pointerId: number, cancelled: boolean) {
  if (!session || session.pointerId !== pointerId) return null

  return { session: null, size: session.size, shouldPersist: !cancelled }
}

type ResizableNodeFrameProps = {
  nodeId: string
  data: NodeData
  bounds: NodeSizeBounds
  defaultSize: NodeSize
  className?: string
  claimLock?: () => Promise<boolean>
  releaseLock?: () => void
  children: ReactNode
}

export function ResizableNodeFrame({
  nodeId,
  data,
  bounds,
  defaultSize,
  className,
  claimLock,
  releaseLock,
  children,
}: ResizableNodeFrameProps) {
  const { patchNodeData } = useCanvasCollaboration()
  const { minWidth, minHeight, maxWidth, maxHeight } = bounds
  const sizeFromData = clampNodeSize({
    width: typeof data.width === 'number' ? data.width : defaultSize.width,
    height: typeof data.height === 'number' ? data.height : defaultSize.height,
  }, bounds)
  const [size, setSize] = useState(sizeFromData)
  const sizeRef = useRef(sizeFromData)
  const resizeRef = useRef<ResizeSession | null>(null)

  useEffect(() => {
    sizeRef.current = sizeFromData
    setSize(sizeFromData)
  }, [data.height, data.width, defaultSize.height, defaultSize.width, maxHeight, maxWidth, minHeight, minWidth])

  const startResize = async (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (claimLock && !(await claimLock())) return
    resizeRef.current = createResizeSession(event.pointerId, event.clientX, event.clientY, sizeRef.current)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeRef.current
    if (!start || start.pointerId !== event.pointerId) return
    const nextSize = clampNodeSize({
      width: start.size.width + event.clientX - start.startX,
      height: start.size.height + event.clientY - start.startY,
    }, bounds)
    sizeRef.current = nextSize
    setSize(nextSize)
  }

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    const finalization = finalizeResize(resizeRef.current, event.pointerId, false)
    if (!finalization) return

    resizeRef.current = finalization.session
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    patchNodeData(nodeId, sizeRef.current)
    releaseLock?.()
  }

  const cancelResize = (event: PointerEvent<HTMLDivElement>) => {
    const finalization = finalizeResize(resizeRef.current, event.pointerId, true)
    if (!finalization) return

    resizeRef.current = finalization.session
    sizeRef.current = finalization.size
    setSize(finalization.size)
    releaseLock?.()
  }

  return (
    <div
      className={`relative group ${className ?? ''}`}
      style={size}
    >
      {children}
      <div
        aria-label="Resize node"
        className="nodrag absolute right-0 bottom-0 h-5 w-5 cursor-se-resize touch-none"
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={finishResize}
        onPointerCancel={cancelResize}
        onLostPointerCapture={cancelResize}
      >
        <svg className="absolute right-1 bottom-1" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M 1 9 L 9 1 M 5 9 L 9 5" stroke="rgba(255,255,255,0.5)" strokeWidth="1" />
        </svg>
      </div>
    </div>
  )
}

import { Upload } from 'lucide-react'
import { useEffect, useReducer } from 'react'
import { getDroppedFiles, hasFileDragPayload, INITIAL_FILE_DROP_STATE, reduceFileDropState } from '@/lib/localAudioDrop'

interface LocalAudioDropOverlayProps {
  enabled: boolean
  onFiles: (files: File[]) => void
}

export function LocalAudioDropOverlay({ enabled, onFiles }: LocalAudioDropOverlayProps) {
  const [state, dispatch] = useReducer(reduceFileDropState, INITIAL_FILE_DROP_STATE)

  useEffect(() => {
    if (!enabled) dispatch({ type: 'reset' })
  }, [enabled])

  useEffect(() => {
    const handleDragEnter = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer
      if (!dataTransfer || !hasFileDragPayload(dataTransfer)) return
      event.preventDefault()
      dataTransfer.dropEffect = 'copy'
      if (enabled) dispatch({ type: 'enter' })
    }

    const handleDragOver = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer
      if (!dataTransfer || !hasFileDragPayload(dataTransfer)) return
      event.preventDefault()
      dataTransfer.dropEffect = 'copy'
    }

    const handleDragLeave = (event: DragEvent) => {
      if (!enabled) return
      const dataTransfer = event.dataTransfer
      if (event.relatedTarget === null || !dataTransfer || hasFileDragPayload(dataTransfer)) {
        dispatch({ type: 'leave' })
      }
    }

    const handleDrop = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer
      if (!dataTransfer || !hasFileDragPayload(dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      dispatch({ type: 'reset' })
      if (enabled) onFiles(getDroppedFiles(dataTransfer))
    }

    const handleWindowBlur = () => dispatch({ type: 'reset' })

    window.addEventListener('dragenter', handleDragEnter, true)
    window.addEventListener('dragover', handleDragOver, true)
    window.addEventListener('dragleave', handleDragLeave, true)
    window.addEventListener('drop', handleDrop, true)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      window.removeEventListener('dragenter', handleDragEnter, true)
      window.removeEventListener('dragover', handleDragOver, true)
      window.removeEventListener('dragleave', handleDragLeave, true)
      window.removeEventListener('drop', handleDrop, true)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [enabled, onFiles])

  if (!enabled || !state.active) return null

  return (
    <div
      data-testid="local-audio-drop-overlay"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm"
    >
      <div className="absolute inset-4 rounded-lg border-2 border-dashed border-primary/70" />
      <div className="relative flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-primary/60 bg-primary/10 text-primary">
          <Upload className="h-7 w-7" aria-hidden="true" />
        </div>
        <p className="text-lg font-semibold">松开以上传到房间</p>
        <p className="text-sm text-muted-foreground">支持多选，文件会按顺序加入上传队列</p>
      </div>
    </div>
  )
}

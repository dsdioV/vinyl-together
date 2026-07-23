import { useEffect, useReducer, useRef } from 'react'
import { toast } from 'sonner'
import { EVENTS } from '@music-together/shared'
import type { LocalAudioAsset, LocalAudioState, LocalAudioTask } from '@music-together/shared'
import { useSocketContext } from '@/providers/SocketProvider'
import { useRoomStore } from '@/stores/roomStore'
import { useLocalAudioStore } from '@/stores/localAudioStore'
import { usePlayerStore } from '@/stores/playerStore'
import { mergeLocalAudioAssetMetadata } from '@/lib/localAudioPlayback'
import {
  cancelLocalAudioTask,
  createLocalAudioTask,
  fetchLocalAudioSnapshot,
  isLocalAudioTerminal,
  uploadLocalAudioContent,
  type LocalAudioTaskResponse,
  type UploadHandle,
} from '@/lib/localAudioProtocol'

interface ActiveUploadPipeline {
  clientTaskId: string
  taskId: string
  handle: UploadHandle | null
  cancelled: boolean
  detached: boolean
}

let activeUpload: ActiveUploadPipeline | null = null

/**
 * Stop the browser-side upload. A user cancellation owns the server task and
 * is followed by DELETE once its server id is known. A detach (leave,
 * disconnect, or page teardown) does not delete a raw PUT that has started:
 * the server can then distinguish an incomplete request from a fully received
 * upload and keep processing the latter. An empty task created just before a
 * detach is deleted once its POST response supplies the generated id.
 */
export function abortActiveLocalAudioUpload(taskId?: string, mode: 'cancel' | 'detach' = 'cancel'): boolean {
  if (!activeUpload || (taskId && activeUpload.taskId !== taskId && activeUpload.clientTaskId !== taskId)) return false
  if (mode === 'detach') activeUpload.detached = true
  else activeUpload.cancelled = true
  activeUpload.handle?.abort()
  return true
}

function unwrapTask(response: LocalAudioTaskResponse | LocalAudioTask): LocalAudioTask {
  return 'task' in response ? response.task : response
}

function syncCurrentPlayerMetadata(asset: LocalAudioAsset): void {
  const player = usePlayerStore.getState()
  const nextTrack = mergeLocalAudioAssetMetadata(player.currentTrack, asset)
  if (nextTrack !== player.currentTrack) player.setCurrentTrack(nextTrack)
}

async function refreshSnapshot(roomId: string, signal?: AbortSignal): Promise<void> {
  const store = useLocalAudioStore.getState()
  store.setLoading(true)
  try {
    const snapshot = await fetchLocalAudioSnapshot(roomId, signal)
    if (!signal?.aborted) store.setSnapshot(roomId, snapshot)
  } catch (error) {
    if (signal?.aborted) return
    store.setLoading(false)
    store.setError(error instanceof Error ? error.message : '本地音乐库加载失败')
  }
}

/** Keeps the server-owned asset library and processing tasks in sync. */
export function useLocalAudioSync(): void {
  const { socket } = useSocketContext()
  const roomId = useRoomStore((state) => state.room?.id ?? null)

  useEffect(() => {
    useLocalAudioStore.getState().setRoom(roomId)
    if (!roomId) return
    const controller = new AbortController()
    void refreshSnapshot(roomId, controller.signal)

    const isCurrentRoom = () => useRoomStore.getState().room?.id === roomId

    const onState = (snapshot: LocalAudioState) => {
      if (!isCurrentRoom()) return
      useLocalAudioStore.getState().setSnapshot(roomId, snapshot)
      const currentAssetId = usePlayerStore.getState().currentTrack?.assetId
      const currentAsset = currentAssetId
        ? snapshot.assets.find((asset) => asset.assetId === currentAssetId)
        : undefined
      if (currentAsset) syncCurrentPlayerMetadata(currentAsset)
    }
    const onAssetUpdated = (asset: LocalAudioAsset) => {
      if (!isCurrentRoom()) return
      useLocalAudioStore.getState().upsertAsset(asset)
      syncCurrentPlayerMetadata(asset)
    }
    const onAssetRemoved = ({ assetId }: { assetId: string }) => {
      if (isCurrentRoom()) useLocalAudioStore.getState().removeAsset(assetId)
    }
    const onTaskUpdated = (task: LocalAudioTask) => {
      if (isCurrentRoom()) useLocalAudioStore.getState().upsertTask(task)
    }
    const onTaskRemoved = ({ taskId }: { taskId: string }) => {
      if (isCurrentRoom()) useLocalAudioStore.getState().removeTask(taskId)
    }

    socket.on(EVENTS.LOCAL_AUDIO_STATE, onState)
    socket.on(EVENTS.LOCAL_AUDIO_ASSET_UPDATED, onAssetUpdated)
    socket.on(EVENTS.LOCAL_AUDIO_ASSET_REMOVED, onAssetRemoved)
    socket.on(EVENTS.LOCAL_AUDIO_TASK_UPDATED, onTaskUpdated)
    socket.on(EVENTS.LOCAL_AUDIO_TASK_REMOVED, onTaskRemoved)

    // A fresh ROOM_STATE follows a successful reconnect. Refresh separately
    // because task/asset deltas may have been missed while offline.
    const onRoomState = () => void refreshSnapshot(roomId, controller.signal)
    socket.on(EVENTS.ROOM_STATE, onRoomState)

    return () => {
      controller.abort()
      socket.off(EVENTS.LOCAL_AUDIO_STATE, onState)
      socket.off(EVENTS.LOCAL_AUDIO_ASSET_UPDATED, onAssetUpdated)
      socket.off(EVENTS.LOCAL_AUDIO_ASSET_REMOVED, onAssetRemoved)
      socket.off(EVENTS.LOCAL_AUDIO_TASK_UPDATED, onTaskUpdated)
      socket.off(EVENTS.LOCAL_AUDIO_TASK_REMOVED, onTaskRemoved)
      socket.off(EVENTS.ROOM_STATE, onRoomState)
    }
  }, [roomId, socket])
}

/** Runs one complete upload pipeline at a time for this browser. */
export function useLocalAudioUploadRunner(): void {
  const roomId = useRoomStore((state) => state.room?.id ?? null)
  const tasks = useLocalAudioStore((state) => state.tasks)
  const [runnerEpoch, advanceRunner] = useReducer((value: number) => value + 1, 0)
  const activeTaskIdRef = useRef<string | null>(null)
  const previousRoomIdRef = useRef<string | null>(roomId)
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    if (previousRoomIdRef.current !== roomId) {
      abortActiveLocalAudioUpload(undefined, 'detach')
      activeTaskIdRef.current = null
      previousRoomIdRef.current = roomId
    }
  }, [roomId])

  useEffect(() => {
    if (!roomId) return
    if (activeUpload) return
    if (useLocalAudioStore.getState().roomId !== roomId) return

    const activeId = activeTaskIdRef.current
    if (activeId) {
      activeTaskIdRef.current = null
    }

    const nextTask = tasks.find((task) => task.stage === 'waiting-upload' && task.file && task.localOnly)
    if (!nextTask?.file) return

    activeTaskIdRef.current = nextTask.taskId
    const clientTaskId = nextTask.taskId
    const file = nextTask.file
    const pipeline: ActiveUploadPipeline = {
      clientTaskId,
      taskId: clientTaskId,
      handle: null,
      cancelled: false,
      detached: false,
    }
    activeUpload = pipeline
    const store = useLocalAudioStore.getState()
    store.updateTask(clientTaskId, { stage: 'receiving', receivedBytes: 0, totalBytes: file.size })

    const run = async () => {
      let serverTaskId = clientTaskId
      try {
        // Keep task creation outside the raw-upload abort signal. If the
        // request reaches the server while the user clicks cancel, waiting for
        // the response gives us the generated task id so it can be deleted.
        // A detached page may still lose this request; the server's waiting
        // timeout then cleans up the task safely.
        const created = await createLocalAudioTask(roomId, {
          fileName: file.name,
          fileSize: file.size,
          addToQueue: nextTask.addToQueue,
        })
        const serverTask = unwrapTask(created)
        serverTaskId = serverTask.taskId
        pipeline.taskId = serverTaskId

        const currentClientTask = useLocalAudioStore.getState().tasks.find((task) => task.taskId === clientTaskId)
        const detached = pipeline.detached || useRoomStore.getState().room?.id !== roomId
        if (pipeline.cancelled || detached || !currentClientTask || isLocalAudioTerminal(currentClientTask.stage)) {
          // No raw PUT has started yet, so this server task is guaranteed not
          // to contain a complete upload. Remove it even for a passive detach
          // to avoid holding the per-user receiving slot until its idle timer.
          await cancelLocalAudioTask(roomId, serverTaskId).catch(() => undefined)
          return
        }

        const currentStore = useLocalAudioStore.getState()
        currentStore.removeTask(clientTaskId)
        currentStore.upsertTask({
          ...serverTask,
          stage: 'receiving',
          receivedBytes: serverTask.receivedBytes ?? 0,
          totalBytes: serverTask.totalBytes ?? file.size,
          file,
          localOnly: false,
        })
        activeTaskIdRef.current = serverTaskId

        const handle = uploadLocalAudioContent(roomId, serverTaskId, file, (receivedBytes, totalBytes) => {
          useLocalAudioStore.getState().updateTask(serverTaskId, {
            stage: 'receiving',
            receivedBytes,
            totalBytes,
            progress: totalBytes > 0 ? receivedBytes / totalBytes : undefined,
          })
        })
        pipeline.handle = handle
        if (pipeline.cancelled || pipeline.detached || useRoomStore.getState().room?.id !== roomId) handle.abort()

        const uploaded = await handle.promise
        const uploadedTask = unwrapTask(uploaded)
        if (pipeline.detached || useRoomStore.getState().room?.id !== roomId) return
        if (pipeline.cancelled) {
          await cancelLocalAudioTask(roomId, serverTaskId).catch(() => undefined)
          return
        }
        const current = useLocalAudioStore.getState().tasks.find((task) => task.taskId === serverTaskId)
        if (!current || !isLocalAudioTerminal(current.stage)) {
          useLocalAudioStore.getState().upsertTask({ ...uploadedTask, file: undefined, localOnly: false })
        }
        if ('asset' in uploaded && uploaded.asset) {
          useLocalAudioStore.getState().upsertAsset(uploaded.asset)
        }
      } catch (error) {
        // A detached pipeline is intentionally silent. The server receives a
        // socket/request close and decides whether to clean up or continue
        // processing based on the bytes it received.
        if (pipeline.cancelled && serverTaskId !== clientTaskId) {
          await cancelLocalAudioTask(roomId, serverTaskId).catch(() => undefined)
        }
        if (pipeline.detached && !pipeline.cancelled) return
        const cancelled = pipeline.cancelled || (error instanceof DOMException && error.name === 'AbortError')
        useLocalAudioStore.getState().updateTask(serverTaskId, {
          stage: cancelled ? 'cancelled' : 'failed',
          errorMessage: cancelled ? '上传已取消' : error instanceof Error ? error.message : '上传失败',
          file: undefined,
          localOnly: false,
        })
        if (!cancelled) toast.error(`「${file.name}」上传失败`)
      } finally {
        if (activeUpload === pipeline) activeUpload = null
        const stillOwnsActiveRef = activeTaskIdRef.current === serverTaskId || activeTaskIdRef.current === clientTaskId
        if (stillOwnsActiveRef) activeTaskIdRef.current = null
        // The raw body is now either fully accepted or stopped. Wake the
        // runner immediately; server-side FFmpeg work proceeds independently.
        if (mountedRef.current) advanceRunner()
      }
    }

    void run()
  }, [roomId, runnerEpoch, tasks])

  useEffect(() => {
    mountedRef.current = true
    if (cleanupTimerRef.current) {
      clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
    }

    return () => {
      mountedRef.current = false
      const pipelineAtCleanup = activeUpload
      // React Strict Mode performs an immediate setup -> cleanup -> setup
      // probe. Deferring the detach one task lets that second setup cancel it,
      // while a real route/page teardown still aborts the browser-side PUT.
      cleanupTimerRef.current = setTimeout(() => {
        if (pipelineAtCleanup && activeUpload === pipelineAtCleanup) {
          abortActiveLocalAudioUpload(undefined, 'detach')
        }
        activeTaskIdRef.current = null
        cleanupTimerRef.current = null
      }, 0)
    }
  }, [])
}

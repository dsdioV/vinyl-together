import { nanoid } from 'nanoid'
import { create } from 'zustand'
import type { LocalAudioAsset, LocalAudioState, LocalAudioTask, LocalAudioUsage } from '@music-together/shared'

/** Browser-only upload state layered on top of the shared server task DTO. */
export type LocalAudioClientTask = LocalAudioTask & {
  file?: File
  /** True until the task has been accepted by the server. */
  localOnly?: boolean
  /** Browser-only guard while a server cancellation request is in flight. */
  cancelling?: boolean
}

interface EnqueueOptions {
  ownerId: string
  ownerNickname: string
  addToQueue: boolean
}

interface LocalAudioStore {
  roomId: string | null
  assets: LocalAudioAsset[]
  tasks: LocalAudioClientTask[]
  usage: LocalAudioUsage | null
  loading: boolean
  error: string | null
  addToQueueAfterUpload: boolean

  setRoom: (roomId: string | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setAddToQueueAfterUpload: (addToQueue: boolean) => void
  setSnapshot: (roomId: string, snapshot: LocalAudioState) => void
  upsertAsset: (asset: LocalAudioAsset) => void
  removeAsset: (assetId: string) => void
  upsertTask: (task: LocalAudioTask | LocalAudioClientTask) => void
  removeTask: (taskId: string) => void
  enqueueFiles: (files: File[], options: EnqueueOptions) => string[]
  updateTask: (taskId: string, patch: Partial<LocalAudioClientTask>) => void
  reset: () => void
}

const initialState = {
  roomId: null,
  assets: [] as LocalAudioAsset[],
  tasks: [] as LocalAudioClientTask[],
  usage: null as LocalAudioUsage | null,
  loading: false,
  error: null as string | null,
  addToQueueAfterUpload: true,
}

function isTerminalTask(task: Pick<LocalAudioTask, 'stage'>): boolean {
  return task.stage === 'ready' || task.stage === 'failed' || task.stage === 'cancelled'
}

function mergeTask(
  previous: LocalAudioClientTask | undefined,
  incoming: LocalAudioTask | LocalAudioClientTask,
): LocalAudioClientTask {
  // Socket/REST delivery can race: a 202 response may arrive after the
  // server has already emitted `ready`. Never let a late non-terminal DTO
  // regress a task that is already terminal in the browser.
  const incomingIsStale = previous && isTerminalTask(previous) && !isTerminalTask(incoming)
  const merged = incomingIsStale ? previous : { ...previous, ...incoming }
  const terminal = isTerminalTask(merged)
  return {
    ...merged,
    // A File exists only on the uploading browser. Never overwrite it with
    // an event/snapshot DTO that omits the field.
    file: terminal ? undefined : 'file' in incoming ? incoming.file : previous?.file,
    localOnly: 'localOnly' in incoming ? incoming.localOnly : previous?.localOnly,
    cancelling: terminal ? false : 'cancelling' in incoming ? incoming.cancelling : previous?.cancelling,
  }
}

export const useLocalAudioStore = create<LocalAudioStore>((set) => ({
  ...initialState,

  setRoom: (roomId) => set((state) => (state.roomId === roomId ? {} : { ...initialState, roomId })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setAddToQueueAfterUpload: (addToQueueAfterUpload) => set({ addToQueueAfterUpload }),

  setSnapshot: (roomId, snapshot) =>
    set((state) => {
      // Keep browser-owned waiting/uploading tasks that an older in-flight
      // snapshot does not contain. This includes the short window after a
      // local id has been replaced by the server task id but before the raw
      // PUT finishes. Once a server task appears, the id-based merge wins.
      const serverTasks = snapshot.tasks.map((task) =>
        mergeTask(
          state.tasks.find((item) => item.taskId === task.taskId),
          task,
        ),
      )
      const serverIds = new Set(serverTasks.map((task) => task.taskId))
      const clientOwned =
        state.roomId === roomId
          ? state.tasks.filter((task) => task.file && !serverIds.has(task.taskId) && !isTerminalTask(task))
          : []
      return {
        roomId,
        assets: snapshot.assets,
        tasks: [...serverTasks, ...clientOwned],
        usage: snapshot.usage ?? null,
        loading: false,
        error: null,
      }
    }),

  upsertAsset: (asset) =>
    set((state) => {
      const index = state.assets.findIndex((item) => item.assetId === asset.assetId)
      if (index < 0) return { assets: [...state.assets, asset] }
      const assets = [...state.assets]
      assets[index] = { ...assets[index], ...asset }
      return { assets }
    }),

  removeAsset: (assetId) => set((state) => ({ assets: state.assets.filter((asset) => asset.assetId !== assetId) })),

  upsertTask: (task) =>
    set((state) => {
      const index = state.tasks.findIndex((item) => item.taskId === task.taskId)
      const merged = mergeTask(index >= 0 ? state.tasks[index] : undefined, task)
      if (index < 0) return { tasks: [...state.tasks, merged] }
      const tasks = [...state.tasks]
      tasks[index] = merged
      return { tasks }
    }),

  removeTask: (taskId) => set((state) => ({ tasks: state.tasks.filter((task) => task.taskId !== taskId) })),

  enqueueFiles: (files, options) => {
    const now = Date.now()
    const tasks: LocalAudioClientTask[] = files.map((file, index) => ({
      taskId: nanoid(16),
      originalFileName: file.name,
      uploadedByUserId: options.ownerId,
      uploadedByNickname: options.ownerNickname,
      stage: 'waiting-upload',
      progress: 0,
      receivedBytes: 0,
      totalBytes: file.size,
      createdAt: now + index,
      updatedAt: now + index,
      addToQueue: options.addToQueue,
      file,
      localOnly: true,
    }))
    set((state) => ({ tasks: [...state.tasks, ...tasks], error: null }))
    return tasks.map((task) => task.taskId)
  },

  updateTask: (taskId, patch) =>
    set((state) => {
      const index = state.tasks.findIndex((task) => task.taskId === taskId)
      if (index < 0) return {}
      const tasks = [...state.tasks]
      const next = { ...tasks[index], ...patch, updatedAt: Date.now() }
      if (isTerminalTask(next)) {
        next.file = undefined
        next.cancelling = false
      }
      tasks[index] = next
      return { tasks }
    }),

  reset: () => set(initialState),
}))

export function getActiveLocalAudioTaskCount(tasks: LocalAudioClientTask[]): number {
  return tasks.filter((task) => task.stage !== 'ready' && task.stage !== 'failed' && task.stage !== 'cancelled').length
}

const visibleTaskPriority: Partial<Record<LocalAudioTask['stage'], number>> = {
  receiving: 0,
  probing: 1,
  transcoding: 1,
  queued: 2,
  'waiting-upload': 3,
  failed: 4,
}

/**
 * Keep every actionable task reachable even after a large multi-file pick.
 * The raw upload comes first so the user can always cancel the request that
 * is currently consuming bandwidth; waiting files follow behind it.
 */
export function getVisibleLocalAudioTasks(tasks: LocalAudioClientTask[]): LocalAudioClientTask[] {
  return tasks
    .filter((task) => task.stage !== 'ready' && task.stage !== 'cancelled')
    .sort(
      (left, right) =>
        (visibleTaskPriority[left.stage] ?? Number.MAX_SAFE_INTEGER) -
          (visibleTaskPriority[right.stage] ?? Number.MAX_SAFE_INTEGER) || left.createdAt - right.createdAt,
    )
}

export function getLocalAudioTask(taskId: string): LocalAudioClientTask | undefined {
  return useLocalAudioStore.getState().tasks.find((task) => task.taskId === taskId)
}

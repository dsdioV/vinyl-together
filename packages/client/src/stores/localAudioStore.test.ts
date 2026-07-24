import { beforeEach, describe, expect, it } from 'vitest'
import type { LocalAudioState, LocalAudioTask } from '@music-together/shared'
import { getVisibleLocalAudioTasks, useLocalAudioStore } from './localAudioStore'

const EMPTY_SNAPSHOT: LocalAudioState = {
  assets: [],
  tasks: [],
  usage: {
    maxUploadBytes: 500 * 1024 * 1024,
    roomBytes: 0,
    roomLimitBytes: 1024,
    serverBytes: 0,
    serverLimitBytes: 2048,
    tempBytes: 0,
    tempLimitBytes: 1024,
  },
}

function serverTask(taskId: string, stage: LocalAudioTask['stage']): LocalAudioTask {
  return {
    taskId,
    originalFileName: 'example.mp3',
    uploadedByUserId: 'user-1',
    uploadedByNickname: 'Uploader',
    addToQueue: true,
    stage,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('localAudioStore upload ownership', () => {
  beforeEach(() => {
    useLocalAudioStore.getState().reset()
    useLocalAudioStore.getState().setRoom('room-a')
  })

  it('keeps a browser-only upload across an older empty snapshot', () => {
    const file = new File(['audio'], 'example.mp3', { type: 'audio/mpeg' })
    const [taskId] = useLocalAudioStore.getState().enqueueFiles([file], {
      ownerId: 'user-1',
      ownerNickname: 'Uploader',
      addToQueue: true,
    })
    useLocalAudioStore.getState().updateTask(taskId, { stage: 'receiving' })

    useLocalAudioStore.getState().setSnapshot('room-a', EMPTY_SNAPSHOT)

    expect(useLocalAudioStore.getState().tasks).toEqual([
      expect.objectContaining({ taskId, stage: 'receiving', file, localOnly: true }),
    ])
  })

  it('keeps the remapped server task while its raw PUT still owns the File', () => {
    const file = new File(['audio'], 'example.mp3', { type: 'audio/mpeg' })
    useLocalAudioStore.getState().upsertTask({
      ...serverTask('server-task', 'receiving'),
      file,
      localOnly: false,
    })

    useLocalAudioStore.getState().setSnapshot('room-a', EMPTY_SNAPSHOT)

    expect(useLocalAudioStore.getState().tasks).toEqual([
      expect.objectContaining({ taskId: 'server-task', file, localOnly: false }),
    ])
  })

  it('releases the File on a terminal server update and on room changes', () => {
    const file = new File(['audio'], 'example.mp3', { type: 'audio/mpeg' })
    useLocalAudioStore.getState().upsertTask({
      ...serverTask('server-task', 'receiving'),
      file,
      localOnly: false,
    })
    useLocalAudioStore.getState().upsertTask(serverTask('server-task', 'ready'))

    expect(useLocalAudioStore.getState().tasks[0]?.file).toBeUndefined()

    useLocalAudioStore.getState().setRoom('room-b')
    expect(useLocalAudioStore.getState()).toMatchObject({ roomId: 'room-b', assets: [], tasks: [] })
  })

  it('preserves selected file order and the shared add-to-queue preference', () => {
    const first = new File(['one'], 'first.mp3')
    const second = new File(['two'], 'second.flac')
    useLocalAudioStore.getState().setAddToQueueAfterUpload(false)

    useLocalAudioStore.getState().enqueueFiles([first, second], {
      ownerId: 'user-1',
      ownerNickname: 'Uploader',
      addToQueue: useLocalAudioStore.getState().addToQueueAfterUpload,
    })

    expect(useLocalAudioStore.getState().tasks).toEqual([
      expect.objectContaining({ originalFileName: 'first.mp3', file: first, addToQueue: false }),
      expect.objectContaining({ originalFileName: 'second.flac', file: second, addToQueue: false }),
    ])
  })

  it('resets the add-to-queue preference when entering another room', () => {
    useLocalAudioStore.getState().setAddToQueueAfterUpload(false)
    useLocalAudioStore.getState().setRoom('room-b')
    expect(useLocalAudioStore.getState().addToQueueAfterUpload).toBe(true)
  })
})

describe('localAudioStore task visibility', () => {
  it('keeps a receiving task reachable when more than eight files are queued', () => {
    const tasks = [
      serverTask('current-upload', 'receiving'),
      ...Array.from({ length: 8 }, (_, index) => ({
        ...serverTask(`waiting-${index}`, 'waiting-upload'),
        createdAt: index + 2,
      })),
    ]

    const visible = getVisibleLocalAudioTasks(tasks)

    expect(visible).toHaveLength(9)
    expect(visible[0]?.taskId).toBe('current-upload')
    expect(visible.map((task) => task.taskId)).toContain('waiting-7')
  })

  it('hides completed and cancelled tasks but keeps failures visible', () => {
    const visible = getVisibleLocalAudioTasks([
      serverTask('ready', 'ready'),
      serverTask('cancelled', 'cancelled'),
      serverTask('failed', 'failed'),
    ])

    expect(visible.map((task) => task.taskId)).toEqual(['failed'])
  })
})

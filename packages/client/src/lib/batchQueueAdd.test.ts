import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QUEUE_BATCH_CHUNK_DELAY_MS,
  QUEUE_BATCH_CHUNK_SIZE,
  chunkTracks,
  emitInChunks,
} from './batchQueueAdd'

describe('chunkTracks', () => {
  it('splits a large list into 500-track chunks', () => {
    const tracks = Array.from({ length: 1200 }, (_, index) => index)
    const chunks = chunkTracks(tracks)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(500)
    expect(chunks[1]).toHaveLength(500)
    expect(chunks[2]).toHaveLength(200)
    expect(chunks.flat()).toEqual(tracks)
  })

  it('keeps a small list as a single chunk', () => {
    expect(chunkTracks([1, 2, 3])).toEqual([[1, 2, 3]])
  })

  it('respects a custom chunk size', () => {
    expect(chunkTracks(Array.from({ length: 10 }, (_, index) => index), 4)).toHaveLength(3)
  })
})

describe('emitInChunks', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits each chunk with its index and waits between chunks', async () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const promise = emitInChunks(Array.from({ length: 1100 }, (_, index) => index), emit)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toHaveLength(QUEUE_BATCH_CHUNK_SIZE)
    expect(emit.mock.calls[0]?.[1]).toBe(0)

    await vi.advanceTimersByTimeAsync(QUEUE_BATCH_CHUNK_DELAY_MS)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[1]?.[0]).toHaveLength(QUEUE_BATCH_CHUNK_SIZE)
    expect(emit.mock.calls[1]?.[1]).toBe(1)

    await vi.advanceTimersByTimeAsync(QUEUE_BATCH_CHUNK_DELAY_MS)
    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit.mock.calls[2]?.[0]).toHaveLength(100)
    expect(emit.mock.calls[2]?.[1]).toBe(2)
    await promise
  })

  it('emits a single chunk without waiting', async () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    await emitInChunks([1, 2], emit)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an empty list', async () => {
    const emit = vi.fn()
    await emitInChunks([], emit)
    expect(emit).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { getDroppedFiles, hasFileDragPayload, INITIAL_FILE_DROP_STATE, reduceFileDropState } from './localAudioDrop'

function dataTransfer(options: {
  types: string[]
  itemKinds?: DataTransferItem['kind'][]
  files?: File[]
}): DataTransfer {
  const items = (options.itemKinds ?? []).map((kind) => ({ kind }))
  return {
    types: options.types,
    items,
    files: options.files ?? [],
  } as unknown as DataTransfer
}

describe('local audio drag detection', () => {
  it('accepts real file payloads and ignores text, links, and in-page images', () => {
    expect(hasFileDragPayload(dataTransfer({ types: ['Files'], itemKinds: ['file'] }))).toBe(true)
    expect(hasFileDragPayload(dataTransfer({ types: ['Files'], itemKinds: [] }))).toBe(true)
    expect(hasFileDragPayload(dataTransfer({ types: ['text/plain'], itemKinds: ['string'] }))).toBe(false)
    expect(hasFileDragPayload(dataTransfer({ types: ['text/uri-list', 'text/html'], itemKinds: ['string'] }))).toBe(
      false,
    )
    expect(hasFileDragPayload(dataTransfer({ types: ['Files', 'text/html'], itemKinds: ['string'] }))).toBe(false)
  })

  it('returns dropped files in the browser-provided order', () => {
    const first = new File(['one'], 'first.mp3')
    const second = new File(['two'], 'second.flac')
    const transfer = dataTransfer({ types: ['Files'], itemKinds: ['file', 'file'], files: [first, second] })

    expect(getDroppedFiles(transfer)).toEqual([first, second])
    expect(getDroppedFiles(dataTransfer({ types: ['text/plain'], files: [first] }))).toEqual([])
  })
})

describe('local audio drag depth', () => {
  it('stays active across nested enter and leave events without flickering', () => {
    const firstEnter = reduceFileDropState(INITIAL_FILE_DROP_STATE, { type: 'enter' })
    const nestedEnter = reduceFileDropState(firstEnter, { type: 'enter' })
    const nestedLeave = reduceFileDropState(nestedEnter, { type: 'leave' })
    const finalLeave = reduceFileDropState(nestedLeave, { type: 'leave' })

    expect(firstEnter).toEqual({ depth: 1, active: true })
    expect(nestedEnter).toEqual({ depth: 2, active: true })
    expect(nestedLeave).toEqual({ depth: 1, active: true })
    expect(finalLeave).toEqual(INITIAL_FILE_DROP_STATE)
    expect(reduceFileDropState(finalLeave, { type: 'leave' })).toEqual(INITIAL_FILE_DROP_STATE)
  })

  it('clears every nested level on cancellation or drop', () => {
    const nested = reduceFileDropState(reduceFileDropState(INITIAL_FILE_DROP_STATE, { type: 'enter' }), {
      type: 'enter',
    })
    expect(reduceFileDropState(nested, { type: 'reset' })).toEqual(INITIAL_FILE_DROP_STATE)
  })
})

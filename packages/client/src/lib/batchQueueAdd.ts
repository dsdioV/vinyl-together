/** 单次 socket 批量消息的曲目数上限（小于服务端 1000 上限，为封面等元数据留余量） */
export const QUEUE_BATCH_CHUNK_SIZE = 500
/** 分块串行发送的块间间隔，避免触发服务端每 5 秒 10 次的 socket 限速 */
export const QUEUE_BATCH_CHUNK_DELAY_MS = 600

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 将大数组切成小块（默认 500/块），串行交给 emit 回调发送。
 * 块间等待 delayMs，防止批量导入触发服务端 socket 限速。
 * emit 回调接收 (chunk, index)，index 从 0 开始。
 */
export async function emitInChunks<T>(
  items: readonly T[],
  emit: (chunk: T[], index: number) => void,
  chunkSize = QUEUE_BATCH_CHUNK_SIZE,
  delayMs = QUEUE_BATCH_CHUNK_DELAY_MS,
): Promise<void> {
  for (let i = 0; i < items.length; i += chunkSize) {
    emit(items.slice(i, i + chunkSize), i / chunkSize)
    if (i + chunkSize < items.length && delayMs > 0) await sleep(delayMs)
  }
}

/** 纯分块函数，便于单元测试与复用。 */
export function chunkTracks<T>(tracks: readonly T[], size = QUEUE_BATCH_CHUNK_SIZE): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < tracks.length; i += size) chunks.push(tracks.slice(i, i + size))
  return chunks
}

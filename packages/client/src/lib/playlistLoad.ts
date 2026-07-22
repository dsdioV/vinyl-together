interface PlaylistErrorPayload {
  code?: unknown
  error?: unknown
}

export const PLAYLIST_NETWORK_ERROR = '无法连接服务器，请稍后重试'

/** Map playlist HTTP failures to messages that are safe and useful to display. */
export function getPlaylistLoadError(status: number, payload: PlaylistErrorPayload | null): string {
  const serverMessage = typeof payload?.error === 'string' ? payload.error.trim() : ''

  if (payload?.code === 'PLAYLIST_TRACK_LIMIT_EXCEEDED' && serverMessage) return serverMessage
  if (status === 401) return '房间身份已失效，请刷新后重试'
  if (status === 403) return '你已不在该房间中，无法加载歌单'
  if ((status === 400 || status === 404 || status === 422) && serverMessage) return serverMessage

  return '歌单加载失败，请稍后重试'
}

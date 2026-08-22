/**
 * 「建房后自动填充默认歌单存档」的进程内意图单例。
 * CreateRoomDialog 勾选 → HomePage 收到 ROOM_CREATED 后置位；
 * RoomPage 挂载且身份为 owner/admin 时消费并触发恢复。
 * SPA 内路由跳转不会丢失；页面刷新即失效（属锦上添花路径，可接受）。
 */
let pending = false

export function setPendingSnapshotRestore(value: boolean): void {
  pending = value
}

export function consumePendingSnapshotRestore(): boolean {
  const value = pending
  pending = false
  return value
}

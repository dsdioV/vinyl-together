import { useMemo } from 'react'
import type { MusicSource, MyPlatformAuth, PlatformAuthStatus } from '@music-together/shared'

export function usePlatformAutoSwitch(
  platformStatus: PlatformAuthStatus[],
  myStatus: MyPlatformAuth[],
) {
  return useMemo(() => {
    //找到全房间最早的VIP平台
    const roomVipPlatforms = platformStatus
      .filter((s) => s.hasVip && s.earliestVipTimestamp !== undefined)
      .sort((a, b) => (a.earliestVipTimestamp || 0) - (b.earliestVipTimestamp || 0))
    
    const earliestRoomVipPlatform = roomVipPlatforms[0]?.platform

    //找到本人有VIP的平台
    const myVipPlatforms = myStatus.filter((s) => s.loggedIn && (s.vipType || 0) > 0)
    const myVipPlatform = myVipPlatforms[0]?.platform

    // 3. 找到本人已登录的平台（按顺序，或者就取第一个）
    const myLoggedInPlatforms = myStatus.filter((s) => s.loggedIn)
    const myLoggedInPlatform = myLoggedInPlatforms[0]?.platform

    // --- 搜索点歌切换逻辑 ---
    //本人有 VIP：切换到本人的 VIP 平台 (如果多人有 VIP，且本人是其中之一，依照最早登录原则)
    //本人无 VIP：跟随房间内最早的 VIP 平台
    //全无人 VIP：保持默认或当前
    
    let preferredSearchPlatform: MusicSource | null = null
    
    if (myVipPlatform) {
      // 如果本人有 VIP，且也是全房最早的，或者是全房唯一 VIP，那肯定是本人的。
      // 如果本人有 VIP 但不是最早的？规则说 "依照最早登录的人的音乐平台进行切换"
      // 我们优先遵循最早登录原则，因为这通常代表了房间的“主导”平台。
      preferredSearchPlatform = earliestRoomVipPlatform || myVipPlatform
    } else {
      preferredSearchPlatform = earliestRoomVipPlatform || null
    }

    // --- 设置账号页面切换逻辑 ---
    // 规则：
    // - 本人有 VIP：切换到本人的 VIP 平台
    // - 本人无 VIP 但已登录：切换到本人的已登录平台
    
    let preferredSettingsPlatform: MusicSource | null = null
    if (myVipPlatform) {
      preferredSettingsPlatform = myVipPlatform
    } else if (myLoggedInPlatform) {
      preferredSettingsPlatform = myLoggedInPlatform
    }

    return {
      preferredSearchPlatform,
      preferredSettingsPlatform,
    }
  }, [platformStatus, myStatus])
}

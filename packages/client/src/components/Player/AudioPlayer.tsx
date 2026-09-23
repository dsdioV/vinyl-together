import { useContainerPortrait } from '@/hooks/useContainerPortrait'
import { useCoverWidth } from '@/hooks/useCoverWidth'
import { useVote } from '@/hooks/useVote'
import { cn, getTrackCoverUrl } from '@/lib/utils'
import { usePlayerStore } from '@/stores/playerStore'
import { useSettingsStore } from '@/stores/settingsStore'

import { BackgroundRender } from '@applemusic-like-lyrics/react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { useCallback, useMemo, useState } from 'react'
import { VoteBanner } from '../Vote/VoteBanner'
import { LyricDisplay } from './LyricDisplay'
import { NowPlaying } from './NowPlaying'
import { PlayerControls } from './PlayerControls'
import { SongInfoBar } from './SongInfoBar'

const FULL_SIZE_STYLE = { width: '100%', height: '100%' } as const

const LYRIC_MASK_STYLE = {
  maskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
} as const

interface AudioPlayerProps {
  onSeek: (time: number) => void
  onOpenChat: () => void
  onOpenQueue: () => void
  onOpenHistory: () => void
  chatUnreadCount: number
}

export function AudioPlayer({ onSeek, onOpenChat, onOpenQueue, onOpenHistory, chatUnreadCount }: AudioPlayerProps) {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const { activeVote, castVote, startVote, forceApprove, forceReject, dismissVote } = useVote()
  const bgFps = useSettingsStore((s) => s.bgFps)
  const bgFlowSpeed = useSettingsStore((s) => s.bgFlowSpeed)
  const bgRenderScale = useSettingsStore((s) => s.bgRenderScale)
  const pureBlackBackground = useSettingsStore((s) => s.pureBlackBackground)
  const { ref: playerRef, isPortrait } = useContainerPortrait()

  // 封面 URL 代理：由 getTrackCoverUrl 统一改为同源代理（见 lib/utils.ts），
  // 这里直接复用其结果，避免再维护一份域名白名单。
  const proxiedCover = useMemo(() => {
    return currentTrack ? getTrackCoverUrl(currentTrack) : undefined
  }, [currentTrack])

  // Mobile: toggle between cover view and lyric view
  const [lyricExpanded, setLyricExpanded] = useState(false)

  // Measure cover area to constrain info/controls width (paused during lyric mode)
  const { ref: coverAreaRef, coverWidth } = useCoverWidth(lyricExpanded)
  const toggleLyricView = useCallback(() => setLyricExpanded((v) => !v), [])

  // Derived styles to constrain info/controls to cover width
  const coverMaxStyle = coverWidth ? { maxWidth: coverWidth } : undefined
  const coverMaxStyleUnlessExpanded = lyricExpanded ? undefined : coverMaxStyle

  const playerControlsProps = {
    onSeek,
    onOpenQueue,
    onOpenHistory,
    onStartVote: startVote,
  } as const

  const songInfoProps = {
    onOpenChat,
    chatUnreadCount,
  } as const

  return (
    <div className={cn('relative flex h-full flex-col overflow-hidden', pureBlackBackground && 'bg-black')}>
      {/* AMLL fluid dynamic background powered by pixi.js */}
      {proxiedCover && !pureBlackBackground && (
        <div className="pointer-events-none absolute inset-0 z-0 opacity-80 saturate-[1.3]">
          <BackgroundRender
            album={proxiedCover}
            playing
            fps={bgFps}
            flowSpeed={bgFlowSpeed}
            renderScale={bgRenderScale}
            style={FULL_SIZE_STYLE}
          />
        </div>
      )}

      {/* Content with padding */}
      <div className="relative z-10 h-full p-5 md:p-[5%] lg:p-[5%]">
        <div
          ref={playerRef}
          className={cn('flex h-full', isPortrait ? 'flex-col' : 'flex-row gap-[clamp(24px,3vw,48px)]')}
        >
          {/* ----------------------------------------------------------------- */}
          {/* Mobile layout: dual-mode (cover view / lyric view)                */}
          {/* ----------------------------------------------------------------- */}
          {isPortrait ? (
            <LayoutGroup>
              <div className="relative mx-auto flex h-full w-full max-w-md flex-col items-center gap-[clamp(12px,3vh,32px)]">
                {/* Vote banner: top of player, doesn't block controls */}
                {activeVote && (
                  <div className="w-full shrink-0 px-2 pt-2">
                    <VoteBanner
                      vote={activeVote}
                      onCastVote={castVote}
                      onForceApprove={forceApprove}
                      onForceReject={forceReject}
                      onDismiss={dismissVote}
                    />
                  </div>
                )}

                {/* 1. Cover — fills remaining space in cover mode, centered within */}
                <div
                  ref={coverAreaRef}
                  className={cn('w-full', !lyricExpanded && 'flex-1 min-h-0 flex items-center justify-center')}
                  style={!lyricExpanded ? ({ containerType: 'size' } as React.CSSProperties) : undefined}
                >
                  <NowPlaying compact={lyricExpanded} onCoverClick={toggleLyricView} />
                </div>

                {/* Lyrics — popLayout so exiting lyrics don't occupy flex space */}
                <AnimatePresence mode="popLayout">
                  {lyricExpanded && (
                    <motion.div
                      key="lyrics"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 20 }}
                      transition={{ duration: 0.3, ease: 'easeOut' }}
                      className="min-h-0 w-full flex-1 overflow-hidden"
                      style={LYRIC_MASK_STYLE}
                    >
                      <LyricDisplay />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* 2. Song info + action buttons (independent zoom module) */}
                {!lyricExpanded && (
                  <div className="w-full shrink-0 mx-auto" style={coverMaxStyle}>
                    <SongInfoBar {...songInfoProps} />
                  </div>
                )}

                {/* 3. Controls (independent zoom module) */}
                <div className="relative z-10 w-full shrink-0 mx-auto" style={coverMaxStyleUnlessExpanded}>
                  <PlayerControls {...playerControlsProps} />
                </div>
              </div>
            </LayoutGroup>
          ) : (
            // ---------------------------------------------------------------
            // Desktop layout: left panel (cover + info + controls) + right lyrics
            // ---------------------------------------------------------------
            <>
              <div className="relative flex w-[40%] flex-col items-center gap-[clamp(12px,3vh,32px)] transition-all duration-300">
                {/* Vote banner: top of player, doesn't block controls */}
                {activeVote && (
                  <div className="w-full shrink-0 px-2 pt-2">
                    <VoteBanner
                      vote={activeVote}
                      onCastVote={castVote}
                      onForceApprove={forceApprove}
                      onForceReject={forceReject}
                      onDismiss={dismissVote}
                    />
                  </div>
                )}
                {/* 1. Cover — flex-1 fills remaining space, centered */}
                <div
                  ref={coverAreaRef}
                  className="min-h-0 w-full flex-1 flex items-center justify-center"
                  style={{ containerType: 'size' }}
                >
                  <NowPlaying />
                </div>
                {/* 2. Song info + action buttons */}
                <div className="w-full shrink-0 mx-auto" style={coverMaxStyle}>
                  <SongInfoBar {...songInfoProps} />
                </div>
                {/* 3. Controls */}
                <div className="w-full shrink-0 mx-auto" style={coverMaxStyle}>
                  <PlayerControls {...playerControlsProps} />
                </div>
              </div>
              <div className="min-h-0 w-[60%] overflow-hidden" style={LYRIC_MASK_STYLE}>
                <LyricDisplay />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

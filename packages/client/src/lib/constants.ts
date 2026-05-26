// ---------------------------------------------------------------------------
// Client-side timing constants (ms / s)
// ---------------------------------------------------------------------------

/** Deduplication window for PLAYER_PLAY events */
export const PLAYER_PLAY_DEDUP_MS = 2000

/** Unmute delay after seeking during track load */
export const HOWL_UNMUTE_DELAY_SEEK_MS = 400

/** Unmute delay when starting from the beginning */
export const HOWL_UNMUTE_DELAY_DEFAULT_MS = 100

/** Throttle interval for currentTime store updates */
export const CURRENT_TIME_THROTTLE_MS = 100

/** Interval for conductor progress reporting — normal (steady state) */
export const CONDUCTOR_REPORT_INTERVAL_MS = 5_000

/** Interval for conductor progress reporting — fast (first seconds of a new track) */
export const CONDUCTOR_REPORT_FAST_INTERVAL_MS = 2_000

/** Duration (ms) of the fast conductor reporting phase after a new track starts */
export const CONDUCTOR_REPORT_FAST_DURATION_MS = 10_000

/** Interval for client-initiated sync requests (drift correction) */
export const SYNC_REQUEST_INTERVAL_MS = 10_000

/**
 * Hard-seek threshold (seconds).
 * Only seek when the client-server position difference exceeds this value.
 * This deliberately large threshold prioritises smooth playback over
 * tight synchronisation — seek-induced rebuffering is far more disruptive
 * than a few seconds of drift in a casual-listening scenario.
 */
export const SYNC_HARD_SEEK_THRESHOLD_S = 5

/**
 * Initial no-sync window (ms) after a new track starts.
 * During this window the client ignores all SYNC_RESPONSE messages,
 * giving the audio buffer time to stabilise before any correction.
 */
export const SYNC_INITIAL_WINDOW_MS = 6_000

/** Safety clamp for network delay estimation (seconds) — prevents clock-skew outliers */
export const MAX_NETWORK_DELAY_S = 5

/** Loading time threshold (seconds) before compensating with a seek */
export const LOAD_COMPENSATION_THRESHOLD_S = 0.15

/** 加载补偿 seek 的最大值（秒），防止网络慢时跳过歌曲开头过多 */
export const MAX_LOAD_COMPENSATION_S = 2

/** Safety timeout for lobby action loading state */
export const ACTION_LOADING_TIMEOUT_MS = 15_000

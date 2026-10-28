export const BEAT_INTERVAL_MS = 15_000;

export const MAX_BEAT_GAP_MS = 60_000;

export const IDLE_MINUTES = 5;

export type PauseReason = 'manual' | 'idle' | 'done';

export interface TimerStatus {
  slug: string;
  elapsedMs: number;
  paused: PauseReason | null;
}

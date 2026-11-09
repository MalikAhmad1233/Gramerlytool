import type { CheckMode } from '../shared/types';

/**
 * Two-tier debounce: a fast LanguageTool check shortly after typing pauses, and a full
 * (AI-assisted) check after a longer pause. Every keystroke resets both timers.
 */
export class CheckScheduler {
  private fastTimer: ReturnType<typeof setTimeout> | null = null;
  private fullTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly run: (mode: CheckMode) => void,
    private readonly options: { fastDelay: number; fullDelay: number; fullEnabled: () => boolean } = {
      fastDelay: 350,
      fullDelay: 1500,
      fullEnabled: () => true,
    },
  ) {}

  poke(immediate = false): void {
    this.cancel();
    this.fastTimer = setTimeout(() => this.run('fast'), immediate ? 0 : this.options.fastDelay);
    if (this.options.fullEnabled()) {
      this.fullTimer = setTimeout(() => this.run('full'), this.options.fullDelay);
    }
  }

  cancel(): void {
    if (this.fastTimer) clearTimeout(this.fastTimer);
    if (this.fullTimer) clearTimeout(this.fullTimer);
    this.fastTimer = this.fullTimer = null;
  }
}

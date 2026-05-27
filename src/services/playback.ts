import { ResolvedMedia } from './providers/types.js';

export class PlaybackController {
	private startedAt: number | null = null;
	private elapsedBeforePause: number = 0;
	private _paused: boolean = false;
	private currentMedia: ResolvedMedia | null = null;
	private seekOffset: number = 0;

	startTracking(media: ResolvedMedia, fromPosition: number = 0): void {
		this.currentMedia = media;
		this.seekOffset = fromPosition;
		this.elapsedBeforePause = 0;
		this._paused = false;
		this.startedAt = Date.now();
	}

	getPosition(): number {
		if (!this.startedAt) return this.seekOffset + this.elapsedBeforePause;
		if (this._paused) return this.seekOffset + this.elapsedBeforePause;
		const elapsed = (Date.now() - this.startedAt) / 1000;
		return this.seekOffset + this.elapsedBeforePause + elapsed;
	}

	pause(): number {
		if (this._paused || !this.startedAt) return this.getPosition();
		const elapsed = (Date.now() - this.startedAt) / 1000;
		this.elapsedBeforePause += elapsed;
		this._paused = true;
		this.startedAt = null;
		return this.getPosition();
	}

	resume(fromPosition: number): void {
		this.seekOffset = fromPosition;
		this.elapsedBeforePause = 0;
		this._paused = false;
		this.startedAt = Date.now();
	}

	seek(targetSeconds: number): number {
		const duration = this.currentMedia?.duration;
		const clamped = duration ? Math.min(Math.max(0, targetSeconds), duration) : Math.max(0, targetSeconds);
		this.seekOffset = clamped;
		this.elapsedBeforePause = 0;
		this._paused = false;
		this.startedAt = Date.now();
		return clamped;
	}

	isPaused(): boolean {
		return this._paused;
	}

	getDuration(): number | undefined {
		return this.currentMedia?.duration;
	}

	getCurrentMedia(): ResolvedMedia | null {
		return this.currentMedia;
	}

	reset(): void {
		this.startedAt = null;
		this.elapsedBeforePause = 0;
		this._paused = false;
		this.currentMedia = null;
		this.seekOffset = 0;
	}
}

import { Client, Message } from "discord.js-selfbot-v13";
import { Streamer } from "@dank074/discord-video-stream";
import config from "../config.js";
import { QueueService } from './queue.js';
import { STTService } from './stt.js';
import { LLMService } from './llm.js';
import { ProviderManager } from './providers/manager.js';
import { ResolvedMedia } from './providers/types.js';
import { PlaybackController } from './playback.js';
import { StreamComposer } from './stream-composer.js';
import logger, { getLogBuffer } from '../utils/logger.js';
import { DiscordUtils, ErrorUtils } from '../utils/shared.js';
import { QueueItem, StreamStatus } from '../types/index.js';

export class StreamingService {
	private streamer: Streamer;
	private queueService: QueueService;
	private providerManager: ProviderManager;
	private playbackController: PlaybackController;
	private composer: StreamComposer;
	private streamStatus: StreamStatus;
	private failedVideos: Set<string> = new Set();
	private isSkipping: boolean = false;
	private sttService: STTService;
	private llmService: LLMService;
	private currentResolved: ResolvedMedia | null = null;
	private streamEpoch: number = 0;
	private overlayInterval: ReturnType<typeof setInterval> | null = null;
	private overlayEnabled: boolean = true;

	constructor(client: Client, streamStatus: StreamStatus, providerManager: ProviderManager) {
		this.streamer = new Streamer(client);
		this.queueService = new QueueService();
		this.providerManager = providerManager;
		this.playbackController = new PlaybackController();
		this.composer = new StreamComposer(this.streamer);
		this.streamStatus = streamStatus;
		this.sttService = new STTService(client);
		this.llmService = new LLMService(this);
		this.sttService.setLLMService(this.llmService);

		if (this.llmService.isEnabled()) {
			logger.info(`LLM: Voice commands enabled — model: ${config.openrouterModel}`);
		} else {
			logger.info("LLM: Voice commands disabled (no OPENROUTER_API_KEY)");
		}

		// Start overlay updates immediately (works without Discord for preview)
		this.startOverlayUpdates();
	}

	// ── Accessors ────────────────────────────────────────────────────

	public getStreamer(): Streamer { return this.streamer; }
	public getQueueService(): QueueService { return this.queueService; }
	public getSTTService(): STTService { return this.sttService; }
	public getStreamStatus(): StreamStatus { return this.streamStatus; }
	public getProviderManager(): ProviderManager { return this.providerManager; }
	public getPlaybackController(): PlaybackController { return this.playbackController; }
	public getComposer(): StreamComposer { return this.composer; }

	// ── Queue management ─────────────────────────────────────────────

	public async addToQueue(message: Message, videoSource: string, title?: string): Promise<boolean> {
		try {
			const username = message.author.username;
			const resolved = await this.providerManager.resolve(videoSource);

			if (resolved) {
				const item = await this.queueService.add(videoSource, resolved.title, username, resolved.provider, resolved.isLive, videoSource);
				item.duration = resolved.duration;
				item.seekable = resolved.seekable;
				item.thumbnailUrl = resolved.thumbnailUrl;
				await DiscordUtils.sendSuccess(message, `Added to queue: \`${item.title}\``);
				return true;
			}

			// Search fallback
			const searchResults = await this.providerManager.search(videoSource, 1);
			if (searchResults.length > 0) {
				const r = searchResults[0];
				const item = await this.queueService.add(r.url, r.title, username, 'youtube', false, videoSource);
				item.duration = r.duration;
				item.thumbnailUrl = r.thumbnailUrl;
				await DiscordUtils.sendSuccess(message, `Added to queue: \`${item.title}\``);
				return true;
			}

			// Absolute fallback
			const item = await this.queueService.add(videoSource, title || videoSource, username, 'url', false, videoSource);
			await DiscordUtils.sendSuccess(message, `Added to queue: \`${item.title}\``);
			return true;
		} catch (error) {
			await ErrorUtils.handleError(error, `adding to queue: ${videoSource}`, message);
			return false;
		}
	}

	public async playFromQueue(message: Message): Promise<void> {
		if (this.streamStatus.playing) {
			await DiscordUtils.sendError(message, 'Already playing a video. Use skip command to skip current video.');
			return;
		}
		const nextItem = this.queueService.getNext();
		if (!nextItem) {
			await DiscordUtils.sendError(message, 'Queue is empty.');
			return;
		}
		this.queueService.setPlaying(true);
		await this.playVideoFromQueueItem(message, nextItem);
	}

	public async skipCurrent(message: Message): Promise<void> {
		if (!this.streamStatus.playing && !this.streamStatus.paused) {
			await DiscordUtils.sendError(message, 'No video is currently playing.');
			return;
		}
		const queueLength = this.queueService.getLength();
		if (this.isSkipping && queueLength > 1) {
			await DiscordUtils.sendError(message, 'Skip already in progress.');
			return;
		}

		this.isSkipping = true;
		try {
			++this.streamEpoch;
			this.playbackController.reset();
			this.currentResolved = null;

			const currentItem = this.queueService.getCurrent();
			const nextItem = this.queueService.skip();

			if (!nextItem) {
				this.queueService.setPlaying(false);
				this.streamStatus.playing = false;
				this.streamStatus.paused = false;
				this.composer.showIdle();
				await DiscordUtils.sendInfo(message, 'Queue', 'No more videos in queue.');
				return;
			}

			const currentTitle = currentItem ? currentItem.title : 'current video';
			await DiscordUtils.sendInfo(message, 'Skipping', `Skipping \`${currentTitle}\`. Playing next: \`${nextItem.title}\``);
			await this.playVideoFromQueueItem(message, nextItem);
		} finally {
			this.isSkipping = false;
		}
	}

	// ── Core playback ────────────────────────────────────────────────

	private async playVideoFromQueueItem(message: Message, queueItem: QueueItem, preResolved?: ResolvedMedia): Promise<void> {
		this.queueService.setPlaying(true);
		logger.info(`Playing from queue: ${queueItem.title} (${queueItem.url})`);
		await this.playVideo(message, queueItem.url, queueItem.title, preResolved);
	}

	private async prepareVideoSource(videoSource: string): Promise<ResolvedMedia> {
		const resolved = await this.providerManager.resolve(videoSource);
		if (resolved) return resolved;

		const searchResults = await this.providerManager.search(videoSource, 1);
		if (searchResults.length > 0) {
			const r = await this.providerManager.resolve(searchResults[0].url);
			if (r) return r;
		}
		throw new Error(`Could not resolve: ${videoSource}`);
	}

	public async playVideo(message: Message, videoSource: string, title?: string, preResolved?: ResolvedMedia): Promise<void> {
		const epoch = ++this.streamEpoch;

		try {
			// Use pre-resolved data if available (skips slow yt-dlp re-resolution)
			const resolved = preResolved || await this.prepareVideoSource(videoSource);
			this.currentResolved = resolved;

			this.streamStatus.playing = true;
			this.streamStatus.paused = false;
			this.streamStatus.manualStop = false;
			// Don't start playback tracking here — the video hasn't started on Discord yet.
			// The web preview uses <video>.currentTime (accurate). Discord position is approximate.

			// Start media decoder FIRST (feeds preview immediately)
			this.composer.setMediaSource(resolved.streamUrl);
			logger.info(`Streaming: ${title || resolved.title}`);

			// Connect Discord in background (non-blocking for preview-only mode)
			this.ensureVoiceAndComposer(title || resolved.title).catch(err => {
				logger.debug('Discord not available (preview-only mode):', err?.message || err);
			});
			await DiscordUtils.sendPlaying(message, title || resolved.title).catch(() => {});

			// Wait for the browser's video element to end
			const result = await this.composer.waitForSourceEnd();

			logger.info(`Source ended: result=${result}, epoch=${epoch}/${this.streamEpoch}`);

			if (this.streamEpoch !== epoch) return;

			if (result === 'finished') {
				logger.info(`Finished playing: ${title || resolved.title}`);
				this.composer.showIdle();
				this.playbackController.reset();
				this.currentResolved = null;
				await this.handleQueueAdvancement(message);
			}
		} catch (error) {
			if (this.streamEpoch !== epoch) return;
			await ErrorUtils.handleError(error, `playing video: ${title || videoSource}`);
			this.failedVideos.add(videoSource);
			this.playbackController.reset();
			this.currentResolved = null;
			this.composer.showIdle();
			await this.handleQueueAdvancement(message);
		}
	}

	private async handleQueueAdvancement(message: Message): Promise<void> {
		await DiscordUtils.sendFinishMessage(message);

		const finishedItem = this.queueService.getCurrent();
		if (finishedItem) this.queueService.removeFromQueue(finishedItem.id);

		const nextItem = this.queueService.getNext();
		if (nextItem) {
			logger.info(`Auto-playing next: ${nextItem.title}`);
			setTimeout(() => {
				this.playVideoFromQueueItem(message, nextItem).catch(err =>
					ErrorUtils.handleError(err, 'auto-playing next item')
				);
			}, 500);
		} else {
			this.queueService.setPlaying(false);
			this.streamStatus.playing = false;
			this.streamer.client.user?.setActivity(DiscordUtils.status_idle());
			logger.info('Queue empty — idle stream active');
		}
	}

	// ── Pause / Resume / Seek (no stream restart!) ───────────────────

	public async pausePlayback(): Promise<number> {
		if (!this.streamStatus.playing || this.streamStatus.paused) {
			throw new Error('Nothing is playing or already paused.');
		}

		// Use GStreamer's reported position (source of truth) rather than wall-clock
		const position = this.composer.getPosition() || this.playbackController.pause();
		this.playbackController.pause();
		++this.streamEpoch;
		this.streamStatus.paused = true;
		this.streamStatus.playing = false;

		this.composer.pauseMedia();

		logger.info(`Paused at ${position.toFixed(1)}s`);
		return position;
	}

	public async resumePlayback(): Promise<void> {
		if (!this.streamStatus.paused || !this.currentResolved) {
			throw new Error('Nothing is paused.');
		}

		// Use GStreamer's position as source of truth
		const position = this.composer.getPosition() || this.playbackController.getPosition();
		logger.info(`Resuming from ${position.toFixed(1)}s`);

		this.streamStatus.paused = false;
		this.streamStatus.playing = true;
		this.playbackController.resume(position);

		this.composer.resumeMedia();
	}

	public async seekTo(seconds: number): Promise<number> {
		if (!this.streamStatus.playing && !this.streamStatus.paused) throw new Error('Nothing is playing.');

		logger.info(`Seeking to ${seconds.toFixed(1)}s`);

		// Use GStreamer's native seek (instant, no pipeline restart!)
		this.composer.seekTo(seconds);
		this.playbackController.seek(seconds);
		this.streamStatus.playing = true;
		this.streamStatus.paused = false;

		return seconds;
	}

	public getPlaybackState() {
		return {
			position: this.playbackController.getPosition(),
			duration: this.playbackController.getDuration(),
			paused: this.playbackController.isPaused(),
			seekable: this.currentResolved?.seekable || false,
			title: this.currentResolved?.title || null,
			audioTracks: this.currentResolved?.audioTracks || [],
		};
	}

	public setAudioTrack(index: number): void {
		if (!this.streamStatus.playing && !this.streamStatus.paused) {
			throw new Error('Nothing is playing.');
		}
		this.composer.setAudioTrack(index);
	}

	// ── Overlay ──────────────────────────────────────────────────────

	private startOverlayUpdates(): void {
		this.stopOverlayUpdates();
		this.tickOverlay();
		this.overlayInterval = setInterval(() => this.tickOverlay(), 1000);
	}

	private stopOverlayUpdates(): void {
		if (this.overlayInterval) {
			clearInterval(this.overlayInterval);
			this.overlayInterval = null;
		}
	}

	private tickOverlay(): void {
		if (!this.overlayEnabled) return;
		const qs = this.queueService;
		const current = qs.getCurrent();
		const allItems = qs.getQueue();

		// Build queue item list for the canvas overlay
		const queueItems = allItems.map(item => {
			const isCurrent = current && item.id === current.id;
			const state = item.type === 'resolving' ? 'resolving' as const
				: isCurrent && this.streamStatus.playing ? 'playing' as const
				: isCurrent && this.streamStatus.paused ? 'paused' as const
				: 'queued' as const;
			return { title: item.title, state };
		});

		// Get most recent log line
		const logs = getLogBuffer();
		const recentLog = logs.length > 0
			? truncate(logs[logs.length - 1]?.message || '', 100)
			: '';

		// Voice activity from STT
		const speakers = this.sttService.getActiveSpeakers();
		const lastTranscript = this.sttService.getLastTranscript();
		const wakeWordActive = this.sttService.isWakeWordActive();

		if ((this.streamStatus.playing || this.streamStatus.paused) && this.currentResolved) {
			const pos = this.composer.getPosition();
			const dur = this.composer.getDuration() || this.currentResolved.duration || 0;
			const posStr = dur > 0 ? `${fmtTime(pos)} / ${fmtTime(dur)}` : fmtTime(pos);
			this.composer.updateIdleInfo({
				title: truncate(this.currentResolved.title, 40),
				duration: this.currentResolved.duration ? fmtTime(this.currentResolved.duration) : undefined,
				position: posStr,
				queue: allItems.length,
				status: this.streamStatus.paused ? 'Paused' : 'Playing',
				log: recentLog,
				queueItems,
				speakers: speakers.length > 0 ? speakers : undefined,
				lastTranscript,
				wakeWordActive,
			});
		} else {
			this.composer.updateIdleInfo({
				status: 'Idle', queue: allItems.length, log: recentLog, queueItems,
				speakers: speakers.length > 0 ? speakers : undefined,
				lastTranscript,
				wakeWordActive,
			});
		}

		// Re-render the overlay (1/sec — the timer writes the cached buffer at 30fps)
		this.composer.refreshOverlay();
	}

	public setOverlayEnabled(enabled: boolean): void {
		this.overlayEnabled = enabled;
		if (!enabled) {
			this.composer.clearOverlay();
		} else {
			this.tickOverlay();
		}
	}

	public isOverlayEnabled(): boolean {
		return this.overlayEnabled;
	}

	// ── Voice + Composer lifecycle ───────────────────────────────────

	public async startComposer(): Promise<void> {
		if (!this.composer.running) {
			await this.composer.start();
			this.startOverlayUpdates();
		}
	}

	private async ensureVoiceAndComposer(title?: string): Promise<void> {
		if (!this.streamStatus.joined || !this.streamer.voiceConnection) {
			// Always patch self_deaf=false so bot can receive audio
			this.sttService.patchStreamer(this.streamer);
			await this.streamer.joinVoice(config.guildId, config.videoChannelId);
			this.streamStatus.joined = true;

			// Explicitly undeafen — the library defaults to self_deaf:true
			this.streamer.sendOpcode(4, {
				guild_id: config.guildId,
				channel_id: config.videoChannelId,
				self_mute: false,
				self_deaf: false,
				self_video: false,
			});

			await new Promise(resolve => setTimeout(resolve, 2000));
			if (!this.streamer.voiceConnection) throw new Error('Voice connection not established');

			// Always activate STT for voice activity overlay; Whisper only loads if sttEnabled
			if (!this.sttService.isRunning()) {
				this.sttService.activate().catch(err => logger.error("STT activate error:", err));
			}
		}

		// Start composer if not running (first play, or after a stop)
		if (!this.composer.running) {
			await this.composer.start();
			this.startOverlayUpdates();
		}

		this.streamStatus.channelInfo = {
			guildId: config.guildId,
			channelId: config.videoChannelId,
			cmdChannelId: config.cmdChannelId!,
		};

		if (title) this.streamer.client.user?.setActivity(DiscordUtils.status_watch(title));
	}

	public async cleanupStreamStatus(): Promise<void> {
		try {
			++this.streamEpoch;
			this.stopOverlayUpdates();
			await this.composer.stop();

			this.sttService.stop();
			this.streamer.leaveVoice();

			this.streamer.client.user?.setActivity(DiscordUtils.status_idle());
			this.streamStatus.joined = false;
			this.streamStatus.joinsucc = false;
			this.streamStatus.playing = false;
			this.streamStatus.paused = false;
			this.streamStatus.manualStop = false;
			this.streamStatus.channelInfo = { guildId: "", channelId: "", cmdChannelId: "" };
		} catch (error) {
			await ErrorUtils.handleError(error, "cleanup stream status");
		}
	}

	public async stopAndClearQueue(): Promise<void> {
		++this.streamEpoch;
		this.playbackController.reset();
		this.currentResolved = null;
		this.queueService.clearQueue();
		logger.info("Queue cleared by stop command");

		// Return to idle — DON'T kill the compositor stream
		this.composer.showIdle();
		this.streamStatus.playing = false;
		this.streamStatus.paused = false;
		this.streamStatus.manualStop = false;
		this.streamer.client.user?.setActivity(DiscordUtils.status_idle());
	}

	// ── Web-friendly methods ─────────────────────────────────────────

	private createStubMessage(): any {
		const noop = async (..._args: any[]) => {};
		const noopMsg = async (..._args: any[]) => ({ delete: noop, edit: noop });
		return { author: { username: 'Web' }, react: noop, reply: noopMsg, channel: { send: noopMsg } };
	}

	public async addToQueueWeb(videoSource: string, requestedBy: string = 'Web', autoPlay: boolean = false): Promise<QueueItem> {
		// Basic validation — reject obvious non-URLs/non-queries
		const trimmed = videoSource.trim();
		if (!trimmed || trimmed.length > 500 || trimmed.includes('\n')) {
			throw new Error('Invalid input');
		}

		// Add to queue IMMEDIATELY with raw input as title — instant UI feedback
		const item = await this.queueService.add(trimmed, trimmed, requestedBy, 'resolving', false, trimmed);

		// Resolve metadata in background, then auto-play if requested
		this.resolveQueueItemAsync(item, videoSource, autoPlay);

		return item;
	}

	private resolveQueueItemAsync(item: QueueItem, videoSource: string, autoPlay: boolean = false): void {
		(async () => {
			let streamUrl: string | null = null;

			try {
				const resolved = await this.providerManager.resolve(videoSource);
				if (resolved) {
					streamUrl = resolved.streamUrl;
					item.url = videoSource;
					item.title = resolved.title;
					item.type = resolved.provider;
					item.isLive = resolved.isLive;
					item.duration = resolved.duration;
					item.seekable = resolved.seekable;
					item.thumbnailUrl = resolved.thumbnailUrl;
					item.resolved = true;
					logger.info(`Resolved: ${resolved.title}`);
				} else {
					const searchResults = await this.providerManager.search(videoSource, 1);
					if (searchResults.length > 0) {
						const r = searchResults[0];
						// Re-resolve the search result to get stream URL
						const searchResolved = await this.providerManager.resolve(r.url);
						streamUrl = searchResolved?.streamUrl || r.url;
						item.url = r.url;
						item.title = r.title;
						item.type = 'youtube';
						item.duration = r.duration || searchResolved?.duration;
						item.seekable = searchResolved?.seekable;
						item.thumbnailUrl = r.thumbnailUrl || searchResolved?.thumbnailUrl;
						item.resolved = true;
						logger.info(`Resolved (search): ${r.title}`);
					} else {
						streamUrl = videoSource;
						item.type = 'url';
						item.resolved = true;
					}
				}
			} catch (err) {
				logger.warn(`Failed to resolve ${videoSource}:`, err);
				item.type = 'error';
				item.title = `[Error] ${videoSource}`;
				return;
			}

			// Auto-play after resolution if nothing is currently playing
			if (autoPlay) {
				if (!this.streamStatus.playing && !this.streamStatus.paused) {
					logger.info(`Auto-playing: ${item.title}`);
					try {
						const preResolved: ResolvedMedia = {
							streamUrl: streamUrl || item.url,
							title: item.title,
							provider: item.type,
							isLive: item.isLive || false,
							duration: item.duration,
							seekable: item.seekable || false,
							thumbnailUrl: item.thumbnailUrl,
						};
						this.queueService.setPlaying(true);
						const stub = this.createStubMessage();
						await this.playVideoFromQueueItem(stub as any, item, preResolved);
					} catch (err) {
						logger.warn('Auto-play failed:', err);
					}
				} else {
					logger.debug(`Skipping auto-play (playing=${this.streamStatus.playing}, paused=${this.streamStatus.paused})`);
				}
			}
		})();
	}

	public async playFromQueueWeb(): Promise<string> {
		if (this.streamStatus.playing) throw new Error('Already playing. Use skip to skip current.');
		const nextItem = this.queueService.getNext();
		if (!nextItem) throw new Error('Queue is empty.');
		this.queueService.setPlaying(true);
		const stub = this.createStubMessage();
		this.playVideoFromQueueItem(stub as any, nextItem).catch(err => logger.error('Web playback error:', err));
		return nextItem.title;
	}

	public async skipCurrentWeb(): Promise<string | null> {
		if (!this.streamStatus.playing && !this.streamStatus.paused) throw new Error('Nothing is currently playing.');
		if (this.isSkipping) throw new Error('Skip already in progress.');

		this.isSkipping = true;
		try {
			++this.streamEpoch;
			this.playbackController.reset();
			this.currentResolved = null;

			const nextItem = this.queueService.skip();
			if (!nextItem) {
				this.queueService.setPlaying(false);
				this.streamStatus.playing = false;
				this.streamStatus.paused = false;
				this.composer.showIdle();
				return null;
			}

			const stub = this.createStubMessage();
			this.playVideoFromQueueItem(stub as any, nextItem).catch(err => logger.error('Web skip/play error:', err));
			return nextItem.title;
		} finally {
			this.isSkipping = false;
		}
	}

	public async pauseWeb(): Promise<number> { return this.pausePlayback(); }
	public async resumeWeb(): Promise<void> { return this.resumePlayback(); }
	public async seekWeb(seconds: number): Promise<number> { return this.seekTo(seconds); }
}

// ── Module-level helpers ─────────────────────────────────────────

function fmtTime(s: number): string {
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = Math.floor(s % 60);
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
	return `${m}:${String(sec).padStart(2, '0')}`;
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.substring(0, max - 3) + '...' : s;
}

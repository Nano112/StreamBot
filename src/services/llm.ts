import { TextChannel } from "discord.js-selfbot-v13";
import { VoiceToolSystem } from "voice-tool-call";
import config from "../config.js";
import logger from "../utils/logger.js";
import { StreamingService } from "./streaming.js";

export class LLMService {
	private streamingService: StreamingService;
	private voiceSystem: VoiceToolSystem;

	constructor(streamingService: StreamingService) {
		this.streamingService = streamingService;

		this.voiceSystem = new VoiceToolSystem({
			intent: 'api',
			apiUrl: config.openrouterBaseUrl,
			apiKey: config.openrouterApiKey,
			autoSpeak: false,
		});

		this.registerTools();

		this.voiceSystem.on('error', ({ error, source }) => {
			logger.error(`VoiceToolSystem error (${source}):`, error);
		});
	}

	private registerTools(): void {
		const svc = this.streamingService;

		this.voiceSystem.registerTools({
			play: {
				description: 'Play a song or video by search query or URL. Adds to queue and auto-plays.',
				parameters: { query: 'string' },
				keywords: ['play', 'put on', 'queue', 'listen'],
				examples: [
					{ input: 'play never gonna give you up', arguments: { query: 'never gonna give you up' } },
					{ input: 'put on some lofi beats', arguments: { query: 'lofi beats' } },
				],
				handler: async (args) => {
					const item = await svc.addToQueueWeb(args.query, 'Voice', true);
					return { queued: true, title: item.title };
				},
			},
			pause: {
				description: 'Pause the currently playing media.',
				parameters: {},
				keywords: ['pause', 'hold', 'wait'],
				handler: async () => {
					const pos = await svc.pausePlayback();
					return { paused: true, position: pos };
				},
			},
			resume: {
				description: 'Resume paused media playback.',
				parameters: {},
				keywords: ['resume', 'continue', 'unpause'],
				handler: async () => {
					await svc.resumePlayback();
					return { resumed: true };
				},
			},
			skip: {
				description: 'Skip the currently playing song/video and play the next one.',
				parameters: {},
				keywords: ['skip', 'next'],
				handler: async () => {
					const current = svc.getQueueService().getCurrent();
					await svc.stopAndClearQueue();
					return { skipped: current?.title || 'current track' };
				},
			},
			stop: {
				description: 'Stop playback and clear the entire queue.',
				parameters: {},
				keywords: ['stop', 'clear', 'shut up'],
				handler: async () => {
					await svc.stopAndClearQueue();
					return { stopped: true };
				},
			},
			get_queue: {
				description: 'Get the current queue and what is playing.',
				parameters: {},
				keywords: ['queue', 'what\'s next', 'list'],
				handler: () => {
					const qs = svc.getQueueService();
					const queue = qs.getQueue();
					const current = qs.getCurrent();
					return {
						playing: current?.title || null,
						queue: queue.map((item, i) => `${i + 1}. ${item.title}`),
						length: queue.length,
					};
				},
			},
			get_status: {
				description: 'Get current playback status.',
				parameters: {},
				keywords: ['status', 'what\'s playing', 'now playing'],
				handler: () => {
					const status = svc.getStreamStatus();
					const current = svc.getQueueService().getCurrent();
					return {
						playing: status.playing,
						paused: status.paused,
						currentTrack: current?.title || null,
						queueLength: svc.getQueueService().getLength(),
					};
				},
			},
			search_youtube: {
				description: 'Search YouTube for videos.',
				parameters: { query: 'string' },
				keywords: ['search', 'find', 'look up'],
				handler: async (args) => {
					const provider = svc.getProviderManager().getProvider('youtube');
					if (!provider || !('searchFormatted' in provider)) return { error: 'Search not available' };
					const results = await (provider as any).searchFormatted(args.query, 5);
					return { results };
				},
			},
		});
	}

	public isEnabled(): boolean {
		return !!config.openrouterApiKey;
	}

	public async processVoiceCommand(
		userId: string,
		username: string,
		text: string,
		textChannel: TextChannel
	): Promise<void> {
		if (!this.isEnabled()) return;

		logger.info(`LLM: Processing voice command from ${username}: "${text}"`);

		try {
			const results = await this.voiceSystem.processText(text);

			if (results && results.length > 0) {
				const summary = results.map(r => {
					if (r.error) return `Error: ${r.error}`;
					return `${r.tool}: ${JSON.stringify(r.result)}`;
				}).join('\n');
				await textChannel.send(`**Clanker**: ${summary}`);
			} else {
				await textChannel.send(`**Clanker**: I didn't understand that. Try "play <song>", "skip", "pause", or "stop".`);
			}
		} catch (err) {
			logger.error("LLM: Error processing voice command:", err);
			await textChannel.send("**Clanker**: Something went wrong.").catch(() => {});
		}
	}
}

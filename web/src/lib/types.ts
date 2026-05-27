// Matches GET /api/bot/status response
export interface BotStatus {
	joined: boolean;
	playing: boolean;
	paused: boolean;
	channelInfo?: {
		guildId: string;
		channelId: string;
		cmdChannelId?: string;
	};
	currentTrack: {
		id: string;
		title: string;
		type: string;
		requestedBy: string;
		duration: number | null;
		seekable: boolean;
		thumbnailUrl: string | null;
	} | null;
	playback: {
		position: number;
		duration: number;
		paused: boolean;
		seekable: boolean;
		audioTracks: AudioTrack[];
	};
	queue: QueueItem[];
	queueLength: number;
}

// Matches GET /api/bot/playback response (getPlaybackState())
export interface PlaybackInfo {
	audioTracks: AudioTrack[];
	[key: string]: unknown;
}

export interface QueueItem {
	id: string;
	title: string;
	type: string;
	resolved: boolean;
	requestedBy: string;
	addedAt?: number;
	duration: number | null;
	thumbnailUrl: string | null;
}

export interface AudioTrack {
	index: number;
	language: string;
	languageCode: string;
	codec: string;
	channels: number;
	title?: string;
	selected?: boolean;
}

export type PlexAuthState = 'idle' | 'awaiting-pin' | 'pin-expired' | 'linked' | 'ready';

export interface PlexAuthStatus {
	state: PlexAuthState;
	code?: string;
	codeExpiresAt?: number;
	accountUser?: string;
	serverName?: string;
	servers?: Array<{
		id: string;
		name: string;
		owned: boolean;
		connections: Array<{
			uri: string;
			local: boolean;
			https: boolean;
			relay: boolean;
		}>;
	}>;
	reason?: string;
}

import dotenv from "dotenv"

dotenv.config({ quiet: true });

const VALID_VIDEO_CODECS = ['VP8', 'H264', 'H265', 'VP9', 'AV1'];

export function parseVideoCodec(value: string): "VP8" | "H264" | "H265" {
	if (typeof value === "string") {
		value = value.trim().toUpperCase();
	}
	if (VALID_VIDEO_CODECS.includes(value)) {
		return value as "VP8" | "H264" | "H265";
	}
	return "H264";
}

export function parsePreset(value: string): "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow" {
	if (typeof value === "string") {
		value = value.trim().toLowerCase();
	}
	switch (value) {
		case "ultrafast":
		case "superfast":
		case "veryfast":
		case "faster":
		case "fast":
		case "medium":
		case "slow":
		case "slower":
		case "veryslow":
			return value as "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
		default:
			return "ultrafast";
	}
}

export function parseBoolean(value: string | undefined): boolean {
	if (typeof value === "string") {
		value = value.trim().toLowerCase();
	}
	switch (value) {
		case "true":
			return true;
		default:
			return false;
	}
}

function parseAdminIds(value: string): string[] {
	try {
		// Try to parse as JSON array first
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) {
			return parsed.filter(id => typeof id === 'string' && id.trim() !== '');
		}
	} catch {
		// If not JSON, try comma-separated values
		if (value.includes(',')) {
			return value.split(',').map(id => id.trim()).filter(id => id !== '');
		}
	}
	// Single value
	return value.trim() ? [value.trim()] : [];
}

export default {
	// Selfbot options
	token: process.env.TOKEN || '',
	prefix: process.env.PREFIX || '',
	guildId: process.env.GUILD_ID ? process.env.GUILD_ID : '',
	cmdChannelId: process.env.COMMAND_CHANNEL_ID ? process.env.COMMAND_CHANNEL_ID : '',
	videoChannelId: process.env.VIDEO_CHANNEL_ID ? process.env.VIDEO_CHANNEL_ID : '',
	adminIds: process.env.ADMIN_IDS ? parseAdminIds(process.env.ADMIN_IDS) : [],

	// General options
	videosDir: process.env.VIDEOS_DIR ? process.env.VIDEOS_DIR : './videos',
	previewCacheDir: process.env.PREVIEW_CACHE_DIR ? process.env.PREVIEW_CACHE_DIR : './tmp/preview-cache',

	// yt-dlp options
	ytdlpCookiesPath: process.env.YTDLP_COOKIES_PATH ? process.env.YTDLP_COOKIES_PATH : '',

	// Stream options
	respect_video_params: process.env.STREAM_RESPECT_VIDEO_PARAMS ? parseBoolean(process.env.STREAM_RESPECT_VIDEO_PARAMS) : false,
	width: process.env.STREAM_WIDTH ? parseInt(process.env.STREAM_WIDTH) : 1920,
	height: process.env.STREAM_HEIGHT ? parseInt(process.env.STREAM_HEIGHT) : 1080,
	fps: process.env.STREAM_FPS ? parseInt(process.env.STREAM_FPS) : 30,
	bitrateKbps: process.env.STREAM_BITRATE_KBPS ? parseInt(process.env.STREAM_BITRATE_KBPS) : 2500,
	maxBitrateKbps: process.env.STREAM_MAX_BITRATE_KBPS ? parseInt(process.env.STREAM_MAX_BITRATE_KBPS) : 5000,
	hardwareAcceleratedDecoding: process.env.STREAM_HARDWARE_ACCELERATION ? parseBoolean(process.env.STREAM_HARDWARE_ACCELERATION) : false,
	h26xPreset: process.env.STREAM_H26X_PRESET ? parsePreset(process.env.STREAM_H26X_PRESET) : 'ultrafast',
	videoCodec: process.env.STREAM_VIDEO_CODEC ? parseVideoCodec(process.env.STREAM_VIDEO_CODEC) : 'H264',

	// STT options
	sttEnabled: process.env.STT_ENABLED ? parseBoolean(process.env.STT_ENABLED) : false,
	sttServerUrl: process.env.STT_SERVER_URL || 'http://localhost:8069',
	sttSilenceThresholdMs: process.env.STT_SILENCE_THRESHOLD_MS ? parseInt(process.env.STT_SILENCE_THRESHOLD_MS) : 1500,
	sttMinAudioMs: process.env.STT_MIN_AUDIO_MS ? parseInt(process.env.STT_MIN_AUDIO_MS) : 500,
	sttMaxAudioMs: process.env.STT_MAX_AUDIO_MS ? parseInt(process.env.STT_MAX_AUDIO_MS) : 30000,
	sttTextChannelId: process.env.STT_TEXT_CHANNEL_ID || '',

	// LLM options (OpenRouter)
	openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
	openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
	openrouterModel: process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite-preview',

	// Persistence options
	dbPath: process.env.DB_PATH || 'data/gatherr.db',

	// Plex options
	plexUrl: process.env.PLEX_URL || '',
	plexToken: process.env.PLEX_TOKEN || '',

	// Videos server options
	server_enabled: process.env.SERVER_ENABLED ? parseBoolean(process.env.SERVER_ENABLED) : false,
	server_username: process.env.SERVER_USERNAME ? process.env.SERVER_USERNAME : 'admin',
	server_password: process.env.SERVER_PASSWORD ? process.env.SERVER_PASSWORD : 'admin',
	server_port: parseInt(process.env.SERVER_PORT ? process.env.SERVER_PORT : '8080'),
}
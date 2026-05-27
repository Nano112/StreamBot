import { StreamProvider, ResolvedMedia, SearchResult } from './types.js';
import yts from 'play-dl';
import ytdl from '../../utils/yt-dlp.js';
import { Youtube } from '../../utils/youtube.js';
import { YTResponse } from '../../types/index.js';
import config from '../../config.js';
import logger from '../../utils/logger.js';

export class YouTubeProvider implements StreamProvider {
	readonly name = 'youtube';
	private youtube = new Youtube();

	canHandle(input: string): boolean {
		return input.includes('youtube.com/') || input.includes('youtu.be/');
	}

	async resolve(input: string): Promise<ResolvedMedia | null> {
		try {
			// Try play-dl first (native JS, ~2-5s) before falling back to yt-dlp (~15-30s)
			const result = await this.resolveWithPlayDl(input);
			if (result) return result;
		} catch (err) {
			logger.debug(`play-dl failed for ${input}, falling back to yt-dlp:`, err);
		}

		try {
			return await this.resolveWithYtDlp(input);
		} catch (error) {
			logger.error(`YouTube provider failed to resolve ${input}:`, error);
			return null;
		}
	}

	private async resolveWithPlayDl(input: string): Promise<ResolvedMedia | null> {
		const startTime = Date.now();
		const info = await yts.video_info(input);
		if (!info?.video_details) return null;

		const details = info.video_details;
		const isLive = details.live || false;
		const title = details.title || 'YouTube Video';
		const thumbnail = details.thumbnails?.[details.thumbnails.length - 1]?.url;

		if (isLive) {
			const liveUrl = await this.youtube.getLiveStreamUrl(input);
			if (!liveUrl) return null;
			logger.info(`play-dl resolved live "${title}" in ${Date.now() - startTime}ms`);
			return {
				streamUrl: liveUrl,
				title,
				provider: this.name,
				isLive: true,
				seekable: false,
				thumbnailUrl: thumbnail,
			};
		}

		// Extract CDN URL from format list
		const formats: any[] = (info as any).format || [];
		const maxH = config.height || 720;
		let bestUrl: string | null = null;

		// Prefer progressive formats (combined video+audio) — they work best with ffmpeg
		// Progressive mimeTypes contain both "video" codec info AND have audio
		for (const f of formats) {
			if (!f.url) continue;
			const mime = f.mimeType || '';
			const hasVideo = mime.includes('video');
			const hasAudio = f.audioBitrate || f.audioQuality || mime.includes('audio');
			if (hasVideo && hasAudio) {
				const h = parseInt(f.qualityLabel) || 9999;
				if (h <= maxH) { bestUrl = f.url; break; }
			}
		}

		// Fallback: any video format (might be DASH video-only)
		if (!bestUrl) {
			for (const f of formats) {
				if (f.url && (f.mimeType || '').includes('video')) {
					const h = parseInt(f.qualityLabel) || 9999;
					if (h <= maxH) { bestUrl = f.url; break; }
				}
			}
		}

		// Last resort: any format
		if (!bestUrl) {
			for (const f of formats) {
				if (f.url) { bestUrl = f.url; break; }
			}
		}

		// play-dl URLs often get 403 with ffmpeg (different auth context).
		// Use yt-dlp --get-url for a reliable stream URL (faster than --dump-single-json
		// since we already have the metadata from play-dl).
		logger.info(`play-dl: metadata for "${title}" in ${Date.now() - startTime}ms, getting stream URL via yt-dlp...`);

		const urlStart = Date.now();
		try {
			const streamUrl = await ytdl(input, {
				getUrl: true,
				format: `best[height<=${maxH}][ext=mp4]/best[height<=${maxH}]/best`,
				noPlaylist: true,
				quiet: true,
				noWarnings: true,
				noCheckCertificate: true,
			} as any);

			if (typeof streamUrl === 'string' && streamUrl.trim()) {
				logger.info(`yt-dlp --get-url in ${Date.now() - urlStart}ms`);
				return {
					streamUrl: streamUrl.trim().split('\n')[0], // first URL line
					title,
					provider: this.name,
					isLive: false,
					duration: details.durationInSec,
					seekable: true,
					thumbnailUrl: thumbnail,
				};
			}
		} catch (err) {
			logger.debug(`yt-dlp --get-url failed:`, err);
		}

		// Full fallback
		return this.resolveWithYtDlp(input, { title, duration: details.durationInSec, thumbnail });
	}

	private async resolveWithYtDlp(input: string, prefetchedMeta?: { title: string; duration?: number; thumbnail?: string }): Promise<ResolvedMedia | null> {
		const metadata = await ytdl(input, {
			dumpSingleJson: true,
			noPlaylist: true,
			format: `best[height<=${config.height || 720}][ext=mp4]/best[height<=${config.height || 720}]/best`,
			quiet: true,
			noWarnings: true,
			noCheckCertificate: true,
		} as any) as YTResponse;

		if (!metadata || !metadata.title) return null;

		const isLive = metadata.is_live === true || (metadata as any).live_status === 'is_live';

		if (isLive) {
			const liveUrl = await this.youtube.getLiveStreamUrl(input);
			if (!liveUrl) return null;
			return {
				streamUrl: liveUrl,
				title: prefetchedMeta?.title || metadata.title,
				provider: this.name,
				isLive: true,
				seekable: false,
				thumbnailUrl: prefetchedMeta?.thumbnail || metadata.thumbnail,
			};
		}

		const streamUrl = metadata.url || this.pickBestFormatUrl(metadata);
		if (!streamUrl) {
			logger.error(`YouTube: no stream URL found for ${input}`);
			return null;
		}

		return {
			streamUrl,
			title: prefetchedMeta?.title || metadata.title,
			provider: this.name,
			isLive: false,
			duration: prefetchedMeta?.duration || metadata.duration,
			seekable: true,
			thumbnailUrl: prefetchedMeta?.thumbnail || metadata.thumbnail,
		};
	}

	async search(query: string, limit: number = 5): Promise<SearchResult[]> {
		try {
			const result = await this.youtube.searchAndGetPageUrl(query);
			if (result.pageUrl && result.title) {
				return [{ title: result.title, url: result.pageUrl }];
			}
			return [];
		} catch (error) {
			logger.error('YouTube search failed:', error);
			return [];
		}
	}

	async searchFormatted(query: string, limit: number = 5): Promise<string[]> {
		return this.youtube.search(query, limit);
	}

	private pickBestFormatUrl(metadata: YTResponse): string | null {
		if (!metadata.formats || !Array.isArray(metadata.formats) || metadata.formats.length === 0) {
			return null;
		}

		const bestFormat = metadata.formats
			.filter(f => f.url && f.ext !== 'm3u8')
			.sort((a, b) => {
				const aScore = (a.vcodec && a.vcodec !== 'none' ? 1 : 0)
					+ (a.acodec && a.acodec !== 'none' ? 1 : 0)
					+ (a.height || 0) / 1000;
				const bScore = (b.vcodec && b.vcodec !== 'none' ? 1 : 0)
					+ (b.acodec && b.acodec !== 'none' ? 1 : 0)
					+ (b.height || 0) / 1000;
				return bScore - aScore;
			})[0];

		return bestFormat?.url || null;
	}
}

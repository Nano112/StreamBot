import { StreamProvider, ResolvedMedia } from './types.js';
import { GeneralUtils } from '../../utils/shared.js';
import ytdl from '../../utils/yt-dlp.js';
import { YTResponse } from '../../types/index.js';
import logger from '../../utils/logger.js';

export class DirectUrlProvider implements StreamProvider {
	readonly name = 'direct-url';

	canHandle(input: string): boolean {
		return GeneralUtils.isValidUrl(input);
	}

	async resolve(input: string): Promise<ResolvedMedia | null> {
		// Try yt-dlp metadata extraction first
		try {
			const metadata = await ytdl(input, {
				dumpJson: true,
				skipDownload: true,
				noWarnings: true,
				quiet: true,
			}) as YTResponse;

			if (metadata && metadata.title) {
				let streamUrl = input;
				if (metadata.formats && Array.isArray(metadata.formats) && metadata.formats.length > 0) {
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

					if (bestFormat?.url) {
						streamUrl = bestFormat.url;
					}
				}

				return {
					streamUrl,
					title: metadata.title,
					provider: this.name,
					isLive: metadata.is_live === true,
					duration: metadata.duration,
					seekable: !metadata.is_live,
				};
			}
		} catch (error) {
			logger.debug('yt-dlp failed for direct URL, using fallback:', input);
		}

		// Fallback: use the URL directly
		let title = 'Direct URL';
		try {
			const urlObj = new URL(input);
			const filename = urlObj.pathname.split('/').pop();
			if (filename && filename.includes('.')) {
				title = decodeURIComponent(filename.replace(/\.[^/.]+$/, ''));
			} else if (urlObj.pathname !== '/' && urlObj.pathname.length > 1) {
				const pathSegment = urlObj.pathname.split('/').pop();
				if (pathSegment) title = decodeURIComponent(pathSegment);
			}
		} catch {
			// ignore URL parse errors
		}

		return {
			streamUrl: input,
			title,
			provider: this.name,
			isLive: false,
			seekable: true,
		};
	}
}

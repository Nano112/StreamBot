import { getStream, getVod } from 'twitch-m3u8';
import { StreamProvider, ResolvedMedia } from './types.js';
import { TwitchStream } from '../../types/index.js';
import config from '../../config.js';
import logger from '../../utils/logger.js';

export class TwitchProvider implements StreamProvider {
	readonly name = 'twitch';

	canHandle(input: string): boolean {
		return input.includes('twitch.tv/');
	}

	async resolve(input: string): Promise<ResolvedMedia | null> {
		try {
			const streamUrl = await this.getStreamUrl(input);
			if (!streamUrl) return null;

			const twitchId = input.split('/').pop() || 'unknown';
			const isVod = input.includes('/videos/');

			return {
				streamUrl,
				title: isVod ? `Twitch VOD: ${twitchId}` : `twitch.tv/${twitchId}`,
				provider: this.name,
				isLive: !isVod,
				seekable: isVod,
			};
		} catch (error) {
			logger.error(`Twitch provider failed to resolve ${input}:`, error);
			return null;
		}
	}

	private async getStreamUrl(url: string): Promise<string | null> {
		try {
			if (url.includes('/videos/')) {
				const vodId = url.split('/videos/').pop() as string;
				const vodInfo = await getVod(vodId);
				const vod = vodInfo.find((s: TwitchStream) => s.resolution === `${config.width}x${config.height}`) || vodInfo[0];
				return vod?.url || null;
			} else {
				const twitchId = url.split('/').pop() as string;
				const streams = await getStream(twitchId);
				const stream = streams.find((s: TwitchStream) => s.resolution === `${config.width}x${config.height}`) || streams[0];
				return stream?.url || null;
			}
		} catch (error) {
			logger.error('Failed to get Twitch stream URL:', error);
			return null;
		}
	}
}

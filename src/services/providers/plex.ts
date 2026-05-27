import { StreamProvider, ResolvedMedia, SearchResult, BrowseResult, BrowseItem, AudioTrack } from './types.js';
import logger from '../../utils/logger.js';

export class PlexProvider implements StreamProvider {
	readonly name = 'plex';
	private getConfig: () => { baseUrl: string; token: string } | null;

	constructor(getConfig: () => { baseUrl: string; token: string } | null) {
		this.getConfig = getConfig;
	}

	private resolveConfig(): { baseUrl: string; token: string } | null {
		const cfg = this.getConfig();
		if (!cfg) return null;
		return { baseUrl: cfg.baseUrl.replace(/\/+$/, ''), token: cfg.token };
	}

	canHandle(input: string): boolean {
		return input.startsWith('plex:');
	}

	async resolve(input: string): Promise<ResolvedMedia | null> {
		const cfg = this.resolveConfig();
		if (!cfg) return null;
		const itemId = input.replace('plex:', '').trim();
		if (!itemId) return null;

		try {
			const metadata = await this.fetchMetadata(cfg, itemId);
			if (!metadata) return null;

			const media = metadata.Media?.[0];
			const part = media?.Part?.[0];
			if (!part) {
				logger.error(`Plex: no media part found for item ${itemId}`);
				return null;
			}

			const streamUrl = `${cfg.baseUrl}${part.key}?X-Plex-Token=${cfg.token}`;

			// Extract audio tracks from Plex stream metadata
			const audioTracks: AudioTrack[] = (part.Stream || [])
				.filter((s: any) => s.streamType === 2) // streamType 2 = audio
				.map((s: any, i: number) => ({
					index: i,
					language: s.language || s.displayTitle || 'Unknown',
					languageCode: s.languageCode || 'und',
					codec: s.codec || 'unknown',
					channels: s.channels || 2,
					title: s.displayTitle || s.title,
					selected: s.selected === true || s.selected === '1',
				}));

			return {
				streamUrl,
				title: metadata.title || `Plex Item ${itemId}`,
				provider: this.name,
				isLive: false,
				duration: metadata.duration ? metadata.duration / 1000 : undefined,
				seekable: true,
				thumbnailUrl: metadata.thumb ? `${cfg.baseUrl}${metadata.thumb}?X-Plex-Token=${cfg.token}` : undefined,
				audioTracks: audioTracks.length > 0 ? audioTracks : undefined,
			};
		} catch (error) {
			logger.error(`Plex: failed to resolve item ${itemId}:`, error);
			return null;
		}
	}

	async search(query: string, limit: number = 10): Promise<SearchResult[]> {
		const cfg = this.resolveConfig();
		if (!cfg) return [];
		try {
			// Search movies (1), shows (2), and episodes (4)
			const results: SearchResult[] = [];
			for (const type of [1, 2, 4]) {
				const url = `${cfg.baseUrl}/search?query=${encodeURIComponent(query)}&type=${type}&X-Plex-Token=${cfg.token}`;
				const response = await fetch(url, { headers: { Accept: 'application/json' } });
				if (!response.ok) continue;

				const data = await response.json() as any;
				const items = data?.MediaContainer?.Metadata || [];
				for (const item of items) {
					const isPlayable = item.type === 'movie' || item.type === 'episode';
					const title = item.type === 'episode'
						? `${item.grandparentTitle} — S${item.parentIndex}E${item.index} ${item.title}`
						: item.title;
					results.push({
						title,
						url: isPlayable ? `plex:${item.ratingKey}` : `plex-browse:${item.ratingKey}`,
						duration: item.duration ? item.duration / 1000 : undefined,
						thumbnailUrl: item.thumb ? `${cfg.baseUrl}${item.thumb}?X-Plex-Token=${cfg.token}` : undefined,
					});
				}
			}
			return results.slice(0, limit);
		} catch (error) {
			logger.error('Plex search failed:', error);
			return [];
		}
	}

	async browse(path?: string): Promise<BrowseResult> {
		const cfg = this.resolveConfig();
		if (!cfg) return { items: [], path: path || '/' };
		try {
			if (!path) {
				return await this.browseLibraries(cfg);
			}

			// Paths prefixed with "section:" are library sections (e.g., "section:2")
			// Plain numeric paths are metadata items (shows, seasons) — fetch children
			let url: string;
			if (path.startsWith('section:')) {
				const sectionKey = path.replace('section:', '');
				url = `${cfg.baseUrl}/library/sections/${sectionKey}/all?X-Plex-Token=${cfg.token}`;
			} else {
				// Metadata item — get children (seasons of a show, episodes of a season)
				url = `${cfg.baseUrl}/library/metadata/${path}/children?X-Plex-Token=${cfg.token}`;
			}

			const response = await fetch(url, {
				headers: { Accept: 'application/json' },
			});
			if (!response.ok) {
				return { items: [], path: path || '/' };
			}

			const data = await response.json() as any;
			const metadata = data?.MediaContainer?.Metadata || [];

			const items: BrowseItem[] = metadata.map((item: any) => ({
				id: item.ratingKey,
				title: item.type === 'episode'
					? `E${item.index} — ${item.title}`
					: item.title,
				type: item.type === 'movie' || item.type === 'episode' ? 'media' as const : 'folder' as const,
				duration: item.duration ? item.duration / 1000 : undefined,
				year: item.year,
				thumbnailUrl: item.thumb ? `${cfg.baseUrl}${item.thumb}?X-Plex-Token=${cfg.token}` : undefined,
			}));

			const containerTitle = data?.MediaContainer?.title2 || data?.MediaContainer?.title1 || data?.MediaContainer?.parentTitle || undefined;
			return { items, path, title: containerTitle };
		} catch (error) {
			logger.error('Plex browse failed:', error);
			return { items: [], path: path || '/' };
		}
	}

	private async browseLibraries(cfg: { baseUrl: string; token: string }): Promise<BrowseResult> {
		const url = `${cfg.baseUrl}/library/sections?X-Plex-Token=${cfg.token}`;
		const response = await fetch(url, {
			headers: { Accept: 'application/json' },
		});
		if (!response.ok) {
			return { items: [], path: '/' };
		}

		const data = await response.json() as any;
		const directories = data?.MediaContainer?.Directory || [];

		const items: BrowseItem[] = directories.map((dir: any) => ({
			id: `section:${dir.key}`,
			title: dir.title,
			type: 'library' as const,
		}));

		return { items, path: '/' };
	}

	private async fetchMetadata(cfg: { baseUrl: string; token: string }, itemId: string): Promise<any> {
		const url = `${cfg.baseUrl}/library/metadata/${itemId}?X-Plex-Token=${cfg.token}`;
		const response = await fetch(url, {
			headers: { Accept: 'application/json' },
		});
		if (!response.ok) return null;

		const data = await response.json() as any;
		return data?.MediaContainer?.Metadata?.[0] || null;
	}
}

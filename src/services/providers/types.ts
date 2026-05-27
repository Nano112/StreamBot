export interface StreamProvider {
	readonly name: string;
	canHandle(input: string): boolean;
	resolve(input: string): Promise<ResolvedMedia | null>;
	search?(query: string, limit?: number): Promise<SearchResult[]>;
	browse?(path?: string): Promise<BrowseResult>;
}

export interface AudioTrack {
	index: number;        // Stream index in the container
	language: string;     // e.g., "English", "French"
	languageCode: string; // e.g., "eng", "fra"
	codec: string;        // e.g., "aac", "ac3", "eac3"
	channels: number;     // e.g., 2, 6, 8
	title?: string;       // e.g., "Surround 5.1"
	selected?: boolean;   // Default track
}

export interface ResolvedMedia {
	streamUrl: string;
	title: string;
	provider: string;
	isLive: boolean;
	duration?: number;
	seekable: boolean;
	thumbnailUrl?: string;
	audioTracks?: AudioTrack[];
}

export interface SearchResult {
	title: string;
	url: string;
	duration?: number;
	thumbnailUrl?: string;
}

export interface BrowseResult {
	items: BrowseItem[];
	path: string;
	title?: string;
	parentPath?: string;
}

export interface BrowseItem {
	id: string;
	title: string;
	type: 'library' | 'folder' | 'media';
	duration?: number;
	year?: number;
	thumbnailUrl?: string;
}

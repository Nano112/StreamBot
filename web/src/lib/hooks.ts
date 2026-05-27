import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from './api';
import type { BotStatus, PlaybackInfo, PlexAuthStatus } from './types';

// ─── Queries ────────────────────────────────────────────────────────────────

export function usePlayback() {
	return useQuery<BotStatus>({
		queryKey: ['bot', 'status'],
		queryFn: () => api<BotStatus>('/api/bot/status'),
		refetchInterval: 1500,
		refetchIntervalInBackground: false,
	});
}

export function useBotStatus() {
	return useQuery<BotStatus>({
		queryKey: ['bot', 'status'],
		queryFn: () => api<BotStatus>('/api/bot/status'),
		refetchInterval: 5000,
		refetchIntervalInBackground: false,
	});
}

export function usePlaybackRaw() {
	return useQuery<PlaybackInfo>({
		queryKey: ['bot', 'playback-raw'],
		queryFn: () => api<PlaybackInfo>('/api/bot/playback'),
		refetchInterval: 5000,
		refetchIntervalInBackground: false,
	});
}

export function usePlexAuthStatus() {
	const { data } = useQuery<PlexAuthStatus>({
		queryKey: ['plex', 'auth', 'status'],
		queryFn: () => api<PlexAuthStatus>('/api/plex/auth/status'),
		refetchInterval: (query) => {
			const state = (query.state.data as PlexAuthStatus | undefined)?.state;
			return state === 'awaiting-pin' ? 2000 : false;
		},
	});
	return data;
}

export interface BrowseItem {
	id: string;
	title: string;
	type: 'library' | 'folder' | 'media';
	duration?: number;
	year?: number;
	thumbnailUrl?: string;
}

export interface BrowseResult {
	items: BrowseItem[];
	path?: string;
	title?: string;
}

export interface SearchResult {
	title: string;
	url: string;
	duration?: number;
	thumbnailUrl?: string;
}

export interface PlexSearchResult {
	results: SearchResult[];
}

export function usePlexBrowse(path?: string) {
	return useQuery<BrowseResult>({
		queryKey: ['plex', 'browse', path ?? ''],
		queryFn: () => {
			const url = path ? `/api/plex/browse?path=${encodeURIComponent(path)}` : '/api/plex/browse';
			return api<BrowseResult>(url);
		},
		enabled: true,
	});
}

export function usePlexSearch(query: string) {
	return useQuery<PlexSearchResult>({
		queryKey: ['plex', 'search', query],
		queryFn: () => api<PlexSearchResult>(`/api/plex/search?q=${encodeURIComponent(query)}`),
		enabled: query.length > 0,
	});
}

export function useBotSearch(query: string) {
	return useQuery<{ results: string[] }>({
		queryKey: ['bot', 'search', query],
		queryFn: () => api<{ results: string[] }>(`/api/bot/search?q=${encodeURIComponent(query)}`),
		enabled: query.length > 0,
	});
}

// ─── Mutations ───────────────────────────────────────────────────────────────

function makeToastMutation<TVariables = void>(
	mutationFn: (vars: TVariables) => Promise<unknown>,
	invalidateKeys: string[][],
	errorLabel: string,
) {
	// eslint-disable-next-line react-hooks/rules-of-hooks
	const qc = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: () => {
			invalidateKeys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
		},
		onError: (err: Error) => {
			toast.error(`${errorLabel}: ${err.message}`);
		},
	});
}

export function useSeek() {
	return makeToastMutation(
		(seconds: number) => api('/api/bot/seek', { method: 'POST', body: JSON.stringify({ seconds }) }),
		[['bot', 'status']],
		'Seek failed',
	);
}

export function usePause() {
	return makeToastMutation(
		() => api('/api/bot/pause', { method: 'POST' }),
		[['bot', 'status']],
		'Pause failed',
	);
}

export function useResume() {
	return makeToastMutation(
		() => api('/api/bot/resume', { method: 'POST' }),
		[['bot', 'status']],
		'Resume failed',
	);
}

export function useSkip() {
	return makeToastMutation(
		() => api('/api/bot/skip', { method: 'POST' }),
		[['bot', 'status']],
		'Skip failed',
	);
}

export function useStop() {
	return makeToastMutation(
		() => api('/api/bot/stop', { method: 'POST' }),
		[['bot', 'status']],
		'Stop failed',
	);
}

export function useQueueRemove() {
	return makeToastMutation(
		(id: string) => api(`/api/bot/queue/${encodeURIComponent(id)}`, { method: 'DELETE' }),
		[['bot', 'status']],
		'Remove failed',
	);
}

export function useAudioTrack() {
	return makeToastMutation(
		(index: number) => api('/api/bot/audio-track', { method: 'POST', body: JSON.stringify({ index }) }),
		[['bot', 'status']],
		'Audio track change failed',
	);
}

export function useStartPlexLogin() {
	return makeToastMutation(
		() => api('/api/plex/auth/start', { method: 'POST' }),
		[['plex', 'auth', 'status']],
		'Plex login failed',
	);
}

export function useCancelPlexLogin() {
	return makeToastMutation(
		() => api('/api/plex/auth/cancel', { method: 'POST' }),
		[['plex', 'auth', 'status']],
		'Cancel failed',
	);
}

export function useSelectPlexServer() {
	return makeToastMutation(
		({ id, connectionUri }: { id: string; connectionUri?: string }) =>
			api('/api/plex/auth/select-server', { method: 'POST', body: JSON.stringify({ id, connectionUri }) }),
		[['plex', 'auth', 'status']],
		'Server selection failed',
	);
}

export function usePlexLogout() {
	return makeToastMutation(
		() => api('/api/plex/auth/logout', { method: 'POST' }),
		[['plex', 'auth', 'status']],
		'Logout failed',
	);
}

export function usePlexQueueAdd() {
	return makeToastMutation(
		({ itemId }: { itemId: string }) =>
			api('/api/plex/queue', { method: 'POST', body: JSON.stringify({ itemId }) }),
		[['bot', 'status']],
		'Queue failed',
	);
}

export function useBotQueueAdd() {
	return makeToastMutation(
		({ url }: { url: string }) =>
			api('/api/bot/queue/add', { method: 'POST', body: JSON.stringify({ url }) }),
		[['bot', 'status']],
		'Queue failed',
	);
}

export function useBotPlay() {
	return makeToastMutation(
		({ url }: { url: string }) =>
			api('/api/bot/play', { method: 'POST', body: JSON.stringify({ url }) }),
		[['bot', 'status']],
		'Play failed',
	);
}

// ─── Library ─────────────────────────────────────────────────────────────────

export interface LibraryItem { name: string; size: number; modified: number }

export function useLibrary() {
	return useQuery<{ items: LibraryItem[] }>({
		queryKey: ['library'],
		queryFn: () => api<{ items: LibraryItem[] }>('/api/library'),
		refetchOnWindowFocus: true,
	});
}

export function useUploadFile() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (file: File) => {
			const fd = new FormData();
			fd.append('file', file);
			const r = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', body: fd });
			if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || String(r.status)); }
			return r.json();
		},
		onSuccess: () => { qc.invalidateQueries({ queryKey: ['library'] }); toast.success('File uploaded'); },
		onError: (e: Error) => toast.error(`Upload failed: ${e.message}`),
	});
}

export function useRemoteUpload() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (link: string) => {
			const fd = new FormData();
			fd.append('link', link);
			const r = await fetch('/api/remote_upload', { method: 'POST', credentials: 'same-origin', body: fd });
			if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || String(r.status)); }
			return r.json();
		},
		onSuccess: () => { qc.invalidateQueries({ queryKey: ['library'] }); toast.success('Remote download started'); },
		onError: (e: Error) => toast.error(`Remote upload failed: ${e.message}`),
	});
}

export function useDeleteFile() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (filename: string) => {
			const r = await fetch(`/delete/${encodeURIComponent(filename)}`, { credentials: 'same-origin', redirect: 'manual' });
			// The delete endpoint redirects on success — treat any non-500 as ok
			if (r.status >= 500) throw new Error(`Server error ${r.status}`);
		},
		onSuccess: () => { qc.invalidateQueries({ queryKey: ['library'] }); toast.success('File deleted'); },
		onError: (e: Error) => toast.error(`Delete failed: ${e.message}`),
	});
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export interface LogEntry { timestamp: string; level: string; message: string }

export function useLogs(enabled: boolean) {
	return useQuery<{ logs: LogEntry[]; total: number }>({
		queryKey: ['bot', 'logs'],
		queryFn: () => api<{ logs: LogEntry[]; total: number }>('/api/bot/logs'),
		refetchInterval: enabled ? 1500 : false,
		refetchIntervalInBackground: false,
		enabled,
	});
}

// ─── Voice channels ────────────────────────────────────────────────

export interface VoiceChannel {
	id: string;
	name: string;
	type: 'voice' | 'stage';
	categoryName: string | null;
	userCount: number;
	canConnect: boolean;
}

export interface VoiceGuild {
	id: string;
	name: string;
	iconUrl: string | null;
	channels: VoiceChannel[];
}

export interface VCHistoryEntry {
	guildId: string;
	guildName: string;
	guildIcon: string | null;
	channelId: string;
	channelName: string;
	lastUsed: string;
}

export function useVoiceChannels(enabled: boolean = true) {
	return useQuery<{ guilds: VoiceGuild[] }>({
		queryKey: ['bot', 'voice-channels'],
		queryFn: () => api<{ guilds: VoiceGuild[] }>('/api/bot/voice-channels'),
		enabled,
		staleTime: 30_000,
	});
}

export function useVCHistory(enabled: boolean = true) {
	return useQuery<{ entries: VCHistoryEntry[] }>({
		queryKey: ['bot', 'vc-history'],
		queryFn: () => api<{ entries: VCHistoryEntry[] }>('/api/bot/vc-history'),
		enabled,
		staleTime: 30_000,
	});
}

export function useVCHistoryRemove() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { guildId: string; channelId: string }) =>
			api('/api/bot/vc-history', { method: 'DELETE', body: JSON.stringify(v) }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['bot', 'vc-history'] }),
		onError: (e: Error) => toast.error(`Remove failed: ${e.message}`),
	});
}

export function useJoinChannel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (v: { guildId: string; channelId: string }) =>
			api('/api/bot/join', { method: 'POST', body: JSON.stringify(v) }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['bot', 'status'] });
			qc.invalidateQueries({ queryKey: ['bot', 'vc-history'] });
		},
		onError: (e: Error) => toast.error(`Join failed: ${e.message}`),
	});
}

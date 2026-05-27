import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Mic, RotateCw, Search, Volume2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
	useVoiceChannels,
	useVCHistory,
	useVCHistoryRemove,
	useJoinChannel,
	useBotStatus,
	type VoiceChannel,
	type VoiceGuild,
} from '@/lib/hooks';

interface Props {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}

export function VoiceChannelPicker({ open, onOpenChange }: Props) {
	const qc = useQueryClient();
	const [query, setQuery] = useState('');
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

	const channels = useVoiceChannels(open);
	const history = useVCHistory(open);
	const status = useBotStatus();
	const removeHistory = useVCHistoryRemove();
	const join = useJoinChannel();

	const current = status.data?.channelInfo;
	const isCurrent = (gid: string, cid: string) =>
		!!(current?.guildId === gid && current?.channelId === cid && status.data?.joined);

	async function doJoin(guildId: string, channelId: string) {
		try {
			await join.mutateAsync({ guildId, channelId });
			toast.success('Joined voice channel');
			onOpenChange(false);
		} catch {
			// toast already shown by hook
		}
	}

	const q = query.trim().toLowerCase();
	const filteredHistory = useMemo(() => {
		const entries = history.data?.entries ?? [];
		if (!q) return entries;
		return entries.filter(e =>
			e.guildName.toLowerCase().includes(q) || e.channelName.toLowerCase().includes(q)
		);
	}, [history.data, q]);

	const filteredGuilds = useMemo(() => {
		const guilds = channels.data?.guilds ?? [];
		if (!q) return guilds;
		return guilds
			.map<VoiceGuild>(g => ({
				...g,
				channels: g.channels.filter(c =>
					c.name.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)
				),
			}))
			.filter(g => g.channels.length > 0);
	}, [channels.data, q]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="bg-[color:var(--color-surface)] border-[color:var(--color-border)] max-w-lg p-0 overflow-hidden">
				<DialogHeader className="px-6 pt-5 pb-3 border-b border-[color:var(--color-border)]">
					<DialogTitle className="font-sans text-xs tracking-[0.18em] uppercase text-[color:var(--color-fg-muted)]">
						Join voice channel
					</DialogTitle>
				</DialogHeader>

				{/* Search */}
				<div className="px-6 pt-3 pb-2 border-b border-[color:var(--color-border)]">
					<div className="relative">
						<Search size={13} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-fg-dim)]" />
						<Input
							autoFocus
							placeholder="Filter guilds and channels…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							className="pl-9 font-mono-tight text-sm bg-[color:var(--color-surface-2)] border-[color:var(--color-border)] focus:border-[color:var(--color-border-strong)]"
						/>
					</div>
				</div>

				<ScrollArea className="max-h-[60vh]">
					<div className="px-6 py-4 space-y-5">
						{/* Recent */}
						{filteredHistory.length > 0 && (
							<section>
								<SectionLabel>Recent</SectionLabel>
								<div className="mt-2 space-y-1">
									{filteredHistory.map(e => (
										<HistoryRow
											key={`${e.guildId}-${e.channelId}`}
											entry={e}
											active={isCurrent(e.guildId, e.channelId)}
											pending={join.isPending}
											onJoin={() => doJoin(e.guildId, e.channelId)}
											onRemove={() => removeHistory.mutate({ guildId: e.guildId, channelId: e.channelId })}
										/>
									))}
								</div>
							</section>
						)}

						{/* All channels */}
						<section>
							<div className="flex items-center justify-between">
								<SectionLabel>All channels</SectionLabel>
								<button
									type="button"
									onClick={() => qc.invalidateQueries({ queryKey: ['bot', 'voice-channels'] })}
									className="text-[color:var(--color-fg-dim)] hover:text-[color:var(--color-fg-muted)] transition-colors cursor-pointer"
									aria-label="Refresh"
									title="Refresh"
								>
									<RotateCw size={11} strokeWidth={1.5} className={channels.isFetching ? 'animate-spin' : ''} />
								</button>
							</div>

							{channels.isLoading ? (
								<div className="mt-3 flex items-center gap-2 text-[color:var(--color-fg-dim)] font-mono-tight text-xs">
									<Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
									Loading channels…
								</div>
							) : filteredGuilds.length === 0 ? (
								<p className="mt-3 text-xs text-[color:var(--color-fg-dim)]">
									{q ? 'Nothing matched.' : 'Bot is not in any servers with voice channels.'}
								</p>
							) : (
								<div className="mt-2 space-y-3">
									{filteredGuilds.map(g => {
										const isOpen = !(collapsed[g.id] ?? false);
										return (
											<div key={g.id}>
												<button
													type="button"
													onClick={() => setCollapsed(c => ({ ...c, [g.id]: !(c[g.id] ?? false) }))}
													className="w-full flex items-center gap-2 group cursor-pointer"
												>
													{isOpen
														? <ChevronDown size={12} strokeWidth={1.5} className="text-[color:var(--color-fg-dim)]" />
														: <ChevronRight size={12} strokeWidth={1.5} className="text-[color:var(--color-fg-dim)]" />}
													{g.iconUrl ? (
														<img src={g.iconUrl} alt="" className="w-4 h-4 rounded-sm" />
													) : (
														<div className="w-4 h-4 rounded-sm bg-[color:var(--color-surface-2)] border border-[color:var(--color-border)]" />
													)}
													<span className="font-sans text-sm text-[color:var(--color-fg)] group-hover:text-[color:var(--color-accent)] transition-colors truncate">
														{g.name}
													</span>
													<span className="font-mono-tight text-[10px] text-[color:var(--color-fg-dim)]">
														{g.channels.length}
													</span>
												</button>
												{isOpen && (
													<div className="mt-1 pl-6 space-y-0.5">
														{g.channels.map(c => (
															<ChannelRow
																key={c.id}
																channel={c}
																active={isCurrent(g.id, c.id)}
																pending={join.isPending}
																onJoin={() => doJoin(g.id, c.id)}
															/>
														))}
													</div>
												)}
											</div>
										);
									})}
								</div>
							)}
						</section>
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<h3 className="text-[10px] tracking-[0.22em] uppercase text-[color:var(--color-fg-dim)]">
			{children}
		</h3>
	);
}

function HistoryRow({
	entry, active, pending, onJoin, onRemove,
}: {
	entry: { guildId: string; guildName: string; guildIcon: string | null; channelId: string; channelName: string; lastUsed: string };
	active: boolean;
	pending: boolean;
	onJoin: () => void;
	onRemove: () => void;
}) {
	return (
		<div
			className={[
				'group flex items-center gap-2 px-2 py-1.5 rounded-md border transition-colors',
				active
					? 'bg-[color:var(--color-accent)]/8 border-[color:var(--color-accent)]/40'
					: 'bg-[color:var(--color-surface-2)]/30 border-transparent hover:border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-2)]',
			].join(' ')}
		>
			{entry.guildIcon ? (
				<img src={entry.guildIcon} alt="" className="w-5 h-5 rounded-sm flex-shrink-0" />
			) : (
				<div className="w-5 h-5 rounded-sm bg-[color:var(--color-surface-2)] border border-[color:var(--color-border)] flex-shrink-0" />
			)}
			<button
				type="button"
				disabled={pending || active}
				onClick={onJoin}
				className="flex-1 min-w-0 text-left flex items-baseline gap-1.5 cursor-pointer disabled:cursor-default"
			>
				<span className="text-sm text-[color:var(--color-fg)] truncate">
					{entry.channelName}
				</span>
				<span className="font-mono-tight text-[10px] tracking-wide uppercase text-[color:var(--color-fg-dim)] truncate">
					{entry.guildName}
				</span>
			</button>
			{active ? (
				<span className="font-mono-tight text-[9px] tracking-[0.18em] uppercase text-[color:var(--color-accent)] flex-shrink-0 pr-1">
					In here
				</span>
			) : (
				<button
					type="button"
					onClick={onRemove}
					className="opacity-0 group-hover:opacity-100 text-[color:var(--color-fg-dim)] hover:text-[color:var(--color-danger)] transition-opacity cursor-pointer flex-shrink-0"
					aria-label="Remove from recent"
					title="Remove from recent"
				>
					<X size={12} strokeWidth={1.5} />
				</button>
			)}
		</div>
	);
}

function ChannelRow({
	channel, active, pending, onJoin,
}: {
	channel: VoiceChannel;
	active: boolean;
	pending: boolean;
	onJoin: () => void;
}) {
	const Icon = channel.type === 'stage' ? Mic : Volume2;
	const disabled = !channel.canConnect || pending || active;
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onJoin}
			className={[
				'w-full flex items-center gap-2 px-2 py-1 rounded-md text-left transition-colors',
				active
					? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-fg)]'
					: !channel.canConnect
						? 'text-[color:var(--color-fg-dim)] cursor-not-allowed'
						: 'text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)] cursor-pointer',
			].join(' ')}
			title={!channel.canConnect ? 'Missing CONNECT permission' : undefined}
		>
			<Icon size={12} strokeWidth={1.5} className="flex-shrink-0" />
			<span className="text-sm truncate flex-1">{channel.name}</span>
			{channel.categoryName && (
				<span className="font-mono-tight text-[10px] text-[color:var(--color-fg-dim)] uppercase tracking-wide truncate max-w-[120px]">
					{channel.categoryName}
				</span>
			)}
			{channel.userCount > 0 && (
				<span className="font-mono-tight text-[10px] text-[color:var(--color-fg-dim)] tabular-nums flex-shrink-0">
					{channel.userCount}
				</span>
			)}
			{active && (
				<span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-accent)] pulse-live flex-shrink-0" />
			)}
		</button>
	);
}

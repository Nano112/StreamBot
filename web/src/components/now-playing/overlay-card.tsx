import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Megaphone, Monitor } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

interface OverlayState {
	enabled: boolean;
	announcement: string;
}

const FRAME_REFRESH_MS = 500;
const PREVIEW_URL = '/debug/preview.jpg';   // real-time JPEG tapped from the GStreamer pipeline

export function OverlayCard() {
	const qc = useQueryClient();

	const { data } = useQuery<OverlayState>({
		queryKey: ['bot', 'overlay'],
		queryFn: () => api<OverlayState>('/api/bot/overlay'),
		refetchInterval: 5000,
	});

	const overlayMut = useMutation({
		mutationFn: (payload: Partial<OverlayState>) =>
			api<OverlayState>('/api/bot/overlay', { method: 'POST', body: JSON.stringify(payload) }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['bot', 'overlay'] }),
		onError: (e: Error) => toast.error(`Overlay update failed: ${e.message}`),
	});

	const enabled = data?.enabled ?? false;
	const remoteAnnouncement = data?.announcement ?? '';

	const [draft, setDraft] = useState(remoteAnnouncement);
	const draftDirtyRef = useRef(false);
	useEffect(() => {
		if (!draftDirtyRef.current) setDraft(remoteAnnouncement);
	}, [remoteAnnouncement]);

	const dirty = draft !== remoteAnnouncement;

	function commitAnnouncement(value: string) {
		const text = value.trim();
		overlayMut.mutate({ announcement: text }, {
			onSuccess: () => {
				draftDirtyRef.current = false;
				toast.success(text ? 'Announcement pinned' : 'Announcement cleared');
			},
		});
	}

	function handleClear() {
		setDraft('');
		draftDirtyRef.current = false;
		commitAnnouncement('');
	}

	return (
		<div className="bg-[color:var(--color-surface)] border border-[color:var(--color-border)] rounded-lg overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between px-5 py-3 border-b border-[color:var(--color-border)]">
				<div className="flex items-center gap-3">
					<Monitor size={14} strokeWidth={1.5} className="text-[color:var(--color-fg-muted)]" />
					<h3 className="font-display italic text-2xl leading-none">Stream monitor</h3>
				</div>
				<div className="flex items-center gap-3">
					<span className="text-[10px] tracking-[0.22em] uppercase text-[color:var(--color-fg-dim)]">Overlay</span>
					<Switch
						checked={enabled}
						onCheckedChange={(v) => overlayMut.mutate({ enabled: v })}
						disabled={overlayMut.isPending}
						aria-label="Toggle overlay"
					/>
					{enabled ? (
						<span className="inline-flex items-center gap-1.5 text-[10px] font-mono tracking-[0.22em] uppercase text-[color:var(--color-live)] w-16">
							<span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-live)] pulse-live" />
							ON AIR
						</span>
					) : (
						<span className="inline-flex items-center gap-1.5 text-[10px] font-mono tracking-[0.22em] uppercase text-[color:var(--color-fg-dim)] w-16">
							<span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-fg-dim)]" />
							HIDDEN
						</span>
					)}
				</div>
			</div>

			{/* Body */}
			<div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-0">
				{/* Live preview */}
				<div className="relative bg-[color:var(--color-bg)] border-b lg:border-b-0 lg:border-r border-[color:var(--color-border)]">
					<PreviewImage active={enabled} />
					<div className="absolute top-2 left-2 flex items-center gap-1.5 text-[9px] font-mono tracking-[0.22em] uppercase text-[color:var(--color-fg-dim)] bg-[color:var(--color-bg)]/80 backdrop-blur-sm rounded px-2 py-0.5 border border-[color:var(--color-border)]/50">
						<span className={`w-1 h-1 rounded-full ${enabled ? 'bg-[color:var(--color-live)] pulse-live' : 'bg-[color:var(--color-fg-dim)]'}`} />
						Live preview · {(1000 / FRAME_REFRESH_MS).toFixed(1)} fps
					</div>
				</div>

				{/* Controls */}
				<div className="p-5 space-y-5">
					<div>
						<Label
							htmlFor="overlay-announcement"
							className="flex items-center gap-2 text-[10px] tracking-[0.22em] uppercase text-[color:var(--color-fg-dim)] mb-2"
						>
							<Megaphone size={11} strokeWidth={1.5} />
							Announcement
						</Label>
						<Input
							id="overlay-announcement"
							value={draft}
							placeholder="Pin a message to the overlay…"
							maxLength={200}
							onChange={(e) => { setDraft(e.target.value); draftDirtyRef.current = true; }}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && dirty) {
									e.preventDefault();
									commitAnnouncement(draft);
								}
							}}
							className="font-mono text-sm bg-[color:var(--color-surface-2)] border-[color:var(--color-border)] focus-visible:ring-[color:var(--color-accent)]"
						/>
						<div className="flex items-center justify-between mt-2">
							<span className="text-[10px] font-mono text-[color:var(--color-fg-dim)] tabular-nums">
								{draft.length}/200
							</span>
							<div className="flex items-center gap-2">
								{remoteAnnouncement && (
									<Button
										variant="ghost"
										size="sm"
										onClick={handleClear}
										disabled={overlayMut.isPending}
										className="h-7 text-[10px] font-mono tracking-[0.18em] uppercase text-[color:var(--color-fg-dim)] hover:text-[color:var(--color-danger)] cursor-pointer"
									>
										Clear
									</Button>
								)}
								<Button
									size="sm"
									onClick={() => commitAnnouncement(draft)}
									disabled={!dirty || overlayMut.isPending}
									className={[
										'h-7 text-[10px] font-mono tracking-[0.18em] uppercase cursor-pointer',
										dirty
											? 'bg-[color:var(--color-accent)] text-[color:var(--color-bg)] hover:bg-[color:var(--color-accent)]/90'
											: 'bg-[color:var(--color-surface-2)] text-[color:var(--color-fg-dim)]',
									].join(' ')}
								>
									{overlayMut.isPending ? 'Pinning…' : dirty ? 'Pin' : 'Pinned'}
								</Button>
							</div>
						</div>
					</div>

					<div>
						<h4 className="text-[10px] tracking-[0.22em] uppercase text-[color:var(--color-fg-dim)] mb-2">
							What's rendered
						</h4>
						<ul className="space-y-1.5 text-xs">
							<RenderedLine label="State" value={enabled ? 'Active' : 'Hidden'} valueAccent={enabled} />
							<RenderedLine label="Title bar" value="Gatherr · HH:MM:SS · WxH@fps" mono />
							<RenderedLine label="Pinned" value={remoteAnnouncement || '(none)'} mono dim={!remoteAnnouncement} />
							<RenderedLine label="Footer" value="Status · Title · Position · Queue" mono />
						</ul>
					</div>

					<p className="text-[10px] text-[color:var(--color-fg-dim)] leading-relaxed">
						Preview shows the idle frame the bot streams when nothing is playing. During media, the compositor overlays this text on top of the video.
					</p>
				</div>
			</div>
		</div>
	);
}

function PreviewImage({ active }: { active: boolean }) {
	const [src, setSrc] = useState(`${PREVIEW_URL}?t=${Date.now()}`);
	const [waiting, setWaiting] = useState(true);

	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			if (cancelled) return;
			if (document.hidden) {
				timer = setTimeout(tick, FRAME_REFRESH_MS * 4);
				return;
			}
			setSrc(`${PREVIEW_URL}?t=${Date.now()}`);
			timer = setTimeout(tick, FRAME_REFRESH_MS);
		};
		timer = setTimeout(tick, FRAME_REFRESH_MS);
		return () => { cancelled = true; clearTimeout(timer); };
	}, []);

	return (
		<div className="relative aspect-video w-full bg-[color:var(--color-bg)]">
			{/* The img is always mounted; we just hide it under the placeholder
			    while it's pre-load or in an errored state. The retry loop above
			    keeps swapping `src`, so a transient 404 self-heals on the next
			    tick instead of locking us into a fallback. */}
			<img
				src={src}
				alt="Stream preview"
				className={[
					'absolute inset-0 w-full h-full object-contain transition-opacity duration-300',
					waiting ? 'opacity-0' : (active ? 'opacity-100' : 'opacity-50'),
				].join(' ')}
				onError={() => setWaiting(true)}
				onLoad={() => setWaiting(false)}
			/>
			{waiting && (
				<div className="absolute inset-0 flex items-center justify-center font-mono text-[10px] tracking-[0.22em] uppercase text-[color:var(--color-fg-dim)]">
					<span className="inline-flex items-center gap-2">
						<span className="w-1 h-1 rounded-full bg-[color:var(--color-fg-dim)] pulse-live" />
						Waiting for stream
					</span>
				</div>
			)}
		</div>
	);
}

function RenderedLine({
	label, value, mono = false, dim = false, valueAccent = false,
}: { label: string; value: string; mono?: boolean; dim?: boolean; valueAccent?: boolean }) {
	return (
		<li className="grid grid-cols-[80px_1fr] gap-2 items-baseline">
			<span className="text-[10px] tracking-[0.18em] uppercase text-[color:var(--color-fg-dim)]">{label}</span>
			<span
				className={[
					mono ? 'font-mono' : '',
					dim ? 'text-[color:var(--color-fg-dim)]' : valueAccent ? 'text-[color:var(--color-accent)]' : 'text-[color:var(--color-fg)]',
					'truncate',
				].join(' ')}
			>
				{value}
			</span>
		</li>
	);
}

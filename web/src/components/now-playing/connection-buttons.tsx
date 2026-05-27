import { useState } from 'react';
import { ChevronsUpDown, LogIn, LogOut, Plus } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import type { BotStatus } from '@/lib/types';
import { VoiceChannelPicker } from './voice-channel-picker';

interface ConnectionButtonsProps {
	status: BotStatus | undefined;
}

export function ConnectionButtons({ status }: ConnectionButtonsProps) {
	const qc = useQueryClient();
	const [inviteOpen, setInviteOpen] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [inviteCode, setInviteCode] = useState('');

	const invalidate = () => qc.invalidateQueries({ queryKey: ['bot', 'status'] });

	const leaveMut = useMutation({
		mutationFn: () => api('/api/bot/leave', { method: 'POST' }),
		onSuccess: () => { invalidate(); toast.success('Left voice channel'); },
		onError: (e: Error) => toast.error(`Leave failed: ${e.message}`),
	});

	const inviteMut = useMutation({
		mutationFn: (invite: string) =>
			api('/api/bot/invite', { method: 'POST', body: JSON.stringify({ invite }) }),
		onSuccess: (data: any) => {
			invalidate();
			toast.success(`Joined server: ${data.guildName || 'Unknown'}`);
			setInviteOpen(false);
			setInviteCode('');
		},
		onError: (e: Error) => toast.error(`Invite failed: ${e.message}`),
	});

	const joined = status?.joined ?? false;

	return (
		<>
			<div className="flex items-center gap-2">
				{joined ? (
					<>
						<Button
							variant="ghost"
							size="sm"
							className="gap-1.5 text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] cursor-pointer"
							onClick={() => setPickerOpen(true)}
						>
							<ChevronsUpDown size={14} strokeWidth={1.5} />
							<span className="text-xs tracking-wide">Switch</span>
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="gap-1.5 text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] cursor-pointer"
							onClick={() => leaveMut.mutate()}
							disabled={leaveMut.isPending}
						>
							<LogOut size={14} strokeWidth={1.5} />
							<span className="text-xs tracking-wide">Leave</span>
						</Button>
					</>
				) : (
					<Button
						size="sm"
						className="gap-1.5 bg-[color:var(--color-accent)] text-[color:var(--color-bg)] hover:bg-[color:var(--color-accent)]/90 cursor-pointer"
						onClick={() => setPickerOpen(true)}
					>
						<LogIn size={14} strokeWidth={1.5} />
						<span className="text-xs tracking-wide">Join VC</span>
					</Button>
				)}

				<Button
					variant="ghost"
					size="sm"
					className="gap-1.5 text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] cursor-pointer"
					onClick={() => setInviteOpen(true)}
				>
					<Plus size={14} strokeWidth={1.5} />
					<span className="text-xs tracking-wide">Invite</span>
				</Button>
			</div>

			<VoiceChannelPicker open={pickerOpen} onOpenChange={setPickerOpen} />

			<Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
				<DialogContent className="bg-[color:var(--color-surface)] border-[color:var(--color-border)] max-w-sm">
					<DialogHeader>
						<DialogTitle className="font-sans text-sm tracking-[0.18em] uppercase text-[color:var(--color-fg-muted)]">
							Join a new server
						</DialogTitle>
					</DialogHeader>
					<div className="space-y-4 pt-2">
						<div className="space-y-1.5">
							<Label className="text-[10px] tracking-[0.18em] uppercase text-[color:var(--color-fg-dim)]">
								Invite Link or Code
							</Label>
							<Input
								placeholder="discord.gg/abc123"
								value={inviteCode}
								onChange={(e) => setInviteCode(e.target.value)}
								className="font-mono text-sm"
								onKeyDown={(e) => {
									if (e.key === 'Enter' && inviteCode.trim()) {
										inviteMut.mutate(inviteCode.trim());
									}
								}}
							/>
							<p className="text-[10px] text-[color:var(--color-fg-dim)] pt-1">
								Use this only to join a brand-new server. To pick a voice channel in an existing server, use Join VC.
							</p>
						</div>
						<Button
							className="w-full bg-[color:var(--color-accent)] text-[color:var(--color-bg)] hover:bg-[color:var(--color-accent)]/90 cursor-pointer"
							onClick={() => inviteMut.mutate(inviteCode.trim())}
							disabled={!inviteCode.trim() || inviteMut.isPending}
						>
							{inviteMut.isPending ? 'Joining…' : 'Join Server'}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

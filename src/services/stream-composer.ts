import { spawn, ChildProcess, execSync } from 'child_process';
import { unlinkSync, createWriteStream, WriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Streamer, prepareStream, playStream } from '@dank074/discord-video-stream';
import config from '../config.js';
import logger from '../utils/logger.js';
import { FrameRenderer, Colors } from '../utils/frame-renderer.js';

/**
 * StreamComposer: GStreamer backend with prepareStream bridge.
 *
 * GStreamer → matroska → FIFO → prepareStream (re-encode to NUT) → playStream (ONCE)
 *
 * GStreamer handles: decode, textoverlay, H264 encode, buffering, seek, pause
 * prepareStream handles: NUT muxing (the only format playStream accepts)
 * playStream: called ONCE, reads NUT continuously
 *
 * Source switching happens inside GStreamer (pipeline swap).
 * The FIFO connection is continuous. Zero DAVE renegotiation.
 */
export class StreamComposer {
	private streamer: Streamer;
	private gstProc: ChildProcess | null = null;
	private prepareCmd: any = null;
	private playPromise: Promise<void> | null = null;
	private abortController: AbortController | null = null;
	private _running = false;
	private _mediaPlaying = false;
	private _paused = false;
	private currentUrl: string | null = null;
	private _position = 0;
	private _duration = 0;
	private fifoPath: string;
	private previewPath: string;
	private fifoKeepAlive: WriteStream | null = null;

	private renderer: FrameRenderer;
	private currentFrame: Buffer;
	private _idleInfo: IdleInfo = { status: 'Idle', queue: 0 };

	constructor(streamer: Streamer) {
		this.streamer = streamer;
		this.renderer = new FrameRenderer(config.width, config.height);
		this.currentFrame = this.renderIdleFrame(this._idleInfo);
		this.fifoPath = join(tmpdir(), `sb-gst-${process.pid}.mkv`);
		this.previewPath = join(tmpdir(), `sb-gst-preview-${process.pid}.jpg`);
		logger.info('Stream composer ready');
	}

	getPreviewPath(): string { return this.previewPath; }

	get running(): boolean { return this._running; }
	get mediaPlaying(): boolean { return this._mediaPlaying; }
	get paused(): boolean { return this._paused; }
	getCurrentFrame(): Buffer { return this.currentFrame; }
	getCurrentUrl(): string | null { return this.currentUrl; }
	getPosition(): number { return this._position; }
	getDuration(): number { return this._duration; }
	getPreviewProc(): ChildProcess | null { return null; }

	// ── Overlay ──────────────────────────────────────────────────────

	refreshOverlay(): void {
		const info = this._idleInfo;
		const lines: string[] = [];
		const now = new Date();
		const t = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

		// Announcement is pinned to the top of the overlay in every state.
		if (info.announcement?.trim()) {
			lines.push(`* ${info.announcement.trim()}`);
			lines.push('');
		}

		if (this._mediaPlaying || this._paused) {
			// During media: compact overlay in corner
			lines.push(`${info.status || 'Playing'}  ${t}`);
			if (info.title) {
				lines.push(info.title.length > 40 ? info.title.substring(0,38)+'..' : info.title);
			}
			if (info.position) lines.push(info.position);
			if (info.queue && info.queue > 1) lines.push(`Queue: ${info.queue - 1} more`);
		} else {
			// Idle: full overlay
			lines.push(`Gatherr  ${t}`);
			lines.push('');
			lines.push(`Queue (${info.queue || 0})`);
			if (info.queueItems?.length) {
				for (let i = 0; i < Math.min(info.queueItems.length, 8); i++) {
					const qi = info.queueItems[i];
					const icon = qi.state==='playing'?'>':qi.state==='paused'?'|':qi.state==='resolving'?'?':' ';
					lines.push(`${icon} ${qi.title.length>28?qi.title.substring(0,26)+'..':qi.title}`);
				}
			} else lines.push('  Empty');
		}

		// Active speakers
		if (info.speakers?.length) {
			lines.push('');
			lines.push(`Speaking: ${info.speakers.join(', ')}`);
		}
		if (info.wakeWordActive) {
			lines.push('>> LISTENING...');
		}
		if (info.lastTranscript) {
			const tr = info.lastTranscript.length > 45 ? info.lastTranscript.substring(0,43)+'..' : info.lastTranscript;
			lines.push(`"${tr}"`);
		}

		const text = lines.join('\n');
		this.sendCmd({ cmd: 'overlay', text });
	}

	clearOverlay(): void {
		this.sendCmd({ cmd: 'overlay', text: '' });
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this._running) return;
		this._running = true;
		this.abortController = new AbortController();

		// Create FIFO + clear any stale preview snapshot from a previous run
		try { unlinkSync(this.fifoPath); } catch {}
		try { unlinkSync(this.previewPath); } catch {}
		try { execSync(`mkfifo "${this.fifoPath}"`, { timeout: 5000 }); } catch (e) {
			logger.error('Failed to create FIFO:', e);
			this._running = false;
			return;
		}

		// Update GStreamer controller to write matroska to the FIFO file (not stdout)
		const gstScript = join(process.cwd(), 'scripts', 'gst-controller.py');
		const python = '/opt/homebrew/bin/python3';

		this.gstProc = spawn(python, [gstScript], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env,
				GST_WIDTH: String(config.width),
				GST_HEIGHT: String(config.height),
				GST_FPS: String(config.fps),
				GST_BITRATE: String(config.bitrateKbps),
				GST_FIFO_PATH: this.fifoPath,
				GST_PREVIEW_PATH: this.previewPath,
				GST_PLUGIN_SYSTEM_PATH: '/opt/homebrew/lib/gstreamer-1.0',
				DYLD_LIBRARY_PATH: '/opt/homebrew/lib',
			},
		});

		// Read logs from stdout (GStreamer controller prints JSON)
		let logBuf = '';
		this.gstProc.stdout?.on('data', (chunk: Buffer) => {
			logBuf += chunk.toString();
			const lines = logBuf.split('\n');
			logBuf = lines.pop() || '';
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.type === 'log') logger.info(`[gst] ${msg.message}`);
					else if (msg.type === 'status') this.handleGstStatus(msg);
					else if (msg.type === 'position') {
						this._position = msg.position || 0;
						this._duration = msg.duration || 0;
					}
				} catch { logger.debug(`[gst] ${line}`); }
			}
		});
		this.gstProc.stderr?.on('data', (d: Buffer) => {
			const m = d.toString().trim();
			if (m && !m.includes('GLib-GIRepository') && !m.includes('Class '))
				logger.debug(`[gst-stderr] ${m}`);
		});
		this.gstProc.on('exit', (code) => {
			if (this._running) logger.warn(`GStreamer exited: code=${code}`);
			this._running = false;
		});

		// Wait for GStreamer to start and open the FIFO for writing
		await new Promise(r => setTimeout(r, 2000));

		// Open a keepalive writer on the FIFO — prevents EOF when GStreamer swaps pipelines
		this.fifoKeepAlive = createWriteStream(this.fifoPath, { flags: 'a' });
		this.fifoKeepAlive.on('error', () => {});
		this.fifoKeepAlive.once('open', () => logger.info('FIFO keepalive connected'));

		logger.info('Starting prepareStream on FIFO...');

		// prepareStream reads MPEG-TS from FIFO → re-encodes to NUT (required for Discord compatibility)
		// noTranscoding doesn't work — Discord needs specific H264 bitstream formatting from the library
		const streamOpts: any = {
			width: config.width,
			height: config.height,
			frameRate: config.fps,
			bitrateVideo: config.bitrateKbps,
			bitrateVideoMax: config.maxBitrateKbps,
			videoCodec: 'H264',
			hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding,
			minimizeLatency: true,
			h26xPreset: config.h26xPreset,
		};

		const { command, output } = prepareStream(this.fifoPath, streamOpts, this.abortController.signal);
		this.prepareCmd = command;
		command.on('error', (err: any) => {
			if (this._running) logger.warn(`[prepareStream] error: ${err.message}`);
		});

		// Single playStream — reads NUT from prepareStream, sends to Discord
		this.playPromise = playStream(
			output, this.streamer,
			{ width: config.width, height: config.height, frameRate: config.fps },
			this.abortController.signal,
		).then(() => { if (this._running) logger.info('playStream ended'); })
		.catch(err => { if (this._running && !this.abortController?.signal.aborted) logger.error('playStream error:', err); });

		await new Promise(r => setTimeout(r, 3000));
		logger.info('Stream composer started — GStreamer → FIFO → prepareStream → Discord');
	}

	async stop(): Promise<void> {
		if (!this._running) return;
		this._running = false;
		this.sendCmd({ cmd: 'quit' });
		this.abortController?.abort();
		if (this.prepareCmd) { try { this.prepareCmd.kill('SIGTERM'); } catch {} this.prepareCmd = null; }
		if (this.gstProc) {
			await new Promise(r => setTimeout(r, 500));
			try { this.gstProc.kill('SIGTERM'); } catch {}
			this.gstProc = null;
		}
		try { this.streamer.stopStream(); } catch {}
		if (this.playPromise) { try { await this.playPromise; } catch {} this.playPromise = null; }
		if (this.fifoKeepAlive) { try { this.fifoKeepAlive.destroy(); } catch {} this.fifoKeepAlive = null; }
		try { unlinkSync(this.fifoPath); } catch {}
		logger.info('Stream composer stopped');
	}

	// ── GStreamer commands ────────────────────────────────────────────

	private sendCmd(cmd: Record<string, any>): void {
		if (this.gstProc?.stdin && !this.gstProc.stdin.destroyed) {
			this.gstProc.stdin.write(JSON.stringify(cmd) + '\n');
		}
	}

	setMediaSource(url: string, opts?: { seekPosition?: number }): void {
		this._mediaPlaying = true;
		this._paused = false;
		this.currentUrl = url;
		logger.info(`[source] media: ${url.substring(0,100)}...`);
		this.sendCmd({ cmd: 'play', url });
		if (opts?.seekPosition && opts.seekPosition > 0) {
			setTimeout(() => this.sendCmd({ cmd: 'seek', position: opts.seekPosition }), 1000);
		}
	}

	pauseMedia(): void {
		// GStreamer native pause + freeze prepareStream's ffmpeg for instant Discord freeze
		this.sendCmd({ cmd: 'pause' });
		this.freezePrepareStream();
		this._paused = true;
		this._mediaPlaying = false;
	}

	resumeMedia(): void {
		// Unfreeze prepareStream first, then resume GStreamer
		this.unfreezePrepareStream();
		this.sendCmd({ cmd: 'resume' });
		this._paused = false;
		this._mediaPlaying = true;
	}

	private freezePrepareStream(): void {
		// SIGSTOP any ffmpeg reading from our FIFO
		const basename = this.fifoPath.split('/').pop();
		try { execSync(`pkill -STOP -f "ffmpeg.*${basename}"`, { timeout: 2000 }); }
		catch {} // pkill returns non-zero if no match
	}

	private unfreezePrepareStream(): void {
		const basename = this.fifoPath.split('/').pop();
		try { execSync(`pkill -CONT -f "ffmpeg.*${basename}"`, { timeout: 2000 }); }
		catch {}
	}

	showIdle(): void {
		this.unfreezePrepareStream(); // Ensure it's running for idle content
		this.sendCmd({ cmd: 'idle' });
		this._mediaPlaying = false;
		this._paused = false;
		this.currentUrl = null;
	}

	seekTo(position: number): void {
		this.sendCmd({ cmd: 'seek', position });
	}

	setAudioTrack(index: number): void {
		logger.info(`[audio] Switching to track ${index}`);
		this.sendCmd({ cmd: 'audio_track', index });
	}

	waitForSourceEnd(): Promise<'finished' | 'aborted'> {
		return new Promise(resolve => {
			if (!this._mediaPlaying) { resolve('aborted'); return; }
			const handler = (msg: any) => {
				if (msg.state === 'eos' || msg.state === 'idle') resolve('finished');
			};
			this._statusHandlers.push(handler);
		});
	}

	private _statusHandlers: ((msg: any) => void)[] = [];
	private handleGstStatus(msg: any): void {
		if (msg.state === 'eos') { this._mediaPlaying = false; logger.info('Media ended (EOS)'); }
		else if (msg.state === 'idle') { this._mediaPlaying = false; this._paused = false; }
		for (const h of this._statusHandlers) h(msg);
		this._statusHandlers = [];
	}

	// ── Idle frame rendering (web preview) ───────────────────────────

	updateIdleInfo(info: IdleInfo): void {
		this._idleInfo = info;
		if (!this._mediaPlaying) this.currentFrame = this.renderIdleFrame(info);
	}

	private renderIdleFrame(info: IdleInfo): Buffer {
		const r = this.renderer, w = config.width, h = config.height;
		r.fill(Colors.bg[0], Colors.bg[1], Colors.bg[2]);
		r.rect(0,0,w,28,Colors.barBg[0],Colors.barBg[1],Colors.barBg[2]);
		r.text('Gatherr',12,8,Colors.blue,1);
		const now = new Date();
		const t = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
		r.text(`${info.status||'Idle'}  |  ${t}  |  ${w}x${h}@${config.fps}`,w-320,8,Colors.gray,1);
		if (info.announcement?.trim()) {
			const msg = info.announcement.trim();
			const truncated = msg.length > 80 ? msg.substring(0, 78) + '..' : msg;
			r.textCentered(`* ${truncated}`, 42, Colors.blue, 1);
		}
		if (info.title && info.status !== 'Idle') {
			const cy = Math.floor(h/2)-30;
			r.textCentered(info.title,cy,Colors.white,2);
			if (info.duration) r.textCentered(`Duration: ${info.duration}`,cy+28,Colors.blue,2);
		} else {
			r.textCentered('Gatherr',Math.floor(h/2)-30,Colors.blue,4);
			r.textCentered('Idle',Math.floor(h/2)+20,Colors.gray,2);
		}
		r.rect(0,h-3,w,3,Colors.blue[0],Colors.blue[1],Colors.blue[2]);
		return r.getBuffer();
	}
}

interface IdleInfo {
	status?: string; title?: string; queue?: number;
	position?: string; duration?: string; log?: string;
	queueItems?: { title: string; state: 'resolving'|'queued'|'playing'|'paused' }[];
	speakers?: string[];          // Currently speaking usernames
	lastTranscript?: string;      // Most recent transcription
	wakeWordActive?: boolean;     // Wake word was triggered
	announcement?: string;        // Pinned operator message
}

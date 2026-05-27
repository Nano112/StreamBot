import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getStreamingService } from '../../services/registry.js';
import { recordVC, getVCHistory, removeVCEntry } from '../../services/vc-history.js';
import config from '../../config.js';
import logger, { getLogBuffer } from '../../utils/logger.js';
import * as plexAuth from '../../services/plex-auth.js';

const router = Router();

// ── Debug: live frame preview ────────────────────────────────────

router.get('/debug/preview.jpg', (_req: Request, res: Response) => {
	const streaming = getStreamingService();
	const composer = streaming?.getComposer();
	if (!composer) { res.status(503).type('text/plain').send('Composer not running'); return; }
	const fs = require('fs') as typeof import('fs');
	const previewPath = composer.getPreviewPath?.() as string | undefined;
	if (!previewPath || !fs.existsSync(previewPath)) {
		res.status(404).type('text/plain').send('No preview yet');
		return;
	}
	try {
		const buf = fs.readFileSync(previewPath);
		res.setHeader('Content-Type', 'image/jpeg');
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.setHeader('Pragma', 'no-cache');
		res.send(buf);
	} catch (e: any) {
		res.status(500).type('text/plain').send(e.message || 'Read failed');
	}
});

router.get('/debug/frame.bmp', (req: Request, res: Response) => {
	const streaming = getStreamingService();
	const composer = streaming?.getComposer();
	if (!composer) { res.status(503).send('Not available'); return; }

	const rgb = composer.getCurrentFrame();
	const w = config.width;
	const h = config.height;
	const rowBytes = w * 3;
	const rowPadding = (4 - (rowBytes % 4)) % 4;
	const rowSize = rowBytes + rowPadding;
	const pixelDataSize = rowSize * h;
	const fileSize = 54 + pixelDataSize;
	const buf = Buffer.alloc(fileSize);

	// BMP header
	buf.write('BM', 0);
	buf.writeUInt32LE(fileSize, 2);
	buf.writeUInt32LE(54, 10);
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(w, 18);
	buf.writeInt32LE(h, 22); // positive = bottom-up
	buf.writeUInt16LE(1, 26);
	buf.writeUInt16LE(24, 28);
	buf.writeUInt32LE(pixelDataSize, 34);

	// Pixel data: BMP is bottom-up + BGR
	for (let y = 0; y < h; y++) {
		const srcRow = h - 1 - y;
		for (let x = 0; x < w; x++) {
			const srcOff = (srcRow * w + x) * 3;
			const dstOff = 54 + y * rowSize + x * 3;
			buf[dstOff] = rgb[srcOff + 2];     // B
			buf[dstOff + 1] = rgb[srcOff + 1]; // G
			buf[dstOff + 2] = rgb[srcOff];     // R
		}
	}

	res.setHeader('Content-Type', 'image/bmp');
	res.setHeader('Cache-Control', 'no-cache');
	res.send(buf);
});

router.get('/debug/preview', (req: Request, res: Response) => {
	res.setHeader('Content-Type', 'text/html');
	res.send(`<!DOCTYPE html>
<html><head><title>Gatherr Studio</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;height:100vh;display:grid;grid-template-columns:1fr 340px;grid-template-rows:auto 1fr auto;}
a{color:#58a6ff;}
/* Header */
.header{grid-column:1/-1;padding:8px 16px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:12px;}
.header h2{font-size:15px;font-weight:600;color:#58a6ff;}
.header .status{font-size:12px;padding:2px 8px;border-radius:10px;background:#238636;color:#fff;}
.header .status.off{background:#da3633;}
.header button{padding:3px 10px;border:1px solid #30363d;border-radius:4px;background:#21262d;color:#c9d1d9;cursor:pointer;font-size:12px;}
.header button:hover{background:#30363d;}
/* Canvas */
.canvas{background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;min-height:0;}
.canvas img{max-width:100%;max-height:100%;object-fit:contain;}
/* Sidebar */
.sidebar{background:#161b22;border-left:1px solid #30363d;display:flex;flex-direction:column;overflow:hidden;}
.panel{padding:10px 12px;border-bottom:1px solid #30363d;}
.panel h3{font-size:12px;text-transform:uppercase;color:#8b949e;margin-bottom:6px;letter-spacing:.5px;}
.panel input,.panel select{width:100%;padding:6px 8px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#e6edf3;font-size:13px;margin-bottom:6px;}
.panel input:focus{border-color:#58a6ff;outline:none;}
.btn-row{display:flex;gap:4px;flex-wrap:wrap;}
.btn{padding:5px 10px;border:1px solid #30363d;border-radius:4px;background:#21262d;color:#c9d1d9;cursor:pointer;font-size:12px;flex:1;text-align:center;}
.btn:hover{background:#30363d;border-color:#58a6ff;}
.btn.primary{background:#238636;border-color:#238636;color:#fff;}
.btn.primary:hover{background:#2ea043;}
.btn.danger{border-color:#da3633;color:#f85149;}
.btn.danger:hover{background:#da3633;color:#fff;}
/* Queue */
.queue{flex:1;overflow-y:auto;padding:0;}
.queue-item{padding:8px 12px;border-bottom:1px solid #21262d;display:flex;justify-content:space-between;align-items:center;font-size:12px;}
.queue-item .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.queue-item .badge{padding:1px 6px;border-radius:3px;background:#30363d;color:#8b949e;font-size:10px;margin-right:6px;}
.queue-item .remove{cursor:pointer;color:#8b949e;padding:2px 6px;border-radius:3px;}
.queue-item .remove:hover{background:#da3633;color:#fff;}
.queue-empty{padding:20px;text-align:center;color:#484f58;font-size:13px;}
/* Now Playing */
.now-playing{padding:8px 12px;background:#1c2128;border-bottom:1px solid #30363d;font-size:12px;}
.now-playing .track{color:#58a6ff;font-weight:600;}
.now-playing .time{color:#8b949e;margin-top:2px;}
.seek-row{display:flex;align-items:center;gap:6px;margin-top:4px;}
.seek-row input[type=range]{flex:1;accent-color:#58a6ff;}
/* Logs */
.logs{max-height:150px;overflow-y:auto;padding:6px 10px;font-family:'SF Mono',Menlo,monospace;font-size:11px;line-height:1.5;background:#0d1117;color:#8b949e;border-top:1px solid #30363d;}
.logs .err{color:#f85149;}.logs .warn{color:#d29922;}.logs .info{color:#3fb950;}
/* Footer */
.footer{grid-column:1/-1;padding:4px 16px;background:#161b22;border-top:1px solid #30363d;font-size:11px;color:#484f58;display:flex;justify-content:space-between;}
</style></head>
<body>
<div class="header">
	<h2>Gatherr Studio</h2>
	<span class="status off" id="discordStatus">Disconnected</span>
	<span class="status" id="streamStatus">Canvas Active</span>
	<div style="flex:1"></div>
	<button onclick="fetch('/debug/ffplay',{method:'POST'})">ffplay Window</button>
</div>

<div class="canvas">
	<img src="/debug/live" id="idlePreview">
	<video id="mediaPreview" autoplay controls style="display:none;width:100%;height:100%;object-fit:contain;background:#000;"></video>
</div>

<div class="sidebar">
	<!-- Add Media -->
	<div class="panel">
		<h3>Add Media</h3>
		<input id="urlInput" placeholder="YouTube URL, search, or direct link..." onkeydown="if(event.key==='Enter')addMedia()">
		<div class="btn-row">
			<button class="btn primary" onclick="addMedia()">Add & Play</button>
		</div>
	</div>

	<!-- Now Playing + Controls -->
	<div class="now-playing" id="npSection" style="display:none;">
		<div class="track" id="npTitle">-</div>
		<div class="time" id="npTime">0:00 / 0:00</div>
		<div class="seek-row">
			<input type="range" id="seekSlider" min="0" max="100" value="0"
				oninput="isSeeking=true" onchange="doSeek()">
		</div>
		<div class="btn-row" style="margin-top:6px;">
			<button class="btn" id="playPauseBtn" onclick="togglePlayPause()">Pause</button>
			<button class="btn" onclick="api('skip')">Skip</button>
			<button class="btn danger" onclick="api('stop')">Stop</button>
		</div>
	</div>
	<div id="idleControls">
		<div class="panel">
			<h3>Playback</h3>
			<div style="color:#484f58;font-size:12px;padding:4px 0;">Idle — add media above to start</div>
		</div>
	</div>

	<!-- Queue -->
	<div class="panel" style="padding-bottom:4px;">
		<h3>Queue <span id="queueCount" style="color:#58a6ff;">0</span></h3>
	</div>
	<div class="queue" id="queueList">
		<div class="queue-empty">Queue empty</div>
	</div>

	<!-- Logs -->
	<div class="panel" style="padding-bottom:0;">
		<h3>Logs</h3>
	</div>
	<div class="logs" id="logOutput"></div>
</div>

<div class="footer">
	<span id="footerInfo">Gatherr Studio — Canvas Preview</span>
	<span id="footerFps">-</span>
</div>

<script>
let logSince = 0;
let isSeeking = false;

async function api(action) {
	try { await fetch('/api/bot/' + action, { method: 'POST' }); } catch(e) {}
}

async function addMedia() {
	const input = document.getElementById('urlInput');
	const url = input.value.trim();
	if (!url) return;
	input.value = '';
	try {
		await fetch('/api/bot/queue/add', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url })
		});
	} catch(e) {}
}

function doSeek() {
	isSeeking = false;
	const s = parseFloat(document.getElementById('seekSlider').value);
	fetch('/api/bot/seek', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ seconds: s })
	});
}

function togglePlayPause() {
	const btn = document.getElementById('playPauseBtn');
	const isPaused = btn.textContent === 'Resume';
	api(isPaused ? 'resume' : 'pause');
}

function fmtTime(s) {
	if (!s || s < 0) return '0:00';
	const m = Math.floor(s / 60), sec = Math.floor(s % 60);
	return m + ':' + String(sec).padStart(2, '0');
}

async function poll() {
	try {
		const r = await fetch('/api/bot/status');
		if (!r.ok) return;
		const d = await r.json();

		document.getElementById('discordStatus').textContent = d.joined ? 'Connected' : 'Disconnected';
		document.getElementById('discordStatus').className = 'status' + (d.joined ? '' : ' off');

		const np = document.getElementById('npSection');
		const idle = document.getElementById('idleControls');
		if ((d.playing || d.paused) && d.currentTrack) {
			np.style.display = '';
			idle.style.display = 'none';
			document.getElementById('npTitle').textContent = d.currentTrack.title;

			const video = document.getElementById('mediaPreview');
			const videoTime = video && !video.paused && video.duration ? video.currentTime : null;
			const videoDur = video && video.duration && isFinite(video.duration) ? video.duration : null;
			const pb = d.playback || {};
			const pos = videoTime !== null ? videoTime : (pb.position || 0);
			const dur = videoDur !== null ? videoDur : (pb.duration || 0);

			document.getElementById('npTime').textContent = fmtTime(pos) + ' / ' + fmtTime(dur);
			if (!isSeeking && dur > 0) {
				const slider = document.getElementById('seekSlider');
				slider.max = dur;
				slider.value = pos;
			}

			// Update play/pause button
			const btn = document.getElementById('playPauseBtn');
			if (d.paused) {
				btn.textContent = 'Resume';
				btn.className = 'btn primary';
			} else {
				btn.textContent = 'Pause';
				btn.className = 'btn';
			}
		} else {
			np.style.display = 'none';
			idle.style.display = '';
		}

		const allItems = d.queue;
		const currentId = d.currentTrack?.id;
		document.getElementById('queueCount').textContent = allItems.length;
		const ql = document.getElementById('queueList');
		if (allItems.length === 0) {
			ql.innerHTML = '<div class="queue-empty">Queue empty — add a URL above</div>';
		} else {
			ql.innerHTML = allItems.map((item, i) => {
				const isCurrent = item.id === currentId;
				const resolving = item.type === 'resolving';
				const dur = item.duration ? fmtTime(item.duration) : '';
				const thumb = item.thumbnailUrl
					? '<img src="' + esc(item.thumbnailUrl) + '" style="width:48px;height:27px;object-fit:cover;border-radius:3px;margin-right:8px;flex-shrink:0;" onerror="this.style.display=\\'none\\'">'
					: '<div style="width:48px;height:27px;background:#21262d;border-radius:3px;margin-right:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#484f58;">' + (resolving ? '...' : '#') + '</div>';
				const stateLabel = isCurrent && d.playing ? '<span style="color:#3fb950;">&#9654; </span>'
					: isCurrent && d.paused ? '<span style="color:#d29922;">&#10074;&#10074; </span>'
					: resolving ? '<span style="color:#d29922;">&#8987; </span>'
					: '';
				const titleText = resolving ? esc(item.title).substring(0,50) : esc(item.title);
				const border = isCurrent ? 'border-left:3px solid #58a6ff;padding-left:9px;' : '';
				const bg = isCurrent ? 'background:#1c2128;' : '';
				return '<div class="queue-item" style="' + border + bg + '">' +
					thumb +
					'<div style="flex:1;min-width:0;">' +
						'<div class="title">' + stateLabel + titleText + '</div>' +
						'<div style="font-size:10px;color:#8b949e;">' +
							(dur ? dur + ' &middot; ' : '') +
							(isCurrent && d.playing ? 'Playing' : isCurrent && d.paused ? 'Paused' : resolving ? 'Resolving...' : esc(item.type)) +
							' &middot; ' + esc(item.requestedBy) +
						'</div>' +
					'</div>' +
					(isCurrent ? '' : '<span class="remove" onclick="rmQueue(\\'' + item.id + '\\')">&#x2715;</span>') +
				'</div>';
			}).join('');
		}
	} catch(e) {}
}

async function rmQueue(id) {
	await fetch('/api/bot/queue/' + encodeURIComponent(id), { method: 'DELETE' });
}

async function fetchLogs() {
	try {
		const r = await fetch('/api/bot/logs?since=' + logSince);
		if (!r.ok) return;
		const d = await r.json();
		if (!d.logs.length) return;
		const el = document.getElementById('logOutput');
		d.logs.forEach(e => {
			const cls = e.level.includes('error') ? 'err' : e.level.includes('warn') ? 'warn' : 'info';
			el.innerHTML += '<div class="' + cls + '">[' + esc(e.timestamp) + '] ' + esc(e.message) + '</div>';
		});
		logSince = d.total;
		while (el.children.length > 200) el.removeChild(el.firstChild);
		el.scrollTop = el.scrollHeight;
	} catch(e) {}
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

document.getElementById('seekSlider').addEventListener('mousedown', () => isSeeking = true);
document.getElementById('seekSlider').addEventListener('mouseup', () => isSeeking = false);

// Switch between idle <img> and media <video> based on playback state
let mediaActive = false;
function updatePreviewMode(playing, paused) {
	const idle = document.getElementById('idlePreview');
	const media = document.getElementById('mediaPreview');
	if ((playing || paused) && !mediaActive) {
		// Switch to video player
		media.src = '/debug/stream?' + Date.now();
		media.style.display = '';
		idle.style.display = 'none';
		mediaActive = true;
	} else if (!playing && !paused && mediaActive) {
		// Switch to idle
		media.pause();
		media.src = '';
		media.style.display = 'none';
		idle.style.display = '';
		mediaActive = false;
	}
}

// Hook into poll
const origPoll = poll;
poll = async function() {
	await origPoll();
	try {
		const r = await fetch('/api/bot/status');
		if (r.ok) {
			const d = await r.json();
			updatePreviewMode(d.playing, d.paused);
		}
	} catch(e) {}
};

setInterval(poll, 500);
setInterval(fetchLogs, 1500);
poll();
fetchLogs();
</script>
</body></html>`);
});

router.get('/debug/live', (req: Request, res: Response) => {
	const streaming = getStreamingService();
	const composer = streaming?.getComposer();
	if (!composer) { res.status(503).send('Not available'); return; }

	const w = config.width;
	const h = config.height;
	const boundary = 'gatherr-frame';

	res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${boundary}`);
	res.setHeader('Cache-Control', 'no-cache, no-store');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();

	const { spawn } = require('child_process');

	const sendJpeg = (data: Buffer) => {
		try {
			res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`);
			res.write(data);
			res.write('\r\n');
		} catch {}
	};

	// Parse MJPEG stream into individual JPEG frames
	let jpegBuf = Buffer.alloc(0);
	const parseMjpeg = (chunk: Buffer) => {
		jpegBuf = Buffer.concat([jpegBuf, chunk]);
		while (true) {
			const start = jpegBuf.indexOf(Buffer.from([0xFF, 0xD8]));
			if (start === -1) break;
			const end = jpegBuf.indexOf(Buffer.from([0xFF, 0xD9]), start + 2);
			if (end === -1) break;
			sendJpeg(jpegBuf.subarray(start, end + 2));
			jpegBuf = jpegBuf.subarray(end + 2);
		}
		if (jpegBuf.length > 512 * 1024) jpegBuf = Buffer.alloc(0);
	};

	// Idle encoder: always running, produces frames when no media
	const idleEncoder = spawn('ffmpeg', [
		'-hide_banner', '-loglevel', 'error',
		'-f', 'rawvideo', '-pix_fmt', 'rgb24',
		'-video_size', `${w}x${h}`, '-r', '10',
		'-i', 'pipe:0',
		'-f', 'mjpeg', '-q:v', '5', 'pipe:1',
	], { stdio: ['pipe', 'pipe', 'pipe'] });
	idleEncoder.stdin.on('error', () => {});

	// Idle encoder: always running, shows idle screen when not playing media
	idleEncoder.stdout.on('data', parseMjpeg);

	const idleInterval = setInterval(() => {
		if (idleEncoder?.stdin && !idleEncoder.stdin.destroyed) {
			idleEncoder.stdin.write(composer.getCurrentFrame());
		}
	}, 100);

	req.on('close', () => {
		clearInterval(idleInterval);
		try { idleEncoder.kill('SIGTERM'); } catch {}
	});
});

// Audio is now muxed in the WebM stream at /debug/stream

// Video proxy: forwards YouTube CDN URL through our server (avoids CORS)
// The browser's native <video> element handles all decoding, sync, pause, seek
router.get('/debug/stream', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	const composer = streaming?.getComposer();
	const url = composer?.getCurrentUrl();

	if (!url) { res.status(204).end(); return; }

	try {
		// Forward Range requests for seeking support
		const headers: Record<string, string> = {
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
		};
		if (req.headers.range) {
			headers['Range'] = req.headers.range;
		}

		const upstream = await fetch(url, { headers });

		// Forward status and relevant headers
		res.status(upstream.status);
		const fwd = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
		for (const h of fwd) {
			const v = upstream.headers.get(h);
			if (v) res.setHeader(h, v);
		}
		res.setHeader('Cache-Control', 'no-cache');

		// Pipe the body
		if (upstream.body) {
			const reader = upstream.body.getReader();
			const pump = async () => {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!res.write(value)) {
						await new Promise(r => res.once('drain', r));
					}
				}
				res.end();
			};
			pump().catch(() => res.end());
			req.on('close', () => { try { reader.cancel(); } catch {} });
		} else {
			res.end();
		}
	} catch (err: any) {
		logger.debug('Proxy error:', err.message);
		if (!res.headersSent) res.status(502).send('Proxy error');
	}
});

// Open a native ffplay window for full-fps preview
router.post('/debug/ffplay', (req: Request, res: Response) => {
	const streaming = getStreamingService();
	const composer = streaming?.getComposer();
	if (!composer) { res.status(503).send('Not available'); return; }

	const w = config.width;
	const h = config.height;
	const { spawn } = require('child_process');

	const ffplay = spawn('ffplay', [
		'-window_title', 'Gatherr Canvas Preview',
		'-f', 'rawvideo', '-pix_fmt', 'rgb24',
		'-video_size', `${w}x${h}`,
		'-framerate', String(config.fps),
		'-i', 'pipe:0',
	], { stdio: ['pipe', 'pipe', 'pipe'] });

	ffplay.stdin.on('error', () => {});
	ffplay.on('exit', () => { clearInterval(interval); });

	const interval = setInterval(() => {
		if (ffplay.stdin && !ffplay.stdin.destroyed) {
			ffplay.stdin.write(composer.getCurrentFrame());
		}
	}, 1000 / config.fps);

	res.json({ success: true, message: 'ffplay window opened' });
});

router.get('/api/bot/logs', (req: Request, res: Response) => {
	const since = parseInt(req.query.since as string) || 0;
	const logs = getLogBuffer();
	const newLogs = since > 0 ? logs.slice(since) : logs.slice(-100);
	res.json({ logs: newLogs, total: logs.length });
});

router.get('/api/bot/status', (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Streaming service not available' });
		return;
	}

	const status = streaming.getStreamStatus();
	const queueService = streaming.getQueueService();
	const queue = queueService.getQueue();
	const current = queueService.getCurrent();
	const playback = streaming.getPlaybackState();

	res.json({
		joined: status.joined,
		playing: status.playing,
		paused: status.paused,
		currentTrack: current ? {
			id: current.id,
			title: current.title,
			type: current.type,
			requestedBy: current.requestedBy,
			duration: current.duration,
			seekable: current.seekable,
			thumbnailUrl: current.thumbnailUrl,
		} : null,
		playback: {
			position: streaming.getComposer().getPosition(),
			duration: streaming.getComposer().getDuration(),
			paused: status.paused,
			seekable: true,
			audioTracks: playback.audioTracks || [],
		},
		queue: queue.map(item => ({
			id: item.id,
			title: item.title,
			type: item.type,
			resolved: item.resolved !== false,
			requestedBy: item.requestedBy,
			addedAt: item.addedAt,
			duration: item.duration,
			thumbnailUrl: item.thumbnailUrl,
		})),
		queueLength: queue.length
	});
});

router.get('/api/bot/playback', (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const playback = streaming.getPlaybackState();
	res.json(playback);
});

router.post('/api/bot/pause', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	try {
		const position = await streaming.pauseWeb();
		res.json({ success: true, position });
	} catch (error: any) {
		logger.error('Web pause error:', error);
		res.status(400).json({ error: error.message || 'Failed to pause' });
	}
});

router.post('/api/bot/resume', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	try {
		await streaming.resumeWeb();
		res.json({ success: true });
	} catch (error: any) {
		logger.error('Web resume error:', error);
		res.status(400).json({ error: error.message || 'Failed to resume' });
	}
});

router.post('/api/bot/seek', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const { seconds } = req.body;
	if (typeof seconds !== 'number' || seconds < 0) {
		res.status(400).json({ error: 'Invalid seconds value' });
		return;
	}

	try {
		const position = await streaming.seekWeb(seconds);
		res.json({ success: true, position });
	} catch (error: any) {
		logger.error('Web seek error:', error);
		res.status(400).json({ error: error.message || 'Failed to seek' });
	}
});

router.post('/api/bot/overlay', (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const { enabled, announcement, widgets } = req.body;
	if (typeof enabled === 'boolean') {
		streaming.setOverlayEnabled(enabled);
	}
	if (typeof announcement === 'string') {
		streaming.setOverlayAnnouncement(announcement);
	}
	if (widgets && typeof widgets === 'object') {
		for (const name of ['announce', 'brand', 'nowplay', 'queue'] as const) {
			if (typeof widgets[name] === 'boolean') {
				streaming.setOverlayWidgetEnabled(name, widgets[name]);
			}
		}
	}

	res.json({
		success: true,
		enabled: streaming.isOverlayEnabled(),
		announcement: streaming.getOverlayAnnouncement(),
		widgets: streaming.getOverlayWidgets(),
	});
});

router.get('/api/bot/overlay', (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	res.json({
		enabled: streaming.isOverlayEnabled(),
		announcement: streaming.getOverlayAnnouncement(),
		widgets: streaming.getOverlayWidgets(),
	});
});

router.post('/api/bot/join', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const guildId = (req.body?.guildId as string) || config.guildId;
	const channelId = (req.body?.channelId as string) || config.videoChannelId;

	if (!guildId || !channelId) {
		res.status(400).json({ error: 'Guild ID and Channel ID are required' });
		return;
	}

	try {
		const streamer = streaming.getStreamer();

		try {
			streamer.leaveVoice();
			logger.info(`Web join: cleaned up stale voice state`);
		} catch (_) {}
		await new Promise(resolve => setTimeout(resolve, 500));

		const client = streamer.client;
		const guild = client.guilds.cache.get(guildId);
		if (!guild) {
			logger.error(`Web join: guild ${guildId} not found in cache. Available guilds: ${client.guilds.cache.map((g: any) => `${g.name} (${g.id})`).join(', ')}`);
			res.status(400).json({ error: `Bot is not in server ${guildId}. Available servers listed in logs.` });
			return;
		}

		const channel = guild.channels.cache.get(channelId);
		if (!channel) {
			logger.error(`Web join: channel ${channelId} not found in guild ${guild.name}. Voice channels: ${guild.channels.cache.filter((c: any) => c.type === 'GUILD_VOICE' || c.type === 'GUILD_STAGE_VOICE').map((c: any) => `${c.name} (${c.id})`).join(', ')}`);
			res.status(400).json({ error: `Channel ${channelId} not found. Check logs for available voice channels.` });
			return;
		}

		try {
			await guild.fetch();
			logger.info(`Web join: fetched guild data for ${guild.name}`);
		} catch (e: any) {
			logger.warn(`Web join: guild fetch warning: ${e.message}`);
		}

		const me = guild.members.cache.get(client.user?.id || '');
		if (me) {
			const perms = channel.permissionsFor?.(me);
			if (perms) {
				const canConnect = perms.has('CONNECT');
				const canSpeak = perms.has('SPEAK');
				logger.info(`Web join: permissions - CONNECT=${canConnect}, SPEAK=${canSpeak}`);
				if (!canConnect) {
					res.status(403).json({ error: 'Bot lacks CONNECT permission for this channel' });
					return;
				}
			}
		} else {
			logger.warn(`Web join: could not find bot member in guild cache`);
		}

		logger.info(`Web join: guild=${guild.name}, channel=${channel.name} (type=${channel.type}), attempting join...`);

		const voiceDebug = (packet: any) => {
			if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE') {
				logger.info(`Web join: received gateway event ${packet.t}`);
			}
		};
		client.on('raw', voiceDebug);

		// TODO: STT patchStreamer breaks voice join (identify video:false causes timeout)
		// streaming.getSTTService().patchStreamer(streamer);
		const joinPromise = streamer.joinVoice(guildId, channelId);
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error('Join timed out after 15 seconds')), 15000)
		);

		try {
			await Promise.race([joinPromise, timeoutPromise]);
		} finally {
			client.removeListener('raw', voiceDebug);
		}

		logger.info(`Web join: successfully joined voice channel`);

		// Explicitly undeafen after join — the library defaults to self_deaf:true
		streamer.sendOpcode(4, {
			guild_id: guildId,
			channel_id: channelId,
			self_mute: false,
			self_deaf: false,
			self_video: false,
		});
		logger.info('Web join: sent self_deaf=false');

		// Record in VC history for quick re-join
		const guildIconHash = guild.icon;
		const guildIconUrl = guildIconHash
			? `https://cdn.discordapp.com/icons/${guildId}/${guildIconHash}.png?size=64`
			: null;
		recordVC({
			guildId,
			guildName: guild.name,
			guildIcon: guildIconUrl,
			channelId,
			channelName: (channel as any).name || channelId,
		});

		const status = streaming.getStreamStatus();
		status.joined = true;
		status.channelInfo = { guildId, channelId, cmdChannelId: config.cmdChannelId };

		// Start the stream composer (idle screen) immediately on join
		try {
			await streaming.startComposer();
		} catch (err: any) {
			logger.warn(`Failed to start composer after join: ${err.message || err}`);
		}

		res.json({ success: true, guildId, channelId });
	} catch (error: any) {
		logger.error(`Web join error: ${error.message || error}`);
		try { streaming.getStreamer().leaveVoice(); } catch (_) {}
		const status = streaming.getStreamStatus();
		status.joined = false;
		res.status(500).json({ error: error.message || 'Failed to join' });
	}
});

router.get('/api/bot/vc-history', (req: Request, res: Response) => {
	res.json({ entries: getVCHistory() });
});

router.get('/api/bot/voice-channels', (_req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) { res.status(503).json({ error: 'Service not available' }); return; }
	const client = streaming.getStreamer().client;
	const me = client.user?.id;

	const guilds = Array.from(client.guilds.cache.values()).map((g: any) => {
		const iconHash = g.icon;
		const iconUrl = iconHash
			? `https://cdn.discordapp.com/icons/${g.id}/${iconHash}.png?size=64`
			: null;
		const channels = Array.from(g.channels.cache.values())
			.filter((c: any) => c.type === 'GUILD_VOICE' || c.type === 'GUILD_STAGE_VOICE')
			.map((c: any) => {
				const parent = c.parent;
				const member = me ? g.members.cache.get(me) : null;
				const perms = (member && c.permissionsFor) ? c.permissionsFor(member) : null;
				return {
					id: c.id,
					name: c.name,
					type: c.type === 'GUILD_STAGE_VOICE' ? 'stage' : 'voice',
					categoryName: parent?.name || null,
					userCount: c.members?.size ?? 0,
					canConnect: perms ? perms.has('CONNECT') : true,
				};
			})
			.sort((a: any, b: any) => {
				if (a.categoryName !== b.categoryName) {
					return (a.categoryName || '').localeCompare(b.categoryName || '');
				}
				return a.name.localeCompare(b.name);
			});
		return { id: g.id, name: g.name, iconUrl, channels };
	}).sort((a, b) => a.name.localeCompare(b.name));

	res.json({ guilds });
});

router.delete('/api/bot/vc-history', (req: Request, res: Response) => {
	const { guildId, channelId } = req.body || {};
	if (guildId && channelId) {
		removeVCEntry(guildId, channelId);
	}
	res.json({ success: true, entries: getVCHistory() });
});

router.post('/api/bot/leave', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	try {
		await streaming.stopAndClearQueue();
		await streaming.getComposer().stop();
		streaming.getStreamer().leaveVoice();
		res.json({ success: true });
	} catch (error: any) {
		logger.error('Web leave error:', error);
		res.status(500).json({ error: error.message || 'Failed to leave' });
	}
});

router.post('/api/bot/invite', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const { invite } = req.body;
	if (!invite || typeof invite !== 'string') {
		res.status(400).json({ error: 'Invite link or code is required' });
		return;
	}

	const code = invite.trim()
		.replace(/^https?:\/\/(www\.)?discord\.(gg|com\/invite)\//i, '')
		.replace(/\/$/, '');

	if (!code) {
		res.status(400).json({ error: 'Invalid invite link' });
		return;
	}

	try {
		const client = streaming.getStreamer().client;
		const accepted = await (client as any).acceptInvite(code);
		const guildName = accepted?.guild?.name || accepted?.name || 'Unknown';
		const guildId = accepted?.guild?.id || accepted?.id || '';
		logger.info(`Joined server via invite: ${guildName} (${guildId})`);
		res.json({ success: true, guildName, guildId });
	} catch (error: any) {
		logger.error('Web invite error:', error);
		res.status(500).json({ error: error.message || 'Failed to accept invite' });
	}
});

router.post('/api/bot/queue/add', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const { url } = req.body;
	if (!url || typeof url !== 'string') {
		res.status(400).json({ error: 'URL or search query is required' });
		return;
	}

	try {
		const shouldAutoPlay = !streaming.getStreamStatus().playing && !streaming.getStreamStatus().paused;
		const item = await streaming.addToQueueWeb(url.trim(), 'Web', shouldAutoPlay);

		res.json({
			success: true,
			item: { id: item.id, title: item.title, type: item.type },
			autoPlaying: shouldAutoPlay
		});
	} catch (error: any) {
		logger.error('Web queue add error:', error);
		res.status(500).json({ error: error.message || 'Failed to add to queue' });
	}
});

router.post('/api/bot/play', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	try {
		const { url } = req.body;

		if (url && typeof url === 'string') {
			await streaming.addToQueueWeb(url.trim());
		}

		const title = await streaming.playFromQueueWeb();
		res.json({ success: true, title });
	} catch (error: any) {
		logger.error('Web play error:', error);
		res.status(500).json({ error: error.message || 'Failed to play' });
	}
});

router.post('/api/bot/skip', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	try {
		const nextTitle = await streaming.skipCurrentWeb();
		res.json({ success: true, nextTitle });
	} catch (error: any) {
		logger.error('Web skip error:', error);
		res.status(500).json({ error: error.message || 'Failed to skip' });
	}
});

router.post('/api/bot/stop', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	try {
		await streaming.stopAndClearQueue();
		res.json({ success: true });
	} catch (error: any) {
		logger.error('Web stop error:', error);
		res.status(500).json({ error: error.message || 'Failed to stop' });
	}
});

router.delete('/api/bot/queue/:id', (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const id = req.params.id as string;
	const removed = streaming.getQueueService().removeFromQueue(id);

	if (removed) {
		res.json({ success: true });
	} else {
		res.status(404).json({ error: 'Item not found in queue' });
	}
});

router.post('/api/bot/queue/clear', (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	streaming.getQueueService().clearQueue();
	res.json({ success: true });
});

router.get('/api/bot/search', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const query = req.query.q as string;
	if (!query) {
		res.status(400).json({ error: 'Query parameter q is required' });
		return;
	}

	try {
		const provider = streaming.getProviderManager().getProvider('youtube');
		let results: string[] = [];
		if (provider && 'searchFormatted' in provider) {
			results = await (provider as any).searchFormatted(query, 5);
		}
		res.json({ results });
	} catch (error: any) {
		logger.error('Web search error:', error);
		res.status(500).json({ error: error.message || 'Search failed' });
	}
});

// --- Audio track endpoints ---

router.post('/api/bot/audio-track', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const { index } = req.body;
	if (typeof index !== 'number' || index < 0) {
		res.status(400).json({ error: 'Invalid track index' });
		return;
	}

	try {
		streaming.setAudioTrack(index);
		res.json({ success: true, index });
	} catch (error: any) {
		res.status(400).json({ error: error.message || 'Failed to switch audio track' });
	}
});

// --- Plex auth endpoints ---

router.get('/api/plex/auth/status', (_req: Request, res: Response) => {
	res.json(plexAuth.getStatus());
});

router.post('/api/plex/auth/start', async (_req: Request, res: Response) => {
	const status = plexAuth.getStatus();
	if (status.state === 'ready') {
		res.status(409).json({ error: 'Already signed in' });
		return;
	}
	try {
		const { code, expiresAt } = await plexAuth.startLogin();
		res.json({ code, expiresAt });
	} catch (err: any) {
		logger.error('Plex auth start failed:', err);
		res.status(502).json({ error: err.message || 'Failed to start login' });
	}
});

router.post('/api/plex/auth/cancel', (_req: Request, res: Response) => {
	const status = plexAuth.getStatus();
	if (status.state !== 'awaiting-pin') {
		res.status(409).json({ error: 'No pending PIN' });
		return;
	}
	plexAuth.cancelLogin();
	res.json({ ok: true });
});

router.post('/api/plex/auth/select-server', async (req: Request, res: Response) => {
	const { id, connectionUri } = req.body || {};
	if (!id || typeof id !== 'string') {
		res.status(400).json({ error: 'id is required' });
		return;
	}
	try {
		await plexAuth.selectServer(id, typeof connectionUri === 'string' ? connectionUri : undefined);
		res.json({ ok: true });
	} catch (err: any) {
		if (err.code === 'unknown-server' || err.code === 'unknown-connection') {
			res.status(400).json({ error: err.message });
			return;
		}
		if (err.code === 'unreachable' || err.code === 'no-connection') {
			res.status(502).json({ error: err.message, uri: err.uri });
			return;
		}
		logger.error('Plex auth select-server failed:', err);
		res.status(500).json({ error: err.message || 'Failed to select server' });
	}
});

router.post('/api/plex/auth/logout', (_req: Request, res: Response) => {
	plexAuth.logout();
	res.json({ ok: true });
});

// --- Plex endpoints ---

router.get('/api/plex/browse', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const providerManager = streaming.getProviderManager();
	const plexProvider = providerManager.getProvider('plex');
	if (!plexProvider) {
		res.status(404).json({ error: 'Plex not configured' });
		return;
	}

	const path = req.query.path as string | undefined;
	try {
		const result = await providerManager.browse('plex', path);
		res.json(result || { items: [], path: path || '/' });
	} catch (error: any) {
		logger.error('Plex browse error:', error);
		res.status(500).json({ error: error.message || 'Browse failed' });
	}
});

router.get('/api/plex/search', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const plexProvider = streaming.getProviderManager().getProvider('plex');
	if (!plexProvider) {
		res.status(404).json({ error: 'Plex not configured' });
		return;
	}

	const query = req.query.q as string;
	if (!query) {
		res.status(400).json({ error: 'Query parameter q is required' });
		return;
	}

	try {
		const results = await plexProvider.search!(query);
		res.json({ results });
	} catch (error: any) {
		logger.error('Plex search error:', error);
		res.status(500).json({ error: error.message || 'Search failed' });
	}
});

router.post('/api/plex/queue', async (req: Request, res: Response) => {
	const streaming = getStreamingService();
	if (!streaming) {
		res.status(503).json({ error: 'Service not available' });
		return;
	}

	const plexProvider = streaming.getProviderManager().getProvider('plex');
	if (!plexProvider) {
		res.status(404).json({ error: 'Plex not configured' });
		return;
	}

	const { itemId } = req.body;
	if (!itemId) {
		res.status(400).json({ error: 'itemId is required' });
		return;
	}

	try {
		const item = await streaming.addToQueueWeb(`plex:${itemId}`);

		let autoPlaying = false;
		if (!streaming.getStreamStatus().playing && !streaming.getStreamStatus().paused) {
			try {
				await streaming.playFromQueueWeb();
				autoPlaying = true;
			} catch (_) {}
		}

		res.json({ success: true, item: { id: item.id, title: item.title }, autoPlaying });
	} catch (error: any) {
		logger.error('Plex queue error:', error);
		res.status(500).json({ error: error.message || 'Failed to queue' });
	}
});

// --- Library endpoint ---

router.get('/api/library', (_req: Request, res: Response) => {
	try {
		const videosDir = config.videosDir;
		if (!fs.existsSync(videosDir)) { res.json({ items: [] }); return; }
		const entries = fs.readdirSync(videosDir, { withFileTypes: true })
			.filter(e => e.isFile())
			.map(e => {
				const p = path.join(videosDir, e.name);
				const stat = fs.statSync(p);
				return { name: e.name, size: stat.size, modified: stat.mtimeMs };
			})
			.sort((a, b) => b.modified - a.modified);
		res.json({ items: entries });
	} catch (e: any) {
		res.status(500).json({ error: e.message });
	}
});

export default router;

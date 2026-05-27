import { Client, TextChannel } from "discord.js-selfbot-v13";
import { Streamer } from "@dank074/discord-video-stream";
import OpusScript from "opusscript";
import dgram from "node:dgram";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import config from "../config.js";
import logger from "../utils/logger.js";
import type { LLMService } from "./llm.js";

// Lazy-load voice-tool-call Whisper (heavy module, only load when needed)
let transcribeFile: ((path: string, config?: any) => Promise<{ text: string }>) | null = null;
let warmUpWhisper: ((config?: any) => Promise<void>) | null = null;

async function loadWhisperModule() {
	if (transcribeFile) return;
	const mod = await import("voice-tool-call/node");
	transcribeFile = mod.transcribeFile;
	warmUpWhisper = mod.warmUpWhisper;
}

interface UserAudioState {
	buffers: Buffer[];
	totalBytes: number;
	lastAudioTime: number;
	silenceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * STT Service — hooks into the Streamer's VoiceConnection for audio reception.
 *
 * Audio pipeline: Discord UDP → decrypt → DAVE E2E decrypt → Opus decode →
 * per-user buffer → silence detection → downsample → WAV → local Whisper → text channel
 */
export class STTService {
	private client: Client;
	private streamer: Streamer | null = null;
	private userAudioStates: Map<string, UserAudioState> = new Map();
	private ssrcToUser: Map<number, string> = new Map();
	private userNames: Map<string, string> = new Map(); // userId → displayName
	private activeSpeakers: Set<string> = new Set();     // userIds currently speaking
	private textChannel: TextChannel | null = null;
	private llmService: LLMService | null = null;
	private running = false;
	private patched = false;
	private opusDecoder: any;

	// Voice activity state (read by overlay)
	private _lastTranscript: string = '';
	private _lastTranscriptTime: number = 0;
	private _wakeWordActive: boolean = false;
	private _wakeWordTimeout: ReturnType<typeof setTimeout> | null = null;

	// UDP audio reception
	private udpSocket: dgram.Socket | null = null;
	private udpSecretKey: Uint8Array | null = null;
	private udpEncryptionMode: string = '';

	private readonly SAMPLE_RATE = 48000;
	private readonly CHANNELS = 2;
	private readonly BYTES_PER_SAMPLE = 2;
	private readonly TARGET_RATE = 16000;

	private static readonly WAKE_WORD_REGEX = /^hey[,!]?\s+clanker[,!:]?\s*/i;

	constructor(client: Client) {
		this.client = client;
		this.opusDecoder = new OpusScript(this.SAMPLE_RATE, this.CHANNELS, OpusScript.Application.AUDIO);
	}

	public setLLMService(llmService: LLMService): void {
		this.llmService = llmService;
	}

	public isRunning(): boolean {
		return this.running;
	}

	/** Active speaker display names */
	public getActiveSpeakers(): string[] {
		return [...this.activeSpeakers].map(id => this.userNames.get(id) || id).slice(0, 5);
	}

	/** Most recent transcript (clears after 5s) */
	public getLastTranscript(): string | undefined {
		if (Date.now() - this._lastTranscriptTime > 5000) return undefined;
		return this._lastTranscript || undefined;
	}

	/** Whether wake word was recently triggered */
	public isWakeWordActive(): boolean {
		return this._wakeWordActive;
	}

	/**
	 * Called BEFORE streamer.joinVoice() to:
	 * 1. Enable STT mode on VoiceConnection (video=false for SPEAKING events)
	 * 2. Patch signalVideo for self_deaf=false
	 */
	public patchStreamer(streamer: Streamer): void {
		if (this.patched) return;
		this.patched = true;
		this.streamer = streamer;

		// Patch signalVideo for self_deaf=false
		(streamer as any).signalVideo = (videoEnabled: boolean) => {
			const vc = streamer.voiceConnection;
			if (!vc) return;
			streamer.sendOpcode(4, {
				guild_id: vc.guildId,
				channel_id: vc.channelId,
				self_mute: false,
				self_deaf: false,
				self_video: videoEnabled,
			});
		};

		// Patch VoiceConnection.prototype.identify BEFORE joinVoice() creates the instance.
		// This makes the voice connection identify as video:false so Discord sends SPEAKING events.
		try {
			// Try both dist and src paths — Bun resolves .ts source when dist doesn't exist
			let VoiceConnection: any;
			try { VoiceConnection = require('@dank074/discord-video-stream/dist/client/voice/VoiceConnection.js').VoiceConnection; } catch {}
			if (!VoiceConnection) try { VoiceConnection = require('@dank074/discord-video-stream/src/client/voice/VoiceConnection.ts').VoiceConnection; } catch {}
			if (!VoiceConnection) try { VoiceConnection = require('@dank074/discord-video-stream').VoiceConnection; } catch {}
			if (VoiceConnection?.prototype) {
				VoiceConnection.prototype.identify = function(this: any) {
					logger.info("STT: VoiceConnection.identify — video:false");
					this.sendOpcode(0, {
						server_id: this.serverId,
						user_id: this.botId,
						session_id: this.session_id,
						token: this.token,
						video: false,
						streams: [],
						max_dave_protocol_version: 1,
					});
				};
				logger.info("STT: Patched VoiceConnection.prototype.identify (video:false)");
			}
		} catch (e) {
			logger.warn("STT: Could not patch VoiceConnection prototype:", e);
		}

		logger.info("STT: Patched signalVideo (self_deaf=false)");
		this.hookVoiceConnectionWhenReady(streamer);
	}

	private hookVoiceConnectionWhenReady(streamer: Streamer): void {
		const check = () => {
			const vc = streamer.voiceConnection;
			if (!vc) { setTimeout(check, 50); return; }
			const vcAny = vc as any;

			// Monkey-patch identify() to use video:false so Discord sends SPEAKING events.
			// Disable DAVE (max_dave_protocol_version: 0) since video:false breaks DAVE handshake.
			// The StreamConnection has its own independent DAVE for Go Live.
			vcAny.identify = () => {
				logger.info("STT: identify — video:false, dave:0");
				vcAny.sendOpcode(0, {
					server_id: vcAny.serverId || vcAny.guildId || vcAny.channelId,
					user_id: vcAny.botId,
					session_id: vcAny.session_id,
					token: vcAny.token,
					video: false,
					streams: [],
					max_dave_protocol_version: 0,
				});
			};

			// Listen for speaking events (library patched to emit them)
			vcAny.on("speaking", (d: any) => {
				this.handleSpeaking(d);
			});

			// Patch handleReady to set up UDP audio each time the connection (re)connects.
			// This handles the initial connect AND the reconnect after createStream().
			const origHandleReady = vcAny.handleReady?.bind(vcAny);
			let lastWs: any = null;
			vcAny.handleReady = (d: any) => {
				// Ensure streams array exists for BaseMediaConnection (we identify with video:false,
				// so Discord may return empty streams — without this, d.streams[0].ssrc crashes silently)
				if (!d.streams || d.streams.length === 0) {
					d.streams = [{ ssrc: 0, rtx_ssrc: 0 }];
				}
				// Let the library process READY first
				origHandleReady?.(d);

				const ip = d.ip;
				const port = d.port;
				const ssrc = d.ssrc;
				const modes = d.modes || [];
				logger.info(`STT: READY — ip=${ip}:${port} ssrc=${ssrc}`);

				// Close old UDP socket on reconnect
				if (this.udpSocket) {
					try { this.udpSocket.close(); } catch {}
					this.udpSocket = null;
				}
				this.udpSecretKey = null;

				const preferredMode = modes.includes('aead_aes256_gcm_rtpsize')
					? 'aead_aes256_gcm_rtpsize' : modes[0] || 'aead_aes256_gcm_rtpsize';
				this.setupUdpAudio(vcAny.ws, ip, port, ssrc, preferredMode);

				// Hook new WS for SESSION_DESC + SPEAKING (if WS changed)
				if (vcAny.ws !== lastWs) {
					lastWs = vcAny.ws;
					vcAny.ws.addEventListener("message", (e: any) => {
						if (typeof e.data !== 'string') return;
						try {
							const { op, d: data } = JSON.parse(e.data);
							if (op === 4 && data.secret_key?.length > 0 && data.mode) {
								this.udpSecretKey = new Uint8Array(data.secret_key);
								this.udpEncryptionMode = data.mode;
								logger.info(`STT: SESSION_DESC — mode=${data.mode} key=${this.udpSecretKey.length}bytes`);
							}
							if (op === 5) this.handleSpeaking(data);
							if (op === 11 && data.user_ids) {
								for (const uid of data.user_ids) {
									if (uid !== this.client.user?.id && !this.userNames.has(uid)) {
										this.resolveUsername(uid);
									}
								}
							}
						} catch {}
					});
				}
			};

			logger.info("STT: Hooked VoiceConnection (identify + speaking + WS)");
		};
		check();

		// Track usernames via gateway
		const client = this.client as any;
		const botId = this.client.user?.id;
		client.on('raw', (packet: any) => {
			if (packet.t !== 'VOICE_STATE_UPDATE') return;
			const d = packet.d;
			if (d.user_id === botId) return;
			if (d.member) {
				const name = d.member.nick || d.member.user?.global_name || d.member.user?.username;
				if (name) this.userNames.set(d.user_id, name);
			}
		});
	}

	public async activate(): Promise<void> {
		if (this.running) return;
		if (!this.streamer) return;
		this.running = true;

		// Only load Whisper if STT transcription is enabled
		if (config.sttEnabled) {
			try {
				await loadWhisperModule();
				await warmUpWhisper!();
				logger.info("STT: Whisper model loaded (local)");
			} catch (err) {
				logger.error("STT: Failed to load Whisper:", err);
			}
		} else {
			logger.info("STT: Voice activity tracking only (STT_ENABLED=false)");
		}

		// Resolve text channel
		const channelId = config.sttTextChannelId || config.cmdChannelId;
		if (channelId) {
			try {
				const channel = await this.client.channels.fetch(channelId);
				if (channel?.isText()) this.textChannel = channel as TextChannel;
			} catch (err) {
				logger.error("STT: Failed to fetch text channel:", err);
			}
		}

		logger.info("STT: Activated");
	}

	private handleSpeaking(d: any): void {
		const { user_id, ssrc, speaking } = d;
		if (user_id && ssrc) this.ssrcToUser.set(ssrc, user_id);
		if (user_id === this.client.user?.id) return;

		if (speaking > 0) {
			this.activeSpeakers.add(user_id);
			// Resolve username if not cached
			if (!this.userNames.has(user_id)) this.resolveUsername(user_id);
		} else {
			this.activeSpeakers.delete(user_id);
			this.onUserStopSpeaking(user_id);
		}
	}

	private async resolveUsername(userId: string): Promise<void> {
		try {
			// Try all available guilds to find the member
			for (const [, guild] of this.client.guilds.cache) {
				try {
					const member = await guild.members.fetch(userId);
					if (member) {
						this.userNames.set(userId, member.displayName || member.user.username);
						return;
					}
				} catch {}
			}
			// Fallback: fetch user directly
			const user = await this.client.users.fetch(userId);
			if (user) this.userNames.set(userId, user.globalName || user.username);
		} catch {}
	}

	/**
	 * Set up a UDP socket to receive voice audio from Discord.
	 * We DON'T send our own SELECT_PROTOCOL — the library handles that with WebRTC.
	 * Instead, we do IP discovery only (to keep the UDP path open) and listen for
	 * any audio packets Discord sends to us.
	 */
	private setupUdpAudio(voiceWs: any, ip: string, port: number, ssrc: number, mode: string): void {
		if (this.udpSocket) return;

		const socket = dgram.createSocket('udp4');
		this.udpSocket = socket;
		let pktCount = 0;
		let discoveryDone = false;

		socket.on('message', (msg: Buffer) => {
			pktCount++;

			// First response is IP discovery
			if (!discoveryDone && msg.length >= 74) {
				const localIp = msg.subarray(8, 72).toString('utf-8').replace(/\0/g, '');
				const localPort = msg.readUInt16BE(msg.length - 2);
				logger.info(`STT: UDP IP discovery — local=${localIp}:${localPort}`);
				discoveryDone = true;
				// Don't send SELECT_PROTOCOL — let the library handle WebRTC setup
				return;
			}

			// Voice audio packets (RTP)
			if (!this.udpSecretKey) return;
			if (msg.length < 12 || (msg[0] & 0xC0) !== 0x80) return;

			if (pktCount <= 5 || pktCount % 500 === 0) {
				logger.info(`STT: UDP audio pkt #${pktCount} len=${msg.length}`);
			}
			this.handleEncryptedVoicePacket(msg);
		});

		socket.on('error', (err) => {
			logger.error('STT: UDP socket error:', err.message);
		});

		// Bind and send IP discovery (keeps the NAT mapping open)
		socket.bind(0, () => {
			const discoveryPacket = Buffer.alloc(74);
			discoveryPacket.writeUInt16BE(0x1, 0);
			discoveryPacket.writeUInt16BE(70, 2);
			discoveryPacket.writeUInt32BE(ssrc, 4);
			socket.send(discoveryPacket, port, ip, (err) => {
				if (err) logger.error('STT: UDP discovery send error:', err.message);
				else logger.info(`STT: Sent UDP IP discovery to ${ip}:${port}`);
			});
		});
	}

	private handleEncryptedVoicePacket(msg: Buffer): void {
		if (msg.length < 12 || (msg[0] & 0xC0) !== 0x80) return;

		const ssrc = msg.readUInt32BE(8);
		const userId = this.ssrcToUser.get(ssrc);
		if (!userId || userId === this.client.user?.id) return;

		if (!this.udpSecretKey) return;
		const secretKey = this.udpSecretKey;
		const encryptionMode = this.udpEncryptionMode;

		try {
			let decrypted = this.decryptPacket(msg, secretKey, encryptionMode);
			if (!decrypted || decrypted.length === 0) return;

			// Strip RTP header extension
			if (msg[0] & 0x10) {
				const extLength = msg.readUInt16BE(14);
				decrypted = decrypted.subarray(4 * extLength);
			}

			// DAVE E2E decryption (if enabled on this connection)
			const vcAny = this.streamer?.voiceConnection as any;
			const daveSession = vcAny?._daveSession;
			const daveVersion = vcAny?._daveProtocolVersion || 0;
			if (daveSession && daveVersion > 0) {
				try {
					decrypted = Buffer.from(daveSession.decrypt(userId, 0, decrypted));
				} catch {
					if (!daveSession.canPassthrough?.(userId)) return;
				}
			}

			// Opus → PCM
			try {
				const pcmInt16 = this.opusDecoder.decode(decrypted);
				const pcm = Buffer.from(pcmInt16.buffer, pcmInt16.byteOffset, pcmInt16.byteLength);
				this.bufferUserAudio(userId, pcm);
			} catch {}
		} catch {}
	}

	private decryptPacket(packet: Buffer, secretKey: Uint8Array, encryptionMode: string): Buffer | null {
		if (encryptionMode === "aead_aes256_gcm_rtpsize") {
			return this.decryptAeadGcmRtpsize(packet, secretKey);
		}
		const cc = packet[0] & 0x0f;
		let headerLength = 12 + (cc * 4);
		if (packet[0] & 0x10) {
			if (headerLength + 4 > packet.length) return null;
			const extLength = packet.readUInt16BE(headerLength + 2);
			headerLength += 4 + (extLength * 4);
		}
		if (headerLength >= packet.length) return null;
		const header = packet.subarray(0, headerLength);
		const encrypted = packet.subarray(headerLength);

		if (encryptionMode === "xsalsa20_poly1305_lite") {
			return this.decryptXSalsa20Lite(encrypted, secretKey);
		} else if (encryptionMode === "xsalsa20_poly1305") {
			return this.decryptXSalsa20(header, encrypted, secretKey);
		}
		return null;
	}

	private decryptXSalsa20Lite(encrypted: Buffer, secretKey: Uint8Array): Buffer | null {
		if (encrypted.length < 4) return null;
		const nonceBytes = encrypted.subarray(encrypted.length - 4);
		const nonce = Buffer.alloc(24);
		nonceBytes.copy(nonce);
		try {
			const { secretbox } = require("tweetnacl");
			const result = secretbox.open(encrypted.subarray(0, encrypted.length - 4), nonce, secretKey);
			return result ? Buffer.from(result) : null;
		} catch { return null; }
	}

	private decryptXSalsa20(header: Buffer, encrypted: Buffer, secretKey: Uint8Array): Buffer | null {
		const nonce = Buffer.alloc(24);
		header.copy(nonce, 0, 0, Math.min(header.length, 24));
		try {
			const { secretbox } = require("tweetnacl");
			const result = secretbox.open(encrypted, nonce, secretKey);
			return result ? Buffer.from(result) : null;
		} catch { return null; }
	}

	private decryptAeadGcmRtpsize(buffer: Buffer, secretKey: Uint8Array): Buffer | null {
		const NONCE_LEN = 4, TAG_LEN = 16;
		if (buffer.length < 12 + TAG_LEN + NONCE_LEN) return null;

		const nonce = Buffer.alloc(12);
		buffer.copy(nonce, 0, buffer.length - NONCE_LEN);

		let headerSize = 12;
		if ((buffer[0] >> 4) & 0x01) headerSize += 4;

		const header = buffer.subarray(0, headerSize);
		const encrypted = buffer.subarray(headerSize, buffer.length - TAG_LEN - NONCE_LEN);
		const authTag = buffer.subarray(buffer.length - TAG_LEN - NONCE_LEN, buffer.length - NONCE_LEN);

		try {
			const crypto = require("crypto");
			const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(secretKey), nonce);
			decipher.setAAD(header);
			decipher.setAuthTag(authTag);
			return Buffer.concat([decipher.update(encrypted), decipher.final()]);
		} catch { return null; }
	}

	public stop(): void {
		if (!this.running) return;
		this.running = false;
		for (const [, state] of this.userAudioStates) {
			if (state.silenceTimer) clearTimeout(state.silenceTimer);
		}
		this.userAudioStates.clear();
		this.ssrcToUser.clear();
		this.textChannel = null;
		this.activeSpeakers.clear();
		if (this.udpSocket) { try { this.udpSocket.close(); } catch {} this.udpSocket = null; }
		logger.info("STT service stopped");
	}

	// ── Audio buffering ──

	private bufferUserAudio(userId: string, pcm: Buffer): void {
		let state = this.userAudioStates.get(userId);
		if (!state) {
			state = { buffers: [], totalBytes: 0, lastAudioTime: Date.now(), silenceTimer: null };
			this.userAudioStates.set(userId, state);
		}

		state.buffers.push(pcm);
		state.totalBytes += pcm.length;
		state.lastAudioTime = Date.now();

		if (state.silenceTimer) clearTimeout(state.silenceTimer);
		state.silenceTimer = setTimeout(() => this.processUserAudio(userId), config.sttSilenceThresholdMs);

		const maxBytes = (config.sttMaxAudioMs / 1000) * this.SAMPLE_RATE * this.CHANNELS * this.BYTES_PER_SAMPLE;
		if (state.totalBytes > maxBytes) this.processUserAudio(userId);
	}

	private onUserStopSpeaking(userId: string): void {
		const state = this.userAudioStates.get(userId);
		if (!state || state.buffers.length === 0) return;
		if (state.silenceTimer) clearTimeout(state.silenceTimer);
		state.silenceTimer = setTimeout(() => this.processUserAudio(userId), config.sttSilenceThresholdMs);
	}

	// ── Audio processing → transcription ──

	private async processUserAudio(userId: string): Promise<void> {
		const state = this.userAudioStates.get(userId);
		if (!state || state.buffers.length === 0) return;

		const buffers = state.buffers;
		const totalBytes = state.totalBytes;
		state.buffers = [];
		state.totalBytes = 0;
		if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }

		const durationMs = (totalBytes / (this.SAMPLE_RATE * this.CHANNELS * this.BYTES_PER_SAMPLE)) * 1000;
		if (durationMs < config.sttMinAudioMs) return;

		const pcmData = Buffer.concat(buffers);
		if (this.calculateRMS(pcmData) < 100) return;

		// Skip transcription if Whisper not loaded (voice activity only mode)
		if (!config.sttEnabled) return;

		const monoData = this.stereoToMono(pcmData);
		const downsampled = this.downsample(monoData, this.SAMPLE_RATE, this.TARGET_RATE);
		const wav = this.encodeWAV(downsampled, this.TARGET_RATE, 1);

		try {
			const text = await this.transcribeLocal(wav);
			if (text && text.trim().length > 0) {
				await this.postTranscription(userId, text);
			}
		} catch (err) {
			logger.error(`STT: Transcription failed for user ${userId}:`, err);
		}
	}

	private async transcribeLocal(wavBuffer: Buffer): Promise<string | null> {
		if (!transcribeFile) await loadWhisperModule();
		if (!transcribeFile) return null;

		// Write WAV to temp file (voice-tool-call reads files)
		const tempPath = join(tmpdir(), `sb-stt-${Date.now()}.wav`);
		writeFileSync(tempPath, wavBuffer);

		try {
			const result = await transcribeFile(tempPath);
			return result.text || null;
		} finally {
			try { unlinkSync(tempPath); } catch {}
		}
	}

	// ── Signal processing helpers ──

	private calculateRMS(pcmData: Buffer): number {
		let sumSquares = 0;
		const sampleCount = pcmData.length / this.BYTES_PER_SAMPLE;
		for (let i = 0; i < pcmData.length; i += this.BYTES_PER_SAMPLE) {
			const sample = pcmData.readInt16LE(i);
			sumSquares += sample * sample;
		}
		return Math.sqrt(sumSquares / sampleCount);
	}

	private stereoToMono(pcmData: Buffer): Buffer {
		const mono = Buffer.alloc(pcmData.length / 2);
		for (let i = 0, j = 0; i < pcmData.length; i += 4, j += 2) {
			const left = pcmData.readInt16LE(i);
			const right = pcmData.readInt16LE(i + 2);
			mono.writeInt16LE(Math.round((left + right) / 2), j);
		}
		return mono;
	}

	private downsample(pcmData: Buffer, fromRate: number, toRate: number): Buffer {
		const ratio = fromRate / toRate;
		const newLength = Math.floor(pcmData.length / this.BYTES_PER_SAMPLE / ratio) * this.BYTES_PER_SAMPLE;
		const result = Buffer.alloc(newLength);
		for (let i = 0; i < newLength / this.BYTES_PER_SAMPLE; i++) {
			const srcIndex = Math.floor(i * ratio) * this.BYTES_PER_SAMPLE;
			if (srcIndex + 1 < pcmData.length) {
				result.writeInt16LE(pcmData.readInt16LE(srcIndex), i * this.BYTES_PER_SAMPLE);
			}
		}
		return result;
	}

	private encodeWAV(pcmData: Buffer, sampleRate: number, channels: number): Buffer {
		const header = Buffer.alloc(44);
		const dataLength = pcmData.length;
		header.write("RIFF", 0);
		header.writeUInt32LE(dataLength + 36, 4);
		header.write("WAVE", 8);
		header.write("fmt ", 12);
		header.writeUInt32LE(16, 16);
		header.writeUInt16LE(1, 20);
		header.writeUInt16LE(channels, 22);
		header.writeUInt32LE(sampleRate, 24);
		header.writeUInt32LE(sampleRate * channels * this.BYTES_PER_SAMPLE, 28);
		header.writeUInt16LE(channels * this.BYTES_PER_SAMPLE, 32);
		header.writeUInt16LE(16, 34);
		header.write("data", 36);
		header.writeUInt32LE(dataLength, 40);
		return Buffer.concat([header, pcmData]);
	}

	// ── Transcription handling ──

	private async postTranscription(userId: string, text: string): Promise<void> {
		if (!this.textChannel) return;
		let username = this.userNames.get(userId) || userId;
		try {
			const guild = this.textChannel.guild;
			if (guild) {
				const member = await guild.members.fetch(userId);
				username = member.displayName || member.user.username;
				this.userNames.set(userId, username);
			}
		} catch {}

		// Update overlay state
		this._lastTranscript = `${username}: ${text}`;
		this._lastTranscriptTime = Date.now();

		try {
			await this.textChannel.send(`**${username}**: ${text}`);
		} catch (err) {
			logger.error("STT: Failed to post transcription:", err);
		}

		// Wake word → LLM tool execution
		if (this.llmService?.isEnabled() && this.textChannel) {
			const match = text.match(STTService.WAKE_WORD_REGEX);
			if (match) {
				const command = text.slice(match[0].length).trim() || text;
				logger.info(`STT: Wake word from ${username}: "${command}"`);

				// Show wake word active on overlay for 5s
				this._wakeWordActive = true;
				if (this._wakeWordTimeout) clearTimeout(this._wakeWordTimeout);
				this._wakeWordTimeout = setTimeout(() => { this._wakeWordActive = false; }, 5000);

				await this.textChannel.send("🔔").catch(() => {});
				this.llmService.processVoiceCommand(userId, username, command, this.textChannel).catch(err => {
					logger.error("STT: Voice command error:", err);
					this._wakeWordActive = false;
				});
			}
		}
	}
}

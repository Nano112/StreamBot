# Gatherr

A self-hosted broadcast control bot for Discord. Pulls video and audio from many sources — local files, YouTube, Twitch, Plex, anything `yt-dlp` understands — runs it through a real-time compositor, and ships the result into a Discord voice channel. Comes with a web dashboard for queueing, browsing, and live configuration.

Built on Bun, TypeScript, FFmpeg, and GStreamer. Intended for self-hosting alongside the rest of the *arr stack.

> Heads up: this bot uses a Discord user account (a "self-bot"), which violates Discord's Terms of Service. Run it on accounts you don't mind losing.

## What it does

- **Multi-source streaming.** Local files in a watched directory, YouTube (videos, live, search), Twitch (live and VODs), Plex (browse + search a real Plex Media Server), and any other site `yt-dlp` supports as a fallback.
- **Plex with proper auth.** Sign in via the standard PIN flow at plex.tv/link from the dashboard — no scraping tokens out of XML files. Auto-discovers your servers, picks a reachable connection, persists the token in SQLite.
- **Live compositor.** Frames pass through an in-process compositor with overlay support before encoding. Foundation for picture-in-picture, watermarks, on-screen status, etc.
- **GStreamer + FFmpeg pipeline.** MPEG-TS over a FIFO into the Discord video stream library. Hardware acceleration optional.
- **Queue with auto-advance.** Standard play / skip / queue commands. Web dashboard mirrors the queue.
- **Voice-channel transcription.** Optional speech-to-text (faster-whisper-compatible server) posts transcripts to a text channel as people talk.
- **LLM tool calling in voice.** Optional OpenRouter integration for in-voice LLM interactions via the `voice-tool-call` library.
- **Web dashboard.** Browse libraries, search across providers, queue items, upload files, render previews, view live logs, tweak streaming params at runtime.

## Requirements

- [Bun](https://bun.sh/) 1.1.39+ (Gatherr is built and run on Bun; the legacy `start:node` script is not currently supported since SQLite persistence was introduced)
- [FFmpeg](https://www.ffmpeg.org/) on `$PATH`
- [GStreamer](https://gstreamer.freedesktop.org/) with the standard plugin set, if you want the GStreamer pipeline
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — auto-downloaded and self-updated by the bot on startup

Optional:

- A GPU with hardware decode/encode support
- A faster-whisper-compatible STT server (any HTTP server speaking the same protocol)
- A Plex Media Server (for the Plex provider)
- An OpenRouter API key (for in-voice LLM tooling)

## Quick start

```bash
git clone https://github.com/Nano112/Gatherr
cd Gatherr
bun install
cp .env.example .env
# edit .env — at minimum: TOKEN, GUILD_ID, COMMAND_CHANNEL_ID, VIDEO_CHANNEL_ID, ADMIN_IDS
bun src/index.ts
```

If you set `SERVER_ENABLED=true` the dashboard runs alongside the bot at `http://localhost:8080` (or whatever you set `SERVER_PORT` to).

To run the dashboard alone (no Discord client):

```bash
bun src/server/index.ts
```

## Configuration

All config lives in `.env`. The full set is documented in `.env.example`; the important groups:

### Discord

| Var | Notes |
|---|---|
| `TOKEN` | Discord user token. Required. |
| `PREFIX` | Command prefix, default `$` |
| `GUILD_ID` | Server the bot operates in |
| `COMMAND_CHANNEL_ID` | Text channel for commands |
| `VIDEO_CHANNEL_ID` | Voice/video channel to stream into |
| `ADMIN_IDS` | Comma-separated or JSON array of user IDs |

### Files

| Var | Notes |
|---|---|
| `VIDEOS_DIR` | Where local video files live, default `./videos` |
| `PREVIEW_CACHE_DIR` | Thumbnail cache, default `./tmp/preview-cache` |
| `DB_PATH` | SQLite path, default `data/streambot.db` |

### Stream

| Var | Default | Notes |
|---|---|---|
| `STREAM_WIDTH` / `STREAM_HEIGHT` | 1280 / 720 | Output resolution |
| `STREAM_FPS` | 30 | Frame rate |
| `STREAM_BITRATE_KBPS` / `STREAM_MAX_BITRATE_KBPS` | 2000 / 2500 | Target and ceiling |
| `STREAM_VIDEO_CODEC` | `H264` | `H264`, `H265`, `VP8`, `VP9`, or `AV1` |
| `STREAM_H26X_PRESET` | `ultrafast` | Standard FFmpeg presets |
| `STREAM_HARDWARE_ACCELERATION` | `false` | GPU encode/decode |
| `STREAM_RESPECT_VIDEO_PARAMS` | `false` | If `true`, pass source params through instead of forcing the above |

### yt-dlp / cookies

`YTDLP_COOKIES_PATH` — path to a Netscape-format `cookies.txt` for accessing age-gated, premium, or private content. Export with [Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) (Chromium) or [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/) (Firefox).

### Plex

Two paths, in order of preference:

1. **In-app sign-in (recommended).** Leave `PLEX_URL` / `PLEX_TOKEN` empty. Open the dashboard's Plex tab, click "Sign in to Plex", enter the 4-character code at [plex.tv/link](https://plex.tv/link), pick a server. The token is stored in SQLite and persists across restarts.
2. **Bootstrap via env.** Set `PLEX_URL` and `PLEX_TOKEN` if you already have a server token. The provider works invisibly; the dashboard will still show a "Sign in to Plex" panel that lets you upgrade to the proper auth flow.

### STT (optional)

| Var | Default | Notes |
|---|---|---|
| `STT_ENABLED` | `false` | Master switch |
| `STT_SERVER_URL` | `http://localhost:8069` | Your faster-whisper-compatible server |
| `STT_SILENCE_THRESHOLD_MS` | 1500 | Silence before flushing a chunk |
| `STT_MIN_AUDIO_MS` / `STT_MAX_AUDIO_MS` | 500 / 30000 | Per-chunk bounds |
| `STT_TEXT_CHANNEL_ID` | falls back to `COMMAND_CHANNEL_ID` | Where transcripts are posted |

### LLM (optional)

`OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL` — if set, in-voice LLM tool calls are enabled.

### Web dashboard

| Var | Notes |
|---|---|
| `SERVER_ENABLED` | `true` to enable |
| `SERVER_PORT` | default `8080` |
| `SERVER_USERNAME` / `SERVER_PASSWORD` | basic auth; password can be plain, bcrypt, or argon2 |

## Commands

Triggered with `PREFIX` (default `$`) in `COMMAND_CHANNEL_ID`.

**Playback**

| Command | What it does |
|---|---|
| `play <name \| url \| query>` | Plays a local file, URL, or YouTube search hit. Provider is auto-detected. |
| `ytsearch <query>` | YouTube search |
| `stop` (aka `leave`, `s`) | Stops playback and clears the queue |
| `skip` (aka `next`) | Skip current item |
| `queue` | Show the queue |
| `list` | Show local videos |

**Utility**

| Command | What it does |
|---|---|
| `status` | Streaming status |
| `preview <name>` | Render thumbnail strips for a local video |
| `ping` | Latency check |
| `help` | Available commands |

**Admin (admin-only)**

| Command | What it does |
|---|---|
| `config [param] [value]` (aka `cfg`, `set`) | Show or change runtime config |

## Web dashboard

When `SERVER_ENABLED=true`, the dashboard runs on `SERVER_PORT`. Features:

- Library management: list, upload, delete, preview, see metadata (resolution, codec, duration)
- Remote URL downloads
- Queue view with auto-refresh
- Per-provider tabs: Plex (with login flow + browse + search), YouTube search, direct URL
- Live log tail
- Runtime adjustment of streaming params (resolution, bitrate, codec, preset)

## Docker

```bash
mkdir gatherr && cd gatherr
wget https://raw.githubusercontent.com/Nano112/Gatherr/main/docker-compose.yml
# edit docker-compose.yml — set env vars, mount your videos dir
docker compose up -d
```

A Cloudflare WARP variant exists in `docker-compose-warp.yml`. Note: the dashboard is unreachable from outside the WARP container due to network isolation, so use WARP only if you don't need the dashboard externally.

## Architecture

A short tour for anyone reading the code:

- `src/index.ts` — entry point. Boots Discord client, registers providers, starts the streaming service and (optionally) the web server.
- `src/services/providers/` — one file per source (`local`, `youtube`, `twitch`, `plex`, `direct-url`). Each implements a small `StreamProvider` interface (`canHandle`, `resolve`, optional `search`/`browse`).
- `src/services/providers/manager.ts` — picks the right provider for a given input and dispatches.
- `src/services/streaming.ts` — playback lifecycle, queue, Discord voice integration.
- `src/services/stream-composer.ts` — frame-level compositor, overlays.
- `src/services/plex-auth.ts` — Plex PIN OAuth flow, server discovery, SQLite-backed token persistence.
- `src/services/db.ts` — SQLite singleton (Bun's built-in `bun:sqlite`).
- `src/services/llm.ts`, `src/services/stt.ts` — optional voice-side integrations.
- `src/server/` — Express + EJS dashboard.

Design notes for non-obvious features live under `docs/superpowers/specs/`.

## Contributing

Issues and PRs welcome on [github.com/Nano112/Gatherr](https://github.com/Nano112/Gatherr). This is a personal project; expect opinionated reviews.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

Gatherr started as a fork of [ysdragon/StreamBot](https://github.com/ysdragon/StreamBot) and inherits the basic shape of the Discord self-bot + `yt-dlp` playback loop from that project. Most of what's here now — the provider system, compositor, GStreamer pipeline, dashboard, Plex auth, STT/LLM integrations, SQLite persistence — is new. Thanks to ysdragon for the starting point.

Also leans on:

- [@dank074/discord-video-stream](https://github.com/Discord-RE/Discord-video-stream) for the video transport into Discord voice
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for the universal source resolver
- [Bun](https://bun.sh/), [Express](https://expressjs.com/), [FFmpeg](https://www.ffmpeg.org/), [GStreamer](https://gstreamer.freedesktop.org/)

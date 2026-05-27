#!/usr/bin/env python3
"""
GStreamer pipeline controller for StreamBot.

Reads JSON commands from stdin, outputs matroska on fd 3.
Commands: play(url), pause, resume, seek(position), overlay(text), idle, quit.
"""

import sys
import os
import json
import threading
import gi

gi.require_version('Gst', '1.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gst, GLib

Gst.init(None)

WIDTH = int(os.environ.get('GST_WIDTH', '1280'))
HEIGHT = int(os.environ.get('GST_HEIGHT', '720'))
FPS = int(os.environ.get('GST_FPS', '30'))
BITRATE = int(os.environ.get('GST_BITRATE', '1000'))
FIFO_PATH = os.environ.get('GST_FIFO_PATH', '/tmp/sb-gst-output.mkv')
PREVIEW_PATH = os.environ.get('GST_PREVIEW_PATH', '/tmp/sb-gst-preview.jpg')
PREVIEW_FPS = int(os.environ.get('GST_PREVIEW_FPS', '2'))
PREVIEW_QUALITY = int(os.environ.get('GST_PREVIEW_QUALITY', '60'))


# Logs go to stdout (matroska goes to FIFO file, not stdout)
def log(msg):
    print(json.dumps({"type": "log", "message": msg}), flush=True)

def status(state, **kwargs):
    print(json.dumps({"type": "status", "state": state, **kwargs}), flush=True)


class StreamController:
    def __init__(self):
        self.pipeline = None
        self.loop = GLib.MainLoop()
        self.overlay_text = "StreamBot | Idle"
        self.current_mode = "idle"  # idle or media
        self.audio_selector = None   # input-selector for audio track switching
        self.audio_pads = []         # list of (pad_index, sink_pad) tuples
        self.desired_audio_track = 0 # which audio track index to use

        self._build_idle_pipeline()

    def _build_idle_pipeline(self):
        """Build idle pipeline using parse_launch (proven to work)."""
        desc = (
            f'videotestsrc pattern=black is-live=true ! '
            f'video/x-raw,width={WIDTH},height={HEIGHT},framerate={FPS}/1 ! '
            f'textoverlay name=overlay text="{self._escape_text(self.overlay_text)}" '
            f'  valignment=top halignment=right font-desc="Monospace 11" '
            f'  shaded-background=true shading-value=160 xpad=10 ypad=10 line-alignment=left ! '
            f'tee name=vtee '
            f'vtee. ! queue ! videoconvert ! '
            f'x264enc tune=zerolatency speed-preset=ultrafast bitrate={BITRATE} bframes=0 key-int-max={FPS*2} ! '
            f'queue max-size-time=500000000 ! '
            f'mpegtsmux name=mux ! '
            f'filesink location={FIFO_PATH} sync=false '
            f'vtee. ! queue leaky=2 max-size-buffers=2 ! videorate ! video/x-raw,framerate={PREVIEW_FPS}/1 ! '
            f'videoconvert ! jpegenc quality={PREVIEW_QUALITY} ! '
            f'appsink name=preview_sink sync=false max-buffers=1 drop=true '
            f' '
            f'audiotestsrc wave=silence is-live=true ! '
            f'audio/x-raw,rate=48000,channels=2,format=S16LE ! '
            f'audioconvert ! audioresample ! '
            f'opusenc bitrate=128000 ! '
            f'queue max-size-time=500000000 ! mux. '
        )

        self.pipeline = Gst.parse_launch(desc)
        self._wire_preview_sink()
        self._setup_bus()
        self.current_mode = "idle"
        log("Idle pipeline built")

    def _wire_preview_sink(self):
        """Hook the named preview_sink appsink so each JPEG buffer is written
        atomically to PREVIEW_PATH (so HTTP readers never see a half-written file)."""
        sink = self.pipeline.get_by_name("preview_sink")
        if not sink:
            return
        sink.set_property("emit-signals", True)
        sink.connect("new-sample", self._on_preview_sample)

    def _on_preview_sample(self, sink):
        sample = sink.emit("pull-sample")
        if not sample:
            return Gst.FlowReturn.OK
        buf = sample.get_buffer()
        success, mapinfo = buf.map(Gst.MapFlags.READ)
        if not success:
            return Gst.FlowReturn.OK
        try:
            tmp = PREVIEW_PATH + ".tmp"
            with open(tmp, "wb") as f:
                f.write(mapinfo.data)
            os.replace(tmp, PREVIEW_PATH)
        except Exception as e:
            log(f"preview write failed: {e}")
        finally:
            buf.unmap(mapinfo)
        return Gst.FlowReturn.OK

    def _build_media_pipeline(self, url):
        """Build media pipeline with uridecodebin + programmatic pad linking."""
        self.pipeline = Gst.Pipeline.new("media")

        # Source
        dec = Gst.ElementFactory.make("uridecodebin", "dec")
        dec.set_property("uri", url)
        dec.set_property("buffer-size", 10 * 1024 * 1024)
        dec.set_property("buffer-duration", 5 * Gst.SECOND)

        # Video branch
        vqueue1 = Gst.ElementFactory.make("queue", "vq1")
        vqueue1.set_property("max-size-time", 1 * Gst.SECOND)
        vconv = Gst.ElementFactory.make("videoconvert", "vconv")
        vscale = Gst.ElementFactory.make("videoscale", "vscale")
        vcaps = Gst.ElementFactory.make("capsfilter", "vcaps")
        vcaps.set_property("caps", Gst.Caps.from_string(
            f"video/x-raw,width={WIDTH},height={HEIGHT}"))
        overlay = Gst.ElementFactory.make("textoverlay", "overlay")
        overlay.set_property("text", self.overlay_text)
        overlay.set_property("valignment", "top")
        overlay.set_property("halignment", "right")
        overlay.set_property("font-desc", "Monospace 11")
        overlay.set_property("shaded-background", True)
        overlay.set_property("shading-value", 160)
        overlay.set_property("xpad", 10)
        overlay.set_property("ypad", 10)
        overlay.set_property("line-alignment", "left")
        vtee = Gst.ElementFactory.make("tee", "vtee")
        venc = Gst.ElementFactory.make("x264enc", "venc")
        venc.set_property("tune", 0x04)  # zerolatency
        venc.set_property("speed-preset", 1)  # ultrafast (prepareStream re-encodes anyway)
        venc.set_property("bitrate", BITRATE)
        venc.set_property("bframes", 0)
        venc.set_property("key-int-max", FPS * 2)
        venc.set_property("threads", 0)  # Auto-detect thread count
        h264parse = Gst.ElementFactory.make("h264parse", "h264p")
        vqueue2 = Gst.ElementFactory.make("queue", "vq2")
        vqueue2.set_property("max-size-time", 500 * Gst.MSECOND)

        # Audio branch: input-selector allows switching between multiple audio tracks
        asel = Gst.ElementFactory.make("input-selector", "asel")
        self.audio_selector = asel
        self.audio_pads = []

        aconv = Gst.ElementFactory.make("audioconvert", "aconv")
        aresample = Gst.ElementFactory.make("audioresample", "aresamp")
        acaps = Gst.ElementFactory.make("capsfilter", "acaps")
        acaps.set_property("caps", Gst.Caps.from_string("audio/x-raw,rate=48000,channels=2"))
        aenc = Gst.ElementFactory.make("opusenc", "aenc")
        aenc.set_property("bitrate", 128000)
        aqueue2 = Gst.ElementFactory.make("queue", "aq2")
        aqueue2.set_property("max-size-time", 500 * Gst.MSECOND)

        # Mux + output (MPEG-TS: handles concatenation when switching sources)
        mux = Gst.ElementFactory.make("mpegtsmux", "mux")
        sink = Gst.ElementFactory.make("filesink", "sink")
        sink.set_property("location", FIFO_PATH)
        sink.set_property("sync", True)  # Realtime pacing for media

        # Preview branch (off the tee): downsample to PREVIEW_FPS, JPEG-encode,
        # appsink writes each frame atomically to PREVIEW_PATH for HTTP polling.
        pvq = Gst.ElementFactory.make("queue", "pvq")
        pvq.set_property("leaky", 2)            # downstream — drop old frames
        pvq.set_property("max-size-buffers", 2)
        pvq.set_property("max-size-time", 0)
        pvq.set_property("max-size-bytes", 0)
        pvrate = Gst.ElementFactory.make("videorate", "pvrate")
        pvcaps = Gst.ElementFactory.make("capsfilter", "pvcaps")
        pvcaps.set_property("caps", Gst.Caps.from_string(f"video/x-raw,framerate={PREVIEW_FPS}/1"))
        pvconv = Gst.ElementFactory.make("videoconvert", "pvconv")
        pvenc = Gst.ElementFactory.make("jpegenc", "pvenc")
        pvenc.set_property("quality", PREVIEW_QUALITY)
        pvsink = Gst.ElementFactory.make("appsink", "preview_sink")
        pvsink.set_property("emit-signals", True)
        pvsink.set_property("sync", False)
        pvsink.set_property("max-buffers", 1)
        pvsink.set_property("drop", True)

        # Add all to pipeline
        for el in [dec, vqueue1, vconv, vscale, vcaps, overlay, vtee, venc, h264parse, vqueue2,
                    asel, aconv, aresample, acaps, aenc, aqueue2, mux, sink,
                    pvq, pvrate, pvcaps, pvconv, pvenc, pvsink]:
            self.pipeline.add(el)

        # Link video branch up to the tee
        Gst.Element.link_many(vqueue1, vconv, vscale, vcaps, overlay, vtee)
        # Tee has request pads — request one src pad per branch
        tee_main_src = vtee.request_pad_simple("src_%u")
        tee_main_src.link(venc.get_static_pad("sink"))
        Gst.Element.link_many(venc, h264parse, vqueue2)
        # Preview branch off the second tee src pad
        tee_preview_src = vtee.request_pad_simple("src_%u")
        tee_preview_src.link(pvq.get_static_pad("sink"))
        Gst.Element.link_many(pvq, pvrate, pvcaps, pvconv, pvenc, pvsink)
        # Link audio branch: input-selector → convert → encode
        Gst.Element.link_many(asel, aconv, aresample, acaps, aenc, aqueue2)
        # Link to mux
        vqueue2.link(mux)
        aqueue2.link(mux)
        mux.link(sink)

        # Hook the preview appsink callback
        self._wire_preview_sink()

        # Handle dynamic pads from uridecodebin
        audio_pad_count = [0]
        def on_pad_added(element, pad):
            caps = pad.get_current_caps() or pad.query_caps(None)
            struct = caps.get_structure(0)
            name = struct.get_name()
            if name.startswith("video/"):
                sink_pad = vqueue1.get_static_pad("sink")
                if not sink_pad.is_linked():
                    ret = pad.link(sink_pad)
                    log(f"Linked video: {ret}")
            elif name.startswith("audio/"):
                # Each audio track gets its own input-selector sink pad
                idx = audio_pad_count[0]
                audio_pad_count[0] += 1
                sel_pad = asel.request_pad_simple("sink_%u" % idx)
                # Add a queue before the selector to prevent blocking
                aq = Gst.ElementFactory.make("queue", f"aq_in_{idx}")
                aq.set_property("max-size-time", 1 * Gst.SECOND)
                self.pipeline.add(aq)
                aq.sync_state_with_parent()
                pad.link(aq.get_static_pad("sink"))
                aq.get_static_pad("src").link(sel_pad)
                self.audio_pads.append((idx, sel_pad))
                log(f"Linked audio track {idx}")
                # Select desired track
                if idx == self.desired_audio_track:
                    asel.set_property("active-pad", sel_pad)
                    log(f"Selected audio track {idx} (desired)")
                elif idx == 0 and self.desired_audio_track >= 0:
                    # Default to first track initially
                    asel.set_property("active-pad", sel_pad)

        dec.connect("pad-added", on_pad_added)

        self._setup_bus()
        self.current_mode = "media"
        log(f"Media pipeline built for: {url[:80]}")

    def _setup_bus(self):
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self._on_error)
        bus.connect("message::eos", self._on_eos)
        bus.connect("message::buffering", self._on_buffering)

    def _escape_text(self, text):
        return text.replace('"', '\\"').replace("'", "\\'")

    def start(self):
        ret = self.pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            log("ERROR: Failed to start pipeline")
            return False
        status("idle")
        log("Pipeline started")

        # Periodic position reporting (every 1s)
        def report_position():
            if self.current_mode == "media":
                pos = self.get_position()
                dur = self.get_duration()
                if pos > 0 or dur > 0:
                    print(json.dumps({
                        "type": "position",
                        "position": round(pos, 1),
                        "duration": round(dur, 1)
                    }), flush=True)
            return True  # Keep timer running
        GLib.timeout_add(1000, report_position)

        return True

    def play_url(self, url):
        log(f"Switching to media: {url[:80]}")

        # Tear down current pipeline
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)

        # Build new media pipeline (outputs to same fd)
        self._build_media_pipeline(url)

        ret = self.pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            log("ERROR: Failed to start media pipeline")
            self._switch_to_idle()
            return

        status("playing")
        log("Media playing")

    def pause(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.PAUSED)
            status("paused")
            log("Paused")

    def resume(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.PLAYING)
            status("playing")
            log("Resumed")

    def seek(self, position_seconds):
        if self.pipeline:
            pos = int(position_seconds * Gst.SECOND)
            success = self.pipeline.seek_simple(
                Gst.Format.TIME,
                Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                pos
            )
            log(f"Seek to {position_seconds:.1f}s: {'OK' if success else 'FAILED'}")

    def set_audio_track(self, track_index):
        self.desired_audio_track = track_index
        if self.audio_selector and self.audio_pads:
            for idx, pad in self.audio_pads:
                if idx == track_index:
                    self.audio_selector.set_property("active-pad", pad)
                    log(f"Switched to audio track {track_index}")
                    return
            log(f"Audio track {track_index} not found (have {len(self.audio_pads)} tracks)")
        else:
            log(f"Audio track {track_index} queued for next media")

    def set_overlay(self, text):
        self.overlay_text = text
        if self.pipeline:
            overlay = self.pipeline.get_by_name("overlay")
            if overlay:
                overlay.set_property("text", text)

    def _switch_to_idle(self):
        log("Switching to idle")
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)

        self._build_idle_pipeline()
        self.pipeline.set_state(Gst.State.PLAYING)
        status("idle")
        log("Idle active")

    def get_position(self):
        if self.pipeline:
            success, pos = self.pipeline.query_position(Gst.Format.TIME)
            if success:
                return pos / Gst.SECOND
        return 0

    def get_duration(self):
        if self.pipeline:
            success, dur = self.pipeline.query_duration(Gst.Format.TIME)
            if success:
                return dur / Gst.SECOND
        return 0

    def _on_error(self, bus, msg):
        err, debug = msg.parse_error()
        log(f"ERROR: {err.message}")
        if debug:
            log(f"DEBUG: {debug}")

    def _on_eos(self, bus, msg):
        log("End of stream")
        status("eos")
        GLib.idle_add(self._switch_to_idle)

    _last_buffering = -1

    def _on_buffering(self, bus, msg):
        percent = msg.parse_buffering()
        if percent < 100:
            self.pipeline.set_state(Gst.State.PAUSED)
            # Only log when percentage changes by 25+
            if percent // 25 != self._last_buffering // 25:
                log(f"Buffering: {percent}%")
            self._last_buffering = percent
        else:
            if self._last_buffering < 100:
                log("Buffering complete")
            self._last_buffering = 100
            if self.current_mode != "idle":
                self.pipeline.set_state(Gst.State.PLAYING)

    def shutdown(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
        self.loop.quit()


def command_reader(controller):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            continue

        action = cmd.get("cmd")
        if action == "play":
            GLib.idle_add(controller.play_url, cmd["url"])
        elif action == "pause":
            GLib.idle_add(controller.pause)
        elif action == "resume":
            GLib.idle_add(controller.resume)
        elif action == "seek":
            GLib.idle_add(controller.seek, cmd.get("position", 0))
        elif action == "overlay":
            GLib.idle_add(controller.set_overlay, cmd.get("text", ""))
        elif action == "audio_track":
            GLib.idle_add(controller.set_audio_track, cmd.get("index", 0))
        elif action == "idle":
            GLib.idle_add(controller._switch_to_idle)
        elif action == "position":
            pos = controller.get_position()
            dur = controller.get_duration()
            print(json.dumps({"type": "position", "position": round(pos, 1), "duration": round(dur, 1)}), flush=True)
        elif action == "quit":
            GLib.idle_add(controller.shutdown)
            break

    GLib.idle_add(controller.shutdown)


def main():
    controller = StreamController()

    cmd_thread = threading.Thread(target=command_reader, args=(controller,), daemon=True)
    cmd_thread.start()

    if not controller.start():
        sys.exit(1)

    try:
        controller.loop.run()
    except KeyboardInterrupt:
        pass
    finally:
        controller.shutdown()


if __name__ == "__main__":
    main()

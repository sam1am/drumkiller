/**
 * VideoRecorder — records a play/practice session as a single WebM in the browser.
 *
 * Composites, every frame, into an offscreen 16:9 canvas, side by side:
 *   1. the webcam in a full-height portrait column on the left (CAM_FRACTION of the width),
 *   2. the highway canvas at full height, centred in the remaining area (the sides are trimmed —
 *      the road itself is at most 980 CSS px wide and centred, so lanes survive any sane window),
 *   3. a repaint of the HUD (score, combo, judgements, song info…) — the real HUD is DOM, so it
 *      would be missing from a plain canvas capture.
 *
 * The composite canvas' captureStream() video track plus the AudioEngine's capture tap (song +
 * drums, sample-accurate) — and optionally the webcam mic — go into one MediaRecorder.
 * No server, no ffmpeg: the finished Blob is offered for download on the results screen.
 */

/** Width of the camera column as a fraction of the video width. */
export const CAM_FRACTION = 0.3;
/** Aspect ratio (w/h) of the camera column — the HUD preview uses the same crop. */
export const CAM_ASPECT = (CAM_FRACTION * 16) / 9;

export interface HudSnapshot {
  score: string;
  multiplier: string;
  multiplierMax: boolean;
  combo: string;
  accuracy: string;
  stars: string;
  /** 0..1 song progress. */
  progress: number;
  title: string;
  artist: string;
  difficulty: string;
  mode: 'play' | 'practice';
  /** Latest judgement text + colour + performance.now() when it appeared. */
  judge: { text: string; color: string; at: number } | null;
  streak: { text: string; at: number } | null;
  countdown: number | null;
}

export interface VideoRecorderOptions {
  highway: HTMLCanvasElement;
  /** Webcam stream (video, optionally audio). May be null: the game is still recorded. */
  camera: MediaStream | null;
  /** Game audio (AudioEngine.captureNode.stream). */
  gameAudio: MediaStream;
  /** Mix the camera's audio track into the recording. */
  mic: boolean;
  /** Rotate the camera picture 180° (upside-down webcam). */
  rotateCamera?: boolean;
  audioContext: AudioContext;
  captureNode: MediaStreamAudioDestinationNode;
  /** Output height (16:9). */
  height: number;
  fps?: number;
  accent?: string;
  hud: () => HudSnapshot;
}

export interface RecordedVideo {
  blob: Blob;
  mimeType: string;
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
}

const JUDGE_MS = 450;
const STREAK_MS = 1400;

/** True when this browser can record at all. */
export function videoRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream === 'function' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** First MediaRecorder MIME type this browser accepts (WebM preferred). */
export function pickMimeType(): string {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

export function fileExtensionFor(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/** Open the webcam (and optionally its mic, raw — no voice processing that would mangle pad sounds). */
export async function openCamera(deviceId: string | undefined, withMic: boolean): Promise<MediaStream> {
  const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  if (deviceId) video.deviceId = { exact: deviceId };
  const audio: MediaTrackConstraints | false = withMic ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false;
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (e) {
    // A remembered camera that is no longer plugged in: fall back to the default one.
    if (deviceId && (e as DOMException).name === 'OverconstrainedError') {
      delete video.deviceId;
      return navigator.mediaDevices.getUserMedia({ video, audio });
    }
    throw e;
  }
}

export class VideoRecorder {
  readonly width: number;
  readonly height: number;
  readonly mimeType: string;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startedAt = 0;
  private lastFrame = 0;
  private frameInterval: number;
  private stopped: Promise<RecordedVideo> | null = null;

  constructor(private opts: VideoRecorderOptions) {
    this.height = opts.height;
    this.width = Math.round((opts.height * 16) / 9);
    this.frameInterval = 1000 / (opts.fps ?? 30);
    this.mimeType = pickMimeType();
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    if (opts.camera && opts.camera.getVideoTracks().length) {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.srcObject = opts.camera;
      this.video = v;
    }
  }

  /** The live webcam element (for an on-screen preview while playing). */
  get cameraElement(): HTMLVideoElement | null {
    return this.video;
  }

  async start(): Promise<void> {
    if (this.recorder) return;
    await this.video?.play().catch(() => undefined);
    const fps = 1000 / this.frameInterval;
    const canvasStream = this.canvas.captureStream(fps);
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];
    const micTrack = this.opts.mic ? this.opts.camera?.getAudioTracks()[0] : undefined;
    if (micTrack) {
      // Route the mic through the capture node so it is mixed with the game audio into one track
      // (it never reaches the speakers — the capture node is not connected to the destination).
      this.micSource = this.opts.audioContext.createMediaStreamSource(new MediaStream([micTrack]));
      this.micSource.connect(this.opts.captureNode);
    }
    tracks.push(...this.opts.gameAudio.getAudioTracks());
    this.stream = new MediaStream(tracks);
    const bps = this.height >= 1080 ? 10_000_000 : 6_000_000;
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType || undefined, videoBitsPerSecond: bps, audioBitsPerSecond: 160_000 });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.recorder.onerror = (e) => console.error('MediaRecorder error', e);
    this.frame(true);
    this.recorder.start(1000);
    this.startedAt = performance.now();
  }

  /** Composite one frame. Called after every highway draw; throttled to the target fps. */
  frame(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastFrame < this.frameInterval - 1) return;
    this.lastFrame = now;
    const { ctx, width: W, height: H } = this;
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(0, 0, W, H);
    this.drawHighway();
    this.drawCamera();
    this.drawHud(now);
  }

  /** The game area: everything right of the camera column. */
  private gameRect(): { x: number; y: number; w: number; h: number } {
    const cam = this.camRect();
    return { x: cam.w, y: 0, w: this.width - cam.w, h: this.height };
  }

  private drawHighway(): void {
    const { ctx } = this;
    const src = this.opts.highway;
    if (!src.width || !src.height) return;
    const r = this.gameRect();
    // Always full height; trim the sides symmetrically so the road stays centred. (On a window
    // narrower than the game area's aspect the top/bottom are trimmed instead.)
    const scale = Math.max(r.w / src.width, r.h / src.height);
    const w = src.width * scale;
    const h = src.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.drawImage(src, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
    ctx.restore();
  }

  private camRect(): { x: number; y: number; w: number; h: number } {
    return { x: 0, y: 0, w: Math.round(this.width * CAM_FRACTION), h: this.height };
  }

  private drawCamera(): void {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const { ctx } = this;
    const r = this.camRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    // Cover-crop the camera into the rect.
    const scale = Math.max(r.w / v.videoWidth, r.h / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    if (this.opts.rotateCamera) {
      // 180° about the column's centre: draw the same cover-crop, upside down.
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.rotate(Math.PI);
      ctx.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
    }
    ctx.drawImage(v, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
    ctx.restore();
    // Divider between the camera column and the game.
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
  }

  private drawHud(now: number): void {
    const { ctx, width: W, height: H } = this;
    const s = this.opts.hud();
    const u = H / 720; // scale unit: HUD designed at 720p
    const display = (px: number) => `${px * u}px "Bungee", "Impact", "Arial Black", sans-serif`;
    const body = (px: number, weight = 700) => `${weight} ${px * u}px "Space Grotesk", system-ui, sans-serif`;
    const mono = (px: number) => `700 ${px * u}px "JetBrains Mono", monospace`;
    const accent = this.opts.accent ?? '#ff2d75';
    const camLeft = this.camRect().w;
    const left = camLeft + 24 * u;

    // progress bar
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, 0, W, 4 * u);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#ffe600');
    grad.addColorStop(1, accent);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W * Math.max(0, Math.min(1, s.progress)), 4 * u);

    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 8 * u;
    ctx.textBaseline = 'top';

    // combo (top-left)
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f4f0ff';
    ctx.font = display(40);
    ctx.fillText(s.combo, left, 18 * u);
    ctx.font = body(10);
    ctx.fillStyle = '#a99fc0';
    ctx.fillText('C O M B O', left, 64 * u);
    if (s.mode === 'practice') {
      ctx.fillStyle = '#ff7a1a';
      ctx.font = body(11);
      ctx.fillText('PRACTICE · NO SCORE', left, 84 * u);
    }

    // score (top-right)
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f4f0ff';
    ctx.font = display(40);
    ctx.fillText(s.score, W - 24 * u, 18 * u);
    ctx.font = display(18);
    ctx.fillStyle = s.multiplierMax ? accent : '#ffe600';
    ctx.fillText(s.multiplier, W - 24 * u, 64 * u);

    // song info (top-centre, under the progress bar)
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f4f0ff';
    ctx.font = display(15);
    ctx.fillText(s.title, camLeft + (W - camLeft) / 2, 16 * u);
    ctx.font = body(11, 500);
    ctx.fillStyle = '#a99fc0';
    ctx.fillText(`${s.artist} · ${s.difficulty.toUpperCase()}`, camLeft + (W - camLeft) / 2, 38 * u);

    // accuracy + stars (bottom-right)
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#ffe600';
    ctx.font = body(15);
    ctx.fillText(s.stars.split('').join(' '), W - 24 * u, H - 18 * u);
    ctx.fillStyle = '#f4f0ff';
    ctx.font = mono(17);
    ctx.fillText(s.accuracy, W - 24 * u, H - 40 * u);

    // judgement (centre)
    if (s.judge) {
      const age = (now - s.judge.at) / JUDGE_MS;
      if (age < 1) {
        const alpha = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85;
        const scale = age < 0.15 ? 0.6 + (0.55 * age) / 0.15 : 1.15 - (0.15 * (age - 0.15)) / 0.85;
        const y = H * 0.58 - (age > 0.15 ? ((age - 0.15) / 0.85) * 40 * u : 0);
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.translate(camLeft + (W - camLeft) / 2, y);
        ctx.scale(scale, scale);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = s.judge.color;
        ctx.shadowColor = s.judge.color;
        ctx.shadowBlur = 20 * u;
        ctx.font = display(34);
        ctx.fillText(s.judge.text, 0, 0);
        ctx.restore();
      }
    }

    // streak banner
    if (s.streak) {
      const age = (now - s.streak.at) / STREAK_MS;
      if (age < 1) {
        const alpha = age < 0.12 ? age / 0.12 : age < 0.7 ? 1 : 1 - (age - 0.7) / 0.3;
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.shadowColor = accent;
        ctx.shadowBlur = 30 * u;
        ctx.font = display(52);
        ctx.fillText(s.streak.text, camLeft + (W - camLeft) / 2, H * 0.22 - (age > 0.7 ? ((age - 0.7) / 0.3) * 30 * u : 0));
        ctx.restore();
      }
    }

    // countdown
    if (s.countdown !== null) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = accent;
      ctx.shadowBlur = 40 * u;
      ctx.font = display(150);
      ctx.fillText(String(s.countdown), camLeft + (W - camLeft) / 2, H / 2);
      ctx.restore();
    }
    ctx.shadowBlur = 0;
  }

  /** Stop recording and resolve with the finished video. Camera tracks are released. */
  stop(): Promise<RecordedVideo> {
    if (this.stopped) return this.stopped;
    const rec = this.recorder;
    if (!rec) {
      this.release();
      return Promise.reject(new Error('not recording'));
    }
    this.stopped = new Promise<RecordedVideo>((resolve) => {
      rec.onstop = () => {
        const mimeType = rec.mimeType || this.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        this.release();
        resolve({ blob, mimeType, duration: (performance.now() - this.startedAt) / 1000, width: this.width, height: this.height });
      };
      // One last frame so the tail is not stale, then stop.
      this.frame(true);
      if (rec.state !== 'inactive') rec.stop();
      else rec.onstop?.(new Event('stop'));
    });
    return this.stopped;
  }

  /** Abandon the recording (quit / restart): stop everything and drop the data. */
  discard(): void {
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') {
      rec.ondataavailable = null;
      rec.onstop = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    this.chunks = [];
    this.release();
  }

  private release(): void {
    this.recorder = null;
    this.micSource?.disconnect();
    this.micSource = null;
    this.stream?.getVideoTracks().forEach((t) => t.stop());
    this.stream = null;
    this.opts.camera?.getTracks().forEach((t) => t.stop());
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.remove();
    }
  }
}

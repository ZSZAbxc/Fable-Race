/**
 * 音频系统（Web Audio API）。
 *
 * 设计要点：
 * - 引擎声用三层「音高档」loop 按车速交叉淡化 + playbackRate 微调，
 *   避免单个 loop 拉伸音高造成的电子味。三个档位来自同一段采样，
 *   只有音高不同，所以交叉淡化不会有音色跳变。
 * - 每辆车的极速不同（CarConfig.engine.maxSpeedKmh），所以 RPM 用
 *   speed/maxSpeed 归一化，慢车和快车的声音行程一致。
 * - 所有资产从 public/sfx 下按需加载，失败静默降级（没声音但不影响开车）。
 * - 浏览器自动播放策略要求首次用户手势后才能 resume AudioContext，
 *   unlock() 负责这件事。
 */

/** 事件音清单（一次性播放） */
export type SfxId =
  | "engine_start"
  | "handbrake"
  | "hit_light"
  | "hit_medium"
  | "hit_heavy"
  | "land"
  | "lap"
  | "finish"
  | "countdown"
  | "go"
  | "fall"
  | "ui_click";

const SFX_FILES: Record<SfxId, string> = {
  engine_start: "engine_start.ogg",
  handbrake: "handbrake.ogg",
  hit_light: "hit_light.ogg",
  hit_medium: "hit_medium.ogg",
  hit_heavy: "hit_heavy.ogg",
  land: "land.ogg",
  lap: "lap.ogg",
  finish: "finish.ogg",
  countdown: "countdown.ogg",
  go: "go.ogg",
  fall: "fall.ogg",
  ui_click: "ui_click.ogg",
};

/** 事件音各自的相对音量，抹平不同来源的电平差 */
const SFX_GAIN: Partial<Record<SfxId, number>> = {
  engine_start: 0.7,
  handbrake: 0.5,
  hit_light: 0.45,
  hit_medium: 0.6,
  hit_heavy: 0.8,
  land: 0.5,
  lap: 0.5,
  finish: 0.7,
  countdown: 0.5,
  go: 0.6,
  fall: 0.4,
  ui_click: 0.3,
};

/** 引擎三层：文件 + 该层对应的归一化转速中心 */
const ENGINE_LAYERS = [
  { file: "engine_low.wav", center: 0.0 },
  { file: "engine_mid.wav", center: 0.45 },
  { file: "engine_high.wav", center: 1.0 },
];

const TIRE_FILE = "tire_skid.wav";
const BASE_PATH = "sfx/";
const VOLUME_KEY = "fable.volume";
const MUTED_KEY = "fable.muted";

interface EngineLayer {
  src: AudioBufferSourceNode;
  gain: GainNode;
  center: number;
}

export class AudioSystem {
  private ctx?: AudioContext;
  private master?: GainNode;
  private buffers = new Map<string, AudioBuffer>();

  /** 引擎/胎噪属于「持续音」，只在一局游戏内存在 */
  private engine: EngineLayer[] = [];
  private engineBus?: GainNode;
  private tire?: { src: AudioBufferSourceNode; gain: GainNode };

  private volume = 0.7;
  private muted = false;
  private started = false;
  private unlocked = false;
  /** 加载失败时彻底关闭音频，避免每帧重试 */
  private failed = false;

  constructor() {
    const v = localStorage.getItem(VOLUME_KEY);
    if (v !== null) {
      const n = Number(v);
      if (Number.isFinite(n)) this.volume = Math.min(1, Math.max(0, n));
    }
    this.muted = localStorage.getItem(MUTED_KEY) === "1";
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get currentVolume(): number {
    return this.volume;
  }

  /**
   * 在首次用户手势里调用：创建/恢复 AudioContext。
   * 浏览器要求音频必须由手势触发，否则 context 会停在 suspended。
   */
  async unlock(): Promise<void> {
    if (this.failed) return;
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          this.failed = true;
          return;
        }
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.unlocked = true;
    } catch {
      this.failed = true;
    }
  }

  /** 预载全部资产；任一失败只影响该条音效 */
  async preload(): Promise<void> {
    if (this.failed) return;
    await this.unlock();
    if (!this.ctx) return;
    const files = [...Object.values(SFX_FILES), ...ENGINE_LAYERS.map((l) => l.file), TIRE_FILE];
    await Promise.all(files.map((f) => this.load(f)));
  }

  private async load(file: string): Promise<AudioBuffer | undefined> {
    if (!this.ctx) return undefined;
    const cached = this.buffers.get(file);
    if (cached) return cached;
    try {
      const res = await fetch(BASE_PATH + file);
      if (!res.ok) return undefined;
      const raw = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(raw);
      this.buffers.set(file, buf);
      return buf;
    } catch {
      return undefined;
    }
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    localStorage.setItem(VOLUME_KEY, String(this.volume));
    this.applyMaster();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    localStorage.setItem(MUTED_KEY, m ? "1" : "0");
    this.applyMaster();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private applyMaster(): void {
    if (!this.ctx || !this.master) return;
    const target = this.muted ? 0 : this.volume;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  /** 播放一次性音效 */
  play(id: SfxId, opts: { gain?: number; rate?: number } = {}): void {
    if (this.failed || !this.unlocked || !this.ctx || !this.master) return;
    const buf = this.buffers.get(SFX_FILES[id]);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const g = this.ctx.createGain();
    g.gain.value = (opts.gain ?? 1) * (SFX_GAIN[id] ?? 1);
    src.connect(g).connect(this.master);
    src.start();
  }

  /**
   * 启动引擎与胎噪的持续音。一局游戏开始时调用一次。
   * 三层 loop 同时以 0 增益播放，之后靠 updateEngine 调整混比。
   */
  startEngine(): void {
    if (this.failed || !this.ctx || !this.master || this.started) return;
    const bus = this.ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);
    this.engineBus = bus;

    for (const layer of ENGINE_LAYERS) {
      const buf = this.buffers.get(layer.file);
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(bus);
      src.start();
      this.engine.push({ src, gain: g, center: layer.center });
    }

    const tireBuf = this.buffers.get(TIRE_FILE);
    if (tireBuf) {
      const src = this.ctx.createBufferSource();
      src.buffer = tireBuf;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.master);
      src.start();
      this.tire = { src, gain: g };
    }

    this.started = this.engine.length > 0 || this.tire !== undefined;
    if (this.engine.length > 0) {
      // 引擎怠速淡入，避免开局爆音
      bus.gain.setTargetAtTime(0.5, this.ctx.currentTime, 0.3);
    }
  }

  /**
   * 每渲染帧调用。
   * @param speedKmh 当前车速
   * @param maxSpeedKmh 该车极速（归一化用）
   * @param throttle 0..1，油门开度影响音量与音高
   * @param drifting 是否在漂移（驱动胎噪）
   * @param airborne 四轮离地时压低引擎负载感
   */
  updateEngine(
    speedKmh: number,
    maxSpeedKmh: number,
    throttle: number,
    drifting: boolean,
    airborne = false
  ): void {
    if (this.failed || !this.started || !this.ctx) return;
    const t = this.ctx.currentTime;

    // 归一化转速：车速为主，油门补一点，让静止踩油门也有反应
    const speedNorm = Math.min(1, Math.max(0, speedKmh / Math.max(1, maxSpeedKmh)));
    const rpm = Math.min(1, speedNorm * 0.85 + throttle * 0.15);

    // 三层按「距离该层中心的远近」分配增益，然后归一化 —— 任意时刻
    // 总增益恒定，交叉淡化听起来是连续的一条引擎声。
    const weights = this.engine.map((l) => {
      const d = Math.abs(rpm - l.center);
      return Math.max(0, 1 - d / 0.55);
    });
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    this.engine.forEach((l, i) => {
      l.gain.gain.setTargetAtTime(weights[i] / sum, t, 0.08);
      // 每层内部再用 playbackRate 做 ±15% 的微调，补足档位之间的空隙
      const local = Math.max(-1, Math.min(1, (rpm - l.center) / 0.55));
      l.src.playbackRate.setTargetAtTime(1 + local * 0.15, t, 0.08);
    });

    if (this.engineBus) {
      // 松油门时略微收声，腾空时更轻（没有负载）
      const load = 0.34 + throttle * 0.3 + speedNorm * 0.16;
      const target = airborne ? load * 0.55 : load;
      this.engineBus.gain.setTargetAtTime(target, t, 0.12);
    }

    if (this.tire) {
      // 胎噪只在漂移且有速度时出声，音量随速度上升
      const target = drifting && !airborne ? Math.min(0.55, 0.16 + speedNorm * 0.5) : 0;
      this.tire.gain.gain.setTargetAtTime(target, t, drifting ? 0.05 : 0.18);
    }
  }

  /** 撞击：按冲击强度选择轻/中/重三档 */
  playImpact(strength: number): void {
    const id: SfxId = strength > 0.66 ? "hit_heavy" : strength > 0.33 ? "hit_medium" : "hit_light";
    this.play(id, { gain: 0.6 + strength * 0.4 });
  }

  /** 停止持续音（一局结束）。事件音与已解锁的 context 保留复用 */
  stopEngine(): void {
    const stop = (src: AudioBufferSourceNode, gain: GainNode) => {
      if (this.ctx) {
        gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
        try {
          src.stop(this.ctx.currentTime + 0.3);
        } catch {
          /* 已停止 */
        }
      } else {
        try {
          src.stop();
        } catch {
          /* 已停止 */
        }
      }
    };
    for (const l of this.engine) stop(l.src, l.gain);
    if (this.tire) stop(this.tire.src, this.tire.gain);
    this.engine = [];
    this.tire = undefined;
    this.engineBus = undefined;
    this.started = false;
  }
}

/** 全局单例：AudioContext 数量有上限，且解锁状态要跨局保留 */
export const audio = new AudioSystem();

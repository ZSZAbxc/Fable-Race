import * as THREE from "three";
import type { Room } from "colyseus.js";
import {
  CARS,
  DEFAULT_CAR_ID,
  MSG,
  NET_SEND_HZ,
  NEUTRAL_INPUT,
  getTrack,
  hasFallenOff,
  type PlayerStatePayload,
  type SpawnPose,
} from "@fable/shared";
import { PhysicsWorld } from "./PhysicsWorld";
import { Input } from "./Input";
import { ChaseCamera } from "./ChaseCamera";
import { PlaygroundScene } from "../scenes/PlaygroundScene";
import { TrackScene } from "../track/TrackScene";
import { RaceController } from "../race/RaceController";
import { CarEntity } from "../vehicle/CarEntity";
import { CarFx } from "../vehicle/CarFx";
import { RemoteCar } from "../net/RemoteCar";
import { audio } from "../audio/AudioSystem";
import { ProximityTags } from "../ui/proximity";
import { TouchControls } from "../ui/touch";
import type { Hud } from "../ui/hud";

export const PLAYGROUND_ID = "playground";

export interface SessionOptions {
  mapId: string;
  color: string;
  /** 本地玩家选择的车辆；缺省用默认车 */
  carId?: string;
  hud: Hud;
  /** 联机模式 */
  net?: {
    room: Room;
    startAt: number;
  };
}

/**
 * 一局游戏的完整运行时（渲染器/物理世界/场景/车辆/循环）。
 * dispose() 后可安全丢弃，用于"结算 → 回大厅 → 再开一局"的循环。
 */
export class GameSession {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private chase: ChaseCamera;
  private input: Input;
  private touch: TouchControls;
  private physics = new PhysicsWorld();
  private hud: Hud;

  private car: CarEntity;
  /** 纯视觉：漂移烟雾 + 胎印。只跟本地车，远端车不做（省性能） */
  private fx: CarFx;
  private spawn: SpawnPose;
  private playground?: PlaygroundScene;
  private trackScene?: TrackScene;
  private race?: RaceController;

  private net?: SessionOptions["net"];
  private remotes = new Map<string, RemoteCar>();
  /** 近距玩家提示，仅多人模式实例化 */
  private prox?: ProximityTags;
  private netSendTimer = 0;
  private stateUnsub: Array<() => unknown> = [];

  private clock = new THREE.Clock();
  private carPos = new THREE.Vector3();
  private lastCount = -1;
  private goShown = false;
  /** 上一帧速度，用于检测撞击（速度突降）与落地 */
  private prevSpeed = 0;
  private prevAirborne = false;
  /** 撞击音冷却，防止贴墙摩擦时连续触发 */
  private hitCooldown = 0;
  /** 结算后冻结输入 */
  private frozen = false;
  /** 设置浮层打开时挂起操控（联机仍继续上报，不然会被判掉线） */
  private paused = false;
  /** M 键改了音频状态后通知外部刷新设置面板 */
  onAudioChanged?: () => void;
  private disposed = false;
  private onResize = () => {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.chase.resize(window.innerWidth / window.innerHeight);
  };

  constructor(opts: SessionOptions) {
    this.hud = opts.hud;
    this.net = opts.net;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(this.renderer.domElement);

    this.chase = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.input = new Input();
    this.touch = new TouchControls(this.input);

    // ---- 场景 ----
    if (opts.mapId === PLAYGROUND_ID) {
      this.playground = new PlaygroundScene(this.scene, this.physics.world);
      this.spawn = { position: { x: 0, y: 1.0, z: 0 }, yaw: 0 };
    } else {
      const track = getTrack(opts.mapId);
      this.trackScene = new TrackScene(this.scene, this.physics.world, track);
      this.spawn = this.trackScene.spawnPose();
      this.race = new RaceController(this.trackScene, track, this.hud, !!this.net);
    }

    // ---- 联机装配 ----
    if (this.net && this.trackScene) {
      const { room } = this.net;
      const me = room.state.players?.get?.(room.sessionId);
      const keysIdx = [...(room.state.players?.keys?.() ?? [])].indexOf(room.sessionId);
      const gridIdx = me && me.spawnIndex >= 0 ? me.spawnIndex : Math.max(0, keysIdx);
      this.spawn = this.trackScene.gridPose(gridIdx);
      this.prox = new ProximityTags();
      this.bindRoom(room);
    }

    const carCfg = CARS[opts.carId ?? DEFAULT_CAR_ID] ?? CARS[DEFAULT_CAR_ID];
    this.car = new CarEntity(this.scene, this.physics.world, carCfg, this.spawn, opts.color);
    this.fx = new CarFx(this.scene);

    // 点火 → 引擎怠速持续音
    audio.play("engine_start");
    audio.startEngine();

    window.addEventListener("resize", this.onResize);
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private bindRoom(room: Room) {
    const addRemote = (p: any, id: string) => {
      if (id === room.sessionId) return;
      const rc = new RemoteCar(this.scene, p.carId, p.color, p.name);
      this.remotes.set(id, rc);
      rc.push(p.x, p.y, p.z, p.qx, p.qy, p.qz, p.qw);
      p.onChange(() => rc.push(p.x, p.y, p.z, p.qx, p.qy, p.qz, p.qw));
      this.updateRoomTag(room);
    };
    this.stateUnsub.push(room.state.players.onAdd(addRemote));
    this.stateUnsub.push(
      room.state.players.onRemove((_p: any, id: string) => {
        this.remotes.get(id)?.dispose(this.scene);
        this.remotes.delete(id);
        this.prox?.drop(id);
        this.updateRoomTag(room);
      })
    );
    this.updateRoomTag(room);
  }

  private updateRoomTag(room: Room) {
    const el = document.getElementById("maps");
    if (el) {
      el.innerHTML = `<span class="room-tag">房间 ${room.roomId} · ${room.state.players?.size ?? 1} 人</span>`;
    }
  }

  /** 结算时调用：停止输入与上报，画面保留 */
  freeze(): void {
    this.frozen = true;
    // 结算浮层弹出，触屏按钮让位
    this.touch.setVisible(false);
  }

  /**
   * 设置浮层开关时调用：挂起操控。
   * 只切输入，物理与联机上报照常 —— 联机是权威服务端，
   * 暂停本地物理会导致位姿与服务端分叉，也可能被判为掉线。
   */
  setPaused(v: boolean): void {
    this.paused = v;
    // 清掉按住的键与积压的边沿，否则关闭浮层瞬间会突然给一脚油门/手刹
    if (v) this.input.clear();
    // 设置浮层盖在 z-index:30，触屏按钮不收起会挡住滑条
    if (!this.frozen) this.touch.setVisible(!v);
  }

  /** 设置里切换屏幕操作按键，即时生效 */
  setTouchControls(on: boolean): void {
    this.touch.setEnabled(on);
  }

  /**
   * 把物理状态映射到声音。
   * 撞击靠「速度突降」检测：Rapier 的射线悬挂载具没有碰撞事件回调，
   * 但撞墙一定伴随明显减速，配合冷却时间足够可靠。
   */
  private updateAudio(dt: number, throttle: number, locked: boolean): void {
    const phys = this.car.physics;
    const speed = phys.speedKmh();
    const airborne = phys.contactCount() === 0;

    audio.updateEngine(
      speed,
      phys.config.engine.maxSpeedKmh,
      locked ? 0 : throttle,
      !locked && phys.isDrifting(),
      airborne
    );

    if (this.hitCooldown > 0) this.hitCooldown -= dt;

    // 落地：从腾空回到接地且有一定下坠速度
    if (this.prevAirborne && !airborne) {
      const vy = Math.abs(phys.body.linvel().y);
      if (vy > 2) audio.play("land", { gain: Math.min(1, vy / 14) });
    }

    // 撞击：一帧内掉速超过阈值
    const drop = this.prevSpeed - speed;
    if (!locked && this.hitCooldown <= 0 && drop > 14 && this.prevSpeed > 22) {
      audio.playImpact(Math.min(1, (drop - 14) / 45));
      this.hitCooldown = 0.25;
    }

    this.prevSpeed = speed;
    this.prevAirborne = airborne;
  }

  private tick() {
    if (this.disposed) return;
    const dt = this.clock.getDelta();
    const now = performance.now();
    const wallNow = Date.now();

    if (!this.frozen && !this.paused && this.input.consumeReset()) {
      this.car.physics.reset(this.race ? this.race.respawnPose(this.spawn) : this.spawn);
      this.prevSpeed = 0;
    }

    if (this.input.consumeMuteToggle()) {
      this.hud.banner(audio.toggleMuted() ? "已静音（M 恢复）" : "已恢复音效", 1200);
      this.onAudioChanged?.();
    }

    // 锁输入：结算冻结 / 设置浮层打开 / 起跑倒计时未结束
    const locked = this.frozen || this.paused || (this.net !== undefined && wallNow < this.net.startAt);
    if (this.net && !this.frozen && wallNow < this.net.startAt) {
      const remain = Math.ceil((this.net.startAt - wallNow) / 1000);
      if (remain !== this.lastCount) {
        this.lastCount = remain;
        this.hud.banner(String(remain), 900);
        audio.play("countdown");
      }
    } else if (this.net && !this.goShown && !this.frozen) {
      this.goShown = true;
      this.hud.banner("GO！", 1000);
      audio.play("go");
    }

    const vehicleInput = locked ? NEUTRAL_INPUT : this.input.vehicle();
    // 手刹按下瞬间给一声，起手感更清晰；锁输入时丢弃这次边沿
    if (this.input.consumeHandbrakePress() && !locked && this.car.physics.speedKmh() > 15) {
      audio.play("handbrake");
    }
    this.physics.advance(dt, (h) => this.car.physics.update(vehicleInput, h));

    // 坠落传送：掉出赛道后直接送回最近检查点。
    // 放在 race.update 之前，重生后的新位置当帧即生效，
    // 不会拿坠落中的坐标去撞检查点判定。
    if (!locked && this.trackScene && this.race && hasFallenOff(this.car.physics.position(), this.trackScene.samples)) {
      this.car.physics.reset(this.race.progress.respawnPose(this.spawn));
      this.hud.banner("坠落 —— 已送回最近检查点", 1800);
      audio.play("fall");
      // 复位后速度归零，别让它被当成撞击
      this.prevSpeed = 0;
    }

    // ---- 音效驱动 ----
    this.updateAudio(dt, vehicleInput.throttle, locked);

    this.car.sync();
    this.fx.update(dt, this.car.physics);
    this.playground?.sync();
    this.remotes.forEach((rc) => rc.update(dt));
    if (!locked) this.race?.update(this.car.physics, now);

    // 位姿上报 20Hz（含水平速度，供服务端权威计圈）
    if (this.net && !this.frozen) {
      this.netSendTimer += dt;
      if (this.netSendTimer >= 1 / NET_SEND_HZ) {
        this.netSendTimer = 0;
        const p = this.car.physics.position();
        const q = this.car.physics.rotation();
        const v = this.car.physics.body.linvel();
        const payload: PlayerStatePayload = {
          x: p.x,
          y: p.y,
          z: p.z,
          qx: q.x,
          qy: q.y,
          qz: q.z,
          qw: q.w,
          vx: v.x,
          vz: v.z,
        };
        this.net.room.send(MSG.STATE, payload);
      }
      // 服务端权威名次
      const me = this.net.room.state.players?.get?.(this.net.room.sessionId);
      if (me) this.hud.setRank(me.rank, this.net.room.state.players.size);
    }

    const p = this.car.physics.position();
    this.carPos.set(p.x, p.y, p.z);
    this.chase.update(dt, this.carPos, this.car.physics.yaw());

    // 相机更新后才能投影名牌
    this.prox?.update(this.chase.camera, this.remotes);

    this.hud.setSpeed(this.car.physics.speedKmh());
    this.renderer.render(this.scene, this.chase.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this.onResize);
    this.input.dispose();
    this.touch.dispose();
    audio.stopEngine();
    this.fx.dispose();
    for (const off of this.stateUnsub) off();
    this.stateUnsub = [];
    this.prox?.clear();
    this.remotes.forEach((rc) => rc.dispose(this.scene));
    this.remotes.clear();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.physics.world.free();
    this.hud.setRaceVisible(false);
    this.hud.hideBanner();
  }
}

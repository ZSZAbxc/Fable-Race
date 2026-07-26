import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  buildCheckpoints,
  buildRibbonGeometry,
  buildWallSegments,
  inWindows,
  sampleClosedSpline,
  trackExclusionWindows,
  yawOf,
  type Checkpoint,
  type DistWindow,
  type SidedWindow,
  type RibbonGeometry,
  type SpawnPose,
  type SplineSample,
  type TrackConfig,
} from "@fable/shared";

/** 路缘宽度 */
const CURB_W = 0.85;

/**
 * 程序化赛道场景：由 TrackConfig 的样条控制点生成
 * 路面/路缘/护栏/起点拱门/检查点标记 + 对应 Rapier 碰撞体。
 */
export class TrackScene {
  readonly checkpoints: Checkpoint[];
  readonly totalLength: number;
  /** 中心线采样点：坠落检测的参照（见 hasFallenOff） */
  readonly samples: SplineSample[];

  private cpMarkers: THREE.Mesh[][] = [];
  private matCpIdle: THREE.MeshStandardMaterial;
  private matCpActive: THREE.MeshStandardMaterial;
  private activeCp = -1;

  constructor(scene: THREE.Scene, world: RAPIER.World, readonly config: TrackConfig) {
    const { samples, totalLength } = sampleClosedSpline(config.controlPoints, 2);
    this.totalLength = totalLength;
    this.samples = samples;
    // 断口区不放检查点（与服务端同一份窗口，判定一致）
    const exclusions = trackExclusionWindows(config);
    this.checkpoints = buildCheckpoints(samples, config.checkpointEvery, totalLength, exclusions);

    this.matCpIdle = new THREE.MeshStandardMaterial({ color: 0x3f76c9, roughness: 0.5 });
    this.matCpActive = new THREE.MeshStandardMaterial({
      color: 0xffa62b,
      emissive: 0xff8c00,
      emissiveIntensity: 0.9,
      roughness: 0.4,
    });

    this.buildEnvironment(scene, world);

    // ---- 赛道路面（单一闭环） ----
    this.buildRoadway(
      scene,
      world,
      samples,
      config.roadWidth,
      config.gaps,
      true,
      config.widthZones,
      config.ramps
    );

    // ---- 路面行进方向箭头 ----
    this.buildDirectionArrows(scene, samples, totalLength, exclusions);

    // ---- 断口警示（起跳台边缘斜纹板） ----
    this.buildGapMarkers(scene, samples, config.gaps, config.roadWidth);

    // ---- 起点线 + 拱门 ----
    this.buildStartLine(scene);

    // ---- 检查点标记（路两侧立柱） ----
    this.buildCheckpointMarkers(scene);
  }

  /**
   * 赛道路面：trimesh 碰撞体 + 沥青/路缘视觉 + 两侧护栏。
   * gaps 窗口内不生成任何几何，形成可飞跃的空中断口。
   */
  private buildRoadway(
    scene: THREE.Scene,
    world: RAPIER.World,
    samples: SplineSample[],
    roadWidth: number,
    gaps: DistWindow[] | undefined,
    closed: boolean,
    widthZones?: TrackConfig["widthZones"],
    ramps?: TrackConfig["ramps"]
  ) {
    const hw = roadWidth / 2;
    // 路缘是固定宽度的贴边，随路面缩放会在加宽段被拉成夸张的宽带，
    // 所以只把 widthZones 交给路面/护栏，路缘用 pad 常量贴在缩放后的边上。
    const opts = { closed, skipWindows: gaps, widthZones, ramps };

    const roadFull = buildRibbonGeometry(samples, hw, -hw, {
      ...opts,
      leftPad: CURB_W,
      rightPad: -CURB_W,
    });
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(roadFull.positions, roadFull.indices).setFriction(1.0)
    );

    const roadVisual = buildRibbonGeometry(samples, hw, -hw, {
      ...opts,
      yLift: 0.01,
      vScale: roadWidth,
    });
    const roadMesh = new THREE.Mesh(this.toGeometry(roadVisual), this.asphaltMaterial());
    roadMesh.receiveShadow = true;
    scene.add(roadMesh);

    const curbMat = this.curbMaterial();
    for (const [a, b, pa, pb] of [
      [hw, hw, CURB_W, 0],
      [-hw, -hw, 0, -CURB_W],
    ] as [number, number, number, number][]) {
      const curb = new THREE.Mesh(
        this.toGeometry(
          buildRibbonGeometry(samples, a, b, {
            ...opts,
            yLift: 0.02,
            vScale: 4,
            leftPad: pa,
            rightPad: pb,
          })
        ),
        curbMat
      );
      curb.receiveShadow = true;
      scene.add(curb);
    }

    // 护栏跳过断口：断口两侧要敞开，否则护栏会横在起跳/落地口
    const skip: SidedWindow[] = [...(gaps ?? [])];
    this.buildWalls(scene, world, samples, roadWidth, closed, skip, widthZones, ramps);
  }

  /** 出生点：起点线后方 12m 居中 */
  spawnPose(): SpawnPose {
    return this.gridPose(-1);
  }

  /** 多人起跑格子位：两列交错向后排（index 0 起）；-1 = 居中单机位 */
  gridPose(index: number): SpawnPose {
    const cp0 = this.checkpoints[0];
    const fwd = cp0.forward;
    // left = up × forward
    const lx = fwd.z;
    const lz = -fwd.x;
    const back = index < 0 ? 12 : 12 + Math.floor(index / 2) * 7.5;
    const lateral = index < 0 ? 0 : (index % 2 === 0 ? -1 : 1) * this.config.roadWidth / 5;
    return {
      position: {
        x: cp0.position.x - fwd.x * back + lx * lateral,
        y: cp0.position.y + 0.8,
        z: cp0.position.z - fwd.z * back + lz * lateral,
      },
      yaw: cp0.yaw,
    };
  }

  /** 高亮下一个检查点 */
  setActiveCheckpoint(index: number): void {
    if (index === this.activeCp) return;
    if (this.activeCp >= 0) {
      for (const m of this.cpMarkers[this.activeCp] ?? []) m.material = this.matCpIdle;
    }
    for (const m of this.cpMarkers[index] ?? []) m.material = this.matCpActive;
    this.activeCp = index;
  }

  // ================= 内部构建 =================

  private buildEnvironment(scene: THREE.Scene, world: RAPIER.World) {
    const env = this.config.environment;
    scene.background = new THREE.Color(env.sky);
    scene.fog = new THREE.Fog(env.fog, env.fogNear, env.fogFar);

    scene.add(new THREE.HemisphereLight(0xffffff, new THREE.Color(env.ground), 0.85));
    const sun = new THREE.DirectionalLight(0xfff0d8, env.sun);
    sun.position.set(80, 110, 50);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 140;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = 400;
    sun.shadow.bias = -0.0006;
    scene.add(sun);

    // 草地
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d")!;
    const base = new THREE.Color(env.ground);
    ctx.fillStyle = `#${base.getHexString()}`;
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = `#${base.clone().offsetHSL(0, 0.02, 0.03).getHexString()}`;
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillRect(64, 64, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(160, 160);
    tex.colorSpace = THREE.SRGBColorSpace;

    const size = 1000;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    scene.add(ground);

    world.createCollider(
      RAPIER.ColliderDesc.cuboid(size / 2, 0.5, size / 2).setTranslation(0, -0.55, 0).setFriction(0.9)
    );
  }

  /** 路面行进方向箭头（黄色 V 形，沿中心线每隔一段一个） */
  private buildDirectionArrows(
    scene: THREE.Scene,
    samples: SplineSample[],
    totalLength: number,
    skipWindows?: DistWindow[],
    roadWidth = this.config.roadWidth
  ) {
    // V 形箭头（shape 空间 +Y 为前进方向）
    const shape = new THREE.Shape();
    shape.moveTo(0, 1.25);
    shape.lineTo(-1.0, -0.2);
    shape.lineTo(-1.0, -1.15);
    shape.lineTo(0, 0.25);
    shape.lineTo(1.0, -1.15);
    shape.lineTo(1.0, -0.2);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd23e,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const EVERY = 22;
    const spots: { x: number; y: number; z: number; yaw: number }[] = [];
    let nextAt = EVERY;
    for (const s of samples) {
      if (s.distance < nextAt) continue;
      // 避开起点线/拱门区域，以及断口
      if (s.distance > 14 && s.distance < totalLength - 10 && !inWindows(s.distance, skipWindows)) {
        spots.push({ ...s.position, yaw: yawOf(s.tangent) });
      }
      nextAt += EVERY;
    }

    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    inst.renderOrder = 1;
    const arrowScale = Math.min(2.2, Math.max(1, roadWidth / 12));
    const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3(arrowScale, arrowScale, 1);
    spots.forEach((s, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.yaw).multiply(pitch);
      p.set(s.x, s.y + 0.06, s.z);
      m.compose(p, q, sc);
      inst.setMatrixAt(i, m);
    });
    scene.add(inst);
  }

  private buildWalls(
    scene: THREE.Scene,
    world: RAPIER.World,
    samples: SplineSample[],
    roadWidth = this.config.roadWidth,
    closed = true,
    skipWindows?: SidedWindow[],
    widthZones?: TrackConfig["widthZones"],
    ramps?: TrackConfig["ramps"]
  ) {
    const cfg = this.config;
    // 只有路面半宽随加宽缩放；路缘+余量是固定尺寸，走 pad 不缩放，
    // 否则 200% 加宽段的护栏会离路缘边多出一米多的空隙。
    const hw = roadWidth / 2;
    const PAD = CURB_W + 0.35;
    const wo = { closed, skipWindows, wallHeight: cfg.wallHeight, widthZones, ramps };
    const segsL = buildWallSegments(samples, hw, { ...wo, pad: PAD });
    const segsR = buildWallSegments(samples, -hw, { ...wo, pad: -PAD });
    const all = [...segsL, ...segsR];

    const geo = new THREE.BoxGeometry(0.3, cfg.wallHeight, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xcfd6dd, roughness: 0.6, metalness: 0.2 });
    const inst = new THREE.InstancedMesh(geo, mat, all.length);
    inst.castShadow = true;
    inst.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    all.forEach((seg, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, seg.yaw);
      p.set(seg.center.x, seg.center.y + cfg.wallHeight / 2, seg.center.z);
      sc.set(1, 1, seg.halfLength * 2);
      m.compose(p, q, sc);
      inst.setMatrixAt(i, m);

      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.15, cfg.wallHeight / 2, seg.halfLength)
          .setTranslation(seg.center.x, seg.center.y + cfg.wallHeight / 2, seg.center.z)
          .setRotation({ x: 0, y: Math.sin(seg.yaw / 2), z: 0, w: Math.cos(seg.yaw / 2) })
          .setFriction(0.1)
          .setRestitution(0.3)
      );
    });
    scene.add(inst);
  }

  /** 断口两侧边缘的黄黑斜纹警示板：提示"这里要起跳" */
  private buildGapMarkers(
    scene: THREE.Scene,
    samples: SplineSample[],
    gaps: DistWindow[] | undefined,
    roadWidth: number
  ) {
    if (!gaps?.length) return;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#f6b93b";
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = "#1e272e";
    ctx.lineWidth = 14;
    for (let i = -64; i < 128; i += 28) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 64, 64);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });

    const nearest = (d: number) =>
      samples.reduce((a, s) => (Math.abs(s.distance - d) < Math.abs(a.distance - d) ? s : a), samples[0]);

    for (const g of gaps) {
      for (const [d, flip] of [
        [g.fromDist, 0],
        [g.toDist, Math.PI],
      ] as [number, number][]) {
        const s = nearest(d);
        const plate = new THREE.Mesh(new THREE.BoxGeometry(roadWidth, 0.45, 0.35), mat);
        plate.position.set(s.position.x, s.position.y + 0.22, s.position.z);
        plate.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yawOf(s.tangent) + flip);
        plate.castShadow = true;
        scene.add(plate);
      }
    }
  }

  private buildStartLine(scene: THREE.Scene) {
    const cp0 = this.checkpoints[0];
    const cfg = this.config;
    const hw = cfg.roadWidth / 2;
    const yaw = cp0.yaw;
    const quat = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);

    // 黑白格起点线
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 32;
    const ctx = c.getContext("2d")!;
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 4; j++) {
        ctx.fillStyle = (i + j) % 2 === 0 ? "#fff" : "#111";
        ctx.fillRect(i * 8, j * 8, 8, 8);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(cfg.roadWidth, 2.4),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set(cp0.position.x, cp0.position.y + 0.035, cp0.position.z);
    line.quaternion.multiplyQuaternions(quat, line.quaternion);
    scene.add(line);

    // 拱门：两根立柱 + 横梁
    const postGeo = new THREE.BoxGeometry(0.5, 6, 0.5);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2f3640, roughness: 0.5 });
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(quat); // 局部 +X → 世界
    for (const dir of [1, -1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(
        cp0.position.x + side.x * (hw + 1.5) * dir,
        cp0.position.y + 3,
        cp0.position.z + side.z * (hw + 1.5) * dir
      );
      post.castShadow = true;
      scene.add(post);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(cfg.roadWidth + 3.5, 0.9, 0.6),
      new THREE.MeshStandardMaterial({ color: 0xe84118, roughness: 0.4 })
    );
    beam.position.set(cp0.position.x, cp0.position.y + 6.1, cp0.position.z);
    beam.quaternion.copy(quat);
    beam.castShadow = true;
    scene.add(beam);
  }

  private buildCheckpointMarkers(scene: THREE.Scene) {
    const hw = this.config.roadWidth / 2;
    const geo = new THREE.CylinderGeometry(0.16, 0.2, 2.4, 10);
    for (const cp of this.checkpoints) {
      const quat = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, cp.yaw);
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
      const pair: THREE.Mesh[] = [];
      if (cp.index === 0) {
        this.cpMarkers.push(pair); // 起点线已有拱门，不放柱子
        continue;
      }
      for (const dir of [1, -1]) {
        const pole = new THREE.Mesh(geo, this.matCpIdle);
        pole.position.set(
          cp.position.x + side.x * (hw + 0.5) * dir,
          cp.position.y + 1.2,
          cp.position.z + side.z * (hw + 0.5) * dir
        );
        pole.castShadow = true;
        scene.add(pole);
        pair.push(pole);
      }
      this.cpMarkers.push(pair);
    }
  }

  private toGeometry(r: RibbonGeometry): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(r.positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(r.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(r.indices, 1));
    geo.computeVertexNormals();
    return geo;
  }

  private asphaltMaterial(): THREE.MeshStandardMaterial {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#3a3d42";
    ctx.fillRect(0, 0, 256, 256);
    // 噪点
    for (let i = 0; i < 900; i++) {
      const g = 52 + Math.random() * 26;
      ctx.fillStyle = `rgb(${g},${g},${g + 4})`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    // 白色边线
    ctx.fillStyle = "#e8e8e8";
    ctx.fillRect(6, 0, 5, 256);
    ctx.fillRect(245, 0, 5, 256);
    // 中央虚线
    ctx.fillStyle = "#ffd23e";
    for (let y = 0; y < 256; y += 64) ctx.fillRect(125, y, 6, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 });
  }

  private curbMaterial(): THREE.MeshStandardMaterial {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#d63031";
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = "#f5f6fa";
    ctx.fillRect(0, 32, 32, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  }
}

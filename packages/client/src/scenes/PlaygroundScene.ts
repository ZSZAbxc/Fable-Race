import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

/** 需要每帧同步位姿的动态物体（可推撞的箱子等） */
export interface DynamicProp {
  mesh: THREE.Object3D;
  body: RAPIER.RigidBody;
}

/**
 * 自由试车场（手感调参用，非比赛场景；比赛赛道由 TrackScene 从样条程序化生成）：
 * 棋盘格大地面 + 飞跳坡道 + 静态障碍 + 可撞飞的动态箱子。
 */
export class PlaygroundScene {
  readonly dynamics: DynamicProp[] = [];

  constructor(scene: THREE.Scene, world: RAPIER.World) {
    this.buildLights(scene);
    this.buildGround(scene, world);
    this.buildRamp(scene, world, new THREE.Vector3(0, 0, 42), 0.2);
    this.buildRamp(scene, world, new THREE.Vector3(-24, 0, -30), 0.28, Math.PI);
    this.buildStaticBoxes(scene, world);
    this.buildCrates(scene, world);
  }

  private buildLights(scene: THREE.Scene) {
    scene.background = new THREE.Color(0x87b5e0);
    scene.fog = new THREE.Fog(0x87b5e0, 120, 420);

    scene.add(new THREE.HemisphereLight(0xcfe5ff, 0x5a6b52, 0.9));

    const sun = new THREE.DirectionalLight(0xfff2d9, 2.2);
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 90;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = 300;
    sun.shadow.bias = -0.0005;
    scene.add(sun);
  }

  private buildGround(scene: THREE.Scene, world: RAPIER.World) {
    // 棋盘格纹理（提供速度感）
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#6d7f5a";
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = "#77895f";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillRect(128, 128, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(120, 120);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;

    const size = 800;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 1 })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    scene.add(mesh);

    world.createCollider(
      RAPIER.ColliderDesc.cuboid(size / 2, 0.5, size / 2)
        .setTranslation(0, -0.5, 0)
        .setFriction(1.0)
    );
  }

  /** 飞跳坡道：低端顶面与地面齐平，上坡顺滑 */
  private buildRamp(
    scene: THREE.Scene,
    world: RAPIER.World,
    at: THREE.Vector3,
    angle: number,
    yaw = 0
  ) {
    const half = new THREE.Vector3(4.5, 0.25, 7);
    // 绕 X 轴 -angle（+Z 端翘起）；中心高度让顶面低端边缘正好贴地
    const centerY = half.z * Math.sin(angle) - half.y * Math.cos(angle);
    const quat = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -angle));

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2),
      new THREE.MeshStandardMaterial({ color: 0xb8874a, roughness: 0.9 })
    );
    mesh.position.set(at.x, centerY, at.z);
    mesh.quaternion.copy(quat);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);

    world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setTranslation(at.x, centerY, at.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
        .setFriction(1.0)
    );
  }

  private buildStaticBoxes(scene: THREE.Scene, world: RAPIER.World) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a94a6, roughness: 0.8 });
    const spots: Array<[number, number, number, number]> = [
      // x, z, 半宽, 半高
      [18, 20, 2, 1.2],
      [-16, 12, 1.5, 2],
      [30, -12, 2.5, 1],
      [-8, -24, 2, 1.5],
    ];
    for (const [x, z, hw, hh] of spots) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, hh * 2, hw * 2), mat);
      mesh.position.set(x, hh, z);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(hw, hh, hw).setTranslation(x, hh, z).setFriction(0.8)
      );
    }
  }

  /** 可撞飞的轻箱子 */
  private buildCrates(scene: THREE.Scene, world: RAPIER.World) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.7 });
    const h = 0.45;
    const positions = [
      [8, 0.5, 14], [8.9, 0.5, 14.1], [8.4, 1.5, 14], // 小堆
      [-10, 0.5, 24], [-11, 0.5, 24.2],
      [14, 0.5, -8],
    ];
    for (const [x, y, z] of positions) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(h * 2, h * 2, h * 2), mat);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);

      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(h, h, h).setDensity(35).setFriction(0.6),
        body
      );
      this.dynamics.push({ mesh, body });
    }
  }

  /** 同步动态物体位姿到渲染 */
  sync(): void {
    for (const { mesh, body } of this.dynamics) {
      const p = body.translation();
      const q = body.rotation();
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }
}

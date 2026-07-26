import * as THREE from "three";

/**
 * 追尾相机：只跟随车辆偏航角（忽略俯仰/侧倾，上坡飞跳不晕），
 * 位置与注视点均做帧率无关的指数平滑。
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;

  private offset = new THREE.Vector3(0, 2.6, -6.4); // 车后上方
  private lookOffset = new THREE.Vector3(0, 1.1, 2.5); // 注视车前方
  private smoothPos = new THREE.Vector3();
  private smoothLook = new THREE.Vector3();
  private tmpPos = new THREE.Vector3();
  private tmpLook = new THREE.Vector3();
  private yawQuat = new THREE.Quaternion();
  private initialized = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 600);
  }

  update(dt: number, carPos: THREE.Vector3, carYaw: number): void {
    this.yawQuat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, carYaw);

    this.tmpPos.copy(this.offset).applyQuaternion(this.yawQuat).add(carPos);
    this.tmpLook.copy(this.lookOffset).applyQuaternion(this.yawQuat).add(carPos);

    if (!this.initialized) {
      this.smoothPos.copy(this.tmpPos);
      this.smoothLook.copy(this.tmpLook);
      this.initialized = true;
    } else {
      const kPos = 1 - Math.exp(-5 * dt);
      const kLook = 1 - Math.exp(-10 * dt);
      this.smoothPos.lerp(this.tmpPos, kPos);
      this.smoothLook.lerp(this.tmpLook, kLook);
    }

    this.camera.position.copy(this.smoothPos);
    this.camera.lookAt(this.smoothLook);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

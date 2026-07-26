/** 车辆配置——数据驱动：新增一辆车 = 新增一个 JSON 文件 */
export interface CarConfig {
  id: string;
  /** 展示名称 */
  name: string;
  /** 默认车身颜色 (hex) */
  color: string;
  chassis: {
    /** 碰撞盒半尺寸 [x, y, z]（米），z 为车头方向 */
    halfExtents: [number, number, number];
    /** 整车质量 (kg) */
    mass: number;
    /** 质心下移量（负值更稳、不易翻车） */
    centerOfMassY: number;
  };
  /** 驱动形式 */
  drivetrain: "RWD" | "FWD" | "AWD";
  engine: {
    /** 最大驱动力 (N) */
    maxForce: number;
    maxSpeedKmh: number;
    reverseMaxSpeedKmh: number;
    /** 刹车力度（每轮） */
    brakeForce: number;
    /** 手刹力度（后轮） */
    handbrakeForce: number;
    /** 滑行阻力（松开油门/刹车后自然减速，每轮） */
    coastBrake: number;
  };
  steering: {
    /** 低速最大转向角（度） */
    maxAngleDeg: number;
    /** 高速最大转向角（度）——防止高速翻车 */
    highSpeedAngleDeg: number;
    /** 低于此速度用最大转向角 (km/h) */
    fullSteerBelowKmh: number;
    /** 高于此速度用最小转向角 (km/h) */
    minSteerAboveKmh: number;
    /** 转向响应速率（越大打方向越快） */
    lerpRate: number;
  };
  wheels: {
    radius: number;
    width: number;
    /** 前轴 z 坐标（车体局部） */
    frontZ: number;
    /** 后轴 z 坐标 */
    rearZ: number;
    /** 半轮距（x 方向） */
    halfTrack: number;
    /** 悬挂连接点高度（车体局部） */
    connectionY: number;
  };
  suspension: {
    restLength: number;
    travel: number;
    stiffness: number;
    compression: number;
    relaxation: number;
    maxForce: number;
  };
  friction: {
    /** 纵向抓地（越大越不打滑） */
    slip: number;
    /** 侧向抓地系数 */
    sideStiffness: number;
  };
  /** 手刹漂移（按住空格触发，松开恢复抓地） */
  drift: {
    /** 漂移时后轮侧向抓地（越小越滑） */
    rearSideStiffness: number;
    /** 漂移时前轮侧向抓地 */
    frontSideStiffness: number;
    /** 车头甩动力矩 (N·m)，配合转向输入摆头 */
    yawTorque: number;
    /** 甩头最大角速度 (rad/s)，防转陀螺 */
    maxYawRate: number;
    /** 漂移期间轻微制动（略微掉速、保留动量） */
    brake: number;
    /** 漂移时引擎出力比例（避免油门把速度方向拽走） */
    engineScale: number;
    /** 低于此速度手刹退化为普通后轮抱死 (km/h) */
    minSpeedKmh: number;
  };
  aero: {
    /** 下压力系数 F = k * v^2 */
    downforce: number;
  };
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** 车辆每帧输入，范围已归一化 */
export interface VehicleInput {
  /** 0..1 */
  throttle: number;
  /** 0..1（低速时自动变为倒车） */
  brake: number;
  /** -1..1，+1 = 左转 */
  steer: number;
  handbrake: boolean;
}

export const NEUTRAL_INPUT: VehicleInput = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
};

export interface SpawnPose {
  position: Vec3Like;
  /** 绕 Y 轴朝向（弧度），0 = 朝 +Z */
  yaw: number;
}

/** 主环弧长窗口（米），用于路面挖洞/护栏开口/检查点排除 */
export interface DistWindow {
  fromDist: number;
  toDist: number;
}

/**
 * 限定侧向的弧长窗口。
 * 不带 side 时两侧同时生效；带 side 时只作用于该侧护栏。
 */
export interface SidedWindow extends DistWindow {
  side?: "left" | "right";
}

/**
 * 局部加宽区：在 [fromDist, toDist] 弧长区间内把路面宽度乘以 scale。
 * 两端各留 blend 米平滑过渡，避免路面宽度突变形成台阶。
 */
export interface WidthZone {
  fromDist: number;
  toDist: number;
  /** 宽度倍数，1 = 原宽，2 = 200% */
  scale: number;
  /** 过渡长度 (m)，默认 25 */
  blend?: number;
}

/**
 * 飞坡：路面在此处向上抬起一个楔形斜面，车冲上去会腾空。
 * 与 gaps 不同——飞坡不挖洞，慢车也只是平稳越过，不会坠落。
 */
export interface RampSpec {
  /** 起坡弧长 */
  fromDist: number;
  /** 坡顶（离地最高处）弧长 */
  peakDist: number;
  /** 坡顶离路面高度 (m) */
  height: number;
  /** 坡顶后方的落差长度 (m)：坡顶到重新接地的距离，0 = 直接切断成跳台 */
  landing: number;
}

/** 赛道配置——数据驱动：新增一张图 = 新增一个 JSON 文件 */
export interface TrackConfig {
  id: string;
  /** 展示名称 */
  name: string;
  /** 难度 1~5（大厅显示星级） */
  difficulty: number;
  /** 比赛圈数 */
  laps: number;
  /** 路面宽度 (m) */
  roadWidth: number;
  /** 护栏高度 (m) */
  wallHeight: number;
  /** 检查点间隔弧长 (m) */
  checkpointEvery: number;
  /**
   * 闭环中心线控制点 [x, y, z]（Catmull-Rom 平滑），
   * y 支持起伏坡道。第一个点附近是起点/终点线。
   */
  controlPoints: [number, number, number][];
  /** 飞跃断口：这些弧长窗口内无路面/护栏（需借速度飞跃） */
  gaps?: DistWindow[];
  /**
   * 额外的检查点排除窗口（弧长米），与 gaps 派生的窗口合并。
   * 用于赛道设计需要的"长无检查点区段"，例如让一段助跑+飞跃成为
   * 一次性挑战：失败就退回区段起点重跑，而不是在中途续命。
   * 注意：检查点同时是坠落重生点，排除一段会让该段内的坠落
   * 退回到窗口之前最后一个检查点。
   */
  checkpointExclusions?: DistWindow[];
  /** 局部加宽区（大路段） */
  widthZones?: WidthZone[];
  /** 飞坡（腾空用的斜坡，不挖洞） */
  ramps?: RampSpec[];
  environment: {
    /** 天空颜色 hex */
    sky: string;
    /** 雾颜色 hex */
    fog: string;
    fogNear: number;
    fogFar: number;
    /** 地表颜色 hex */
    ground: string;
    /** 阳光强度 */
    sun: number;
  };
}

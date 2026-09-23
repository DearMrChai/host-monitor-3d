/* ============================================================================
 * 点阵涟漪地形 (RippleTerrain)
 * ----------------------------------------------------------------------------
 * 视觉描述：
 *   - 平静时：一张纯平的点阵网格（深蓝色），像一块待机的电路板
 *   - 有涟漪时：涟漪环经过的顶点会被"抬起"（高度起伏）+ "点亮"（颜色）
 *   - 涟漪可叠加：多台设备的涟漪会互相穿过，形成漂亮的干涉图样
 * 
 * 技术原理：
 *   - 使用 Points 粒子系统（每个顶点是一个发光圆点）
 *   - 每帧遍历所有顶点，累加所有涟漪对它的贡献（波高 + 颜色）
 *   - 使用高斯包络让涟漪形成一个"环"，而不是一个"实心圆"
 * ============================================================================
 */
class RippleTerrain {
  /**
   * @param {THREE.Scene} scene - Three.js 场景对象
   * @param {Object} options - 可选参数
   * @param {number} options.size - 地形尺寸（默认 300，即 300x300 单位）
   * @param {number} options.segments - 细分段数（默认 180，即 180x180 = 32400 个顶点）
   * @param {number} options.density - 细分密度，数字越大网格越密但性能消耗越高
   */
  constructor(scene, options = {}) {
    this.scene = scene;
    
    // === 地形尺寸与细分 ===
    // size 控制地形大小，segments 控制网格密度
    // 更密的网格 = 涟漪轮廓更平滑，但顶点计算量更大
    const size = options.size || 300;
    const segments = options.segments || 180;
    
    // === 创建平面几何体 ===
    // PlaneGeometry 默认竖直，rotateX(-PI/2) 让它平铺到地面
    this.geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    this.geometry.rotateX(-Math.PI / 2);
    
    // 保存一份原始顶点坐标（未受涟漪影响的平面坐标）
    // 每帧计算涟漪时，都从这份基础坐标出发，避免累积误差
    this.basePositions = this.geometry.attributes.position.array.slice();
    this.count = this.basePositions.length / 3;
    
    // === 顶点颜色（初始为暗蓝色） ===
    // RGB 三个通道：0.02 / 0.06 / 0.15 → 近乎黑色的深蓝
    // 涟漪经过时会动态点亮顶点颜色
    const colors = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      colors[i * 3]     = 0.02;  // R
      colors[i * 3 + 1] = 0.06;  // G
      colors[i * 3 + 2] = 0.15;  // B
    }
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    
    // === 材质 ===
    // 使用 Points 材质，每个顶点渲染一个发光圆点
    // vertexColors: true → 颜色由顶点属性动态控制（用于涟漪点亮）
    // blending: AdditiveBlending → 加法混合，让点与点叠加时产生发光感
    const material = new THREE.PointsMaterial({
      size: 0.7,                              // 每个点的大小
      map: roundTexture,                       // 圆形渐变贴图（让点边缘柔和）
      vertexColors: true,                      // 启用顶点颜色（涟漪点亮需要）
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,        // 加法混合，产生发光效果
      depthWrite: false,                       // 关闭深度写入，避免透明物体互相遮挡
      sizeAttenuation: true                    // 近大远小，增强立体感
    });
    
    this.mesh = new THREE.Points(this.geometry, material);
    this.scene.add(this.mesh);
    
    // === 涟漪列表 ===
    // 每激起一个涟漪，就往这个数组 push 一个对象
    // 主循环每帧遍历所有活跃涟漪，计算它们对每个顶点的贡献
    this.ripples = [];
  }
  
  /**
   * 在指定位置激起一个涟漪
   * @param {number} x - 涟漪中心的 X 坐标
   * @param {number} z - 涟漪中心的 Z 坐标
   * @param {number} colorHex - 涟漪颜色（十六进制，如 0x00ff41 绿色）
   * @param {number} amplitude - 涟漪强度系数（默认 1.0，越大越高越亮）
   *                             状态联动建议：
   *                             空闲态 0.6 / 活跃态 0.85 / 警报态 1.2
   */
  addRipple(x, z, colorHex, amplitude = 1.0) {
    const c = new THREE.Color(colorHex);
    this.ripples.push({
      x, z,                    // 涟漪中心位置
      colorR: c.r,             // 涟漪颜色（拆成 RGB 分量方便计算）
      colorG: c.g,
      colorB: c.b,
      age: 0,                  // 已存活时间（秒）
      radius: 0,               // 当前扩散半径（age * rippleSpeed）
      amplitude                // 强度系数（乘在波高和亮度上）
    });
  }
  
  /**
   * 每帧更新（在动画循环里调用）
   * @param {number} delta - 上一帧到当前帧的时间间隔（秒）
   */
  update(delta) {
    const positions = this.geometry.attributes.position.array;
    const colors = this.geometry.attributes.color.array;
    const basePos = this.basePositions;
    
    // ==================== 参数速查 ====================
    // 这些参数在 PULSE_SETTINGS 里集中管理，下面通过闭包读取
    const height = PULSE_SETTINGS.rippleHeight;         // 涟漪高度
    const speed = PULSE_SETTINGS.rippleSpeed;           // 涟漪扩散速度
    const thickness = PULSE_SETTINGS.rippleThickness;   // 涟漪环厚度
    const brightness = PULSE_SETTINGS.rippleBrightness; // 涟漪亮度
    const maxAge = 4.0;                                  // 单个涟漪最长存活时间（秒）
    
    // ==================== 1. 更新涟漪状态 ====================
    // 每个涟漪随时间扩散，超过寿命或飞出边界就删除
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += delta;
      r.radius = r.age * speed;   // 半径 = 存活时间 × 扩散速度
      
      // 删除条件：超过寿命 或 半径超出地形范围
      if (r.age >= maxAge || r.radius > 150) {
        this.ripples.splice(i, 1);
      }
    }
    
    // ==================== 2. 遍历所有顶点，累加涟漪贡献 ====================
    for (let i = 0; i < this.count; i++) {
      const bx = basePos[i * 3];     // 基础 X 坐标
      const bz = basePos[i * 3 + 2]; // 基础 Z 坐标
      
      let y = 0;                              // 当前顶点的高度（累加值）
      let cr = 0.02, cg = 0.06, cb = 0.15;    // 当前顶点的颜色（默认暗蓝）
      
      // ==================== 3. 遍历所有涟漪，计算贡献 ====================
      for (let k = 0; k < this.ripples.length; k++) {
        const r = this.ripples[k];
        
        // --- 3.1 计算顶点到涟漪中心的距离 ---
        const dist = Math.sqrt((bx - r.x) ** 2 + (bz - r.z) ** 2);
        
        // --- 3.2 计算"到涟漪环的距离" ---
        // d = 0 表示顶点正好在环上；d > 0 表示在环外，d < 0 表示在环内
        const d = dist - r.radius;
        
        // --- 3.3 高斯包络（决定涟漪环的厚度） ---
        // 公式：exp(-d² / (thickness² × 100))
        // 效果：d 越接近 0，包络值越接近 1（波峰），远离环则快速衰减到 0
        // thickness 越大 → 分母越大 → 衰减越慢 → 涟漪越"宽"
        const envelope = Math.exp(-(d * d) / (thickness * thickness * 100));
        
        // --- 3.4 生命周期衰减（涟漪越老越弱） ---
        // ageDecay: 1.0 → 0.0 随时间线性减小
        const ageDecay = 1 - r.age / maxAge;
        
        // --- 3.5 距离衰减（越远越暗） ---
        // 公式：exp(-radius × 0.008) → 随半径指数衰减
        // 0.008 是衰减系数，改大 → 衰减更快；改小 → 涟漪能扩散得更远
        const distanceDecay = Math.exp(-r.radius * 0.008);
        
        // --- 3.6 综合波形公式 ---
        // sin(d × 0.5) 产生"波峰 + 波谷"（涟漪的上下起伏）
        // 乘上 envelope → 只在环附近有效
        // 乘上 ageDecay → 越老越弱
        // 乘上 distanceDecay → 越远越弱
        // 乘上 amplitude → 状态强度
        const wave = Math.sin(d * 0.5) * envelope * ageDecay * distanceDecay * r.amplitude;
        
        // --- 3.7 累加到高度 ---
        // 正波峰 → 顶点抬高；负波谷 → 顶点下沉
        // 再乘 rippleHeight 决定整体波动幅度
        y += wave * height;
        
        // --- 3.8 累加到颜色 ---
        // 取波形的绝对值（正峰和负谷都发光）
        // 乘 brightness 后作为颜色增量
        // 涟漪颜色本身有 RGB 三个分量，所以同时加到 cr/cg/cb
        const glow = Math.abs(wave) * brightness;
        cr += r.colorR * glow * 0.9;
        cg += r.colorG * glow * 0.9;
        cb += r.colorB * glow * 0.9;
      }
      
      // ==================== 4. 写入结果 ====================
      // 高度写入顶点位置（只改 Y，X/Z 不变）
      positions[i * 3 + 1] = y;
      
      // 颜色写入顶点颜色，钳制在 0~1 之间
      colors[i * 3]     = Math.min(1, cr);
      colors[i * 3 + 1] = Math.min(1, cg);
      colors[i * 3 + 2] = Math.min(1, cb);
    }
    
    // ==================== 5. 标记几何体需要更新 ====================
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }
}

// 使用示例：
// const rippleTerrain = new RippleTerrain(scene);
// rippleTerrain.addRipple(0, 0, 0x00ff41, 1.0);   // 在原点激起绿色涟漪
// 主循环里调用：rippleTerrain.update(delta);
/* ============================================================================
 * 8 角铁构造器 (Corner Brackets)
 * ----------------------------------------------------------------------------
 * 参考"木箱角铁"：每个角由 3 个臂组成（X / Y / Z 三轴）
 * 上下共 8 个角，形成一个透明立体空间的加固结构
 * 
 * 参数：
 *   width  - 区域宽度（X 轴）
 *   depth  - 区域深度（Z 轴）
 *   height - 区域高度（Y 轴）
 *   colorHex - 角铁颜色（跟随状态变化）
 * 
 * 返回值：THREE.Group（包含 8 个角的角铁，直接 add 到场景或父级）
 * ============================================================================
 */
function createCornerBrackets(width, depth, height, colorHex) {
  const group = new THREE.Group();
  
  // === 角铁尺寸参数（想调粗细/长短改这里） ===
  const bracketLen = width * 0.05;   // 臂长（越小越短，越隐蔽）
  const bracketThk = 0.08;           // 厚度
  const bracketWid = 0.15;           // 宽度
  
  // === 材质（微弱发光，若有若无感） ===
  const bracketMat = new THREE.MeshStandardMaterial({
    color: colorHex,
    emissive: colorHex,
    emissiveIntensity: 0.06,   // 自发光强度（越低越隐形）
    transparent: true,
    opacity: 0.22,             // 整体透明度（越低越淡）
    roughness: 0.6,
    metalness: 0.8
  });
  
  // === 四个底部角 + 四个顶部角 ===
  const corners = [
    [-width/2, -depth/2],  // 左下
    [ width/2, -depth/2],  // 右下
    [-width/2,  depth/2],  // 左上
    [ width/2,  depth/2]   // 右上
  ];
  
  const boxBottomY = -2;  // 底部角铁的 Y 坐标（沉入地面下 2 单位）
  const boxTopY = height; // 顶部角铁的 Y 坐标
  
  corners.forEach(([cx, cz]) => {
    // 判断角铁向内延伸的方向（右上角的角铁要往左下伸）
    const xDir = cx > 0 ? -1 : 1;
    const zDir = cz > 0 ? -1 : 1;
    
    // ================= 底部角铁 =================
    const bottomGroup = new THREE.Group();
    bottomGroup.position.set(cx, boxBottomY, cz);
    
    // 垂直臂（向上）
    const vArmBottom = new THREE.Mesh(
      new THREE.BoxGeometry(bracketWid, bracketLen, bracketWid),
      bracketMat
    );
    vArmBottom.position.set(0, bracketLen / 2, 0);
    bottomGroup.add(vArmBottom);
    
    // X 轴水平臂（向中心延伸）
    const xArmBottom = new THREE.Mesh(
      new THREE.BoxGeometry(bracketLen, bracketWid, bracketWid),
      bracketMat
    );
    xArmBottom.position.set(xDir * bracketLen / 2, bracketWid / 2, 0);
    bottomGroup.add(xArmBottom);
    
    // Z 轴水平臂（向中心延伸）
    const zArmBottom = new THREE.Mesh(
      new THREE.BoxGeometry(bracketWid, bracketWid, bracketLen),
      bracketMat
    );
    zArmBottom.position.set(0, bracketWid / 2, zDir * bracketLen / 2);
    bottomGroup.add(zArmBottom);
    
    group.add(bottomGroup);
    
    // ================= 顶部角铁 =================
    const topGroup = new THREE.Group();
    topGroup.position.set(cx, boxTopY, cz);
    
    // 垂直臂（向下）
    const vArmTop = new THREE.Mesh(
      new THREE.BoxGeometry(bracketWid, bracketLen, bracketWid),
      bracketMat
    );
    vArmTop.position.set(0, -bracketLen / 2, 0);
    topGroup.add(vArmTop);
    
    // X 轴水平臂
    const xArmTop = new THREE.Mesh(
      new THREE.BoxGeometry(bracketLen, bracketWid, bracketWid),
      bracketMat
    );
    xArmTop.position.set(xDir * bracketLen / 2, -bracketWid / 2, 0);
    topGroup.add(xArmTop);
    
    // Z 轴水平臂
    const zArmTop = new THREE.Mesh(
      new THREE.BoxGeometry(bracketWid, bracketWid, bracketLen),
      bracketMat
    );
    zArmTop.position.set(0, -bracketWid / 2, zDir * bracketLen / 2);
    topGroup.add(zArmTop);
    
    group.add(topGroup);
  });
  
  // 把材质也返回去，方便外部做颜色切换和呼吸动画
  group.userData.bracketMat = bracketMat;
  
  return group;
}
// 假设你的区域是 50 x 50 x 15
const brackets = createCornerBrackets(50, 50, 15, 0x00ff41);
brackets.position.set(zoneX, 0, zoneZ); // 放到区域中心
scene.add(brackets);

// 如果要动态切换颜色（比如状态变化）：
brackets.userData.bracketMat.color.setHex(0xff0033);
brackets.userData.bracketMat.emissive.setHex(0xff0033);

// 如果要做呼吸动画（在主循环里）：
const mat = brackets.userData.bracketMat;
mat.emissiveIntensity = 0.06 + Math.sin(elapsedTime * 1.2) * 0.03;
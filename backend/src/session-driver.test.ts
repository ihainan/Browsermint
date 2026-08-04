import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const {
  buildBrowserEnv, buildResizeDisplayCommand, BROWSER_STARTUP_COMMAND,
  BROWSER_DEVICE_SCALE_FACTOR,
} = await import("./services/driver/session-driver.js");

// 帧的像素数 = 布局 CSS 尺寸 × Chrome **启动时**的 device scale factor。模拟 dsf
// （Emulation.setDeviceMetricsOverride）不改合成器，所以这个启动参数是让画面流本身
// 变清晰的唯一开关；丢了它，cdp.service 那边把 cap 放大到 2x 也只会拿到 1x 的帧。
test("浏览器容器必须带 --force-device-scale-factor（流清晰度的唯一来源）", () => {
  const env = buildBrowserEnv("host-1");
  assert.match(env.CHROME_ARGS, /--force-device-scale-factor=2\b/);
  assert.equal(BROWSER_DEVICE_SCALE_FACTOR, 2);
  // 原有的反检测/渲染参数不能被这次改动挤掉
  assert.match(env.CHROME_ARGS, /--disable-blink-features=AutomationControlled/);
  assert.match(env.CHROME_ARGS, /--use-angle=swiftshader/);
});

// Steel 的假指纹注入会让 JS 里的 navigator.userAgent（139）与同一次请求的 HTTP
// User-Agent / sec-ch-ua（146）对不上，userAgentData.brands 还被注成空数组——真实
// 浏览器不可能这样，服务端一比就知道身份被改过，比不做任何伪装更可疑（2026-08-04
// 实测）。关掉之后三者一致。
test("必须关掉 Steel 的假指纹注入（它让 JS 与请求头自报的版本互相矛盾）", () => {
  const env = buildBrowserEnv("host-1");
  assert.equal(env.SKIP_FINGERPRINT_INJECTION, "true");
});

// 容器默认 Etc/UTC，而出口 IP 在境外：「系统时区 UTC」是机房容器的标志性特征，
// 与出口地理位置不自洽。注：实测这**不是** Google 验证码的原因，属卫生问题。
test("浏览器时区不能留在 UTC（与出口地理位置不自洽）", () => {
  const env = buildBrowserEnv("host-1");
  assert.notEqual(env.TZ, "UTC");
  assert.notEqual(env.TZ, "Etc/UTC");
  assert.equal(env.TZ, env.DEFAULT_TIMEZONE, "两个变量必须一致,否则 Chrome 与 Steel 各按各的来");
});

// Chrome 的 UI 也按 dsf 画。X 屏不跟着放大的话，noVNC 那条「打开完整浏览器」的
// 兜底路径可用逻辑空间直接减半（1920x1080 的桌面只剩 960x540 可用）。
test("X 屏尺寸按 dsf 放大，逻辑可用空间保持不变", () => {
  const cmd = buildResizeDisplayCommand(1280, 800);
  const shell = cmd.at(-1)!;
  assert.match(shell, /2560x1600/, "请求 1280x800 逻辑尺寸 → X 屏 2560x1600 物理像素");
  assert.doesNotMatch(shell, /"1280x800"/);
  assert.deepEqual(cmd.slice(0, 2), ["sh", "-c"]);
});

test("X 屏放大后仍封顶在 4K（大显示器上全屏不得要一块荒唐的 framebuffer）", () => {
  const shell = buildResizeDisplayCommand(2560, 1440).at(-1)!;
  assert.match(shell, /3840x2160/);
});

// 页面的布局宽不可能超过它所在的窗口，窗口又不可能超过 X 屏。启动几何量的是物理
// 像素，所以它同样要带 ×dsf —— 缩回 1920x1080 会把 cast 能请求的最宽视口悄悄砍半。
test("启动几何保留 1920x1080 的逻辑桌面（物理 3840x2160）", () => {
  assert.match(BROWSER_STARTUP_COMMAND, /-geometry 3840x2160\b/);
});

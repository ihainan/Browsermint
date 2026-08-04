/**
 * 协议重放：把一整段「真实形态」的画面序列喂进 producer，再用**独立写的一份合成器**
 * 把观看端收到的消息还原成画面，逐帧比对像素。
 *
 * 为什么必须单独有这一层（2026-08-04 的教训）：
 *
 * 1. **假帧让增量断言恒真**。producer 的老用例把帧写成 `"AAA"` 这样的字符串，差分器
 *    解码失败会静默回退整帧——于是「有没有发增量」「增量对不对」在那里根本无法区分，
 *    187 条全绿却对真缺陷零鉴别力。这里的帧全部是 sharp 真压出来的 JPEG。
 * 2. **判据必须落在画面上**。历史上所有用户报的画面缺陷（整体位移、顶部空白、底部截断、
 *    块贴错位置、内容过期）都是「画布显示的 ≠ 远端此刻的样子」，而断言一直落在
 *    「我们发了什么消息」，恒真。这里断言重建出来的**像素**。
 * 3. **不能拿被测代码验被测代码**。合成器在这个文件里独立实现一份（`ReferenceViewer`）：
 *    如果直接复用前端那份，两边同时错就会一起绿。
 * 4. **1x 是测不出问题的**：静帧倍率与流倍率相等时才会踩到「静帧后不重置基准」，
 *    而那只在观看端 2 倍屏时发生。所以这里默认 DPR=2。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import sharp from "sharp";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const {
  attachCastViewer, forgetTargetViewport, setTargetViewport,
  setCastTestHooks, resetCastTestHooks, setCdpServiceOverridesForTests,
  resetCdpServiceOverridesForTests,
} = await import("./services/cdp.service.js");

const SESSION = "sess-replay";
// **每条用例一个独立 target**：producer 以 session+target 为键常驻，复用同一个键会把
// 上一条用例的差分器状态（尺寸、基准、seq）带进来——表现为莫名其妙的 (size) 整帧。
let targetSeq = 0;
const nextTarget = () => `page-replay-${++targetSeq}`;
const W = 480, H = 320;                       // 布局尺寸（小一点，跑得快）
const DPR = 2;                                // **默认 2 倍屏**：见文件头第 4 条

const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 5)); };

// ── 造一张「长页」，并能按滚动位置裁出一帧 ──────────────────────────────────
//
// 页面要满足两点，否则测不出东西：行与行之间有明暗起伏（位移检测靠它），
// 且有一条**始终不动的顶栏**（真实网页普遍有，且正是它把位移判据拖偏过）。

const PAGE_H = 2400;
const STICKY = 40;

function longPage(): Buffer {
  // 像网页而不像噪声：**成块**的深色文字行 + 浅色空白，块高不一（8~44 行）。
  //
  // 两版都栽在夹具上，都值得记下来：
  //   * 第一版用 |sin(y/13)| 做明暗 → 垂直周期约 41 行，「下滚 199」与「上滚 46」
  //     在像素上同样成立，位移检测认了别名解；
  //   * 第二版用哈希的**低位**做每行亮度 → 逐行一高一低（145/54/150/62…），
  //     成了周期 2 的锯齿，任何偶数位移都对得上。
  // 真实页面既不是纯周期也不是逐行乱跳，是「几行文字 + 一段空白」的块状结构。
  const raw = Buffer.alloc(W * PAGE_H * 3);
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let y = 0;
  while (y < PAGE_H) {
    const blockH = 8 + Math.floor(rand() * 36);
    const dark = rand() < 0.55;
    const base = dark ? 30 + rand() * 60 : 170 + rand() * 60;
    for (let r = 0; r < blockH && y < PAGE_H; r++, y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        raw[i] = Math.min(255, base + ((x * 7) & 23));
        raw[i + 1] = Math.min(255, base + ((x * 3 + y) & 23));
        raw[i + 2] = Math.min(255, base + ((x ^ y) & 23));
      }
    }
  }
  return raw;
}
const PAGE = longPage();

/** 视口在 scrollY 处看到的原始像素（含固定顶栏）。 */
function viewportRaw(scrollY: number, scale = 1): { raw: Buffer; w: number; h: number } {
  const top = Math.max(0, Math.min(PAGE_H - H, scrollY));
  const out = Buffer.alloc(W * H * 3);
  PAGE.copy(out, 0, top * W * 3, (top + H) * W * 3);
  PAGE.copy(out, 0, 0, STICKY * W * 3);                 // 固定顶栏：永远是页面最上面那条
  if (scale === 1) return { raw: out, w: W, h: H };
  const big = Buffer.alloc(W * scale * H * scale * 3);  // 最近邻放大，模拟 2x 截图
  for (let y = 0; y < H * scale; y++) {
    for (let x = 0; x < W * scale; x++) {
      const src = (Math.floor(y / scale) * W + Math.floor(x / scale)) * 3;
      const dst = (y * W * scale + x) * 3;
      out.copy(big, dst, src, src + 3);
    }
  }
  return { raw: big, w: W * scale, h: H * scale };
}

const encode = async (r: { raw: Buffer; w: number; h: number }, quality: number) =>
  (await sharp(r.raw, { raw: { width: r.w, height: r.h, channels: 3 } })
    .jpeg({ quality }).toBuffer()).toString("base64");

const decode = async (b64: string) => {
  const { data, info } = await sharp(Buffer.from(b64, "base64")).removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  return { raw: data, w: info.width, h: info.height };
};

/** 两幅同尺寸图的平均像素差。JPEG 有损，判据是「接近」而不是「相等」。 */
function meanDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Infinity;
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i += 7) { sum += Math.abs(a[i] - b[i]); n++; }
  return sum / n;
}

// ── 独立的参考合成器（**不复用前端那份**）─────────────────────────────────
class ReferenceViewer {
  raw: Buffer | null = null;
  w = 0; h = 0;
  lastSeq: number | null = null;
  needKeyframeCount = 0;

  async accept(msg: any): Promise<void> {
    if (msg.data) {                                   // 整帧
      const img = await decode(msg.data);
      this.raw = img.raw; this.w = img.w; this.h = img.h;
      this.lastSeq = msg.seq ?? null;
      return;
    }
    if (!msg.delta) return;
    if (msg.base !== this.lastSeq || !this.raw) {     // 跟丢了：要一张整帧
      this.needKeyframeCount++;
      return;
    }
    const { shift, tiles } = msg.delta;
    if (shift) {
      const moved = Buffer.alloc(this.raw.length);
      for (let y = 0; y < this.h; y++) {
        const src = y + shift;
        if (src >= 0 && src < this.h) {
          this.raw.copy(moved, y * this.w * 3, src * this.w * 3, (src + 1) * this.w * 3);
        }
      }
      this.raw = moved;
    }
    for (const t of tiles || []) {
      const tile = await decode(t.data);
      for (let r = 0; r < t.h; r++) {
        tile.raw.copy(this.raw, ((t.y + r) * this.w + t.x) * 3, r * t.w * 3, (r + 1) * t.w * 3);
      }
    }
    this.lastSeq = msg.seq ?? null;
  }
}

// ── 测试装置 ────────────────────────────────────────────────────────────────
class ReplaySocket extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  sent: Array<Record<string, any>> = [];
  answerShot: ((data: string) => void) | null = null;
  scrollWidth: number | null = null;
  constructor(public url = "") { super(); setImmediate(() => this.emit("open")); }
  send(raw: string) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (msg.id === undefined) return;
    if (msg.method === "Page.captureScreenshot") {     // 静帧由测试决定什么时候回
      this.answerShot = (data: string) => {
        this.answerShot = null;
        this.emit("message", Buffer.from(JSON.stringify({ id: msg.id, result: { data } })));
      };
      return;
    }
    const result = (msg.method === "Runtime.evaluate" && this.scrollWidth !== null)
      ? { result: { value: this.scrollWidth } } : {};
    setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({ id: msg.id, result }))));
  }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
  pushFrame(data: string) {
    this.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data, sessionId: 9, metadata: { deviceWidth: W, deviceHeight: H } },
    })));
  }
}

class ReplayViewer extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  received: string[] = [];
  send(payload: string) { this.received.push(payload); }
  close() { this.readyState = 3; this.emit("close"); }
}

function setup(TARGET: string) {
  const created: ReplaySocket[] = [];
  resetCastTestHooks();
  setCdpServiceOverridesForTests({
    executeCdpCommand: async (_s, method) => method === "Target.getTargets"
      ? { targetInfos: [{ targetId: TARGET, type: "page" }] } : {},
  });
  setCastTestHooks({
    cdpBase: { sessionId: SESSION, base: "ws://fake" },
    socketFactory: () => { const s = new ReplaySocket(); created.push(s); return s as any; },
  });
  return created;
}
const teardown = () => { forgetTargetViewport(SESSION); resetCastTestHooks(); resetCdpServiceOverridesForTests(); };

/** 起一条流：返回 producer 的 socket、观看端、以及独立合成器。 */
async function startStream() {
  const TARGET = nextTarget();
  const created = setup(TARGET);
  await setTargetViewport(SESSION, TARGET, W, H, DPR);
  const viewer = new ReplayViewer();
  await attachCastViewer(SESSION, TARGET, viewer as any);
  const sock = created.at(-1)!;
  const ref = new ReferenceViewer();
  let consumed = 0;
  const drain = async () => {
    await settle();
    for (; consumed < viewer.received.length; consumed++) {
      await ref.accept(JSON.parse(viewer.received[consumed]));
    }
  };
  return { sock, viewer, ref, drain };
}

/** 送一帧「滚到 scrollY」的动帧，然后断言观看端重建出来的画面就是它。 */
async function pushAndCheck(
  h: { sock: ReplaySocket; ref: ReferenceViewer; viewer: ReplayViewer; drain: () => Promise<void> },
  scrollY: number, label: string,
) {
  // **动帧也按 DPR 出图**：真机上观看端是 2 倍屏时，流本身就是 2 倍，静帧与动帧尺寸相同——
  // 而「静帧后不重置基准」这个缺陷**只在尺寸相同时**才踩得到（尺寸不同会走 size 整帧，
  // 正好绕开）。夹具按 1 倍推流的话，这条用例永远抓不到它。
  const src = viewportRaw(scrollY, DPR);
  h.sock.pushFrame(await encode(src, 62));
  await h.drain();
  assert.ok(h.ref.raw, `${label}: 观看端什么都没收到`);
  // 重建的画面必须与「远端这一刻的样子」一致。差一个像素的位移在有纹理的页面上
  // 会让平均差飙到两位数，所以 6 是很紧的判据。
  const expect = await decode(await encode(src, 62));
  const diff = meanDiff(h.ref.raw!, expect.raw);
  if (process.env.REPLAY_DEBUG) {
    const last = JSON.parse(h.viewer.received.at(-1)!);
    console.log(`  [debug] ${label}: kind=${last.data ? "key" : "delta"} shift=${last.delta?.shift} tiles=${last.delta?.tiles?.length} diff=${diff.toFixed(1)}`);
  }
  assert.ok(diff < 6, `${label}: 重建画面与远端对不上（平均差 ${diff.toFixed(1)}）`);
}

// ── 用例 ────────────────────────────────────────────────────────────────────

test("重放：连续滚动（含非 8 倍数）逐帧都要与远端一致", async () => {
  const h = await startStream();
  try {
    let y = 0;
    await pushAndCheck(h, y, "首帧");
    for (const step of [199, 37, 128, 201, 96, 203]) {   // 故意混入非 8 倍数
      y += step;
      await pushAndCheck(h, y, `滚到 ${y}`);
    }
    assert.equal(h.ref.needKeyframeCount, 0, "正常链路上不该出现跟丢");
  } finally { teardown(); }
});

test("重放：静止 → 高清静帧 → 再滚动，画面不能整体位移", async () => {
  // 2026-08-04 用户实测的那个缺陷：静帧成了观看端的新基准，而远端基准还停在旧动帧上，
  // 于是下一帧的增量（带位移）贴到了静帧上——画面整体下移、顶部空一条、底部被切。
  const h = await startStream();
  try {
    await pushAndCheck(h, 0, "首帧");
    await pushAndCheck(h, 400, "滚一段");
    await new Promise(r => setTimeout(r, 900));          // 等静帧触发
    assert.ok(h.sock.answerShot, "静止之后应当去抓高清静帧");
    h.sock.answerShot!(await encode(viewportRaw(400, DPR), 96));   // 2x、更高画质
    await h.drain();
    assert.equal(h.ref.w, W * DPR, "观看端手里应当已经换成那张高清静帧");

    // **静帧之后必须是一个「小改动」**才测得到东西：大滚动的增量本来就不比整帧小，
    // 会退回整帧，corrupt 的增量根本不会产生（第一版就是这么漏掉的）。
    // 用户真实踩到的形态就是这个：静止 → 页面局部一动 → 增量贴到静帧上。
    const edited = viewportRaw(400, DPR);
    for (let y = 120 * DPR; y < 140 * DPR; y++) {
      for (let x = 60 * DPR; x < 180 * DPR; x++) {
        const i = (y * W * DPR + x) * 3;
        edited.raw[i] = 0; edited.raw[i + 1] = 0; edited.raw[i + 2] = 0;
      }
    }
    h.sock.pushFrame(await encode(edited, 62));
    await h.drain();
    const want = await decode(await encode(edited, 62));
    const diff = meanDiff(h.ref.raw!, want.raw);
    assert.ok(diff < 6,
      `静帧之后的第一帧不能是接在旧动帧上的增量（重建平均差 ${diff.toFixed(1)}，`
      + `画面尺寸 ${h.ref.w}x${h.ref.h}）`);
  } finally { teardown(); }
});

test("重放：慢链路丢掉一条增量后，观看端必须要整帧、不能硬贴", async () => {
  // 平台那一跳「只送最新一帧」会主动顶掉中间帧，所以丢增量是常态而不是异常。
  // 丢了之后基准就对不上，硬贴的结果是画面永久花掉——判据是「有没有去要整帧」。
  const h = await startStream();
  try {
    await pushAndCheck(h, 0, "首帧");
    // 局部小改动才会走增量：大滚动的增量不比整帧小、跨两个分带的改动面积又会超阈值，
    // 两种都会退回整帧，那样这条用例就什么也测不到了（第一版就是这么白写的）。
    const edited = (n: number) => {
      const v = viewportRaw(0, DPR);
      for (let y = (100 + n * 4) * DPR; y < (116 + n * 4) * DPR; y++) {
        for (let x = 100 * DPR; x < 200 * DPR; x++) {
          const i = (y * W * DPR + x) * 3;
          v.raw[i] = 0; v.raw[i + 1] = 0; v.raw[i + 2] = 0;
        }
      }
      return v;
    };
    h.sock.pushFrame(await encode(edited(0), 62));
    await settle();
    const dropped = JSON.parse(h.viewer.received.at(-1)!);
    assert.ok(dropped.delta, `这一帧应当是增量，实际 ${JSON.stringify(dropped).slice(0, 80)}`);
    h.viewer.received.pop();                       // 慢链路把它顶掉了
    h.sock.pushFrame(await encode(edited(1), 62));
    await h.drain();
    if (process.env.REPLAY_DEBUG) {
      console.log("  [debug] 丢掉的:", JSON.stringify({ seq: dropped.seq, base: dropped.base }),
        "之后收到:", h.viewer.received.slice(-2).map(m => { const x = JSON.parse(m); return { seq: x.seq, base: x.base, key: !!x.data }; }),
        "ref.lastSeq:", h.ref.lastSeq, "need:", h.ref.needKeyframeCount);
    }
    assert.ok(h.ref.needKeyframeCount > 0, "基准对不上时必须要整帧，不能硬贴上去");
  } finally { teardown(); }
});

test("重放：整页换掉（导航）之后画面必须立刻正确", async () => {
  const h = await startStream();
  try {
    await pushAndCheck(h, 0, "首帧");
    const other = Buffer.alloc(W * DPR * H * DPR * 3);
    for (let i = 0; i < other.length; i++) other[i] = (i * 37) & 0xff;
    const page = { raw: other, w: W * DPR, h: H * DPR };
    h.sock.pushFrame(await encode(page, 62));
    await h.drain();
    const expect = await decode(await encode(page, 62));
    assert.ok(meanDiff(h.ref.raw!, expect.raw) < 6, "换页之后画面必须是新页面");
  } finally { teardown(); }
});

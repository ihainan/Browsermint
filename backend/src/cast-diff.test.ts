/**
 * 帧差分的行为（services/cast-diff.ts）。
 *
 * 判据都落在**真实像素**上：造出「打字」「滚动」「整页换掉」三种帧，断言差分给出的
 * 结果能把上一帧还原成下一帧——而不是断言「调用了什么」。差分类逻辑写错的典型后果是
 * 画面漂移/撕裂，只有还原比对能抓住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

const { FrameDiffer, detectShift } = await import("./services/cast-diff.js");

const W = 640, H = 400;                    // 测试用小一点，逻辑与尺寸无关

/**
 * 造一张「像网页」的底图：**行与行之间要有明暗起伏**（文字行 / 空白 / 图片块）。
 *
 * 这一点不是细节：位移检测靠的正是行亮度剖面的起伏，剖面太平时会主动放弃检测
 * （大片纯色下任何位移都「对得上」，乱认会让整屏错位）。第一版的测试底图每行均值
 * 几乎一样，于是「滚动」这条用例一直失败——**是夹具不真实，不是实现不对**。
 */
function makeBase(): Buffer {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const band = 60 + 160 * Math.abs(Math.sin(y / 11));      // 行间明暗（文字行/空白）
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      raw[i] = (band + ((x * 7) & 31)) & 0xff;
      raw[i + 1] = (band + ((x * 3 + y) & 31)) & 0xff;
      raw[i + 2] = (band + ((x ^ y) & 31)) & 0xff;
    }
  }
  return raw;
}

const toJpeg = (raw: Buffer, w = W, h = H) =>
  sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 62 }).toBuffer();

/** 把差分结果贴回上一帧，得到「客户端应该看到的画面」——用来验证还原正确性。 */
async function apply(prev: Buffer, res: any): Promise<Buffer> {
  if (res.kind === "key") {
    return sharp(Buffer.from(res.data, "base64")).removeAlpha().raw().toBuffer();
  }
  const out = Buffer.alloc(prev.length);
  const shift = res.shift as number;
  for (let y = 0; y < H; y++) {
    const src = y + shift;
    if (src >= 0 && src < H) prev.copy(out, y * W * 3, src * W * 3, (src + 1) * W * 3);
  }
  for (const t of res.tiles) {
    const tile = await sharp(Buffer.from(t.data, "base64")).removeAlpha().raw().toBuffer();
    for (let r = 0; r < t.h; r++) {
      tile.copy(out, ((t.y + r) * W + t.x) * 3, r * t.w * 3, (r + 1) * t.w * 3);
    }
  }
  return out;
}

/** 两幅图的平均像素差。JPEG 有损，所以判据是「接近」而不是「相等」。 */
function meanDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 33) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length / 33);
}

test("第一帧永远是整帧（客户端手里什么都没有）", async () => {
  const d = new FrameDiffer({ tile: 64 });
  const res = await d.next(await toJpeg(makeBase()));
  assert.equal(res.kind, "key");
});

test("打字类小改动：只发变化的块，且能还原出画面", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));

  const typed = Buffer.from(base);
  for (let y = 100; y < 130; y++) for (let x = 200; x < 320; x++) {
    const i = (y * W + x) * 3; typed[i] = 0; typed[i + 1] = 0; typed[i + 2] = 0;
  }
  const res: any = await d.next(await toJpeg(typed));
  assert.equal(res.kind, "delta");
  assert.equal(res.shift, 0);
  const cols = Math.ceil(W / 64), rows = Math.ceil(H / 64);
  assert.ok(res.tiles.length > 0 && res.tiles.length < cols * rows * 0.3,
    `应当只有少数块变化，实际 ${res.tiles.length}/${cols * rows}`);

  const prevRaw = await sharp(await toJpeg(base)).removeAlpha().raw().toBuffer();
  const restored = await apply(prevRaw, res);
  const target = await sharp(await toJpeg(typed)).removeAlpha().raw().toBuffer();
  assert.ok(meanDiff(restored, target) < 12, `还原偏差过大: ${meanDiff(restored, target)}`);
});

test("滚动：认出整体位移，只补新露出来的那一条", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));

  const dy = 96;                              // 内容整体上移 96px
  const scrolled = Buffer.alloc(base.length);
  base.copy(scrolled, 0, dy * W * 3);
  for (let y = H - dy; y < H; y++) for (let x = 0; x < W; x++) {   // 新露出来的部分
    const i = (y * W + x) * 3;
    scrolled[i] = (x * 5) & 0xff; scrolled[i + 1] = 200; scrolled[i + 2] = (y * 3) & 0xff;
  }
  const res: any = await d.next(await toJpeg(scrolled));
  assert.equal(res.kind, "delta", "滚动必须走位移而不是退回整帧");
  assert.equal(res.shift, dy, `位移应当是 ${dy}，实际 ${res.shift}`);
  // 只需要补底部那一条：变化块应当集中在底部
  assert.ok(res.tiles.every((t: any) => t.y >= H - dy - 64),
    "位移之后不该还有大片其它块在变");
});

test("增量比整帧还大时就发整帧（用字节数说话，不靠猜阈值）", async () => {
  // 造一帧：变化面积不大，但变化区域是噪声（压不动），增量会比整帧更贵
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));
  const noisy = Buffer.from(base);
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    noisy[i] = (x * 131 + y * 17) & 0xff;
    noisy[i + 1] = (x * 57 + y * 191) & 0xff;
    noisy[i + 2] = (x * 29 + y * 83) & 0xff;
  }
  const res = await d.next(await toJpeg(noisy));
  assert.equal(res.kind, "key");
});

test("整页换掉：变化面积过大就退回整帧（分块在这时更贵）", async () => {
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(makeBase()));
  const other = Buffer.alloc(W * H * 3);
  for (let i = 0; i < other.length; i++) other[i] = (i * 13) & 0xff;
  const res = await d.next(await toJpeg(other));
  assert.equal(res.kind, "key");
});

test("画面没变：不发任何块（省到底）", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  const jpeg = await toJpeg(base);
  await d.next(jpeg);
  const res: any = await d.next(jpeg);
  assert.equal(res.kind, "delta");
  assert.equal(res.tiles.length, 0);
});

test("到了间隔就补一张整帧（防止增量累积出漂移）", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64, keyframeIntervalMs: 1000 });
  await d.next(await toJpeg(base), 0);
  const a = await d.next(await toJpeg(base), 500);
  assert.equal(a.kind, "delta");
  const b = await d.next(await toJpeg(base), 1500);
  assert.equal(b.kind, "key");
});

test("reset 之后必须重新给整帧（新观看者/跟丢了）", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));
  d.reset();
  const res = await d.next(await toJpeg(base));
  assert.equal(res.kind, "key");
});

test("尺寸变了（换布局）不能拿旧帧做差分", async () => {
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(makeBase()));
  const small = Buffer.alloc((W / 2) * (H / 2) * 3, 128);
  const res = await d.next(await toJpeg(small, W / 2, H / 2));
  assert.equal(res.kind, "key");
});

/** 造一条有起伏的行亮度剖面（平剖面本来就不该被用来判位移）。 */
function profile(fn: (y: number) => number): Float32Array {
  const p = new Float32Array(H);
  for (let y = 0; y < H; y++) p[y] = fn(y);
  return p;
}

test("位移检测：无关内容不该被误判成位移", () => {
  const a = profile(y => 128 + 60 * Math.sin(y / 7));
  const b = profile(y => 128 + 60 * Math.sin(y / 13 + 2));
  assert.equal(detectShift(a, b, H, 200), 0);
});

test("位移检测：真的位移要认出来（含非 8 倍数——JPEG 块会错位的那种）", () => {
  const src = profile(y => 128 + 60 * Math.sin(y / 9) + 20 * Math.cos(y / 3));
  for (const dy of [8, 37, 100]) {
    const b = profile(y => (y + dy < H ? src[y + dy] : 30 + (y % 17)));
    assert.equal(detectShift(src, b, H, 200), dy, `dy=${dy} 没认出来`);
  }
});

test("位移检测：真实页面那种「对得上但不完美」的滚动也要认出来", () => {
  // 真机日志的教训：sticky 头部 + JPEG 噪声下，最优匹配的平均差实测在 0.85~1.36，
  // 门槛卡在 1.0 会让常见滚动全被判成「没滚」→ 每帧退回整帧。这条钉住那个区间。
  const src = profile(y => 128 + 60 * Math.sin(y / 9) + 20 * Math.cos(y / 3));
  const dy = 40;
  const noise = (y: number) => ((y * 2654435761) % 1000) / 1000 * 2.6 - 1.3;  // ±1.3 的确定性噪声
  const b = profile(y => (y < 90 ? src[y] : y + dy < H ? src[y + dy] + noise(y) : 30 + (y % 17)));
  assert.equal(detectShift(src, b, H, 200), dy);
});

test("位移检测：重复纹理下取最近的解，别认成隔了好几屏", () => {
  // 表格/列表这类页面上，隔 N 行的内容也「对得上」；认错距离画面会整块错位
  // 行距 40 的重复纹理（表格行）滚了 12px：12 / 52 / 92 都「对得上」，必须取 12。
  const period = 40, dy = 12;
  const src = profile(y => 128 + 60 * Math.sin((y / period) * 2 * Math.PI) + y / 40);
  const b = profile(y => (y + dy < H ? src[y + dy] : 40 + (y % 13)));
  assert.equal(detectShift(src, b, H, 200), dy);
});

test("位移检测：剖面太平（大片纯色）时放弃检测，别乱认", () => {
  const flat = profile(() => 200);
  const alsoFlat = profile(() => 200.2);
  assert.equal(detectShift(flat, alsoFlat, H, 200), 0);
});

test("位移检测：画面没动时不能报出位移", () => {
  const p = profile(y => 128 + 60 * Math.sin(y / 9));
  assert.equal(detectShift(p, p, H, 200), 0);
});

test("后台标签吐出来的纯白帧要丢掉（别闪白，也别拿它当基准）", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));
  const white = Buffer.alloc(W * H * 3, 255);
  const blank: any = await d.next(await toJpeg(white));
  assert.equal(blank.kind, "delta");
  assert.equal(blank.tiles.length, 0, "白帧不该发出任何像素");
  // 关键：白帧不能污染基准，下一张真实帧还得能跟白帧之前的画面正常做差分
  const typed = Buffer.from(base);
  for (let y = 100; y < 130; y++) for (let x = 200; x < 320; x++) {
    const i = (y * W + x) * 3; typed[i] = 0; typed[i + 1] = 0; typed[i + 2] = 0;
  }
  const res: any = await d.next(await toJpeg(typed));
  assert.equal(res.kind, "delta");
  assert.ok(res.tiles.length < 10, `白帧污染了基准，变化块 ${res.tiles.length}`);
});

test("真正的空白网页（纯白但有压缩起伏）最终必须送出（跳帧上限 + force 兜底）", async () => {
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(makeBase()));
  const nearlyWhite = Buffer.alloc(W * H * 3, 255);
  for (let y = 40; y < 60; y++) for (let x = 30; x < 400; x++) {    // 一行字
    const i = (y * W + x) * 3; nearlyWhite[i] = 40; nearlyWhite[i + 1] = 40; nearlyWhite[i + 2] = 40;
  }
  // 大片新出现的纯色带会先被当成「没画完的帧」跳过（这是防滚动白帧的正确行为），
  // 但调用方的 350ms 兜底会用 force 重投同一帧——那时必须照常送出。
  const first: any = await d.next(await toJpeg(nearlyWhite));
  if (first.kind === "delta" && first.tiles.length === 0) {
    const forced: any = await d.next(await toJpeg(nearlyWhite), Date.now(), null, true);
    assert.ok(forced.kind === "key" || forced.tiles.length > 0, "force 重投必须送出白底页面");
  } else {
    assert.ok(first.kind === "key" || first.tiles.length > 0, "有内容的白底页面必须送出");
  }
});

test("滚动中「没画完的帧」（大片新纯色带）要跳过，且不污染基准", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));
  // 模拟 Chrome 的中间帧：内容整体下移 120px，顶部新露出的区域还没光栅化（纯白）
  const transient = Buffer.alloc(W * H * 3, 255);
  base.copy(transient, 120 * W * 3, 0, (H - 120) * W * 3);
  const res: any = await d.next(await toJpeg(transient));
  assert.equal(res.kind, "delta", "没画完的帧不该变成整帧发出去");
  assert.equal(res.tiles.length, 0, "没画完的帧一个像素都不该发");
  assert.match(String(res.why || ""), /transient/, "要能在日志里看出是被跳过的");
  // 基准没被污染：下一帧回到原画面时应当几乎无变化
  const back: any = await d.next(await toJpeg(base));
  assert.equal(back.kind, "delta");
  assert.equal(back.shift, 0);
  assert.ok(back.tiles.length <= 1, `基准被污染了，变化块 ${back.tiles.length}`);
});

test("连续三帧都是纯色带：第三帧必须照常发（页面可能真的就长这样）", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));
  const transient = Buffer.alloc(W * H * 3, 255);
  base.copy(transient, 120 * W * 3, 0, (H - 120) * W * 3);
  const j = await toJpeg(transient);
  const r1: any = await d.next(j);
  const r2: any = await d.next(j);
  const r3: any = await d.next(j);
  assert.equal(r1.tiles?.length ?? -1, 0);
  assert.equal(r2.tiles?.length ?? -1, 0);
  assert.ok(r3.kind === "key" || r3.tiles.length > 0 || r3.shift !== 0,
    "跳帧必须有上限，否则真实的白底画面永远到不了观看端");
});

test("光标闪烁：没有热区会被噪声阈值滤掉，有热区必须重发", async () => {
  const base = makeBase();
  // 光标 = 2x20 的深色竖条，故意小到块平均差远低于阈值
  const blinked = Buffer.from(base);
  for (let y = 100; y < 120; y++) for (let x = 300; x < 302; x++) {
    const i = (y * W + x) * 3; blinked[i] = 0; blinked[i + 1] = 0; blinked[i + 2] = 0;
  }
  const noHot = new FrameDiffer({ tile: 128 });
  await noHot.next(await toJpeg(base));
  const r1: any = await noHot.next(await toJpeg(blinked));
  assert.equal(r1.kind, "delta");
  assert.equal(r1.tiles.length, 0, "前提不成立：光标级变化本应被阈值滤掉（否则热区就没意义了）");

  const withHot = new FrameDiffer({ tile: 128 });
  await withHot.next(await toJpeg(base));
  const hot = { x: 290, y: 96, w: 40, h: 28 };
  const r2: any = await withHot.next(await toJpeg(blinked), Date.now(), hot);
  assert.equal(r2.kind, "delta");
  assert.equal(r2.tiles.length, 1, "热区内的光标变化必须重发");
  const t = r2.tiles[0];
  assert.ok(t.x <= 300 && t.x + t.w >= 302 && t.y <= 100 && t.y + t.h >= 120,
    `热区块没盖住光标: ${t.x},${t.y},${t.w}x${t.h}`);
});

test("热区是整个输入框那么宽时，光标变化不能被整框平均稀释掉", async () => {
  const base = makeBase();
  const blinked = Buffer.from(base);
  for (let y = 100; y < 120; y++) for (let x = 300; x < 302; x++) {
    const i = (y * W + x) * 3; blinked[i] = 0; blinked[i + 1] = 0; blinked[i + 2] = 0;
  }
  const d = new FrameDiffer({ tile: 128 });
  await d.next(await toJpeg(base));
  const hot = { x: 0, y: 96, w: W, h: 28 };            // input 框：只知道整框范围
  const res: any = await d.next(await toJpeg(blinked), Date.now(), hot);
  assert.equal(res.tiles.length, 1, "整框宽的热区也必须认出光标那一小条");
  assert.ok(res.tiles[0].w <= 64, `应该只发变化的窄条,实际宽 ${res.tiles[0].w}`);
});

test("白带每帧只长一点点（棘轮式）也必须被拦住——基线不跟着白帧爬", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));
  // 慢速光栅化的真实形态:白带逐帧从 10% → 20% → 30%,单帧增幅都低于 12% 阈值
  const withTopWhite = (rows: number) => {
    const f = Buffer.from(base);
    f.fill(255, 0, rows * W * 3);
    return f;
  };
  const r1: any = await d.next(await toJpeg(withTopWhite(Math.floor(H * 0.10))));
  const r2: any = await d.next(await toJpeg(withTopWhite(Math.floor(H * 0.20))));
  // 第一帧 10% 低于阈值放行;第二帧累计 20%,相对「实」基线已超阈值,必须跳过
  assert.match(String(r2.why || ""), /transient/,
    `棘轮白帧逃逸了: r1=${r1.kind}/${r1.why} r2=${r2.kind}/${r2.why}`);
});

test("10 秒间隔整帧撞上「没画完的帧」时，坏帧不能借 interval 身份放行", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64, keyframeIntervalMs: 1 });   // 立即到期
  await d.next(await toJpeg(base), 1000);
  const transient = Buffer.alloc(W * H * 3, 255);
  base.copy(transient, 120 * W * 3, 0, (H - 120) * W * 3);
  const res: any = await d.next(await toJpeg(transient), 2000);
  assert.equal(res.kind, "delta", "到期整帧必须让位给 transient 跳过");
  assert.match(String(res.why || ""), /transient/);
  // 正常帧照常拿到到期整帧
  const ok: any = await d.next(await toJpeg(base), 3000);
  assert.equal(ok.kind, "key");
});

test("后台空白帧的丢弃要带 why=blank（调用方靠它决定不缓存、不重投）", async () => {
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(makeBase()));
  const white = Buffer.alloc(W * H * 3, 255);
  const res: any = await d.next(await toJpeg(white));
  assert.equal(res.kind, "delta");
  assert.equal(res.tiles.length, 0);
  assert.equal(res.why, "blank");
});

test("热区是整个多行输入框（很高）时，顶部一行的光标也不能被竖向稀释掉", async () => {
  const base = makeBase();
  const blinked = Buffer.from(base);
  for (let y = 20; y < 40; y++) for (let x = 300; x < 302; x++) {   // 光标在框的第一行
    const i = (y * W + x) * 3; blinked[i] = 0; blinked[i + 1] = 0; blinked[i + 2] = 0;
  }
  const d = new FrameDiffer({ tile: 128 });
  await d.next(await toJpeg(base));
  const hot = { x: 0, y: 16, w: W, h: 300 };           // textarea：整框,300px 高
  const res: any = await d.next(await toJpeg(blinked), Date.now(), hot);
  assert.equal(res.tiles.length, 1, "高框热区里顶部的光标变化必须重发");
  const t = res.tiles[0];
  assert.ok(t.y <= 20 && t.y + t.h >= 40 && t.x <= 300 && t.x + t.w >= 302,
    `热区块没盖住光标: ${t.x},${t.y},${t.w}x${t.h}`);
  assert.ok(t.h <= 96, `应该只发变化的小块,实际高 ${t.h}`);
});

test("上一帧的 1 像素高细线被修复时必须重发（隔行采样会整条跳过它）", async () => {
  const base = makeBase();
  const lined = Buffer.from(base);
  for (let x = 0; x < W; x++) {                        // 奇数行上一条 1px 白线
    const i = (101 * W + x) * 3; lined[i] = 255; lined[i + 1] = 255; lined[i + 2] = 255;
  }
  const d = new FrameDiffer({ tile: 128 });
  await d.next(await toJpeg(lined));                   // 带白线的帧是基准
  const res: any = await d.next(await toJpeg(base));   // 修复帧
  assert.equal(res.kind, "delta");
  assert.ok(res.tiles.length > 0, "细线修复被丢掉了——白线会永久烙在观看端画面里");
  const covers = res.tiles.some((t: any) => t.y <= 101 && t.y + t.h > 101);
  assert.ok(covers, "重发的块没有盖住那条线");
});

test("同一行相邻的变化块要并成一条，别一小块一小块单独压", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));
  const wide = Buffer.from(base);
  for (let y = 100; y < 150; y++) for (let x = 0; x < W; x++) {   // 横跨整行的一条改动
    const i = (y * W + x) * 3; wide[i] = 10; wide[i + 1] = 10; wide[i + 2] = 10;
  }
  const res: any = await d.next(await toJpeg(wide));
  assert.equal(res.kind, "delta");
  const row = res.tiles.filter((t: any) => t.y === 64);
  assert.equal(row.length, 1, `整行改动应当只发一条，实际 ${row.length} 块`);
  assert.equal(row[0].w, W, "这一条应当横跨整幅宽度");
  // 还原仍要正确（合并不能把坐标算错）
  const prevRaw = await sharp(await toJpeg(base)).removeAlpha().raw().toBuffer();
  const restored = await apply(prevRaw, res);
  const target = await sharp(await toJpeg(wide)).removeAlpha().raw().toBuffer();
  assert.ok(meanDiff(restored, target) < 12, `还原偏差过大: ${meanDiff(restored, target)}`);
});

test("不相邻的变化块不能被并到一起（中间没变的部分不该重发）", async () => {
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));
  const two = Buffer.from(base);
  for (const x0 of [0, W - 64]) {
    for (let y = 100; y < 120; y++) for (let x = x0; x < x0 + 64; x++) {
      const i = (y * W + x) * 3; two[i] = 5; two[i + 1] = 5; two[i + 2] = 5;
    }
  }
  const res: any = await d.next(await toJpeg(two));
  const row = res.tiles.filter((t: any) => t.y === 64);
  assert.equal(row.length, 2, `左右两块不该合并，实际 ${row.length}`);
});

test("位移不是 8 的倍数时，没变的内容不能被当成变了（JPEG 块错位）", async () => {
  // 这条钉住真机上的现象：位移认对了（199px）却仍有 85% 的块判成变化 → 退回整帧。
  const base = makeBase();
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(base));
  const dy = 37;                                   // 故意不是 8 的倍数
  const scrolled = Buffer.alloc(base.length);
  base.copy(scrolled, 0, dy * W * 3);
  for (let y = H - dy; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    scrolled[i] = (x * 5) & 0xff; scrolled[i + 1] = 200; scrolled[i + 2] = (y * 3) & 0xff;
  }
  const res: any = await d.next(await toJpeg(scrolled));
  assert.equal(res.kind, "delta");
  assert.equal(res.shift, dy);
  const area = res.tiles.reduce((s: number, t: any) => s + t.w * t.h, 0) / (W * H);
  assert.ok(area < 0.25, `位移之后只该补新露出来的一条，实际变化面积 ${(area * 100).toFixed(0)}%`);
});

test("位移必须精确到像素：差一像素比认不出来更糟", () => {
  // 「同分取最近」写松了会把 200 换成 199，整屏内容随之全部对不上
  const src = profile(y => 128 + 50 * Math.sin(y / 8) + 25 * Math.cos(y / 21));
  const dy = 200;
  const b = profile(y => (y + dy < H ? src[y + dy] : 20 + (y % 23)));
  assert.equal(detectShift(src, b, H, 300), dy);
});

// 注：帧进来时已经是 JPEG，绿蓝变了之后解码出的红色也会跟着动（YCbCr 的必然结果），
// 所以「只比红色通道」在我们这条管线里抓不出反例——这条测的是行为（这种变化必须发出去），
// 不是判据的鉴别力。三通道比较留作纵深防御：换成无损输入时它才是必须的。
test("红色不变、绿蓝大变的画面也必须发出去", async () => {
  const raw = Buffer.alloc(W * H * 3);
  for (let i = 0; i < raw.length; i += 3) {                 // 深红底，行间有起伏
    const y = Math.floor(i / 3 / W);
    raw[i] = 120 + (y % 7) * 8; raw[i + 1] = 0; raw[i + 2] = 0;
  }
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(raw));
  const recolored = Buffer.from(raw);
  for (let y = 100; y < 200; y++) for (let x = 100; x < 400; x++) {
    const i = (y * W + x) * 3;
    recolored[i + 1] = 255; recolored[i + 2] = 255;         // 红不动，绿蓝拉满
  }
  const res: any = await d.next(await toJpeg(recolored));
  const changed = res.kind === "key" || res.tiles.length > 0;
  assert.ok(changed, "只比红色通道的话这一整类变化会被静默丢掉，画面永久停在旧内容");
});

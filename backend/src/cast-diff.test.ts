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

test("真正的空白网页（纯白但有压缩起伏）不能被当成无效帧丢掉", async () => {
  const d = new FrameDiffer({ tile: 64 });
  await d.next(await toJpeg(makeBase()));
  const nearlyWhite = Buffer.alloc(W * H * 3, 255);
  for (let y = 40; y < 60; y++) for (let x = 30; x < 400; x++) {    // 一行字
    const i = (y * W + x) * 3; nearlyWhite[i] = 40; nearlyWhite[i + 1] = 40; nearlyWhite[i + 2] = 40;
  }
  const res: any = await d.next(await toJpeg(nearlyWhite));
  assert.ok(res.kind === "key" || res.tiles.length > 0, "有内容的白底页面必须照常送出");
});

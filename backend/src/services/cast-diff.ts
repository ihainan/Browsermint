/**
 * 帧差分：把「每次变化都发一整张 JPEG」变成「只发变化的部分」。
 *
 * 为什么值得做（2026-08-03 实测，1280x800 密集页面）：
 *   整帧 q62 ≈ 49KB（百度那种页面真机上 116KB）
 *   打字类小改动 → 128px 分块下只有 3/70 块变化 → **5KB，省 90%**
 *   滚动一屏     → 67/70 块变化 → 51KB，**比整帧还大**（分块差分在滚动上是净亏）
 *   滚动 + 位移检测（RFB 的 CopyRect 思路）→ 只补新露出来的一条 → **2KB，省 95%**
 *
 * 所以顺序是：**先看是不是整体位移**（滚动是浏览里最频繁的动作），不是位移再做分块差分，
 * 变化面积过大就干脆退回整帧。
 *
 * 每帧的 CPU（本机 libvips，1280x800）：解码 4.9ms + 行哈希 0.26ms + 位移搜索 0.13ms +
 * 编码变化块 ~2ms ≈ **8ms**。10fps 下约 8% 单核，且只在有人看的时候跑。
 */
import sharp from "sharp";

export interface DiffTile {
  x: number;
  y: number;
  w: number;
  h: number;
  data: string;            // base64 JPEG
}

export type DiffResult =
  | { kind: "key"; data: string; why: string }                     // 整帧（base64 JPEG）
  | { kind: "delta"; shift: number; tiles: DiffTile[] };           // 增量：先位移，再贴块

export interface FrameDifferOptions {
  tile?: number;           // 分块边长
  quality?: number;        // 块的 JPEG 质量（与流一致即可）
  /** 变化块占比超过它就退回整帧——分块在大面积变化时反而更贵 */
  keyframeRatio?: number;
  /** 两次整帧之间最多隔多久（毫秒）：防止长期增量累积出漂移 */
  keyframeIntervalMs?: number;
  /** 位移搜索范围（像素）。一屏 800 高；差分忙时会跳帧，两帧间可能滚了大半屏，所以给到 ±700 */
  shiftRange?: number;
}

// 块内平均像素差超过它才算「变了」。太小会被 JPEG 噪声刷屏，太大会漏掉细小文字变化。
const TILE_DIFF_THRESHOLD = 3;

const DEFAULTS = {
  tile: 128,
  quality: 62,
  keyframeRatio: 0.4,
  keyframeIntervalMs: 10_000,
  shiftRange: 700,   // 帧被跳过时两帧之间可能已经滚了大半屏，范围太小就认不出来
};

/**
 * 行亮度剖面：位移检测的依据。
 *
 * **不能用「逐行哈希 + 相等」**。滚动量只要不是 8 的倍数，JPEG 的 8×8 块就会错位，
 * 同样的内容解出来的像素处处小幅变化（实测：平均差 1.09，最大 68），任何基于相等的
 * 判据都会失效——第一版就是这么写的，除了「刚好滚 8 的倍数」以外一律认不出位移
 * （单测 + 真实截图都抓到了）。
 *
 * 改用每行的平均亮度（浮点）：压缩噪声对均值的影响只有 0.3 上下，做互相关很稳。
 */
function rowProfile(raw: Buffer, width: number, height: number): Float32Array {
  const out = new Float32Array(height);
  const stride = width * 3;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let n = 0;
    const off = y * stride;
    for (let x = 0; x < stride; x += 9) { sum += raw[off + x]; n++; }
    out[y] = sum / n;
  }
  return out;
}

/** 剖面的「起伏程度」。太平（大片纯色/整齐文字）时任何位移都对得上，必须放弃检测。 */
function profileSpread(p: Float32Array): number {
  let mean = 0;
  for (let i = 0; i < p.length; i++) mean += p[i];
  mean /= p.length;
  let dev = 0;
  for (let i = 0; i < p.length; i++) dev += Math.abs(p[i] - mean);
  return dev / p.length;
}

/**
 * 「对得上」的绝对门槛。**放宽到 3.0 是实测改的**：真实页面滚动（含 sticky 头部、
 * 懒加载、JPEG 噪声）的最优匹配落在 0.85~1.36，卡在 1.0 会把 20px 和 150px 这类
 * 常见滚动直接判成「没滚」——真机日志里 shift 全是 0、每帧退回整帧，就是这么来的。
 *
 * 真正分开「滚了」和「没滚」的是下面的倍数关系，不是这个绝对值：实测真滚动 5~27 倍，
 * 完全没动时是 0 倍。所以这道只用来挡「两幅无关画面」。
 */
const SHIFT_MAD_LIMIT = 3.0;
const SHIFT_MARGIN = 2.5;         // 最优要比「不动」明显好这么多倍，才敢说真的滚了
const MIN_SPREAD = 1.5;           // 剖面起伏下限
/** 差不多好的候选里取位移最小的：远处的巧合匹配（页面自身重复纹理）不该赢过近处的真解。 */
const SHIFT_TIE_RATIO = 1.15;

/**
 * 找「整幅内容上下平移了多少」。返回 0 表示不是位移。
 *
 * 判据故意保守：错判成位移会让整屏内容对不上（很显眼），漏判只是这一帧退回分块/整帧。
 */
/** 上一次位移判定的取值。只用于排障日志——真机上「为什么没认出滚动」只能靠它。 */
export const shiftDiag = { best: 0, bestMad: 0, still: 0, spread: 0, why: "" };

export function detectShift(
  prev: Float32Array, next: Float32Array, height: number, range: number,
): number {
  const spread = Math.min(profileSpread(prev), profileSpread(next));
  shiftDiag.spread = spread;
  shiftDiag.best = 0; shiftDiag.bestMad = 0; shiftDiag.still = 0; shiftDiag.why = "";
  if (spread < MIN_SPREAD) { shiftDiag.why = "flat"; return 0; }
  const buf: number[] = [];
  /**
   * 位移 dy 下「对得有多好」。**掐掉最差的那 1/4 行**：sticky 头部、固定底栏、悬浮按钮
   * 在滚动时原地不动，永远对不上；把它们和真正对不上的行一起平均，会把一次好端端的
   * 滚动的分数拉到判不出来（实测顶部 90px 固定栏就足以让 40px 滚动被判成「没滚」）。
   */
  const mad = (dy: number): number => {
    const from = Math.max(0, -dy);
    const to = Math.min(height, height - dy);
    if (to - from < height * 0.3) return Infinity;
    buf.length = 0;
    for (let y = from; y < to; y += 4) buf.push(Math.abs(prev[y + dy] - next[y]));
    if (buf.length < 20) return Infinity;
    buf.sort((a, b) => a - b);
    const keep = Math.max(10, Math.floor(buf.length * 0.75));
    let sum = 0;
    for (let i = 0; i < keep; i++) sum += buf[i];
    return sum / keep;
  };
  const still = mad(0);
  let best = 0;
  let bestMad = Infinity;
  const scores = new Float64Array(2 * range + 1);
  for (let dy = -range; dy <= range; dy++) {
    if (dy === 0) { scores[dy + range] = Infinity; continue; }
    const m = mad(dy);
    scores[dy + range] = m;
    if (m < bestMad) { bestMad = m; best = dy; }
  }
  shiftDiag.best = best; shiftDiag.bestMad = bestMad; shiftDiag.still = still;
  if (bestMad > SHIFT_MAD_LIMIT) { shiftDiag.why = "mad"; return 0; }
  // 同样好的候选里取最近的一个：页面上重复的行（表格、列表）会让远处也「对得上」，
  // 认错方向或认成一屏多的位移，画面就整块错位。
  for (let dy = -range; dy <= range; dy++) {
    if (dy === 0) continue;
    if (scores[dy + range] <= bestMad * SHIFT_TIE_RATIO && Math.abs(dy) < Math.abs(best)) {
      best = dy;
    }
  }
  if (still <= bestMad * SHIFT_MARGIN) { shiftDiag.why = "margin"; return 0; }
  return best;
}

export class FrameDiffer {
  private readonly opt: Required<FrameDifferOptions>;
  private prevRaw: Buffer | null = null;
  private prevProfile: Float32Array | null = null;
  private lastKeyAt = 0;
  private width = 0;
  private height = 0;

  constructor(options: FrameDifferOptions = {}) {
    this.opt = { ...DEFAULTS, ...options };
  }

  /** 布局变了 / 有新观看者 / 客户端说自己跟丢了 → 下一帧必须是整帧。 */
  reset(): void {
    this.prevRaw = null;
    this.prevProfile = null;
  }

  async next(jpeg: Buffer, now = Date.now()): Promise<DiffResult> {
    const { data, info } = await sharp(jpeg).removeAlpha()
      .raw().toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;
    const sizeChanged = width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;

    if (sizeChanged || !this.prevRaw || !this.prevProfile
        || now - this.lastKeyAt >= this.opt.keyframeIntervalMs) {
      return this.keyframe(jpeg, data, width, height, now,
        sizeChanged ? "size" : !this.prevRaw ? "first" : "interval");
    }

    const profile = rowProfile(data, width, height);
    const shift = detectShift(this.prevProfile, profile, height, this.opt.shiftRange);
    const tiles = this.changedRegions(this.prevRaw, data, width, height, shift);

    // 什么时候干脆退回整帧：
    //   * 没有位移，而且变化面积过大 —— 分块在这时比整帧还贵（实测滚动 51KB vs 49KB）。
    //   * 有位移时**几乎从不**退回：位移的代价只有「新露出来的那一条」，
    //     一条 1280×N 的 JPEG 比整帧小一个数量级（实测 2KB vs 49KB）。
    const area = tiles.reduce((sum, t) => sum + t.w * t.h, 0) / (width * height);
    const limit = shift === 0 ? this.opt.keyframeRatio : 0.8;
    if (area > limit) {
      return this.keyframe(jpeg, data, width, height, now,
        `area=${area.toFixed(2)}>${limit} shift=${shift} 位移判据[最优=${shiftDiag.best} `
        + `分=${shiftDiag.bestMad.toFixed(2)} 不动=${shiftDiag.still.toFixed(2)} `
        + `起伏=${shiftDiag.spread.toFixed(2)} 否决=${shiftDiag.why || "无"}]`);
    }

    await this.encodeTiles(tiles, data, width);

    // **最后用字节数说话**：整帧就在手上（Chrome 已经压好了），增量的大小也算得出来。
    // 与其靠「变化面积超过 X%」这种猜的阈值，不如直接比——增量不比整帧小就发整帧。
    // 省掉一整类「某些页面上增量反而更大」的意外（实测滚动时确实会出现）。
    const deltaBytes = tiles.reduce((sum, t) => sum + (t.data.length * 3) / 4, 0);
    if (deltaBytes >= jpeg.length * 0.9) {
      return this.keyframe(jpeg, data, width, height, now,
        `bytes=${Math.round(deltaBytes / 1024)}KB>=${Math.round(jpeg.length / 1024)}KB shift=${shift} tiles=${tiles.length}`);
    }

    this.prevRaw = data;
    this.prevProfile = profile;
    return { kind: "delta", shift, tiles };
  }

  private keyframe(
    jpeg: Buffer, raw: Buffer, width: number, height: number, now: number, why = "first",
  ): DiffResult {
    this.prevRaw = raw;
    this.prevProfile = rowProfile(raw, width, height);
    this.lastKeyAt = now;
    return { kind: "key", data: jpeg.toString("base64"), why };
  }

  /**
   * 需要重发的区域。位移时分两部分：
   *   1) 新露出来的那一条 —— 整条一个矩形，不切块（少一堆 JPEG 头，压缩率也更好）；
   *   2) 位移之后仍然对不上的块（sticky 头部、懒加载进来的图等）。
   */
  private changedRegions(
    prev: Buffer, next: Buffer, width: number, height: number, shift: number,
  ): DiffTile[] {
    const out: DiffTile[] = [];
    let from = 0;
    let to = height;
    if (shift > 0) {                    // 内容上移：底部露出新内容
      to = Math.max(0, height - shift);
      out.push({ x: 0, y: to, w: width, h: height - to, data: "" });
    } else if (shift < 0) {             // 内容下移：顶部露出新内容
      from = Math.min(height, -shift);
      out.push({ x: 0, y: 0, w: width, h: from, data: "" });
    }
    const T = this.opt.tile;
    for (let y0 = Math.floor(from / T) * T; y0 < to; y0 += T) {
      const h = Math.min(T, to - y0);
      if (h <= 0) continue;
      for (let x0 = 0; x0 < width; x0 += T) {
        const w = Math.min(T, width - x0);
        if (this.regionDiffers(prev, next, width, height, x0, y0, w, h, shift)) {
          out.push({ x: x0, y: y0, w, h, data: "" });
        }
      }
    }
    return out;
  }

  /** 带容差的比较：逐字节相等在两张独立压缩的 JPEG 之间永远不成立。 */
  private regionDiffers(
    prev: Buffer, next: Buffer, width: number, height: number,
    x0: number, y0: number, w: number, h: number, shift: number,
  ): boolean {
    let sum = 0;
    let n = 0;
    for (let r = 0; r < h; r += 2) {                 // 隔行采样：快一倍，够用
      const yNext = y0 + r;
      const yPrev = yNext + shift;
      if (yPrev < 0 || yPrev >= height) return true;
      const a = (yPrev * width + x0) * 3;
      const b = (yNext * width + x0) * 3;
      for (let c = 0; c < w * 3; c += 3) {
        const d = prev[a + c] - next[b + c];
        sum += d < 0 ? -d : d;
        n++;
      }
    }
    return n > 0 && sum / n > TILE_DIFF_THRESHOLD;
  }

  private async encodeTiles(tiles: DiffTile[], raw: Buffer, width: number): Promise<void> {
    for (const t of tiles) {
      const buf = Buffer.alloc(t.w * t.h * 3);
      for (let r = 0; r < t.h; r++) {
        const src = ((t.y + r) * width + t.x) * 3;
        raw.copy(buf, r * t.w * 3, src, src + t.w * 3);
      }
      t.data = (await sharp(buf, { raw: { width: t.w, height: t.h, channels: 3 } })
        .jpeg({ quality: this.opt.quality })
        .toBuffer()).toString("base64");
    }
  }
}

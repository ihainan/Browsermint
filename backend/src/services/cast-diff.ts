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

/**
 * 块内平均像素差超过它才算「变了」。太小会被 JPEG 噪声刷屏，太大会漏掉细小文字变化。
 *
 * **门槛得跟着位移走**。滚动量只要不是 8 的倍数，JPEG 的 8×8 块就整体错位，同一块
 * 内容重压出来处处小幅不同。实测（真实页面、q62、128px 块，内容完全没变）：
 *   位移是 8 的倍数   → 块平均差 中位 0.06、最大 1.46
 *   位移不是 8 的倍数 → 块平均差 中位 0.57、九成 3.2、**最大 5.13**
 * 一律卡 3 的后果是真机上位移认对了（199px）却仍有 85% 的块被判成「变了」→ 退回整帧，
 * 增量白算。真实的内容变化（文字出现、图片换掉）远在 10 以上，抬到 7 不会漏。
 */
const TILE_DIFF_THRESHOLD = 3;
const TILE_DIFF_THRESHOLD_SHIFTED = 7;
/** 有位移时行方向的分带高度（见 changedRegions）。 */
const SHIFTED_ROW_BAND = 32;

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
    // 三个通道都算。只取红色理论上会漏掉「红色不变、绿蓝大变」的画面；实测这条管线里
    // 抓不出反例（帧是 JPEG，绿蓝一动解码出的红色也跟着动），算纵深防御。
    for (let x = 0; x < stride; x += 9) {
      sum += raw[off + x] + raw[off + x + 1] + raw[off + x + 2];
      n += 3;
    }
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

/** 「整幅纯白」的判据：亮度接近 255 且几乎没有起伏。 */
function isBlank(p: Float32Array | null): boolean {
  if (!p || p.length === 0) return false;
  let min = Infinity;
  for (let i = 0; i < p.length; i++) if (p[i] < min) min = p[i];
  return min > 250 && profileSpread(p) < 0.05;
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
/**
 * 最优要比「不动」好这么多倍，才敢说真的滚了。
 *
 * 2.5 太严：真机上真实滚动只比「不动」好 1.5~2.1 倍就被否掉了（离线合成图能到
 * 5~27 倍，真实页面因为 sticky/懒加载达不到）。放到 1.3 的底气在于**认错也不会画错**：
 * 位移之后所有块都要跟「按这个位移搬过来的上一帧」逐块比，认错的话几乎每块都对不上，
 * 面积判据会立刻把这一帧退回整帧。
 */
const SHIFT_MARGIN = 1.3;
const MIN_SPREAD = 1.5;           // 剖面起伏下限
/**
 * 差不多好的候选里取位移最小的：远处的巧合匹配（页面自身重复纹理）不该赢过近处的真解。
 *
 * 但**只在明显更近时才换**（不到六成距离）。第一版写成「近一点就换」，于是真机上
 * 最优 200 被换成 199——差一像素等于整屏内容全对不上，比认不出位移还糟（面积判据里
 * 看得清清楚楚：位移认对了，却仍有 81% 的块判成变化）。
 */
const SHIFT_TIE_RATIO = 1.15;
const SHIFT_TIE_MUST_BE_NEARER = 0.6;

/**
 * 位移判定的取值，只用于排障日志。**每个差分器传自己的**——写成模块级全局的话，
 * 多个页面同时差分会互相覆盖，日志里读到的是别人的数（排错方向的现成陷阱）。
 */
export interface ShiftDiag {
  best: number; bestMad: number; still: number; spread: number; why: string;
  prevMean: number; nextMean: number; prevSpread: number; nextSpread: number;
}
export const newShiftDiag = (): ShiftDiag => ({
  best: 0, bestMad: 0, still: 0, spread: 0, why: "",
  prevMean: 0, nextMean: 0, prevSpread: 0, nextSpread: 0,
});

const profileMean = (p: Float32Array): number => {
  let m = 0;
  for (let i = 0; i < p.length; i++) m += p[i];
  return m / p.length;
};

/**
 * 找「整幅内容上下平移了多少」。返回 0 表示不是位移。
 *
 * 认错的代价有兜底：位移之后每块都要跟「搬过来的上一帧」比，认错就几乎全不匹配，
 * 面积判据会把这一帧退回整帧。所以判据可以不那么保守。
 */
export function detectShift(
  prev: Float32Array, next: Float32Array, height: number, range: number,
  diag: ShiftDiag = newShiftDiag(),
): number {
  diag.prevSpread = profileSpread(prev);
  diag.nextSpread = profileSpread(next);
  diag.prevMean = profileMean(prev);
  diag.nextMean = profileMean(next);
  const spread = Math.min(diag.prevSpread, diag.nextSpread);
  diag.spread = spread;
  diag.best = 0; diag.bestMad = 0; diag.still = 0; diag.why = "";
  if (spread < MIN_SPREAD) { diag.why = "flat"; return 0; }
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
    // 隔 2 行采样（不是 4）：采得太稀会把最优位移算偏一两个像素，而位移偏一像素
    // 就是整屏对不上——这里省下的一点 CPU 不值。
    for (let y = from; y < to; y += 2) buf.push(Math.abs(prev[y + dy] - next[y]));
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
  diag.best = best; diag.bestMad = bestMad; diag.still = still;
  if (bestMad > SHIFT_MAD_LIMIT) { diag.why = "mad"; return 0; }
  // 同样好的候选里取最近的一个：页面上重复的行（表格、列表）会让远处也「对得上」，
  // 认错方向或认成一屏多的位移，画面就整块错位。
  for (let dy = -range; dy <= range; dy++) {
    if (dy === 0) continue;
    if (scores[dy + range] <= bestMad * SHIFT_TIE_RATIO
        && Math.abs(dy) <= Math.abs(best) * SHIFT_TIE_MUST_BE_NEARER) {
      best = dy;
    }
  }
  if (still <= bestMad * SHIFT_MARGIN) { diag.why = "margin"; return 0; }
  return best;
}

export class FrameDiffer {
  private readonly opt: Required<FrameDifferOptions>;
  private prevRaw: Buffer | null = null;
  private prevProfile: Float32Array | null = null;
  private lastKeyAt = 0;
  /**
   * 代次。`next()` 是异步的（解码/编码都要等），而 `reset()` 随时可能从别处进来
   * （观看端要整帧、高清静帧换了分辨率）。没有它的话，在途的那次差分完成后照样把
   * `prevRaw` 写回去，等于把 reset 抹掉——之后发出的增量所基于的那张图观看端根本没有。
   */
  private gen = 0;
  private readonly diag = newShiftDiag();
  private width = 0;
  private height = 0;

  constructor(options: FrameDifferOptions = {}) {
    this.opt = { ...DEFAULTS, ...options };
  }

  /** 布局变了 / 有新观看者 / 客户端说自己跟丢了 → 下一帧必须是整帧。 */
  reset(): void {
    this.prevRaw = null;
    this.prevProfile = null;
    this.gen++;
  }

  async next(jpeg: Buffer, now = Date.now()): Promise<DiffResult> {
    const gen = this.gen;
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

    // **一张纯白的帧不是画面**。后台标签的合成器会时不时吐一张空帧（实测与真实帧交替
    // 出现），照单全收的话观看端就是闪白，帧差也没法工作——每一帧都在跟一张白纸比。
    // 已经有过内容还突然全白，一律当无效帧丢掉：真实网页哪怕是空白页也有细微起伏。
    if (isBlank(profile) && !isBlank(this.prevProfile)) {
      return { kind: "delta", shift: 0, tiles: [] };
    }
    const shift = detectShift(this.prevProfile, profile, height, this.opt.shiftRange, this.diag);
    const tiles = this.changedRegions(this.prevRaw, data, width, height, shift);

    // 什么时候干脆退回整帧：
    //   * 没有位移，而且变化面积过大 —— 分块在这时比整帧还贵（实测滚动 51KB vs 49KB）。
    //   * 有位移时**几乎从不**退回：位移的代价只有「新露出来的那一条」，
    //     一条 1280×N 的 JPEG 比整帧小一个数量级（实测 2KB vs 49KB）。
    const area = tiles.reduce((sum, t) => sum + t.w * t.h, 0) / (width * height);
    const limit = shift === 0 ? this.opt.keyframeRatio : 0.8;
    if (area > limit) {
      return this.keyframe(jpeg, data, width, height, now,
        `area=${area.toFixed(2)}>${limit} shift=${shift} 位移判据[最优=${this.diag.best} `
        + `分=${this.diag.bestMad.toFixed(2)} 不动=${this.diag.still.toFixed(2)} `
        + `否决=${this.diag.why || "无"} 尺寸=${width}x${height} `
        + `上一帧[亮度=${this.diag.prevMean.toFixed(1)} 起伏=${this.diag.prevSpread.toFixed(2)}] `
        + `这一帧[亮度=${this.diag.nextMean.toFixed(1)} 起伏=${this.diag.nextSpread.toFixed(2)}]]`);
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

    // 这一路上 await 过好几次（解码、编码），期间可能有人 reset 过。那就当这一帧作废：
    // 重发一张整帧，让观看端与我们从同一张图重新起头（宁可多发一帧，不可发一张对不上
    // 基准的增量）。**没有单测**：能确定性构造的那个时刻旧代码走的是另一条分支，
    // 真正危险的窗口在编码中途，测试里稳不住。
    if (gen !== this.gen) return this.keyframe(jpeg, data, width, height, now, "reset-raced");
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
    // 位移时把行方向切细。滚动后仍然对不上的通常是**很扁的一条**（sticky 顶栏、固定
    // 底栏、悬浮条），用 128 见方的粗网格去框，一条 40 行的顶栏要连累整块 128 行——
    // 加上新露出来的那一条就凑满整屏，于是判定「变化面积过大」退回整帧，增量白算。
    const TH = shift === 0 ? T : SHIFTED_ROW_BAND;
    for (let y0 = Math.floor(from / TH) * TH; y0 < to; y0 += TH) {
      const h = Math.min(TH, to - y0);
      if (h <= 0) continue;
      // **同一行里相邻的变化块并成一条横带再压**。单独压小块很亏：每块一份 JPEG 头，
      // 块之间的相关性也用不上。真机实测滚动时 14 个小块要 51KB，而整帧才 56KB——
      // 增量白算了。合并之后同样的内容通常只要一半上下。
      let runStart = -1;
      for (let x0 = 0; x0 < width; x0 += T) {
        const w = Math.min(T, width - x0);
        if (this.regionDiffers(prev, next, width, height, x0, y0, w, h, shift)) {
          if (runStart < 0) runStart = x0;
        } else if (runStart >= 0) {
          out.push({ x: runStart, y: y0, w: x0 - runStart, h, data: "" });
          runStart = -1;
        }
      }
      // **循环外收尾**。第一版靠「多走一步」来 flush（`x0 <= width`），而那一步只有在
      // 画面宽度正好是块宽整数倍时才走得到：1280/128 正好 10 块，所以真机上从没露过馅；
      // 宽度不是整数倍（窄视口、别的倍率）时，那一行最后一段变化被整个丢掉——
      // 表现为滚动后 sticky 顶栏不重画，画面顶端留着位移过来的内容。协议重放测试抓到的。
      if (runStart >= 0) out.push({ x: runStart, y: y0, w: width - runStart, h, data: "" });
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
    let maxRow = 0;
    for (let r = 0; r < h; r += 2) {                 // 隔行采样：快一倍，够用
      const yNext = y0 + r;
      const yPrev = yNext + shift;
      if (yPrev < 0 || yPrev >= height) return true;
      const a = (yPrev * width + x0) * 3;
      const b = (yNext * width + x0) * 3;
      const rowFrom = n;
      const rowBase = sum;
      // 同样三通道都比，隔一个像素采样抵掉开销（理由见 rowProfile 那段）。
      for (let c = 0; c < w * 3; c += 6) {
        for (let k = 0; k < 3; k++) {
          const d = prev[a + c + k] - next[b + c + k];
          sum += d < 0 ? -d : d;
          n++;
        }
      }
      if (n > rowFrom) {
        const rowMean = (sum - rowBase) / (n - rowFrom);
        if (rowMean > maxRow) maxRow = rowMean;
      }
    }
    const limit = shift % 8 === 0 ? TILE_DIFF_THRESHOLD : TILE_DIFF_THRESHOLD_SHIFTED;
    // **整块平均之外，还要看最差的那一行**：一块里只有一小条变了（sticky 顶栏、固定
    // 底栏）时，平均会把它稀释到门槛以下，那一条就不重发了。放宽门槛到 7 之后这个洞更大。
    // 注：位移时行方向已经切成 32 的细带，所以这道是纵深防御——**没有能区分它的测试**，
    // 别把它当成被验证过的行为。
    return n > 0 && (sum / n > limit || maxRow > limit * 2.5);
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

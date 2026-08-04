import test from "node:test";

/** 帧差分是异步的（要解码 JPEG），推一帧之后要等一拍才看得到广播结果。 */
/**
 * 等广播这一轮真正跑完。
 *
 * **不能只 drain 微任务**：帧现在要过一遍帧差（sharp 解码/编码，真的落到线程池），
 * 30 个 setImmediate 常常还没轮到它 —— 这条以前是随机挂的（实测 4 跑挂 3），
 * 而随机挂的测试比它守的行为更危险：绿灯是假的。
 */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 5));
};
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const { parseSessionWebSocketPath } = await import("./services/proxy.service.js");
const {
  attachCastViewer, forgetTargetViewport, setTargetViewport, applyViewportToProducer,
  setCastTestHooks, resetCastTestHooks, setCdpServiceOverridesForTests,
  resetCdpServiceOverridesForTests, notifyChildTarget,
} = await import("./services/cdp.service.js");
const { setPrismaForTests } = await import("./db/client.js");

const SESSION = "sess-1";
const TARGET = "page-1";

/** Minimal stand-in for a devtools socket: records the CDP commands we send and
 *  lets the test push events back (frames, close). */
class FakeSocket extends EventEmitter {
  readyState = 1;                       // OPEN
  bufferedAmount = 0;
  sent: Array<Record<string, any>> = [];
  constructor(public url = "") {
    super();
    setImmediate(() => this.emit("open"));
  }
  scrollWidth: number | null = null;      // 页面内容宽度（null = 不回答）
  send(raw: string) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (msg.id === undefined) return;
    // Chrome replies to every command; setTargetViewport / fit measurement wait for it.
    const result = (msg.method === "Runtime.evaluate" && this.scrollWidth !== null)
      ? { result: { value: this.scrollWidth } }
      : {};
    setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({ id: msg.id, result }))));
  }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
  methods() { return this.sent.map((m) => m.method).filter(Boolean); }
  pushFrame(data: string, ackId = 7) {
    this.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame", params: { data, sessionId: ackId },
    })));
  }
}

/** Stand-in for a viewer connection (what the platform BFF proxies to). */
class FakeViewer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  received: string[] = [];
  send(payload: string) { this.received.push(payload); }
  close() { this.readyState = 3; this.emit("close"); }
}

// `sockets` 也接受**惰性**构造器：FakeSocket 在构造时就 setImmediate 派发 "open"，
// 预先 new 好放进数组的话，只要测试在 attach 之前先 await 过别的东西（例如
// setTargetViewport 会自己建一条视口 socket），那次 await 就把 "open" 消费掉了，
// 后面注册的 once("open") 永远等不到 → "cast socket timeout"。
// `onCdp` 是必要的：像 Target.activateTarget 这种命令走的是 executeCdpCommand，
// 不经过 producer 的 socket。只断言 socket 上发了什么，抓不住「有没有去抢前台」
// 这类最危险的行为（codex 复审 2026-08-03，Medium-5）。
function setup(opts: {
  sockets?: Array<FakeSocket | (() => FakeSocket)>;
  scrollWidth?: number;
  onCdp?: (method: string, params?: any) => void;
} = {}) {
  const created: FakeSocket[] = [];
  resetCastTestHooks();
  setCdpServiceOverridesForTests({
    executeCdpCommand: async (_s, method, params?: any) => {
      opts.onCdp?.(method, params);
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: TARGET, type: "page" }, { targetId: "w-1", type: "worker" }] };
      }
      return {};
    },
  });
  setCastTestHooks({
    cdpBase: { sessionId: SESSION, base: "ws://fake" },
    socketFactory: () => {
      const next = opts.sockets?.shift();
      const s = (typeof next === "function" ? next() : next) ?? new FakeSocket();
      if (opts.scrollWidth !== undefined) s.scrollWidth = opts.scrollWidth;
      created.push(s);
      return s as any;
    },
  });
  return created;
}

function teardown() {
  forgetTargetViewport(SESSION);
  resetCastTestHooks();
  resetCdpServiceOverridesForTests();
}

test("并发 attach 只建一个 producer（否则旧的成为永不停歇的僵尸）", async () => {
  const created = setup();
  try {
    const a = new FakeViewer(), b = new FakeViewer();
    await Promise.all([
      attachCastViewer(SESSION, TARGET, a as any),
      attachCastViewer(SESSION, TARGET, b as any),
    ]);
    assert.equal(created.length, 1, `expected 1 producer socket, got ${created.length}`);
    // 两个 viewer 都挂在同一条流上
    created[0].pushFrame("AAA");
    await settle();
    assert.equal(a.received.length, 1);
    assert.equal(b.received.length, 1);
  } finally { teardown(); }
});

test("帧先 ack 再广播（未 ack 时 Chrome 不发下一帧）", async () => {
  const created = setup();
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const before = created[0].sent.length;
    created[0].pushFrame("AAA", 42);
    const ack = created[0].sent.slice(before).find((m) => m.method === "Page.screencastFrameAck");
    assert.ok(ack, "frame must be acked");
    assert.equal(ack!.params.sessionId, 42);
    await settle();                       // 差分是异步的，广播晚一拍
    assert.equal(v.received.length, 1);
  } finally { teardown(); }
});

test("建流期间 viewer 已断开：不得加入 viewers（否则永不归零、流永不停）", async () => {
  const created = setup();
  try {
    const v = new FakeViewer();
    const p = attachCastViewer(SESSION, TARGET, v as any);
    v.close();                      // producer 还在建立中就断开
    await p;
    created[0].pushFrame("AAA");
    await settle();
    assert.equal(v.received.length, 0, "closed viewer must not receive frames");
    // 且不该留下一个有 viewer 的 producer：再接一个 viewer 应复用同一条流
    const v2 = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v2 as any);
    assert.equal(created.length, 1);
  } finally { teardown(); }
});

test("慢 viewer 被跳过而不是无限缓冲（帧过期即无价值）", async () => {
  const created = setup();
  try {
    const fast = new FakeViewer(), slow = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, fast as any);
    await attachCastViewer(SESSION, TARGET, slow as any);
    slow.bufferedAmount = 8 * 1024 * 1024;      // 已经落后 8MiB
    created[0].pushFrame("AAA");
    await settle();
    assert.equal(fast.received.length, 1);
    assert.equal(slow.received.length, 0);
  } finally { teardown(); }
});

test("视口必须在 startScreencast 之前设置（否则第一帧是错的尺寸）", async () => {
  const created = setup();
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const methods = created[created.length - 1].methods();
    const iMetrics = methods.indexOf("Emulation.setDeviceMetricsOverride");
    const iStart = methods.indexOf("Page.startScreencast");
    assert.ok(iMetrics >= 0 && iStart >= 0, `missing commands: ${methods.join(",")}`);
    assert.ok(iMetrics < iStart, `viewport must precede startScreencast: ${methods.join(",")}`);
  } finally { teardown(); }
});

test("非 page 类型的 target 不给建流", async () => {
  setup();
  try {
    const v = new FakeViewer();
    await assert.rejects(() => attachCastViewer(SESSION, "w-1", v as any), /not a page/);
    await assert.rejects(() => attachCastViewer(SESSION, "nope", v as any), /not found/);
  } finally { teardown(); }
});

test("session 清理会带走 producer、viewer 与 socket（三张表不留残渣）", async () => {
  const created = setup();
  try {
    const v = new FakeViewer();
    await setTargetViewport(SESSION, TARGET, 735, 867);
    await attachCastViewer(SESSION, TARGET, v as any);
    forgetTargetViewport(SESSION);
    assert.equal(v.readyState, 3, "viewer should be closed");
    assert.ok(created.every((s) => s.readyState === 3), "producer sockets should be closed");
    // session 级清理连 CDP base 一起丢掉：此后再 attach 必须失败而不是复用死 producer
    const v2 = new FakeViewer();
    await assert.rejects(() => attachCastViewer(SESSION, TARGET, v2 as any), /No CDP base/);
  } finally { teardown(); }
});

test("pagecast路由: 解析 targetId 与 token（含播放器的双问号拼接）", () => {
  const p = parseSessionWebSocketPath(
    "/ws/sessions/sess-1/pagecast?token=T&targetId=ABC?pageId=ABC");
  assert.equal(p?.wsType, "pagecast");
  assert.equal(p?.sessionId, "sess-1");
  assert.equal(p?.token, "T");
});

test("pagecast与被反代的cast是两条路由，互不影响", () => {
  assert.equal(parseSessionWebSocketPath("/ws/sessions/s/cast?token=T")?.wsType, "cast");
  assert.equal(parseSessionWebSocketPath("/ws/sessions/s/pagecast?token=T")?.wsType, "pagecast");
  assert.equal(parseSessionWebSocketPath("/ws/sessions/s/bogus?token=T"), null);
});

// 这一条是真机漏测补回来的：早先的验收只看"画面尺寸 == 栏宽"和"有像素"，而固定宽度
// 布局的站点（百度、Google 的 PC 首页）在窄视口下**不重排**——两项判据照样全绿，实际
// 却是内容横向溢出、右半边够不着。判据必须落在"内容宽度 vs 视口"上。
// ── 布局视口固定（2026-08-03，追踪 #86 阶段 0a）──────────────────────────────
// 以前是「谁最后连上，页面就按谁的栏宽重排」。一个远端页面只有一个真实视口，多端同看
// 时会互相改掉对方的排版；工作现场要跨设备同步之后这个毛病只会被放大。
// 现在布局固定 1280x800，「画面多大」完全由观看端自己缩放决定。
test("布局视口固定：栏宽再怎么变，远端排版都不变", async () => {
  const created = setup({ scrollWidth: 2000 });   // 内容远超视口也不放宽
  try {
    await setTargetViewport(SESSION, TARGET, 400, 300, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    await new Promise((r) => setTimeout(r, 1600));   // 等过原来 fit 会触发的时机
    const metrics = created.at(-1)!.sent
      .filter((m) => m.method === "Emulation.setDeviceMetricsOverride");
    assert.ok(metrics.length > 0);
    for (const m of metrics) {
      assert.equal(m.params.width, 1280, "布局宽必须恒为 1280，与栏宽无关");
      assert.equal(m.params.height, 800, "高也要固定：只固定宽的话 100vh/sticky 仍会被改");
    }
  } finally { teardown(); }
});

test("缩放档不改布局（缩放从此是观看端自己的事）", async () => {
  const created = setup({ scrollWidth: 900 });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 917, 2, 0.5);   // zoom 50%
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const metrics = created.at(-1)!.sent
      .filter((m) => m.method === "Emulation.setDeviceMetricsOverride").at(-1)!;
    assert.equal(metrics.params.width, 1280, "zoom 不该参与布局计算");
    assert.equal(metrics.params.height, 800);
  } finally { teardown(); }
});

test("内容装不下也不放宽布局（交给观看端横向滚动，与真实浏览器一致）", async () => {
  const created = setup({ scrollWidth: 2500 });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 917, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)!;
    const before = sock.sent.filter((m) => m.method === "Page.stopScreencast").length;
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(sock.sent.filter((m) => m.method === "Page.stopScreencast").length, before,
      "不该为了放宽布局而重启流——那正是「跟着观看端改排版」的另一种形式");
  } finally { teardown(); }
});

test("帧上限 = 固定布局 × 观看端 DPR", async () => {
  const created = setup({ scrollWidth: 900 });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 917, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const cast = created.at(-1)!.sent.filter((m) => m.method === "Page.startScreencast").at(-1)!;
    assert.equal(cast.params.maxWidth, 2560);    // 1280 × 2
    assert.equal(cast.params.maxHeight, 1600);
  } finally { teardown(); }
});

test("普通屏观看端：帧上限 = 固定布局 × 1（2x 比 1x 贵 ~2.5 倍字节）", async () => {
  const created = setup({ scrollWidth: 900 });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 917, 1);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const cast = created.at(-1)!.sent.filter((m) => m.method === "Page.startScreencast").at(-1)!;
    assert.equal(cast.params.maxWidth, 1280);
  } finally { teardown(); }
});

// 控制通道：只有带**有效租约**的连接能写。否则任何 cast 连接都会在 producer 开始
// 读入站消息的那一刻变成控制通道（codex 评审点名的阻断项之一）。
function leasePrisma(live: { leaseId: string } | null) {
  return {
    $queryRaw: async () => [{ now: new Date() }],
    targetLease: {
      findFirst: async ({ where }: any) =>
        live && where.leaseId === live.leaseId ? { id: "x" } : null,
      findUnique: async () => (live ? { ...live, expiresAt: new Date(Date.now() + 60000) } : null),
      create: async () => ({}), updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
  } as any;
}

test("没有租约的 viewer：输入被服务端丢弃（不是靠 UI 自觉）", async () => {
  const created = setup();
  setPrismaForTests(leasePrisma(null));
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);     // 不传 leaseId
    const before = created[0].sent.length;
    (v as any).emit("message", Buffer.from(JSON.stringify({
      type: "mouseEvent", revision: 1,
      event: { type: "mousePressed", x: 10, y: 10, button: "left" },
    })));
    await new Promise((r) => setTimeout(r, 60));
    const inputs = created[0].sent.slice(before).filter((m) => String(m.method).startsWith("Input."));
    assert.deepEqual(inputs, [], "只读连接不得产生任何 Input 命令");
  } finally { teardown(); }
});

test("持租约的连接：输入转成 CDP Input 命令", async () => {
  const created = setup();
  setPrismaForTests(leasePrisma({ leaseId: "L1" }));
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any, "L1");
    (v as any).emit("message", Buffer.from(JSON.stringify({
      type: "mouseEvent", revision: 1,   // 必填：省略即视为对不上当前布局
      event: { type: "mousePressed", x: 12, y: 34, button: "left", clickCount: 1 },
    })));
    await new Promise((r) => setTimeout(r, 80));
    const click = created[0].sent.find((m) => m.method === "Input.dispatchMouseEvent");
    assert.ok(click, "应转发为 Input.dispatchMouseEvent");
    assert.equal(click!.params.x, 12);
    assert.equal(click!.params.y, 34);
  } finally { teardown(); }
});

test("revision 过旧的输入被丢弃（页面已重排，再点就点错地方）", async () => {
  const created = setup();
  setPrismaForTests(leasePrisma({ leaseId: "L1" }));
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any, "L1");
    const before = created[0].sent.length;
    (v as any).emit("message", Buffer.from(JSON.stringify({
      type: "mouseEvent", revision: 999,
      event: { type: "mousePressed", x: 1, y: 1, button: "left" },
    })));
    await new Promise((r) => setTimeout(r, 60));
    const inputs = created[0].sent.slice(before).filter((m) => String(m.method).startsWith("Input."));
    assert.deepEqual(inputs, [], "对不上当前 revision 的输入必须丢弃");
  } finally { teardown(); }
});

test("不带 revision 的输入被丢弃（可选校验等于没有校验）", async () => {
  const created = setup();
  setPrismaForTests(leasePrisma({ leaseId: "L1" }));
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any, "L1");
    const before = created[0].sent.length;
    (v as any).emit("message", Buffer.from(JSON.stringify({
      type: "mouseEvent", event: { type: "mousePressed", x: 5, y: 5, button: "left" },
    })));
    await new Promise((r) => setTimeout(r, 60));
    const inputs = created[0].sent.slice(before).filter((m) => String(m.method).startsWith("Input."));
    assert.deepEqual(inputs, []);
  } finally { teardown(); }
});

// ── 2026-08-02 codex 评审的三条 High：放行路径上的缺陷 ────────────────────────
// 这些在「接管输入根本到不了页面」期间全是潜伏的；把输入接通后才变成实际风险。

test("High-1：旧控制连接关闭，不得清掉当前持有者按住的键", async () => {
  const created = setup();
  setPrismaForTests(leasePrisma({ leaseId: "L1" }));
  try {
    const a = new FakeViewer(), b = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, a as any, "L1");
    await attachCastViewer(SESSION, TARGET, b as any, "L1");
    for (const [v, button] of [[a, "left"], [b, "right"]] as const) {
      (v as any).emit("message", Buffer.from(JSON.stringify({
        type: "mouseEvent", revision: 1,
        event: { type: "mousePressed", x: 1, y: 1, button },
      })));
    }
    await new Promise((r) => setTimeout(r, 80));
    const before = created[0].sent.length;
    a.close();                       // 旧连接断开
    await new Promise((r) => setTimeout(r, 60));
    const released = created[0].sent.slice(before)
      .filter((m) => m.method === "Input.dispatchMouseEvent" && m.params.type === "mouseReleased")
      .map((m) => m.params.button);
    assert.deepEqual(released, ["left"],
      "只能释放该连接自己按住的键；清掉 right 就是把当前持有者的拖拽打断了");
  } finally { teardown(); }
});

test("High-2：租约查询乱序返回时，press/release 顺序不得被打乱", async () => {
  const created = setup();
  let call = 0;
  setPrismaForTests({
    $queryRaw: async () => [{ now: new Date() }],
    targetLease: {
      // 第一次查询故意慢：没有串行化时 release 会抢在 press 前面派发。
      findFirst: async ({ where }: any) => {
        const delay = call++ === 0 ? 60 : 0;
        await new Promise((r) => setTimeout(r, delay));
        return where.leaseId === "L1" ? { id: "x" } : null;
      },
      findUnique: async () => ({ leaseId: "L1", expiresAt: new Date(Date.now() + 60000) }),
      create: async () => ({}), updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
  } as any);
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any, "L1");
    for (const type of ["mousePressed", "mouseReleased"]) {
      (v as any).emit("message", Buffer.from(JSON.stringify({
        type: "mouseEvent", revision: 1,
        event: { type, x: 3, y: 4, button: "left" },
      })));
    }
    await new Promise((r) => setTimeout(r, 200));
    const order = created[0].sent
      .filter((m) => m.method === "Input.dispatchMouseEvent")
      .map((m) => m.params.type);
    assert.deepEqual(order, ["mousePressed", "mouseReleased"]);
  } finally { teardown(); }
});

test("High-3：新 revision 只在确认属于新布局的帧到达后才发布", async () => {
  const created = setup();
  setPrismaForTests(leasePrisma({ leaseId: "L1" }));
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any, "L1");
    await setTargetViewport(SESSION, TARGET, 800, 600, 1, 1);
    v.received.length = 0;
    await applyViewportToProducer(SESSION, TARGET);

    const pushMeta = (data: string, w: number, h: number) =>
      created[0].emit("message", Buffer.from(JSON.stringify({
        method: "Page.screencastFrame",
        params: { data, sessionId: 1, metadata: { deviceWidth: w, deviceHeight: h } },
      })));

    // 布局固定之后这条路径基本不会被走到（改栏宽不再改变布局），但这套过渡期机制
    // 作为安全网保留：将来任何会改变布局的改动都得靠它挡住「旧坐标带新版本」。
    pushMeta("OLD", 400, 300);           // 还在管线里的旧布局帧
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(v.received, [],
      "过渡期内旧布局的帧不得下发——否则它会被打上新 revision，坐标校验形同虚设");

    pushMeta("NEW", 1280, 800);          // 第一张确认属于（固定）新布局的帧
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(v.received.length, 1);
    const frame = JSON.parse(v.received[0]);
    assert.equal(frame.data, "NEW");
    assert.equal(frame.revision, 2, "确认帧到达时才 +1");
  } finally { teardown(); }
});

test("最新帧优先：socket 里还有没发完的帧时，跳过而不是排队", async () => {
  const created = setup();
  try {
    const slow = new FakeViewer();
    const fast = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, slow as any);
    await attachCastViewer(SESSION, TARGET, fast as any);
    slow.received.length = 0; fast.received.length = 0;

    slow.bufferedAmount = 60_000;        // 上一帧还没发完
    created[0].pushFrame("F1");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(slow.received, [],
      "落后的连接不该继续排队——排进去的那一帧发到时早就过期了");
    assert.equal(fast.received.length, 1, "没落后的连接照常收帧");

    slow.bufferedAmount = 0;             // 追上了
    created[0].pushFrame("F2");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(JSON.parse(slow.received[0]).data, "F2",
      "追上之后直接拿到最新的一帧，不补发旧的");
  } finally { teardown(); }
});

// 空闲高清帧：截图流的帧尺寸恒等于 CSS 视口（实测，dsf 无效），所以流本身没法更清晰；
// captureScreenshot 的 clip.scale 才认。停下来补一张 2x 的图。
test("静止后补一张 2x 高清帧，并按当前布局裁切", async () => {
  const created = setup();
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    created[0].emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data: "SOFT", sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } },
    })));
    await new Promise((r) => setTimeout(r, 900));   // 超过空闲阈值（IDLE_BEFORE_STILL_MS=700）
    const shot = created[0].sent.find((m) => m.method === "Page.captureScreenshot");
    assert.ok(shot, "静止后应抓一张高清静帧");
    assert.equal(shot!.params.clip.scale, 2);
    assert.equal(shot!.params.clip.width, 800, "裁切区域必须是流当前的布局");
    assert.equal(shot!.params.clip.height, 600);
  } finally { teardown(); }
});

test("遮罩期间绝不抓高清静帧（比直接发流更糟：把密码页拍得更清楚）", async () => {
  const created = setup();
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    created[0].emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data: "SOFT", sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } },
    })));
    // 密码框聚焦
    created[0].emit("message", Buffer.from(JSON.stringify({
      method: "Runtime.bindingCalled", params: { name: "__browsermint_password_focus", payload: "1" },
    })));
    await new Promise((r) => setTimeout(r, 900));
    const shot = created[0].sent.find((m) => m.method === "Page.captureScreenshot");
    assert.equal(shot, undefined, "遮罩期间不得抓图");
  } finally { teardown(); }
});

test("落后的连接不会饿死：缓冲排空后补发最后一帧（不是永远停在旧画面）", async () => {
  const created = setup();
  try {
    const slow = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, slow as any);
    slow.received.length = 0;
    slow.bufferedAmount = 60_000;         // 正忙
    created[0].pushFrame("LAST");         // 之后页面静止，不会再有帧
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(slow.received, [], "忙的时候先不发");
    slow.bufferedAmount = 0;              // 排空了，但没有任何新帧来触发发送
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(JSON.parse(slow.received[0]).data, "LAST",
      "必须自己补发，否则页面静止后这个连接永远停在更早的画面上");
  } finally { teardown(); }
});

test("新连上的观看者拿到缓存帧时，必须同时拿到布局尺寸（否则能看不能点）", async () => {
  const created = setup();
  try {
    const first = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, first as any);
    created[0].emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data: "CACHED", sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } },
    })));
    await new Promise((r) => setTimeout(r, 20));

    const joiner = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, joiner as any);
    const painted = JSON.parse(joiner.received[0]);
    assert.equal(painted.data, "CACHED");
    assert.equal(painted.layoutWidth, 800, "没有布局尺寸，viewer 会拒绝一切输入");
    assert.equal(painted.layoutHeight, 600);
  } finally { teardown(); }
});

// ── 高清静帧与动帧的竞态（codex 复审 2026-08-02）────────────────────────────
// 静帧截图是慢往返：期间若页面又动了（新动帧已广播），迟到的静帧再发出去就是
// 把旧画面盖在新画面上。frameSeq 在截图开始时固化，动过就丢弃这张静帧。

/** captureScreenshot 的回复由测试手动控制，其余命令照常自动回。 */
class StillSocket extends FakeSocket {
  answerShot: ((data: string) => void) | null = null;
  send(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.method === "Page.captureScreenshot") {
      this.sent.push(msg);
      this.answerShot = (data: string) => this.emit("message",
        Buffer.from(JSON.stringify({ id: msg.id, result: { data } })));
      return;
    }
    super.send(raw);
  }
  pushStreamFrame(data: string) {
    this.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data, sessionId: 9, metadata: { deviceWidth: 800, deviceHeight: 600 } },
    })));
  }
}

test("截图期间来了新动帧：迟到的静帧作废，不得盖在新画面上", async () => {
  const created = setup({ sockets: [new StillSocket()] });
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created[0] as StillSocket;
    sock.pushStreamFrame("MOVE1");
    await new Promise((r) => setTimeout(r, 900));   // 静止超过 700ms → 触发截图
    assert.ok(sock.answerShot, "idle 后应发起高清截图");
    sock.pushStreamFrame("MOVE2");                  // 截图往返期间页面又动了
    sock.answerShot!("STALE_STILL");
    await new Promise((r) => setTimeout(r, 20));
    const datas = v.received.map((x) => JSON.parse(x).data).filter(Boolean);
    assert.ok(!datas.includes("STALE_STILL"), "过期静帧必须被丢弃");
    assert.equal(datas.at(-1), "MOVE2", "屏上留的必须是最新动帧");
  } finally { teardown(); }
});

test("截图期间页面没动：静帧正常送达（卫兵不误杀）", async () => {
  const created = setup({ sockets: [new StillSocket()] });
  try {
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created[0] as StillSocket;
    sock.pushStreamFrame("MOVE1");
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(sock.answerShot, "idle 后应发起高清截图");
    sock.answerShot!("SHARP_STILL");
    await new Promise((r) => setTimeout(r, 20));
    const datas = v.received.map((x) => JSON.parse(x).data).filter(Boolean);
    assert.equal(datas.at(-1), "SHARP_STILL", "静止时高清帧应到达 viewer");
  } finally { teardown(); }
});


/**
 * 造两张「差一点点」的真 JPEG。
 *
 * 不能用假字符串：差分器解码不了就直接回退整帧，于是**任何关于增量的断言在这一层都
 * 区分不出对错**（这条测试第一版就是这么白写的）。
 */
async function realJpegs(): Promise<{ a: string; b: string }> {
  const sharp = (await import("sharp")).default;
  const W = 320, H = 240;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const band = 60 + 150 * Math.abs(Math.sin(y / 9));
    raw[i] = band; raw[i + 1] = (band + x) & 0xff; raw[i + 2] = (band + y) & 0xff;
  }
  const changed = Buffer.from(raw);
  for (let y = 40; y < 70; y++) for (let x = 40; x < 90; x++) {
    const i = (y * W + x) * 3; changed[i] = 0; changed[i + 1] = 0; changed[i + 2] = 0;
  }
  const enc = (r: Buffer) =>
    sharp(r, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 62 }).toBuffer();
  return { a: (await enc(raw)).toString("base64"), b: (await enc(changed)).toString("base64") };
}

test("布局尺寸在整条流上必须恒定——变来变去 = 画面不停放大缩小", async () => {
  // 2026-08-04：第一版修法是「metadata 除以倍率」，但倍率在起流/重配的间隙里未必等于
  // 这一帧的倍率，于是布局在 1280x800 与 2560x1600 之间横跳，用户看到画面反复缩放。
  // 判据不是「某一帧对不对」，而是**整条流上只能有一个值**。
  const created = setup({
    sockets: [() => new FakeSocket(), () => new StillSocket()], scrollWidth: 735,
  });
  try {
    await setTargetViewport(SESSION, TARGET, 1280, 800, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)! as StillSocket;
    const push = (dw: number, dh: number) => sock.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data: "AAA", sessionId: 9, metadata: { deviceWidth: dw, deviceHeight: dh } },
    })));
    push(2560, 1600);            // Chrome 按设备像素报
    await settle();
    push(2560, 1600);
    await settle();
    push(1280, 800);             // 有些时刻它报的是 CSS 像素（重配前后）
    await settle();
    const layouts = new Set(v.received.map(m => {
      const f = JSON.parse(m);
      return f.layoutWidth ? `${f.layoutWidth}x${f.layoutHeight}` : null;
    }).filter(Boolean));
    assert.equal(layouts.size, 1, `整条流上布局必须恒定，实际出现了 ${[...layouts].join(" / ")}`);
    assert.ok(layouts.has("1280x800"), `应当是我们跟 Chrome 要的 CSS 视口，实际 ${[...layouts]}`);
  } finally { teardown(); }
});

test("上报给观看端的布局是 CSS 像素，不是设备像素（2 倍屏画面会整整大一倍）", async () => {
  // 2026-08-04 用户实测：画面在「正常」和「整体放大/下移/底部被切」之间来回跳。
  // 根因就在这里：screencastFrame 的 metadata 是设备像素，2 倍屏下是 2560x1600，
  // 而观看端拿它当 CSS 布局尺寸去定画布的显示大小 → 画面放大一倍。另一些帧上报的是
  // CSS 像素，两种单位交替出现 = 来回跳。1 倍屏下两者数值相同，所以只在视网膜屏上犯。
  const created = setup({
    sockets: [() => new FakeSocket(), () => new StillSocket()], scrollWidth: 735,
  });
  try {
    await setTargetViewport(SESSION, TARGET, 1280, 800, 2);      // 2 倍屏
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)! as StillSocket;
    // Chrome 按设备像素上报
    sock.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data: "AAA", sessionId: 9, metadata: { deviceWidth: 2560, deviceHeight: 1600 } },
    })));
    await settle();
    const frame = JSON.parse(v.received.at(-1)!);
    assert.equal(frame.layoutWidth, 1280,
      `观看端拿到的必须是 CSS 像素，实际 ${frame.layoutWidth}x${frame.layoutHeight}`);
    assert.equal(frame.layoutHeight, 800);
  } finally { teardown(); }
});

test("静帧之后的下一帧必须是整帧，不能是接在旧动帧上的增量", async () => {
  // 用户实测（2026-08-04）：静止时画面整体下移、顶部空一条、底部被切，和正常状态来回跳。
  // 根因是观看端手里已经换成了那张高清静帧，而差分器的基准还停在之前的动帧上——
  // 下一帧的增量（含滚动位移）被贴到了静帧上。
  //
  // **必须把观看端倍率设成 2**：只有「静帧倍率 == 流倍率」时旧写法才跳过重置。
  // 倍率不同的时候旧写法也会重置，所以此前的用例（默认 1x）永远碰不到这个洞——
  // 这正是它躲过测试、直到用户在视网膜屏上才撞见的原因。
  const created = setup({
    sockets: [() => new FakeSocket(), () => new StillSocket()], scrollWidth: 735,
  });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)! as StillSocket;
    const { a, b } = await realJpegs();
    sock.pushStreamFrame(a);
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(sock.answerShot, "idle 后应发起高清截图");
    sock.answerShot!(a);                            // 高清静帧（观看端手里换成了它）
    await new Promise((r) => setTimeout(r, 60));
    v.received.length = 0;
    sock.pushStreamFrame(b);                        // 页面又动起来
    await new Promise((r) => setTimeout(r, 400));
    const frames = v.received.map((x) => JSON.parse(x)).filter(f => f.data || f.delta);
    assert.ok(frames.length > 0, "动起来之后应当有帧发出");
    assert.ok(frames[0].data,
      `静帧之后的第一帧必须是整帧，实际 ${JSON.stringify(frames[0]).slice(0, 140)}`);
  } finally { teardown(); }
});

// 注：原「放宽布局跨 producer 记忆」的两条用例已随 fit 机制一并移除
// （布局固定后没有「放宽布局」这个概念了，见上面的固定视口用例）。

// 2026-08-03 推翻了此前那条「流已经是 2x 就不抓静帧」。当时的理由是「像素数没增加，
// 抓了也白抓」——**只对了像素这一半**。视网膜屏上 2x 的流已经是像素对像素，可 JPEG
// 的振铃仍然压在每个字的边缘上，这正是用户说的「100% 看着糊、80% 反而清楚」（80% 时
// 帧被降采样，痕迹被平均掉了）。所以静帧该抓，只是它的价值在画质不在分辨率。
test("流已经是 2x：静止时照样抓高清静帧（同倍率、更高画质）", async () => {
  // setTargetViewport 先建一条视口 socket，producer 是第二条 —— 静帧要断言在后者上
  const created = setup({
    sockets: [() => new FakeSocket(), () => new StillSocket()], scrollWidth: 735,
  });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)! as StillSocket;
    sock.pushStreamFrame("MOVE1");
    await new Promise((r) => setTimeout(r, 900));   // 超过 IDLE_BEFORE_STILL_MS
    const shot = sock.sent.find((m) => m.method === "Page.captureScreenshot");
    assert.ok(shot, "静止之后必须抓一张静帧");
    assert.equal(shot!.params.clip.scale, 2, "倍率不低于流本身，别把画面降下去");
    assert.ok(shot!.params.quality >= 95, "静帧的意义在画质：质量必须明显高于流");
    sock.answerShot!("STILL");
    await new Promise((r) => setTimeout(r, 20));
    const datas = v.received.map((x) => JSON.parse(x).data).filter(Boolean);
    assert.equal(datas.at(-1), "STILL", "屏上最后留的是那张高画质静帧");
  } finally { teardown(); }
});

// ── 画面冻结（2026-08-03 用户实测：百度点搜索结果后画面死掉）────────────────
// 根因：点 target=_blank 的链接 → 远端新建标签页抢走前台 → 原页面被 Chrome 判为
// 不可见 → 合成器不再出帧 → 画面永久停在最后一帧（而且看起来一切正常：WS 没断、
// 尺寸没变、像素也在）。实测对照见 session-driver.ts 与 cdp.service.ts 的注释。
test("起流即开焦点模拟（后台标签页照样出帧的唯一有效手段）", async () => {
  const created = setup();
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)!;
    const focus = sock.sent.filter((m) => m.method === "Emulation.setFocusEmulationEnabled");
    assert.equal(focus.length, 1);
    assert.equal(focus[0].params.enabled, true);
    // 必须在起流之前：先出的帧也得是可见状态下渲染的
    const methods = sock.methods();
    assert.ok(methods.indexOf("Emulation.setFocusEmulationEnabled")
              < methods.indexOf("Page.startScreencast"));
  } finally { teardown(); }
});

test("页面不可见且有人在看：只重申焦点模拟，绝不抢前台", async () => {
  const activated: string[] = [];
  const created = setup({ onCdp: (m, prm) => { if (m === "Target.activateTarget") activated.push(prm?.targetId); } });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)!;
    const before = sock.sent.filter((m) => m.method === "Emulation.setFocusEmulationEnabled").length;
    sock.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastVisibilityChanged", params: { visible: false },
    })));
    await new Promise((r) => setTimeout(r, 50));
    const after = sock.sent.filter((m) => m.method === "Emulation.setFocusEmulationEnabled");
    assert.equal(after.length, before + 1, "应重申一次焦点模拟");
    assert.equal(after.at(-1)!.params.enabled, true);
    // 等过恢复窗口：仍然不许抢前台（只读观众抢前台会打断持租约的 agent，
    // 且两个 producer 会每 2.5s 互抢——codex 复审 High-2）
    await new Promise((r) => setTimeout(r, 2800));
    assert.deepEqual(activated, [], "任何情况下看门狗都不得调用 activateTarget");
    const stops = sock.sent.filter((m) => m.method === "Page.stopScreencast");
    assert.ok(stops.length >= 1, "温和恢复：重启自己的流");
  } finally { teardown(); }
});

test("恢复窗口内来了新帧：证明已恢复，不再重启流", async () => {
  const created = setup();
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)!;
    const stopsBefore = sock.sent.filter((m) => m.method === "Page.stopScreencast").length;
    sock.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastVisibilityChanged", params: { visible: false },
    })));
    await new Promise((r) => setTimeout(r, 100));
    sock.pushFrame("BACK");            // 帧本身就是恢复的证据
    await new Promise((r) => setTimeout(r, 2800));
    const stopsAfter = sock.sent.filter((m) => m.method === "Page.stopScreencast").length;
    assert.equal(stopsAfter, stopsBefore, "收到帧后不该再重启流");
  } finally { teardown(); }
});

test("观众离开后即使报不可见也不做任何恢复动作", async () => {
  const created = setup();
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)!;
    v.close();
    await new Promise((r) => setTimeout(r, 20));
    // 只数可见性恢复会发的两种命令：producer 起流 1.2s 后还会自己做一次布局复核
    // （Runtime.evaluate 量内容宽度），拿消息总数当判据会把它误算进来。
    const count = () => sock.sent.filter((m) =>
      m.method === "Emulation.setFocusEmulationEnabled" || m.method === "Page.stopScreencast").length;
    const before = count();
    sock.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastVisibilityChanged", params: { visible: false },
    })));
    await new Promise((r) => setTimeout(r, 2800));
    assert.equal(count(), before, "无观众时不该为可见性做任何恢复动作");
  } finally { teardown(); }
});

test("主框架导航后重申焦点模拟（导航是最可能把它弄丢的时刻）", async () => {
  const created = setup();
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    const sock = created.at(-1)!;
    const before = sock.sent.filter(
      (m) => m.method === "Emulation.setFocusEmulationEnabled").length;
    sock.emit("message", Buffer.from(JSON.stringify({
      method: "Page.frameNavigated", params: { frame: { id: "f1", url: "https://x/" } },
    })));
    // 子框架导航不该触发
    sock.emit("message", Buffer.from(JSON.stringify({
      method: "Page.frameNavigated",
      params: { frame: { id: "f2", parentId: "f1", url: "https://y/" } },
    })));
    await new Promise((r) => setTimeout(r, 30));
    const after = sock.sent.filter(
      (m) => m.method === "Emulation.setFocusEmulationEnabled").length;
    assert.equal(after, before + 1, "只有主框架导航才重申，子框架不算");
    // 重申不能把原有的主框架导航处理挤掉：曾经写成独立分支 + return，
    // 结果 URL 不更新、tabUpdate 不广播、放宽布局不失效（codex 复审 High-1）
    const tabUpdates = v.received.map((x) => JSON.parse(x))
      .filter((m: any) => m.type === "tabUpdate");
    assert.ok(tabUpdates.length >= 1, "导航后必须仍然广播 tabUpdate");
    assert.equal(tabUpdates.at(-1).url, "https://x/", "URL 必须更新");
  } finally { teardown(); }
});

// ── 用户点开的新页面（2026-08-03）────────────────────────────────────────────
// 点 target=_blank 的链接会在远端建一个新 target。平台的页面台账靠 agent 显式上报
// 喂养，而 Chrome 自己开的标签页没人上报 —— 于是新页面对平台不存在，画面停在原页，
// 用户看到的是「点了没反应」。attachedToTarget 的 openerId 是唯一的来源线索。
test("页面开出新页面：通知来源页的观看端", async () => {
  const created = setup();
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    v.received.length = 0;
    notifyChildTarget(SESSION, TARGET, { targetId: "child-1", url: "https://x/" });
    await new Promise((r) => setTimeout(r, 30));
    const msgs = v.received.map((x) => JSON.parse(x)).filter((m) => m.type === "childTarget");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].targetId, "child-1");
    assert.equal(msgs[0].url, "https://x/");
    assert.equal(msgs[0].openerTargetId, TARGET);
  } finally { teardown(); }
});

test("只有**此刻仍持写权**的连接算发起者，其他窗口不跟着跳", async () => {
  const created = setup();
  const asked: any[] = [];
  try {
    // 租约查询必须真的被调用：旧版只看「连接当时带没带 leaseId」，把过期租约也
    // 当成持有者（codex 复审 M4）。这个 mock 同时充当「有没有真的去查」的探针。
    // holdsLease 先取库时间再查行，两个都要有替身，否则查询根本走不到
    setPrismaForTests({
      $queryRaw: async () => [{ now: new Date() }],
      targetLease: { findFirst: async (q: any) => { asked.push(q); return { id: "L1" } } },
    } as any);
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const watcher = new FakeViewer();
    const controller = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, watcher as any);
    await attachCastViewer(SESSION, TARGET, controller as any, "L1");
    watcher.received.length = 0; controller.received.length = 0;
    notifyChildTarget(SESSION, TARGET, { targetId: "child-2" });
    await new Promise((r) => setTimeout(r, 30));
    const pick = (v: FakeViewer) => v.received.map((x) => JSON.parse(x))
      .find((m: any) => m.type === "childTarget");
    assert.ok(asked.length > 0, "必须真的去查租约，而不是只看连接带过 leaseId");
    assert.equal(pick(controller)?.initiated, true, "点链接的那个窗口才是发起者");
    assert.equal(pick(watcher)?.initiated, false,
      "旁观窗口只收到通知，不得自动切页（那就是抢焦点的老毛病换个马甲）");
  } finally { teardown(); setPrismaForTests(null as any); }
});

test("租约已经失效的连接不算发起者（连接还开着不代表还持有写权）", async () => {
  const created = setup();
  try {
    setPrismaForTests({
      $queryRaw: async () => [{ now: new Date() }],
      targetLease: { findFirst: async () => null },      // 租约没了
    } as any);
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const stale = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, stale as any, "L-EXPIRED");
    stale.received.length = 0;
    notifyChildTarget(SESSION, TARGET, { targetId: "child-x" });
    await new Promise((r) => setTimeout(r, 30));
    const msg = stale.received.map((x) => JSON.parse(x))
      .find((m: any) => m.type === "childTarget");
    assert.ok(msg, "通知本身还是要发（页面确实开了）");
    assert.equal(msg.initiated, false, "但它已经不是发起者了");
  } finally { teardown(); setPrismaForTests(null as any); }
});

test("没有观看端时不做任何广播（agent 自己开的页面不该惊动谁）", () => {
  setup();
  try {
    notifyChildTarget(SESSION, "no-such-target", { targetId: "child-3" });
  } finally { teardown(); }
});

// ── 文本类输入（2026-08-03 用户实测：中文打不进去）──────────────────────────
// dispatchInput 开头有一道 `if (!msg.event) return`，而 insertText / imeComposition
// 这类消息只有一段文本、没有 event 字段——它们在进入任何分支之前就被丢掉了。
// 中文定稿因此从来没送到过页面，粘贴的文本应该也一样。
//
// 这块此前**零测试覆盖**：BM 的输入测试全在测鼠标和滚轮；前端那条「中文输入」的
// 用例只断言到「组件发出了 insertText」，接收端理不理没人管，于是两边都是绿的。
test("输入法定稿的文字必须真的送到页面（没有 event 字段也要认）", async () => {
  const created = setup();
  try {
    setPrismaForTests({
      $queryRaw: async () => [{ now: new Date() }],
      targetLease: { findFirst: async () => ({ id: "L1" }) },
    } as any);
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any, "L1");
    const sock = created.at(-1)!;
    sock.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data: "F", sessionId: 1, metadata: { deviceWidth: 735, deviceHeight: 867 } },
    })));
    await new Promise((r) => setTimeout(r, 20));
    v.emit("message", Buffer.from(JSON.stringify({
      type: "insertText", text: "你好啊", revision: 1,
    })));
    await new Promise((r) => setTimeout(r, 60));
    const ins = sock.sent.filter((m) => m.method === "Input.insertText");
    assert.equal(ins.length, 1, "insertText 必须被分发到页面");
    assert.equal(ins[0].params.text, "你好啊");
  } finally { teardown(); setPrismaForTests(null as any); }
});

test("组合中的文字也要送到页面（否则远端一直空白到选词那一刻）", async () => {
  const created = setup();
  try {
    setPrismaForTests({
      $queryRaw: async () => [{ now: new Date() }],
      targetLease: { findFirst: async () => ({ id: "L1" }) },
    } as any);
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any, "L1");
    const sock = created.at(-1)!;
    sock.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data: "F", sessionId: 1, metadata: { deviceWidth: 735, deviceHeight: 867 } },
    })));
    await new Promise((r) => setTimeout(r, 20));
    v.emit("message", Buffer.from(JSON.stringify({
      type: "imeComposition", text: "nihao", revision: 1,
    })));
    await new Promise((r) => setTimeout(r, 60));
    const comp = sock.sent.filter((m) => m.method === "Input.imeSetComposition");
    assert.equal(comp.length, 1);
    assert.equal(comp[0].params.text, "nihao");
  } finally { teardown(); setPrismaForTests(null as any); }
});

// ── codex 复审 2026-08-03（输入法批次）的修复 ───────────────────────────────
function leaseOk() {
  setPrismaForTests({
    $queryRaw: async () => [{ now: new Date() }],
    targetLease: { findFirst: async () => ({ id: "L1" }) },
  } as any);
}
async function controllingViewer(created: any[]) {
  await setTargetViewport(SESSION, TARGET, 735, 867, 2);
  const v = new FakeViewer();
  await attachCastViewer(SESSION, TARGET, v as any, "L1");
  const sock = created.at(-1)!;
  sock.emit("message", Buffer.from(JSON.stringify({
    method: "Page.screencastFrame",
    params: { data: "F", sessionId: 1, metadata: { deviceWidth: 735, deviceHeight: 867 } },
  })));
  await new Promise((r) => setTimeout(r, 20));
  return { v, sock };
}

test("打字打到一半断线：远端不许留着那段没定稿的拼音（High-1）", async () => {
  const created = setup();
  try {
    leaseOk();
    const { v, sock } = await controllingViewer(created);
    v.emit("message", Buffer.from(JSON.stringify({
      type: "imeComposition", text: "nihao", revision: 1,
    })));
    await new Promise((r) => setTimeout(r, 60));
    v.close();                       // 打到一半连接断了
    await new Promise((r) => setTimeout(r, 30));
    const comps = sock.sent.filter((m) => m.method === "Input.imeSetComposition");
    assert.equal(comps.at(-1)!.params.text, "",
      "断线时必须撤销组合，否则那段拼音永远留在页面上、用户自己也删不掉");
  } finally { teardown(); setPrismaForTests(null as any); }
});

test("定稿是一条消息里做完撤销+插入（High-2：拆开会丢字）", async () => {
  const created = setup();
  try {
    leaseOk();
    const { v, sock } = await controllingViewer(created);
    v.emit("message", Buffer.from(JSON.stringify({
      type: "imeCommit", text: "你好啊", revision: 1,
    })));
    await new Promise((r) => setTimeout(r, 60));
    const methods = sock.sent.map((m) => m.method);
    const iClear = methods.lastIndexOf("Input.imeSetComposition");
    const iIns = methods.lastIndexOf("Input.insertText");
    assert.ok(iClear >= 0 && iIns > iClear, "撤销要在插入之前，且两者都要发生");
    assert.equal(sock.sent[iClear].params.text, "");
    assert.equal(sock.sent[iIns].params.text, "你好啊");
  } finally { teardown(); setPrismaForTests(null as any); }
});

test("按 Esc 取消组合：只撤销、不插入空文字", async () => {
  const created = setup();
  try {
    leaseOk();
    const { v, sock } = await controllingViewer(created);
    const before = sock.sent.filter((m) => m.method === "Input.insertText").length;
    v.emit("message", Buffer.from(JSON.stringify({
      type: "imeCommit", text: "", revision: 1,
    })));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sock.sent.filter((m) => m.method === "Input.insertText").length, before);
    assert.equal(
      sock.sent.filter((m) => m.method === "Input.imeSetComposition").at(-1)!.params.text, "");
  } finally { teardown(); setPrismaForTests(null as any); }
});

test("超长粘贴按码点截断，不把 emoji 劈成半个（M7）", async () => {
  const created = setup();
  try {
    leaseOk();
    const { v, sock } = await controllingViewer(created);
    // 每个 emoji 占 2 个 UTF-16 单元。**前面加一个单单元字符**，截断位置才会落在
    // 某个 emoji 中间——全是 emoji 的话按偶数位切正好在边界上，测不出问题
    // （第一版就是这么写的，变异验证时才发现它抓不住）。
    const text = "a" + "😀".repeat(60000);
    v.emit("message", Buffer.from(JSON.stringify({
      type: "insertText", text, revision: 1,
    })));
    await new Promise((r) => setTimeout(r, 80));
    const sent = sock.sent.filter((m) => m.method === "Input.insertText").at(-1)!.params.text;
    assert.ok(sent.length > 0);
    // 没有落单的代理项 = 没有被劈开的字符
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(sent),
      "截断处不得留下半个字符");
  } finally { teardown(); setPrismaForTests(null as any); }
});

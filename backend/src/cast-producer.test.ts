import test from "node:test";
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
  resetCdpServiceOverridesForTests,
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

function setup(opts: { sockets?: FakeSocket[]; scrollWidth?: number } = {}) {
  const created: FakeSocket[] = [];
  resetCastTestHooks();
  setCdpServiceOverridesForTests({
    executeCdpCommand: async (_s, method) => {
      if (method === "Target.getTargets") {
        return { targetInfos: [{ targetId: TARGET, type: "page" }, { targetId: "w-1", type: "worker" }] };
      }
      return {};
    },
  });
  setCastTestHooks({
    cdpBase: { sessionId: SESSION, base: "ws://fake" },
    socketFactory: () => {
      const s = opts.sockets?.shift() ?? new FakeSocket();
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
test("不重排的站点：内容超出视口时缩放适配（而不是留一条横向滚动条）", async () => {
  const created = setup({ scrollWidth: 1250 });   // 视口给 735，页面仍要 1250（百度实测值）
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);   // HiDPI 观看端
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    await new Promise((r) => setTimeout(r, 1600));   // 等 fit 评估

    const producerSock = created.at(-1)!;
    const metrics = producerSock.sent.filter((m) => m.method === "Emulation.setDeviceMetricsOverride");
    // max(内容 1250, 栏宽 735 × DPR 2 = 1470) → 1470
    assert.equal(metrics.at(-1)!.params.width, 1470,
      "要缩放的页面：布局宽取 max(内容宽, 栏宽×DPR)");
    // 上限必须放行整幅布局：按栏宽封顶会把 1470 的帧又缩回 735，等于白做
    const casts = producerSock.sent.filter((m) => m.method === "Page.startScreencast");
    assert.equal(casts.at(-1)!.params.maxWidth, 1470);
  } finally { teardown(); }
});

// 关键回归：曾把「按 DPR 提分辨率」折进触发条件，结果响应式站点也被放宽到 width×dpr，
// 正文字号直接减半——那正是这个功能要避免的事。
test("响应式站点不触发缩放（哪怕 DPR>1 也不能放宽，否则字变一半大）", async () => {
  const created = setup({ scrollWidth: 735 });    // 页面老实按视口重排
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);   // HiDPI 观看端
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    await new Promise((r) => setTimeout(r, 1600));

    const producerSock = created.at(-1)!;
    const metrics = producerSock.sent.filter((m) => m.method === "Emulation.setDeviceMetricsOverride");
    assert.ok(metrics.every((m) => m.params.width === 735),
      "响应式站点不该被放宽布局视口（那会把正文字号缩掉一半）");
  } finally { teardown(); }
});

// 缩放档位：语义对齐浏览器 Ctrl +/− —— 缩小 = 布局更宽 = 内容显小但帧像素更多。
test("缩放 50%：布局按栏宽/zoom 放宽，帧上限跟着放宽", async () => {
  const created = setup({ scrollWidth: 700 });    // 页面本身装得下，不触发 fit
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 1, 0.5);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    await new Promise((r) => setTimeout(r, 1600));

    const sock = created.at(-1)!;
    const metrics = sock.sent.filter((m) => m.method === "Emulation.setDeviceMetricsOverride");
    assert.equal(metrics.at(-1)!.params.width, 1470, "50% → 布局 = 735/0.5");
    const casts = sock.sent.filter((m) => m.method === "Page.startScreencast");
    assert.equal(casts.at(-1)!.params.maxWidth, 1470, "帧上限不能还按栏宽，否则又缩回去");
  } finally { teardown(); }
});

test("缩放 150%：布局收窄，内容显大（代价是像素更少）", async () => {
  const created = setup({ scrollWidth: 400 });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 1, 1.5);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    await new Promise((r) => setTimeout(r, 1600));

    const metrics = created.at(-1)!.sent
      .filter((m) => m.method === "Emulation.setDeviceMetricsOverride");
    assert.equal(metrics.at(-1)!.params.width, 490, "150% → 布局 = 735/1.5");
  } finally { teardown(); }
});

test("缩放后仍按缩放后的布局判断是否装得下（不是按栏宽）", async () => {
  const created = setup({ scrollWidth: 1200 });   // 内容 1200
  try {
    // 50% → 布局 1470 已经装得下 1200，不该再放宽
    await setTargetViewport(SESSION, TARGET, 735, 867, 1, 0.5);
    const v = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v as any);
    await new Promise((r) => setTimeout(r, 1600));

    const metrics = created.at(-1)!.sent
      .filter((m) => m.method === "Emulation.setDeviceMetricsOverride");
    assert.ok(metrics.every((m) => m.params.width === 1470),
      "布局已够宽就不该二次放宽");
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

    pushMeta("OLD", 400, 300);           // 还在管线里的旧布局帧
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(v.received, [],
      "过渡期内旧布局的帧不得下发——否则它会被打上新 revision，坐标校验形同虚设");

    pushMeta("NEW", 800, 600);           // 第一张确认属于新布局的帧
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
    await new Promise((r) => setTimeout(r, 400));   // 超过空闲阈值
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
    await new Promise((r) => setTimeout(r, 400));
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
    await new Promise((r) => setTimeout(r, 400));   // 250ms 静止 → 触发截图
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
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(sock.answerShot, "idle 后应发起高清截图");
    sock.answerShot!("SHARP_STILL");
    await new Promise((r) => setTimeout(r, 20));
    const datas = v.received.map((x) => JSON.parse(x).data).filter(Boolean);
    assert.equal(datas.at(-1), "SHARP_STILL", "静止时高清帧应到达 viewer");
  } finally { teardown(); }
});

// ── 放宽布局跨 producer 记忆（2026-08-02 用户实测：切走回来必放大缩小一次）────
// fit 放宽的布局原本只活在 producer 里：viewer 全走 + linger 到期拆掉 producer 后
// 布局丢失，下次建流先按基础布局起（页面重排、内容显大），1.2s 后 fit 又放宽回去
// （再重排、内容显小）。现在放宽结果按 target 记住，重建的 producer 直接用它起流。
test("producer 重建按记住的放宽布局起流，fit 复核不再重排", async () => {
  const created = setup({ scrollWidth: 1250 });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v1 = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v1 as any);
    await new Promise((r) => setTimeout(r, 1600));   // 等 fit 评估：735 → 1470
    const sock1 = created.at(-1)!;   // [0]=viewport socket, [1]=producer
    const widened = sock1.sent.filter((m) => m.method === "Emulation.setDeviceMetricsOverride").at(-1)!;
    assert.equal(widened.params.width, 1470, "前置：fit 已放宽到 1470");

    // producer 意外死掉（等价于 linger 到期拆流，跳过 5s 等待）
    sock1.close();
    const v2 = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v2 as any);
    const sock2 = created.at(-1)!;
    assert.notEqual(sock2, sock1, "应新建 producer");
    const metrics0 = sock2.sent.filter((m) => m.method === "Emulation.setDeviceMetricsOverride")[0];
    assert.equal(metrics0.params.width, 1470,
      "重建的 producer 必须直接按放宽布局起流，而不是基础 735（那会让页面重排两次）");
    const cast0 = sock2.sent.filter((m) => m.method === "Page.startScreencast")[0];
    assert.equal(cast0.params.maxWidth, 1470, "帧上限同样按放宽布局");

    // 喂一帧让 producer 知道当前布局，再等 fit 复核：同布局不得 stop/start
    sock2.emit("message", Buffer.from(JSON.stringify({
      method: "Page.screencastFrame",
      params: { data: "F", sessionId: 1, metadata: { deviceWidth: 1470, deviceHeight: 1734 } },
    })));
    await new Promise((r) => setTimeout(r, 1600));
    const stops = sock2.sent.filter((m) => m.method === "Page.stopScreencast");
    assert.equal(stops.length, 0, "fit 复核发现布局已一致：不许再 stop/start 重排页面");
  } finally { teardown(); }
});

test("显式改视口（拖分栏/换缩放档）会作废记住的放宽布局，由 fit 重新推导", async () => {
  const created = setup({ scrollWidth: 1250 });
  try {
    await setTargetViewport(SESSION, TARGET, 735, 867, 2);
    const v1 = new FakeViewer();
    await attachCastViewer(SESSION, TARGET, v1 as any);
    await new Promise((r) => setTimeout(r, 1600));   // fit → 1470
    await setTargetViewport(SESSION, TARGET, 900, 867, 2);   // 用户拖宽了栏
    // 改视口后 producer 收到的 metrics 应是新基础布局 900，而不是按旧栏宽算的 1470
    const prod = created[1];   // [0]=viewport socket, [1]=producer
    const m = prod.sent.filter((x) => x.method === "Emulation.setDeviceMetricsOverride").at(-1)!;
    assert.equal(m.params.width, 900, "旧放宽布局必须作废（它按 735 栏宽推导）");
  } finally { teardown(); }
});

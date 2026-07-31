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
  attachCastViewer, forgetTargetViewport, setTargetViewport,
  setCastTestHooks, resetCastTestHooks, setCdpServiceOverridesForTests,
  resetCdpServiceOverridesForTests,
} = await import("./services/cdp.service.js");

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

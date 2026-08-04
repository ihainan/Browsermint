import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browsermint_test",
  JWT_SECRET: "test-jwt-secret-minimum-16",
  JWT_SESSION_TOKEN_SECRET: "test-session-secret-minimum-16",
  NODE_ENV: "test",
});

const { setPrismaForTests } = await import("./db/client.js");
const {
  acquireLease, renewLease, releaseLease, currentLease, holdsLease, isLockedByOther,
} = await import("./services/lease.service.js");

/** In-memory stand-in for the TargetLease table, faithful to the two properties
 *  the arbitration depends on: unique (session,target) and conditional updates. */
function makePrisma() {
  let rows: any[] = [];
  let seq = 0;
  return {
    // 过期判断统一走 DB 时钟（多副本各用本机时钟会出现"两个都以为自己能写"）。
    // holdsLease 的单条合并查询（输入热路径省一次往返）也在这里仿真。
    $queryRaw: async (strings: any, ...vals: any[]) => {
      const q = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (q.includes('FROM "TargetLease"')) {
        const [sessionId, targetId, leaseId] = vals;
        const now = new Date();
        const hit = rows.find((r) => r.sessionId === sessionId && r.targetId === targetId
          && r.leaseId === leaseId && r.expiresAt > now);
        return hit ? [{ id: hit.id }] : [];
      }
      return [{ now: new Date() }];
    },
    _rows: () => rows,
    targetLease: {
      findUnique: async ({ where }: any) => {
        const k = where.sessionId_targetId;
        return rows.find((r) => r.sessionId === k.sessionId && r.targetId === k.targetId) ?? null;
      },
      findFirst: async ({ where }: any) => rows.find((r) =>
        r.sessionId === where.sessionId && r.targetId === where.targetId &&
        (!where.leaseId || r.leaseId === where.leaseId) &&
        (!where.expiresAt?.gt || r.expiresAt > where.expiresAt.gt)) ?? null,
      create: async ({ data }: any) => {
        if (rows.some((r) => r.sessionId === data.sessionId && r.targetId === data.targetId)) {
          throw new Error("unique violation");
        }
        const row = { id: `l${++seq}`, ...data };
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = rows.filter((r) =>
          (!where.id || r.id === where.id) &&
          (!where.sessionId || r.sessionId === where.sessionId) &&
          (!where.targetId || r.targetId === where.targetId) &&
          (!where.leaseId || r.leaseId === where.leaseId) &&
          (!where.expiresAt?.gt || r.expiresAt > where.expiresAt.gt));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      deleteMany: async ({ where }: any) => {
        const before = rows.length;
        rows = rows.filter((r) => !(r.sessionId === where.sessionId &&
          r.targetId === where.targetId && r.leaseId === where.leaseId));
        return { count: before - rows.length };
      },
    },
  } as any;
}

const S = "sess-1", T = "page-1";

test("获取后他人拿不到，且能看到当前持有者", async () => {
  setPrismaForTests(makePrisma());
  const mine = await acquireLease(S, T, "win-a", "符积高");
  assert.equal(mine.ok, true);
  const other = await acquireLease(S, T, "win-b", "另一个窗口");
  assert.equal(other.ok, false);
  assert.equal((other as any).reason, "held");
  assert.equal((other as any).holderLabel, "符积高");
});

test("同一持有者重复获取是幂等的（刷新页面不该被自己挡住）", async () => {
  setPrismaForTests(makePrisma());
  const a = await acquireLease(S, T, "win-a", null);
  const b = await acquireLease(S, T, "win-a", null);
  assert.equal(b.ok, true);
  assert.notEqual((a as any).lease.leaseId, (b as any).lease.leaseId, "重取应换新 fencing token");
});

test("过期后可被他人接管（持有者不再心跳就是走了）", async () => {
  const prisma = makePrisma();
  setPrismaForTests(prisma);
  await acquireLease(S, T, "win-a", "A");
  prisma._rows()[0].expiresAt = new Date(Date.now() - 1000);
  const taken = await acquireLease(S, T, "win-b", "B");
  assert.equal(taken.ok, true);
  assert.equal((await currentLease(S, T))!.holderLabel, "B");
});

test("fencing：旧 leaseId 既不能续期，也不再被认作持有者", async () => {
  const prisma = makePrisma();
  setPrismaForTests(prisma);
  const a = await acquireLease(S, T, "win-a", "A");
  const staleId = (a as any).lease.leaseId;
  prisma._rows()[0].expiresAt = new Date(Date.now() - 1000);
  await acquireLease(S, T, "win-b", "B");          // 接管，leaseId 换了

  assert.equal(await holdsLease(S, T, staleId), false, "过期窗口不得再被认作持有者");
  const renew = await renewLease(S, T, staleId);
  assert.equal(renew.ok, false, "过期窗口不得靠续期把自己救回来");
});

test("释放别人的租约是无操作，不是错误", async () => {
  const prisma = makePrisma();
  setPrismaForTests(prisma);
  await acquireLease(S, T, "win-a", "A");
  await releaseLease(S, T, "not-my-lease");
  assert.equal(prisma._rows().length, 1, "别人的租约不该被误删");
});

test("isLockedByOther：持有者自己不被挡，其他人被挡", async () => {
  setPrismaForTests(makePrisma());
  const a = await acquireLease(S, T, "win-a", "A");
  const id = (a as any).lease.leaseId;
  assert.equal(await isLockedByOther(S, T, id), null, "持有者自己的写不该被挡");
  assert.notEqual(await isLockedByOther(S, T, null), null, "无租约的写必须被挡");
  assert.notEqual(await isLockedByOther(S, T, "other"), null);
});

test("过期租约不算锁（不能永久卡住一个页面）", async () => {
  const prisma = makePrisma();
  setPrismaForTests(prisma);
  await acquireLease(S, T, "win-a", "A");
  prisma._rows()[0].expiresAt = new Date(Date.now() - 1);
  assert.equal(await currentLease(S, T), null);
  assert.equal(await isLockedByOther(S, T, null), null);
});

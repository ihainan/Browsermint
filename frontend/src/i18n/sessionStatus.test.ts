import test from "node:test";
import assert from "node:assert/strict";
import { getSessionStatusLabel } from "./sessionStatus.ts";
import type { Session } from "../api/client.ts";

test("getSessionStatusLabel returns localized labels for every session status", () => {
  const statuses: Session["status"][] = ["creating", "running", "stopping", "stopped", "error", "paused"];

  assert.deepEqual(statuses.map((status) => getSessionStatusLabel("en", status)), [
    "creating",
    "running",
    "stopping",
    "stopped",
    "error",
    "idle",
  ]);
  assert.deepEqual(statuses.map((status) => getSessionStatusLabel("zh", status)), [
    "创建中",
    "运行中",
    "停止中",
    "已停止",
    "异常",
    "空闲",
  ]);
});

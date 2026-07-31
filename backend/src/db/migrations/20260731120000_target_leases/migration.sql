-- Single-writer lease over a page target.
-- Lives in Browsermint (not the platform) because every writer — user input,
-- the agent's own CDP connection, REST navigate/viewport — funnels through this
-- process. An arbiter anywhere else can be bypassed by the agent's direct CDP.
CREATE TABLE "TargetLease" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "sessionId"   UUID         NOT NULL,
    "targetId"    VARCHAR(128) NOT NULL,
    "leaseId"     VARCHAR(64)  NOT NULL,
    "holderLabel" VARCHAR(120),
    "holderKey"   VARCHAR(128) NOT NULL,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TargetLease_pkey" PRIMARY KEY ("id")
);

-- One writer per target: the unique index is what makes acquisition atomic.
CREATE UNIQUE INDEX "TargetLease_sessionId_targetId_key" ON "TargetLease"("sessionId", "targetId");
CREATE INDEX "TargetLease_expiresAt_idx" ON "TargetLease"("expiresAt");

ALTER TABLE "TargetLease" ADD CONSTRAINT "TargetLease_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

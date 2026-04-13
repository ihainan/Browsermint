-- AlterTable: add online time tracking columns to Session
ALTER TABLE "Session" ADD COLUMN "onlineMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "runningStartedAt" TIMESTAMP(3);

-- Back-fill runningStartedAt for sessions currently in "running" state.
-- Uses lastActiveAt as a conservative proxy (actual start time is unknown for
-- sessions that were running before this migration).
UPDATE "Session"
SET "runningStartedAt" = "lastActiveAt"
WHERE status = 'running' AND "deletedAt" IS NULL;

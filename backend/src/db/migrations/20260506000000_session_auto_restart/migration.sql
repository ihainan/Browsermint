-- AlterTable: add auto-restart attempt counter to Session
ALTER TABLE "Session" ADD COLUMN "autoRestartAttempts" INTEGER NOT NULL DEFAULT 0;

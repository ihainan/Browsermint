-- Stable external page identity → current CDP targetId.
-- Embedders (e.g. the ZGCAI chat workspace) address pages by their own id; CDP
-- target ids are recreated on every resume, so the mapping has to be persisted.
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "targetLabels" JSONB;

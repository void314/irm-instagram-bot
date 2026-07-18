-- Примечание: "tsv" (chunks) и "preferred_branch_ref_1c_id" (patients) уже были
-- добавлены вручную в 0003_hybrid.sql, drizzle-kit просто не видел это в снапшоте
-- (миграции применялись без drizzle-kit migrate). Здесь оставлена только реальная
-- новая колонка, добавление идемпотентно на случай повторного прогона.
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "citizenship" text;
-- 004 — CTR feedback baseline + rollback tracking.
--
-- Captures the GSC snapshot for the targeted query at the moment a content
-- change is applied. The ctr-feedback worker compares 14 days of post-apply
-- data against this baseline and rolls back losses.

ALTER TABLE opportunities ADD COLUMN baseline_ctr REAL;
ALTER TABLE opportunities ADD COLUMN baseline_position REAL;
ALTER TABLE opportunities ADD COLUMN baseline_impressions INTEGER;
ALTER TABLE opportunities ADD COLUMN feedback_checked_at TEXT;
ALTER TABLE opportunities ADD COLUMN feedback_outcome TEXT; -- 'improved' | 'flat' | 'rolled_back' | 'insufficient_data'
ALTER TABLE opportunities ADD COLUMN feedback_delta_ctr REAL;
ALTER TABLE opportunities ADD COLUMN rolled_back_to_history_id INTEGER;

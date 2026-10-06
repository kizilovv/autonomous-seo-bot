-- Preserve old snapshots but explicitly distinguish their unknown window.
ALTER TABLE ga4_snapshots ADD COLUMN window_start TEXT;
ALTER TABLE ga4_snapshots ADD COLUMN window_end TEXT;
CREATE INDEX idx_ga4_window ON ga4_snapshots(property_id, window_start, window_end);

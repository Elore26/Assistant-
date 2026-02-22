-- Add failure reason tracking to tasks
-- Tracks WHY tasks were not completed for pattern analysis
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS fail_reason TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS fail_count INTEGER DEFAULT 0;

-- Create task_fail_reasons table for aggregated analytics
CREATE TABLE IF NOT EXISTS task_fail_reasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id),
  reason TEXT NOT NULL,
  logged_at TIMESTAMPTZ DEFAULT now(),
  task_date DATE NOT NULL
);

ALTER TABLE task_fail_reasons ENABLE ROW LEVEL SECURITY;

-- Add source column to job_listings for conversion tracking (if missing)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='job_listings' AND column_name='source') THEN
    ALTER TABLE job_listings ADD COLUMN source TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='job_listings' AND column_name='region') THEN
    ALTER TABLE job_listings ADD COLUMN region TEXT;
  END IF;
END $$;

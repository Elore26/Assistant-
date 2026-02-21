-- Tier 5: Rocks (90-day priorities) + Critical Information Requirements
-- Based on EOS/Traction + McChrystal CoS Playbook

-- ─── ROCKS TABLE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  domain TEXT NOT NULL,                -- career/health/finance/learning/higrow
  measurable_target TEXT NOT NULL,     -- "Obtenir 3 interviews" (binary done/not done)
  current_status TEXT DEFAULT 'on_track', -- on_track/off_track/done
  quarter_start DATE NOT NULL,
  quarter_end DATE NOT NULL,
  progress_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE rocks ENABLE ROW LEVEL SECURITY;

-- ─── CRITICAL INFORMATION REQUIREMENTS ───────────────────────
CREATE TABLE IF NOT EXISTS critical_info_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,                 -- "Interview programmé"
  condition_type TEXT NOT NULL,        -- "job_status_change", "metric_threshold", "deadline_approaching"
  condition_config JSONB NOT NULL,     -- {"table": "job_listings", "field": "status", "value": "interview"}
  alert_priority INTEGER DEFAULT 1,   -- 1 = immediate push, 2 = next briefing
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE critical_info_requirements ENABLE ROW LEVEL SECURITY;

-- ─── DEFAULT CIRs (pre-configured) ──────────────────────────
INSERT INTO critical_info_requirements (title, condition_type, condition_config, alert_priority)
VALUES
  ('Interview programmé', 'job_status_change', '{"table": "job_listings", "field": "status", "value": "interview"}', 1),
  ('3+ rejets en 7 jours', 'metric_threshold', '{"table": "job_listings", "metric": "rejections_7d", "threshold": 3}', 2),
  ('Rock off-track > 14 jours', 'deadline_approaching', '{"table": "rocks", "metric": "off_track_days", "threshold": 14}', 2),
  ('Deadline Rock < 14 jours', 'deadline_approaching', '{"table": "rocks", "metric": "days_remaining", "threshold": 14}', 2),
  ('Candidature > 5j sans réponse', 'metric_threshold', '{"table": "job_listings", "metric": "days_since_applied", "threshold": 5}', 2)
ON CONFLICT DO NOTHING;

-- ─── SCORECARD WEEKLY SNAPSHOTS ──────────────────────────────
CREATE TABLE IF NOT EXISTS scorecard_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  metrics JSONB NOT NULL,             -- all 10 metrics stored as JSON
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(week_start)
);

ALTER TABLE scorecard_snapshots ENABLE ROW LEVEL SECURITY;

-- Add cover_letter_snippet to job_listings if missing
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='job_listings' AND column_name='cover_letter_snippet') THEN
    ALTER TABLE job_listings ADD COLUMN cover_letter_snippet TEXT;
  END IF;
END $$;

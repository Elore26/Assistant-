-- ============================================================
-- INTELLIGENCE LAYER: user_patterns, task_feedback, reminder_effectiveness
-- ============================================================

-- 1. USER PATTERNS — Bot learns behavioral patterns over time
CREATE TABLE IF NOT EXISTS user_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type TEXT NOT NULL,           -- 'completion_by_context', 'completion_by_day', 'completion_by_hour', 'completion_by_duration', 'reschedule_pattern', 'optimal_reminder_time'
  pattern_key TEXT NOT NULL,            -- e.g. 'health', 'monday', '09', '25min', 'learning_monday'
  pattern_value JSONB NOT NULL DEFAULT '{}',  -- { rate: 0.85, sample_size: 42, avg_duration_actual: 35 }
  confidence REAL NOT NULL DEFAULT 0,   -- 0-1, based on sample_size
  last_computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_patterns_type_key ON user_patterns(pattern_type, pattern_key);

-- 2. TASK FEEDBACK — Micro-feedback after task completion
CREATE TABLE IF NOT EXISTS task_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  actual_duration_minutes INT,           -- How long it really took
  difficulty TEXT CHECK (difficulty IN ('easy', 'normal', 'hard')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_feedback_task ON task_feedback(task_id);

-- 3. REMINDER EFFECTIVENESS — Track which reminders lead to action
CREATE TABLE IF NOT EXISTS reminder_effectiveness (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  reminder_type TEXT NOT NULL,           -- 'upcoming', 'missed', 'idle_nudge', 'goal_nudge'
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hour_sent INT NOT NULL,                -- 0-23, hour when reminder was sent
  day_of_week INT NOT NULL,              -- 0-6
  task_completed_within_2h BOOLEAN,      -- Was the task completed within 2 hours?
  task_completed_at TIMESTAMPTZ,         -- When was it actually completed?
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminder_eff_task ON reminder_effectiveness(task_id);
CREATE INDEX IF NOT EXISTS idx_reminder_eff_sent ON reminder_effectiveness(sent_at);

-- 4. BOT SELF RETRO — Weekly self-evaluation records
CREATE TABLE IF NOT EXISTS bot_retro (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL UNIQUE,
  retro_data JSONB NOT NULL DEFAULT '{}',  -- { what_works: [...], what_fails: [...], changes_applied: [...] }
  changes_applied JSONB NOT NULL DEFAULT '[]', -- Auto-adjustments made
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE user_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_effectiveness ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_retro ENABLE ROW LEVEL SECURITY;

-- Service role policies (edge functions use service role)
CREATE POLICY "service_all_user_patterns" ON user_patterns FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all_task_feedback" ON task_feedback FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all_reminder_effectiveness" ON reminder_effectiveness FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_all_bot_retro" ON bot_retro FOR ALL USING (true) WITH CHECK (true);

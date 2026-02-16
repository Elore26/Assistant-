-- ============================================
-- OREN SYSTEM — Task Management V2 Migration
-- Features: Recurring tasks, Subtasks, Context/Tags,
--   Inbox, Pomodoro, Velocity, Sprint Goals, Time Blocking
-- ============================================

-- 1. Add new columns to tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS context TEXT DEFAULT NULL; -- work, home, errands, health, learning
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_rule TEXT DEFAULT NULL; -- RRULE format: daily, weekly:1, monthly:15, weekdays
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_source_id UUID DEFAULT NULL; -- links to the original recurring task
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_inbox BOOLEAN DEFAULT FALSE; -- true = no date/priority assigned yet
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pomodoro_count INTEGER DEFAULT 0; -- number of pomodoros completed
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pomodoro_target INTEGER DEFAULT NULL; -- target pomodoros for this task
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS energy_level TEXT DEFAULT NULL; -- high, medium, low — for time blocking
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL;

-- 2. Create task_metrics table for velocity tracking
CREATE TABLE IF NOT EXISTS task_metrics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  metric_date DATE NOT NULL,
  tasks_completed INTEGER DEFAULT 0,
  tasks_created INTEGER DEFAULT 0,
  tasks_rescheduled INTEGER DEFAULT 0,
  total_pomodoros INTEGER DEFAULT 0,
  deep_work_minutes INTEGER DEFAULT 0,
  completion_rate REAL DEFAULT 0,
  avg_task_duration_min REAL DEFAULT 0,
  top_context TEXT DEFAULT NULL,
  most_rescheduled_task TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(metric_date)
);

-- 3. Create sprint_goals table for weekly objectives
CREATE TABLE IF NOT EXISTS sprint_goals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start DATE NOT NULL, -- Monday of the sprint week
  domain TEXT NOT NULL, -- career, health, finance, learning, personal
  title TEXT NOT NULL,
  target_value REAL DEFAULT 1,
  current_value REAL DEFAULT 0,
  metric_unit TEXT DEFAULT 'count',
  status TEXT DEFAULT 'active', -- active, completed, failed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create pomodoro_sessions table
CREATE TABLE IF NOT EXISTS pomodoro_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ DEFAULT NULL,
  duration_minutes INTEGER DEFAULT 25,
  break_minutes INTEGER DEFAULT 5,
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Create tomorrow_plans table for evening planning
CREATE TABLE IF NOT EXISTS tomorrow_plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_date DATE NOT NULL, -- the date being planned for
  task_ids UUID[] DEFAULT '{}', -- ordered list of planned task IDs
  validated BOOLEAN DEFAULT FALSE, -- user confirmed the plan
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(plan_date)
);

-- 6. Index for performance
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_context ON tasks(context) WHERE context IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_inbox ON tasks(is_inbox) WHERE is_inbox = TRUE;
CREATE INDEX IF NOT EXISTS idx_tasks_recurrence ON tasks(recurrence_rule) WHERE recurrence_rule IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_metrics_date ON task_metrics(metric_date);
CREATE INDEX IF NOT EXISTS idx_sprint_goals_week ON sprint_goals(week_start, status);
CREATE INDEX IF NOT EXISTS idx_pomodoro_task ON pomodoro_sessions(task_id);

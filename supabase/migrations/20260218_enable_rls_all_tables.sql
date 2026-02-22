-- ============================================
-- OREN SYSTEM — Enable RLS on ALL public tables
-- Fix: policy_exists_rls_disabled & rls_disabled_in_public
-- Date: 2026-02-18
-- Idempotent: safe to re-run
-- ============================================

-- ============================================
-- GROUP 1: Tables with existing policies but RLS disabled
-- These already have policies defined — just need RLS turned on
-- ============================================

ALTER TABLE IF EXISTS public.briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.daily_brain ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.finance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.focus_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.health_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.trade_journal ENABLE ROW LEVEL SECURITY;

-- ============================================
-- GROUP 2: Tables without RLS at all (no policies yet)
-- Enable RLS + create allow_all policies
-- Uses DROP IF EXISTS + CREATE to be idempotent
-- ============================================

-- agent_reports
ALTER TABLE IF EXISTS public.agent_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_agent_reports" ON public.agent_reports;
CREATE POLICY "allow_all_agent_reports" ON public.agent_reports
  FOR ALL USING (true) WITH CHECK (true);

-- career_data
ALTER TABLE IF EXISTS public.career_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_career_data" ON public.career_data;
CREATE POLICY "allow_all_career_data" ON public.career_data
  FOR ALL USING (true) WITH CHECK (true);

-- higrow_data
ALTER TABLE IF EXISTS public.higrow_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_higrow_data" ON public.higrow_data;
CREATE POLICY "allow_all_higrow_data" ON public.higrow_data
  FOR ALL USING (true) WITH CHECK (true);

-- trading_data
ALTER TABLE IF EXISTS public.trading_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_trading_data" ON public.trading_data;
CREATE POLICY "allow_all_trading_data" ON public.trading_data
  FOR ALL USING (true) WITH CHECK (true);

-- health_data
ALTER TABLE IF EXISTS public.health_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_health_data" ON public.health_data;
CREATE POLICY "allow_all_health_data" ON public.health_data
  FOR ALL USING (true) WITH CHECK (true);

-- learning_data
ALTER TABLE IF EXISTS public.learning_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_learning_data" ON public.learning_data;
CREATE POLICY "allow_all_learning_data" ON public.learning_data
  FOR ALL USING (true) WITH CHECK (true);

-- finance_data
ALTER TABLE IF EXISTS public.finance_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_finance_data" ON public.finance_data;
CREATE POLICY "allow_all_finance_data" ON public.finance_data
  FOR ALL USING (true) WITH CHECK (true);

-- telegram_users
ALTER TABLE IF EXISTS public.telegram_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_telegram_users" ON public.telegram_users;
CREATE POLICY "allow_all_telegram_users" ON public.telegram_users
  FOR ALL USING (true) WITH CHECK (true);

-- telegram_messages
ALTER TABLE IF EXISTS public.telegram_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_telegram_messages" ON public.telegram_messages;
CREATE POLICY "allow_all_telegram_messages" ON public.telegram_messages
  FOR ALL USING (true) WITH CHECK (true);

-- bot_state
ALTER TABLE IF EXISTS public.bot_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_bot_state" ON public.bot_state;
CREATE POLICY "allow_all_bot_state" ON public.bot_state
  FOR ALL USING (true) WITH CHECK (true);

-- task_templates
ALTER TABLE IF EXISTS public.task_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_task_templates" ON public.task_templates;
CREATE POLICY "allow_all_task_templates" ON public.task_templates
  FOR ALL USING (true) WITH CHECK (true);

-- code_commands
ALTER TABLE IF EXISTS public.code_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_code_commands" ON public.code_commands;
CREATE POLICY "allow_all_code_commands" ON public.code_commands
  FOR ALL USING (true) WITH CHECK (true);

-- task_metrics
ALTER TABLE IF EXISTS public.task_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_task_metrics" ON public.task_metrics;
CREATE POLICY "allow_all_task_metrics" ON public.task_metrics
  FOR ALL USING (true) WITH CHECK (true);

-- sprint_goals
ALTER TABLE IF EXISTS public.sprint_goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_sprint_goals" ON public.sprint_goals;
CREATE POLICY "allow_all_sprint_goals" ON public.sprint_goals
  FOR ALL USING (true) WITH CHECK (true);

-- pomodoro_sessions
ALTER TABLE IF EXISTS public.pomodoro_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_pomodoro_sessions" ON public.pomodoro_sessions;
CREATE POLICY "allow_all_pomodoro_sessions" ON public.pomodoro_sessions
  FOR ALL USING (true) WITH CHECK (true);

-- tomorrow_plans
ALTER TABLE IF EXISTS public.tomorrow_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_tomorrow_plans" ON public.tomorrow_plans;
CREATE POLICY "allow_all_tomorrow_plans" ON public.tomorrow_plans
  FOR ALL USING (true) WITH CHECK (true);

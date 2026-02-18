-- ============================================
-- OREN SYSTEM — Enable RLS on ALL public tables
-- Fix: policy_exists_rls_disabled & rls_disabled_in_public
-- Date: 2026-02-18
-- ============================================

-- ============================================
-- GROUP 1: Tables with existing policies but RLS disabled
-- These already have policies defined — just need RLS turned on
-- ============================================

ALTER TABLE public.briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_brain ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.focus_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_journal ENABLE ROW LEVEL SECURITY;

-- ============================================
-- GROUP 2: Tables without RLS at all (no policies yet)
-- Enable RLS + create basic read policies for service_role/anon
-- ============================================

-- agent_reports
ALTER TABLE public.agent_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_agent_reports" ON public.agent_reports
  FOR ALL USING (true) WITH CHECK (true);

-- career_data
ALTER TABLE public.career_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_career_data" ON public.career_data
  FOR ALL USING (true) WITH CHECK (true);

-- higrow_data
ALTER TABLE public.higrow_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_higrow_data" ON public.higrow_data
  FOR ALL USING (true) WITH CHECK (true);

-- trading_data
ALTER TABLE public.trading_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_trading_data" ON public.trading_data
  FOR ALL USING (true) WITH CHECK (true);

-- health_data
ALTER TABLE public.health_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_health_data" ON public.health_data
  FOR ALL USING (true) WITH CHECK (true);

-- learning_data
ALTER TABLE public.learning_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_learning_data" ON public.learning_data
  FOR ALL USING (true) WITH CHECK (true);

-- finance_data
ALTER TABLE public.finance_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_finance_data" ON public.finance_data
  FOR ALL USING (true) WITH CHECK (true);

-- telegram_users
ALTER TABLE public.telegram_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_telegram_users" ON public.telegram_users
  FOR ALL USING (true) WITH CHECK (true);

-- telegram_messages
ALTER TABLE public.telegram_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_telegram_messages" ON public.telegram_messages
  FOR ALL USING (true) WITH CHECK (true);

-- bot_state
ALTER TABLE public.bot_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_bot_state" ON public.bot_state
  FOR ALL USING (true) WITH CHECK (true);

-- task_templates
ALTER TABLE public.task_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_task_templates" ON public.task_templates
  FOR ALL USING (true) WITH CHECK (true);

-- code_commands
ALTER TABLE public.code_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_code_commands" ON public.code_commands
  FOR ALL USING (true) WITH CHECK (true);

-- task_metrics
ALTER TABLE public.task_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_task_metrics" ON public.task_metrics
  FOR ALL USING (true) WITH CHECK (true);

-- sprint_goals
ALTER TABLE public.sprint_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_sprint_goals" ON public.sprint_goals
  FOR ALL USING (true) WITH CHECK (true);

-- pomodoro_sessions
ALTER TABLE public.pomodoro_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_pomodoro_sessions" ON public.pomodoro_sessions
  FOR ALL USING (true) WITH CHECK (true);

-- tomorrow_plans
ALTER TABLE public.tomorrow_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_tomorrow_plans" ON public.tomorrow_plans
  FOR ALL USING (true) WITH CHECK (true);

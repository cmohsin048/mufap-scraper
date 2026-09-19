-- Fix Supabase Security Advisor warning 0010_security_definer_view.
-- Run this in the Supabase SQL Editor for the existing project.

ALTER VIEW public.latest_nav SET (security_invoker = true);
ALTER VIEW public.fund_performance SET (security_invoker = true);


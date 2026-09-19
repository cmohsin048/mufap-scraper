-- Revert progress statuses written during MUFAP Cloudflare/HTTP 403 runs.
-- This does not change daily_nav prices or last_collected_date values.
-- Run in Supabase SQL Editor if your webapp shows nav_collection_progress.status.

UPDATE public.nav_collection_progress
SET
  status = 'completed',
  error_message = NULL,
  completed_at = COALESCE(completed_at, NOW()),
  updated_at = NOW()
WHERE status IN ('error', 'in_progress')
  AND (
    error_message = 'Request failed with status code 403'
    OR error_message ILIKE '%MUFAP returned HTTP 403%'
    OR error_message = 'read ECONNRESET'
  );


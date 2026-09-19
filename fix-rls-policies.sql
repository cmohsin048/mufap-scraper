-- Fix RLS policies to allow service role inserts
-- Run this in Supabase SQL Editor

-- Drop existing service role policies
DROP POLICY IF EXISTS "Allow service role full access on amcs" ON amcs;
DROP POLICY IF EXISTS "Allow service role full access on funds" ON funds;
DROP POLICY IF EXISTS "Allow service role full access on fund_categories" ON fund_categories;

-- Create new policies that work with service key
-- These policies allow all operations when using service role key
CREATE POLICY "Allow service role full access on amcs" 
  ON amcs FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Allow service role full access on funds" 
  ON funds FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Allow service role full access on fund_categories" 
  ON fund_categories FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');


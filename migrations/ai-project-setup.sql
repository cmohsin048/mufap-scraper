-- AI documents project setup (the second Supabase project, "islamicfundsAi").
-- Run once in the NEW project's SQL Editor. Creates the assistant's document tables and search
-- functions; the main project keeps funds, NAVs, payouts and everything else.
-- fund_id / amc_id values are the main project's IDs. There are no foreign keys to funds or amcs
-- because those tables live in the main project.
BEGIN;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.fund_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amc_id UUID,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('fmr', 'offering_document', 'supplemental_offering_document',
    'key_fact_statement', 'expense_ratio', 'trust_deed', 'financial_report', 'mufap_profile', 'other')),
  title TEXT NOT NULL,
  display_title TEXT,
  source_url TEXT NOT NULL UNIQUE,
  source_page_url TEXT,
  document_date DATE,
  page_count INTEGER,
  content_hash TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fund_documents_type_date ON public.fund_documents(doc_type, document_date DESC);
CREATE INDEX IF NOT EXISTS idx_fund_documents_amc ON public.fund_documents(amc_id);

CREATE TABLE IF NOT EXISTS public.fund_document_funds (
  document_id UUID NOT NULL REFERENCES public.fund_documents(id) ON DELETE CASCADE,
  fund_id UUID NOT NULL,
  pages INTEGER[],
  PRIMARY KEY (document_id, fund_id)
);
CREATE INDEX IF NOT EXISTS idx_fund_document_funds_fund ON public.fund_document_funds(fund_id);

CREATE TABLE IF NOT EXISTS public.document_chunks (
  id BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES public.fund_documents(id) ON DELETE CASCADE,
  fund_ids UUID[] NOT NULL DEFAULT '{}',
  chunk_index INTEGER NOT NULL,
  page_from INTEGER, page_to INTEGER,
  section TEXT,
  context TEXT,
  content TEXT NOT NULL,
  token_count INTEGER,
  content_hash TEXT NOT NULL,
  chunker_version TEXT,
  embedding extensions.vector(768) NOT NULL,
  embedding_model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(context, '') || ' ' || content)) STORED,
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_document_chunks_funds ON public.document_chunks USING gin (fund_ids);
CREATE INDEX IF NOT EXISTS idx_document_chunks_fts ON public.document_chunks USING gin (fts);
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding ON public.document_chunks
  USING hnsw (embedding extensions.vector_cosine_ops);

-- Hybrid search (same as migrations/002 in the main project).
CREATE OR REPLACE FUNCTION public.search_document_chunks(
  query_embedding extensions.vector(768),
  query_text TEXT,
  match_count INTEGER DEFAULT 8,
  filter_fund_ids UUID[] DEFAULT NULL,
  filter_amc_ids UUID[] DEFAULT NULL,
  filter_doc_types TEXT[] DEFAULT NULL,
  filter_since DATE DEFAULT NULL,
  include_amc_wide BOOLEAN DEFAULT FALSE,     -- with a fund filter: also include chunks not tied to any fund (market reviews)
  filter_embedding_model TEXT DEFAULT 'gemini-embedding-001',
  candidate_count INTEGER DEFAULT 40,
  rrf_k INTEGER DEFAULT 60
) RETURNS TABLE (
  chunk_id BIGINT, document_id UUID, chunk_index INTEGER, fund_ids UUID[], section TEXT, content TEXT,
  page_from INTEGER, page_to INTEGER, doc_type TEXT, title TEXT, source_url TEXT, document_date DATE, amc_id UUID,
  similarity DOUBLE PRECISION, vector_rank INTEGER, keyword_rank INTEGER, score DOUBLE PRECISION
) LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, extensions AS $$
#variable_conflict use_column
DECLARE
  restricted BOOLEAN := filter_fund_ids IS NOT NULL OR filter_amc_ids IS NOT NULL;
  n INTEGER := LEAST(GREATEST(candidate_count, 10), 200);
  keywords tsquery;
  all_words tsquery;
  any_word tsquery;
  keyword_weight DOUBLE PRECISION := 1.0;
BEGIN
  -- The question's stemmed words, stop words ("what", "is", "the") removed:
  --   all_words: 'front' & 'end' & 'load' & 'meezan' & 'cash'   precise: a chunk must contain every word
  --   any_word:  'front' | 'end' | 'load' | 'meezan' | 'cash'   broad: any word will do
  -- v1 used any_word only. The retrieval eval showed why that hurts: generic words ("fund", "load")
  -- matched other funds' fee tables, and keyword search made unfiltered results worse than vector-only
  -- (MRR 0.49 vs 0.71). So: all words first; any word only if nothing matches, and then at half weight.
  SELECT (string_agg(quote_literal(lexeme), ' & '))::tsquery, (string_agg(quote_literal(lexeme), ' | '))::tsquery
    INTO all_words, any_word
    FROM unnest(tsvector_to_array(to_tsvector('english', coalesce(query_text, '')))) AS lexeme;
  keywords := all_words;
  IF all_words IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_chunks c JOIN public.fund_documents d ON d.id = c.document_id
    WHERE c.fts @@ all_words
      AND (filter_doc_types IS NULL OR d.doc_type = ANY(filter_doc_types))
      AND (filter_amc_ids IS NULL OR d.amc_id = ANY(filter_amc_ids))
      AND (filter_fund_ids IS NULL OR c.fund_ids && filter_fund_ids OR (include_amc_wide AND c.fund_ids = '{}'))
  ) THEN
    keywords := any_word;
    keyword_weight := 0.5;
  END IF;
  -- More graph neighbours explored per HNSW query = better recall for a little more time (default 40).
  PERFORM set_config('hnsw.ef_search', '100', true);

  RETURN QUERY
  WITH eligible AS (
    SELECT c.id
    FROM public.document_chunks c
    JOIN public.fund_documents d ON d.id = c.document_id
    WHERE restricted
      AND c.embedding_model = filter_embedding_model
      AND (filter_doc_types IS NULL OR d.doc_type = ANY(filter_doc_types))
      AND (filter_since IS NULL OR d.document_date IS NULL OR d.document_date >= filter_since)
      AND (filter_amc_ids IS NULL OR d.amc_id = ANY(filter_amc_ids))
      AND (filter_fund_ids IS NULL OR c.fund_ids && filter_fund_ids          -- && = arrays overlap
           OR (include_amc_wide AND c.fund_ids = '{}'))
  ),
  vector_hits AS (
    -- Exact scan over the eligible chunks ("+ 0" stops the planner from using the approximate index).
    SELECT c.id, (c.embedding <=> query_embedding) AS distance
    FROM public.document_chunks c
    WHERE restricted AND c.id IN (SELECT id FROM eligible)
    ORDER BY (c.embedding <=> query_embedding) + 0
    LIMIT n
  ),
  vector_hits_global AS (
    -- Approximate (HNSW) search over everything, then filtered. Over-fetch so filters leave enough.
    SELECT h.id, h.distance FROM (
      SELECT c.id, c.document_id, (c.embedding <=> query_embedding) AS distance
      FROM public.document_chunks c
      WHERE NOT restricted AND c.embedding_model = filter_embedding_model
      ORDER BY c.embedding <=> query_embedding
      LIMIT n * 4
    ) h
    JOIN public.fund_documents d ON d.id = h.document_id
    WHERE (filter_doc_types IS NULL OR d.doc_type = ANY(filter_doc_types))
      AND (filter_since IS NULL OR d.document_date IS NULL OR d.document_date >= filter_since)
    ORDER BY h.distance
    LIMIT n
  ),
  vector_ranked AS (
    SELECT v.id, v.distance, row_number() OVER (ORDER BY v.distance)::INTEGER AS rank
    FROM (SELECT * FROM vector_hits UNION ALL SELECT * FROM vector_hits_global) v
  ),
  keyword_ranked AS (
    SELECT k.id, row_number() OVER (ORDER BY k.rank DESC)::INTEGER AS rank
    FROM (
      SELECT c.id, ts_rank_cd(c.fts, keywords, 32) AS rank   -- 32: rank / (rank + 1), so long chunks are not favoured
      FROM public.document_chunks c
      JOIN public.fund_documents d ON d.id = c.document_id
      WHERE keywords IS NOT NULL AND c.fts @@ keywords
        AND c.embedding_model = filter_embedding_model
        AND (filter_doc_types IS NULL OR d.doc_type = ANY(filter_doc_types))
        AND (filter_since IS NULL OR d.document_date IS NULL OR d.document_date >= filter_since)
        AND (filter_amc_ids IS NULL OR d.amc_id = ANY(filter_amc_ids))
        AND (filter_fund_ids IS NULL OR c.fund_ids && filter_fund_ids OR (include_amc_wide AND c.fund_ids = '{}'))
      ORDER BY rank DESC
      LIMIT n
    ) k
  ),
  fused AS (
    SELECT coalesce(v.id, k.id) AS id, v.distance, v.rank AS v_rank, k.rank AS k_rank,
           coalesce(1.0 / (rrf_k + v.rank), 0) + keyword_weight * coalesce(1.0 / (rrf_k + k.rank), 0) AS rrf
    FROM vector_ranked v FULL OUTER JOIN keyword_ranked k ON k.id = v.id
  )
  SELECT c.id, c.document_id, c.chunk_index, c.fund_ids, c.section, c.content, c.page_from, c.page_to,
         d.doc_type, coalesce(d.display_title, d.title), d.source_url, d.document_date, d.amc_id,
         -- Chunks found only by keyword get their real similarity too, so the caller can judge relevance.
         1 - coalesce(f.distance, c.embedding <=> query_embedding), f.v_rank, f.k_rank, f.rrf::DOUBLE PRECISION
  FROM fused f
  JOIN public.document_chunks c ON c.id = f.id
  JOIN public.fund_documents d ON d.id = c.document_id
  ORDER BY f.rrf DESC
  LIMIT LEAST(GREATEST(match_count, 1), 30);
END;
$$;

-- Swap one document's chunks in a single transaction (same as migrations/001).
CREATE OR REPLACE FUNCTION public.replace_document_chunks(p_document_id UUID, p_chunks JSONB)
RETURNS INTEGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, extensions AS $$
DECLARE inserted INTEGER;
BEGIN
  DELETE FROM public.document_chunks WHERE document_id = p_document_id;
  INSERT INTO public.document_chunks (document_id, fund_ids, chunk_index, page_from, page_to, section, context, content,
    token_count, content_hash, chunker_version, embedding, embedding_model)
  SELECT p_document_id,
         coalesce(ARRAY(SELECT jsonb_array_elements_text(c->'fund_ids'))::UUID[], '{}'),
         (c->>'chunk_index')::INTEGER, (c->>'page_from')::INTEGER, (c->>'page_to')::INTEGER,
         c->>'section', c->>'context', c->>'content', (c->>'token_count')::INTEGER,
         c->>'content_hash', c->>'chunker_version', (c->>'embedding')::extensions.vector, c->>'embedding_model'
  FROM jsonb_array_elements(p_chunks) AS c;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;

ALTER TABLE public.fund_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fund_document_funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read fund_documents" ON public.fund_documents;
CREATE POLICY "Public read fund_documents" ON public.fund_documents FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public read fund_document_funds" ON public.fund_document_funds;
CREATE POLICY "Public read fund_document_funds" ON public.fund_document_funds FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public read document_chunks" ON public.document_chunks;
CREATE POLICY "Public read document_chunks" ON public.document_chunks FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON public.fund_documents, public.fund_document_funds, public.document_chunks FROM anon, authenticated;
GRANT SELECT ON public.fund_documents, public.fund_document_funds, public.document_chunks TO anon, authenticated;
GRANT ALL ON public.fund_documents, public.fund_document_funds, public.document_chunks TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.document_chunks_id_seq TO service_role;
GRANT EXECUTE ON FUNCTION public.search_document_chunks(extensions.vector, TEXT, INTEGER, UUID[], UUID[], TEXT[], DATE, BOOLEAN, TEXT, INTEGER, INTEGER) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.replace_document_chunks(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_document_chunks(UUID, JSONB) TO service_role;
COMMIT;

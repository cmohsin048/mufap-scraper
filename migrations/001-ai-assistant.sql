-- Additive migration for the AI fund assistant. Run once in the Supabase SQL Editor.
-- It creates new tables only; existing catalog, NAV and payout tables are not changed.
BEGIN;

-- pgvector stores embeddings (lists of numbers that represent meaning) and
-- finds the nearest ones with an index. Supabase ships it; it only needs enabling.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- ==================== Fund profiles (MUFAP fund detail page) ====================
-- Loads, fees and ratings are kept as published text ("1.5% p.a.", "AA-(f)")
-- because the source mixes units. Expense ratios and assets are numeric.
CREATE TABLE IF NOT EXISTS public.fund_profiles (
  fund_id UUID PRIMARY KEY REFERENCES public.funds(fund_id) ON DELETE CASCADE,
  mufap_fund_id BIGINT NOT NULL,
  inception_date DATE,
  front_end_load TEXT, back_end_load TEXT, contingent_load TEXT, management_fee TEXT,
  dealing_days TEXT, cutoff_time TEXT, risk_profile TEXT, pricing_mechanism TEXT, benchmark TEXT,
  trustee TEXT, auditor TEXT, rating TEXT, rating_company TEXT, rating_date TEXT, leverage TEXT, fund_manager TEXT,
  net_assets_pkr_mn NUMERIC, net_assets_ex_fof_pkr_mn NUMERIC,
  returns JSONB NOT NULL DEFAULT '{}'::jsonb,          -- {"YTD": 10.5, "1 Year": 10.16, ...} annualized % as published
  ter_ytd_pct NUMERIC, ter_mtd_pct NUMERIC, gov_levies_ytd_pct NUMERIC, gov_levies_mtd_pct NUMERIC, selling_marketing_pct NUMERIC,
  asset_allocation JSONB NOT NULL DEFAULT '[]'::jsonb, asset_allocation_as_of TEXT,
  top_holdings JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_url TEXT NOT NULL,
  scraped_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fund_profiles_risk ON public.fund_profiles(risk_profile);

-- ==================== Source documents (FMRs, offering documents, KFS, ...) ====================
CREATE TABLE IF NOT EXISTS public.fund_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amc_id UUID REFERENCES public.amcs(amc_id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('fmr', 'offering_document', 'supplemental_offering_document',
    'key_fact_statement', 'expense_ratio', 'trust_deed', 'financial_report', 'mufap_profile', 'other')),
  title TEXT NOT NULL,                                  -- link text as found on the AMC site (often just "Download ...")
  display_title TEXT,                                   -- citation title, e.g. "Al Meezan · Fund Manager Report · Aug 2026"
  source_url TEXT NOT NULL UNIQUE,
  source_page_url TEXT,
  document_date DATE,
  page_count INTEGER,
  content_hash TEXT NOT NULL,                           -- sha256 of extracted text; ingestion re-embeds only when it changes
  extracted_text TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fund_documents_type_date ON public.fund_documents(doc_type, document_date DESC);
CREATE INDEX IF NOT EXISTS idx_fund_documents_amc ON public.fund_documents(amc_id);
ALTER TABLE public.fund_documents ADD COLUMN IF NOT EXISTS display_title TEXT;   -- for databases created by an earlier version of this file

-- One FMR covers many funds, so documents map to funds many-to-many.
-- pages lists the 1-based PDF pages about that fund (NULL = whole document).
CREATE TABLE IF NOT EXISTS public.fund_document_funds (
  document_id UUID NOT NULL REFERENCES public.fund_documents(id) ON DELETE CASCADE,
  fund_id UUID NOT NULL REFERENCES public.funds(fund_id) ON DELETE CASCADE,
  pages INTEGER[],
  PRIMARY KEY (document_id, fund_id)
);
CREATE INDEX IF NOT EXISTS idx_fund_document_funds_fund ON public.fund_document_funds(fund_id);

-- ==================== Embedded chunks for RAG ====================
-- 768 dimensions: gemini-embedding-001 supports shorter vectors (Matryoshka
-- training), and HNSW indexes in pgvector are limited to 2,000 dimensions.
--
-- Each chunk stores two kinds of searchable representation:
--   embedding  meaning-based ("dense") search: finds "entry charge" for a question about "front-end load"
--   fts        keyword ("sparse") search: exact terms like "KMI-30", "AM1", "2.00%", fund abbreviations
-- search_document_chunks() runs both and merges the two rankings (hybrid search).
CREATE TABLE IF NOT EXISTS public.document_chunks (
  id BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES public.fund_documents(id) ON DELETE CASCADE,
  fund_ids UUID[] NOT NULL DEFAULT '{}',   -- funds this text is about; empty = AMC-wide text (e.g. market review)
  chunk_index INTEGER NOT NULL,
  page_from INTEGER, page_to INTEGER,
  section TEXT,                            -- nearest heading above the chunk, e.g. "Fund Details"
  context TEXT,                            -- one-line header: document, funds, section (embedded with the content)
  content TEXT NOT NULL,
  token_count INTEGER,
  content_hash TEXT NOT NULL,              -- sha256 of chunker version + context + content
  chunker_version TEXT,
  embedding extensions.vector(768) NOT NULL,
  embedding_model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);
-- For databases created by an earlier version of this file.
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS section TEXT;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS context TEXT;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS token_count INTEGER;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS chunker_version TEXT;
-- Keyword index. 'english' stems words (fees -> fee, investing -> invest) and drops stop words.
-- A generated column is recomputed by Postgres on every insert, so it can never be stale.
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(context, '') || ' ' || content)) STORED;

CREATE INDEX IF NOT EXISTS idx_document_chunks_funds ON public.document_chunks USING gin (fund_ids);
CREATE INDEX IF NOT EXISTS idx_document_chunks_fts ON public.document_chunks USING gin (fts);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON public.document_chunks(document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding ON public.document_chunks
  USING hnsw (embedding extensions.vector_cosine_ops);

-- The first version of this file had a vector-only search; hybrid search replaces it.
DROP FUNCTION IF EXISTS public.match_document_chunks(extensions.vector, INTEGER, UUID[], TEXT[], TEXT);

-- Hybrid search with Reciprocal Rank Fusion (RRF).
--   1. vector search: the N chunks closest in meaning ("<=>" is cosine distance, similarity = 1 - distance)
--   2. keyword search: the N chunks with the best full-text rank for any of the query's words
--   3. fuse: score = sum over both lists of 1 / (rrf_k + rank). A chunk ranked high in both wins;
--      a chunk found by only one method can still make it. RRF uses ranks, not raw scores, so the
--      two very different score scales never need to be calibrated against each other.
-- When the search is restricted to funds or AMCs, the candidate set is small (hundreds of chunks),
-- so the vector part is an exact scan instead of the approximate HNSW index: an index scan
-- followed by a filter can return fewer than N rows when the filter is selective.
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
BEGIN
  -- OR together the query's stemmed words: "front end load of meezan cash" -> 'front' | 'end' | 'load' | 'meezan' | 'cash'.
  -- (websearch_to_tsquery would AND them, and a long question would then match almost nothing.)
  SELECT (string_agg(quote_literal(lexeme), ' | '))::tsquery   -- cast, not to_tsquery: the words are already stemmed
    INTO keywords
    FROM unnest(tsvector_to_array(to_tsvector('english', coalesce(query_text, '')))) AS lexeme;
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
           coalesce(1.0 / (rrf_k + v.rank), 0) + coalesce(1.0 / (rrf_k + k.rank), 0) AS rrf
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

-- Replace all chunks of one document in a single transaction, so a search never sees a
-- half-updated document (old chunks deleted, new ones not yet inserted).
-- p_chunks: JSON array of {chunk_index, fund_ids, page_from, page_to, section, context, content,
-- token_count, content_hash, chunker_version, embedding: "[0.1,...]", embedding_model}.
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

-- ==================== Assistant usage log ====================
-- No message text and no keys: only what is needed to watch free-tier usage.
CREATE TABLE IF NOT EXISTS public.ai_usage_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  conversation_id TEXT,
  mode TEXT,
  provider TEXT, model TEXT, key_slot TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
  latency_ms INTEGER, model_calls INTEGER, tool_calls TEXT[],
  failovers INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created ON public.ai_usage_log(created_at DESC);

-- ==================== Access ====================
-- Profiles, documents and chunks are public information: anyone may read.
-- Only the service role (collectors, ingestion, server logging) may write.
ALTER TABLE public.fund_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fund_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fund_document_funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read fund_profiles" ON public.fund_profiles;
CREATE POLICY "Public read fund_profiles" ON public.fund_profiles FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public read fund_documents" ON public.fund_documents;
CREATE POLICY "Public read fund_documents" ON public.fund_documents FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public read fund_document_funds" ON public.fund_document_funds;
CREATE POLICY "Public read fund_document_funds" ON public.fund_document_funds FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Public read document_chunks" ON public.document_chunks;
CREATE POLICY "Public read document_chunks" ON public.document_chunks FOR SELECT TO anon, authenticated USING (true);
REVOKE ALL ON public.fund_profiles, public.fund_documents, public.fund_document_funds, public.document_chunks FROM anon, authenticated;
GRANT SELECT ON public.fund_profiles, public.fund_documents, public.fund_document_funds, public.document_chunks TO anon, authenticated;
REVOKE ALL ON public.ai_usage_log FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_document_chunks(extensions.vector, TEXT, INTEGER, UUID[], UUID[], TEXT[], DATE, BOOLEAN, TEXT, INTEGER, INTEGER) TO anon, authenticated;
-- Only the ingestion script (service role) may rewrite chunks.
REVOKE ALL ON FUNCTION public.replace_document_chunks(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_document_chunks(UUID, JSONB) TO service_role;

COMMIT;

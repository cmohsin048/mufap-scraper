-- Migration 002: better keyword half of the hybrid document search.
-- Run once in the Supabase SQL Editor after 001. It only replaces one function (same name and
-- arguments), so no data changes and running it twice is harmless.
--
-- Why: on real data (40 questions, 2026-10-08) searches without a fund filter got worse when keyword
-- search was added (MRR 0.49 hybrid vs 0.71 vector-only), because the keyword query matched ANY word.
-- Now it requires ALL of the question's words first and falls back to any word (at half weight) only
-- when nothing matches.
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


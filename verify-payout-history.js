// Read-only historical verification. Archives public reports so a failed audit
// can resume without re-downloading previously fetched chunks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const Collector = require('./industry-stats-collector');
const Storage = require('./payout-storage');

async function main() {
  const collector = new Collector();
  const storage = new Storage(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY), { quarantineConflicts: true });
  const directory = path.join(__dirname, 'tmp', 'payout-history');
  fs.mkdirSync(directory, { recursive: true });
  const report = { startedAt: new Date().toISOString(), from: '1995-01-01', to: collector.getCurrentDate(),
    mode: 'read-only', chunks: [], status: 'running' };
  const save = () => fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2));
  const seen = new Map();
  const records = [];
  try {
    await storage.initialize();
    report.schemaReady = storage.schemaReady;
    const chunks = collector.buildDateChunks(report.from, report.to, 3);
    for (const [index, chunk] of chunks.entries()) {
      const base = `${chunk.from}_${chunk.to}`;
      const file = path.join(directory, `${base}.html`);
      const cached = fs.existsSync(file);
      console.log(`[${index + 1}/${chunks.length}] ${base}${cached ? ' (cached public report)' : ''}`);
      const html = cached ? fs.readFileSync(file, 'utf8') : await collector.fetchPage({ ...chunk, silent: true });
      if (!cached) fs.writeFileSync(file, html);
      const rows = collector.parsePage(html, chunk);
      const unique = collector.mergeUnique(records, rows, seen, true);
      await storage.storeChunk(unique);
      const hash = crypto.createHash('sha256').update(html).digest('hex');
      const sourceFetchedAt = fs.statSync(file).mtime.toISOString();
      fs.writeFileSync(path.join(directory, `${base}.json`), JSON.stringify(unique, null, 2));
      report.chunks.push({ ...chunk, rows: rows.length, unique: unique.length, sourceFetchedAt, sha256: hash });
      report.stats = storage.stats;
      save();
      console.log(`  validated ${rows.length} rows; ${storage.stats.matched} catalog matches so far`);
      if (!cached && index < chunks.length - 1) await collector.delay(500);
    }
    report.status = 'complete';
    report.totalSourceRows = records.length;
    report.unmatchedShariah = [...storage.unmatched.values()];
    report.quarantined = [...storage.issues.values()];
    report.completedAt = new Date().toISOString();
    console.log(JSON.stringify({ status: report.status, chunks: report.chunks.length,
      rows: records.length, stats: storage.stats, schemaReady: storage.schemaReady }));
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    throw error;
  } finally {
    report.stats = storage.stats;
    report.unmatchedShariah = [...storage.unmatched.values()];
    report.quarantined = [...storage.issues.values()];
    save();
    storage.writeUnmatchedReport();
    await collector.mufap.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };

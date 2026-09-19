// Import only the public HTML snapshots recorded by the completed history audit.
// Every chunk is re-parsed, hashed, matched, upserted, and read back. Real data only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const Collector = require('../industry-stats-collector');
const Storage = require('../payout-storage');

async function main() {
  const directory = path.join(__dirname, '..', 'tmp', 'payout-history');
  const audit = JSON.parse(fs.readFileSync(path.join(directory, 'verification.json'), 'utf8'));
  if (audit.status !== 'complete' || audit.chunks.length !== new Collector().buildDateChunks(audit.from, audit.to, 3).length) {
    throw new Error('A complete historical verification is required before importing snapshots.');
  }
  const c = new Collector();
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const storage = new Storage(db, { dryRun: false, quarantineConflicts: true });
  const report = { startedAt: new Date().toISOString(), from: audit.from, to: audit.to, status: 'running', chunks: [] };
  const save = () => fs.writeFileSync(path.join(directory, 'import-verification.json'), JSON.stringify(report, null, 2));
  try {
    await storage.initialize();
    for (const [index, chunk] of audit.chunks.entries()) {
      const html = fs.readFileSync(path.join(directory, `${chunk.from}_${chunk.to}.html`), 'utf8');
      if (crypto.createHash('sha256').update(html).digest('hex') !== chunk.sha256) throw new Error(`Snapshot hash mismatch for ${chunk.from}`);
      console.log(`[${index + 1}/${audit.chunks.length}] Store and read back ${chunk.from} to ${chunk.to}`);
      const records = c.parsePage(html, chunk);
      const before = storage.stats.upserted;
      await storage.storeChunk(records, chunk);
      report.chunks.push({ from: chunk.from, to: chunk.to, readbackVerified: true, upserted: storage.stats.upserted - before });
      report.stats = storage.stats;
      save();
    }
    report.status = 'complete';
    report.completedAt = new Date().toISOString();
    console.log(JSON.stringify({ status: report.status, stats: storage.stats, quarantined: storage.issues.size }));
  } catch (error) {
    report.status = 'failed'; report.error = error.message; throw error;
  } finally {
    report.stats = storage.stats;
    report.quarantined = [...storage.issues.values()];
    report.unmatchedShariah = [...storage.unmatched.values()];
    save(); storage.writeUnmatchedReport(); await c.mufap.close();
  }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };

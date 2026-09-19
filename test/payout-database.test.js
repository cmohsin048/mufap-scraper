const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

test('PostgreSQL migration, real insert/readback, idempotency, constraints, and read-only public access', async t => {
  const db = new PGlite();
  const fund = '00000000-0000-0000-0000-000000000001';
  const amc = '00000000-0000-0000-0000-000000000002';
  const otherAmc = '00000000-0000-0000-0000-000000000003';
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE amcs (amc_id uuid PRIMARY KEY);
      CREATE TABLE funds (fund_id uuid PRIMARY KEY, amc_id uuid REFERENCES amcs(amc_id));
      CREATE TABLE daily_nav (fund_id uuid, nav_date date, nav numeric);
      GRANT SELECT ON daily_nav TO anon,authenticated,service_role;
      INSERT INTO amcs VALUES ('${amc}'), ('${otherAmc}');
      INSERT INTO funds VALUES ('${fund}', '${amc}');`);
    const sql = fs.readFileSync(path.join(__dirname, '../setup-payout-database.sql'), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    const insert = `INSERT INTO fund_payouts (fund_id,amc_id,payout_date,payout_per_unit,ex_nav,
      source_fund_name,source_amc_name,source_date_from,source_date_to,scraped_at)
      VALUES ($1,$2,'2026-08-01',$3,$4,'Test Fund','Test AMC','2026-08-01','2026-08-31',now())`;
    await db.exec('SET ROLE service_role');
    await db.query(insert, [fund, amc, '0.0292', '100.0000']);
    await db.query(`${insert} ON CONFLICT (fund_id,payout_date) DO UPDATE SET payout_per_unit=excluded.payout_per_unit`,
      [fund, amc, '0.03123456', '100.0000']);
    const read = await db.query('SELECT payout_per_unit::text,ex_nav::text FROM fund_payouts');
    assert.equal(read.rows.length, 1);
    assert.equal(read.rows[0].payout_per_unit, '0.03123456');
    assert.equal(Number(read.rows[0].ex_nav), 100);
    await db.query(`INSERT INTO fund_payout_coverage VALUES ($1,'2026-08-01','2026-08-31','verified',1,now())`, [fund]);
    await db.exec('RESET ROLE');
    await db.query("INSERT INTO daily_nav VALUES ($1,'2026-07-31',100),($1,'2026-08-31',100)", [fund]);

    for (const role of ['anon', 'authenticated']) {
      await t.test(`${role} can read payouts and coverage but cannot insert, update, or delete`, async () => {
        await db.exec(`RESET ROLE; SET ROLE ${role}`);
        assert.equal((await db.query('SELECT * FROM fund_payouts')).rows.length, 1);
        assert.equal((await db.query('SELECT * FROM fund_payout_coverage')).rows.length, 1);
        const snapshot = (await db.query("SELECT get_fund_return_inputs($1,'2026-07-31','2026-08-31') AS data", [fund])).rows[0].data;
        assert.equal(snapshot.navRecords.length, 2);
        assert.equal(snapshot.payouts.length, 1);
        assert.equal(snapshot.coverage[0].status, 'verified');
        await assert.rejects(db.query(insert, [fund, amc, '1', '100']), /permission denied/);
        await assert.rejects(db.query('UPDATE fund_payouts SET payout_per_unit=99'), /permission denied/);
        await assert.rejects(db.query('DELETE FROM fund_payouts'), /permission denied/);
        await assert.rejects(db.query("UPDATE fund_payout_coverage SET status='verified'"), /permission denied/);
      });
    }
    await db.exec('RESET ROLE; SET ROLE service_role');
    for (const amount of ['-1', 'NaN', 'Infinity', '-Infinity']) {
      await assert.rejects(db.query('UPDATE fund_payouts SET payout_per_unit=$1', [amount]), /check constraint/);
      await assert.rejects(db.query('UPDATE fund_payouts SET ex_nav=$1', [amount]), /check constraint/);
    }
    await assert.rejects(db.query('UPDATE fund_payouts SET amc_id=$1', [otherAmc]), /foreign key constraint/);
    await assert.rejects(db.query("UPDATE fund_payouts SET payout_date='2026-09-01'"), /check constraint/);
    await assert.rejects(db.query("UPDATE fund_payout_coverage SET status='done'"), /check constraint/);
    await assert.rejects(db.query('UPDATE fund_payout_coverage SET row_count=-1'), /check constraint/);
    await assert.rejects(db.query(insert, [fund, amc, '1', '100']), /unique constraint/);
    await db.exec('BEGIN; UPDATE fund_payouts SET payout_per_unit=77; ROLLBACK;');
    assert.equal((await db.query('SELECT payout_per_unit::text FROM fund_payouts')).rows[0].payout_per_unit, '0.03123456');
  } finally { await db.close(); }
});

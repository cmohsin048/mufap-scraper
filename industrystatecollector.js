// Convenience entry point. Both filenames use the same collector and defaults.
const Collector = require('./industry-stats-collector');

if (require.main === module) {
  Collector.main().catch(error => {
    console.error(`Industry stats payout collection failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = Collector;

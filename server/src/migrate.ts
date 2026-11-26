import { createPool, migrate } from './db.js';

const pool = createPool();
migrate(pool)
  .then((applied) => console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database up to date'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

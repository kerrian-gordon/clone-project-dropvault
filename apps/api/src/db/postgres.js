import pg from 'pg';

// The catalog is currently an in-memory document. Hold a database advisory lock
// for this API process so a second instance cannot overwrite its changes.
const LOCK_KEY = 0x44564c54;

export async function openPostgresCatalog(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
    if (!lock.rows[0].locked) {
      throw new Error('Another DropVault API instance is already using this PostgreSQL catalog');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS dropvault_catalog (
      id integer PRIMARY KEY CHECK (id = 1),
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    return {
      async load() {
        const result = await client.query('SELECT state FROM dropvault_catalog WHERE id = 1');
        return result.rows[0]?.state ?? null;
      },
      async save(state) {
        await client.query(`INSERT INTO dropvault_catalog (id, state) VALUES (1, $1::jsonb)
          ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [JSON.stringify(state)]);
      },
      close: () => client.end(),
    };
  } catch (error) {
    await client.end();
    throw error;
  }
}

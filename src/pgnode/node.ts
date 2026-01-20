import { Pool } from 'pg';

export interface PgNode {
    id: number;
    pool: Pool;
    connectionString: string;
}

export async function createPgNode(id: number, connectionString: string): Promise<PgNode> {
    const pool = new Pool({ connectionString });

    await pool.query('SELECT 1');

    await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      id UUID PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      vector_clock JSONB DEFAULT '{}'
    )
  `);

    return { id, pool, connectionString };
}

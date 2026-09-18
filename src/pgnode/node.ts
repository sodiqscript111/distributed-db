import { Pool, PoolConfig } from 'pg';

export interface PgNode {
    id: string;
    pool: Pool;
    connectionString: string;
}

export interface PgPoolOptions {
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
}

export async function createPgNode(
    id: string,
    connectionString: string,
    poolOptions?: PgPoolOptions
): Promise<PgNode> {
    const poolConfig: PoolConfig = {
        connectionString,
        max: poolOptions?.max ?? 20,
        idleTimeoutMillis: poolOptions?.idleTimeoutMillis ?? 30000,
        connectionTimeoutMillis: poolOptions?.connectionTimeoutMillis ?? 5000,
    };

    const pool = new Pool(poolConfig);

    pool.on('error', (err) => {
        console.error(`[WARN] PostgreSQL pool error on node ${id}: ${err.message}`);
    });

    await pool.query('SELECT 1');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS records (
            id UUID PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            vector_clock JSONB DEFAULT '{}'
        )
    `);

    await pool.query(`
        DO $$
        BEGIN
            ALTER TABLE records ALTER COLUMN created_at TYPE TIMESTAMPTZ;
            ALTER TABLE records ALTER COLUMN updated_at TYPE TIMESTAMPTZ;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END $$;
    `).catch(() => {});

    return { id, pool, connectionString };
}

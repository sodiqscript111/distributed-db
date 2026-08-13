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

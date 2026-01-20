import express from 'express';
import * as fs from 'fs';
import * as toml from 'toml';
import { Config } from './types/config';
import { HashRing } from './hashing/hashring';
import { VectorClock } from './versioning/vectorclock';
import { PgNode, createPgNode } from './pgnode/node';
import { Handler } from './api/handler';
import { setupRoutes } from './api/routes';

function loadConfig(path: string): Config {
    const content = fs.readFileSync(path, 'utf-8');
    return toml.parse(content) as Config;
}

async function main(): Promise<void> {
    const cfg = loadConfig('config.toml');

    const ring = new HashRing(cfg.replication.hash_ring_replicas);
    const nodes = new Map<string, PgNode>();

    for (let i = 0; i < cfg.postgres.nodes.length; i++) {
        const connectionString = cfg.postgres.nodes[i];
        try {
            const node = await createPgNode(i, connectionString);
            console.log(`Connected to PostgreSQL node ${i} at ${connectionString}`);
            nodes.set(connectionString, node);
            ring.addNode(connectionString);
        } catch (err) {
            console.error(`Failed to connect to PostgreSQL at ${connectionString}: ${err}`);
        }
    }

    if (nodes.size === 0) {
        console.error('No PostgreSQL nodes available. Exiting.');
        process.exit(1);
    }

    const handler = new Handler(
        nodes,
        ring,
        new VectorClock(),
        cfg.replication.factor
    );

    const app = express();
    app.use(express.json());

    const router = express.Router();
    setupRoutes(router, handler);
    app.use(router);

    const port = cfg.server.port;
    app.listen(port, () => {
        console.log(`Starting server on port ${port}`);
    });
}

main().catch(console.error);

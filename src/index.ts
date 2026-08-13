import express, { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as toml from 'toml';
import {
    SecretsManagerClient,
    GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Config } from './types/config';
import { HashRing } from './hashing/hashring';
import { PgNode, createPgNode } from './pgnode/node';
import { Handler } from './api/handler';
import { setupRoutes } from './api/routes';

interface DbSecret {
    username: string;
    password: string;
    nodes: string[];
}

function loadConfig(configPath: string): Config {
    const resolved = path.isAbsolute(configPath)
        ? configPath
        : path.resolve(__dirname, '..', configPath);
    const content = fs.readFileSync(resolved, 'utf-8');
    return toml.parse(content) as Config;
}

async function fetchDbSecret(region: string, secretName: string): Promise<DbSecret> {
    const client = new SecretsManagerClient({ region });

    const response = await client.send(
        new GetSecretValueCommand({ SecretId: secretName })
    );

    if (!response.SecretString) {
        throw new Error(`Secret "${secretName}" has no string value`);
    }

    const secret = JSON.parse(response.SecretString) as DbSecret;

    if (!Array.isArray(secret.nodes) || secret.nodes.length === 0) {
        throw new Error(`Secret "${secretName}" is missing the "nodes" array`);
    }

    return secret;
}

async function main(): Promise<void> {
    const configPath = process.env.CONFIG_PATH || 'config.toml';
    const cfg = loadConfig(configPath);

    const awsRegion = process.env.AWS_REGION || cfg.aws.region;
    const secretName = process.env.SECRET_NAME || cfg.aws.secret_name;

    console.log(`Fetching DB credentials from Secrets Manager: ${secretName} (region: ${awsRegion})`);
    const secret = await fetchDbSecret(awsRegion, secretName);
    console.log(`Retrieved ${secret.nodes.length} node connection string(s) from secret`);

    const ring = new HashRing(cfg.replication.hash_ring_replicas);
    const nodes = new Map<string, PgNode>();

    for (let i = 0; i < secret.nodes.length; i++) {
        const connectionString = secret.nodes[i];
        const nodeId = `node-${i}`;
        try {
            const node = await createPgNode(nodeId, connectionString);
            console.log(`Connected to PostgreSQL ${nodeId}`);
            nodes.set(nodeId, node);
            ring.addNode(nodeId);
        } catch (err) {
            console.error(`Failed to connect to PostgreSQL ${nodeId}: ${err}`);
        }
    }

    if (nodes.size === 0) {
        console.error('No PostgreSQL nodes available. Exiting.');
        process.exit(1);
    }

    console.log(`${nodes.size}/${secret.nodes.length} PostgreSQL nodes connected`);

    const handler = new Handler(
        nodes,
        ring,
        cfg.replication.factor
    );

    const app = express();
    app.use(express.json({ limit: '1mb' }));

    const router = express.Router();
    setupRoutes(router, handler);
    app.use(router);

    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
        console.error(`[ERROR] Unhandled error: ${err.message}`);
        console.error(err.stack);
        res.status(500).json({ error: 'internal server error' });
    });

    const port = cfg.server.port;
    const server = app.listen(port, () => {
        console.log(`Server listening on port ${port}`);
    });

    const shutdown = async (signal: string) => {
        console.log(`\n[INFO] Received ${signal}. Shutting down gracefully...`);

        server.close(async () => {
            console.log('[INFO] HTTP server closed. Draining database pools...');

            const drainPromises = Array.from(nodes.values()).map(async (node) => {
                try {
                    await node.pool.end();
                    console.log(`[INFO] Pool for ${node.id} drained.`);
                } catch (err) {
                    console.error(`[ERROR] Failed to drain pool for ${node.id}: ${err}`);
                }
            });

            await Promise.all(drainPromises);
            console.log('[INFO] All connections closed. Goodbye.');
            process.exit(0);
        });

        setTimeout(() => {
            console.error('[WARN] Graceful shutdown timed out after 10s. Forcing exit.');
            process.exit(1);
        }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
    console.error('[FATAL] Failed to start server:', err);
    process.exit(1);
});

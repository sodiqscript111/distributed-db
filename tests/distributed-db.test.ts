import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPgNode, PgNode } from '../src/pgnode/node';
import { HashRing } from '../src/hashing/hashring';
import { Handler } from '../src/api/handler';
import { setupRoutes } from '../src/api/routes';

describe('Distributed Database Integration Tests with Testcontainers', () => {
    let container1: StartedPostgreSqlContainer;
    let container2: StartedPostgreSqlContainer;
    let container3: StartedPostgreSqlContainer;

    let app: Express;
    let nodes: Map<string, PgNode>;
    let ring: HashRing;
    let handler: Handler;

    beforeAll(async () => {
        [container1, container2, container3] = await Promise.all([
            new PostgreSqlContainer('postgres:16-alpine').start(),
            new PostgreSqlContainer('postgres:16-alpine').start(),
            new PostgreSqlContainer('postgres:16-alpine').start()
        ]);

        const connStrings = [
            container1.getConnectionUri(),
            container2.getConnectionUri(),
            container3.getConnectionUri()
        ];

        ring = new HashRing(50);
        nodes = new Map<string, PgNode>();

        for (let i = 0; i < connStrings.length; i++) {
            const nodeId = `node-${i}`;
            const node = await createPgNode(nodeId, connStrings[i]);
            nodes.set(nodeId, node);
            ring.addNode(nodeId);
        }

        handler = new Handler(nodes, ring, 2);

        app = express();
        app.use(express.json({ limit: '1mb' }));
        const router = express.Router();
        setupRoutes(router, handler);
        app.use(router);
    }, 120000);

    afterAll(async () => {
        if (nodes) {
            for (const node of nodes.values()) {
                await node.pool.end().catch(() => {});
            }
        }
        await Promise.allSettled([
            container1?.stop(),
            container2?.stop(),
            container3?.stop()
        ]);
    }, 60000);

    it('health check returns healthy with all 3 nodes running', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('healthy');
        expect(res.body.total_nodes).toBe(3);
        expect(res.body.ring_nodes).toBe(3);
        expect(res.body.nodes['node-0']).toBe('healthy');
        expect(res.body.nodes['node-1']).toBe('healthy');
        expect(res.body.nodes['node-2']).toBe('healthy');
    });

    it('inserts a record with quorum confirmation across replicas', async () => {
        const res = await request(app)
            .post('/db')
            .send({ name: 'Alice Cooper', email: 'alice@example.com' });

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('ok');
        expect(res.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        expect(res.body.name).toBe('Alice Cooper');
        expect(res.body.email).toBe('alice@example.com');
        expect(res.body.replicas).toHaveLength(2);
        expect(res.body.success_count).toBe(2);
        expect(res.body.quorum).toBe(2);
        expect(res.body.record_clock).toBeDefined();
    });

    it('reads a record with vector clock and replica metadata', async () => {
        const createRes = await request(app)
            .post('/db')
            .send({ name: 'Bob Smith', email: 'bob@example.com' });

        const id = createRes.body.id;

        const getRes = await request(app).get(`/db/${id}`);
        expect(getRes.status).toBe(200);
        expect(getRes.body.id).toBe(id);
        expect(getRes.body.name).toBe('Bob Smith');
        expect(getRes.body.email).toBe('bob@example.com');
        expect(getRes.body.record_clock).toBeDefined();
        expect(getRes.body.replicas).toHaveLength(2);
    });

    it('handles 30 concurrent readers simultaneously without errors', async () => {
        const createRes = await request(app)
            .post('/db')
            .send({ name: 'Concurrent Reader Test', email: 'concurrent@example.com' });

        const id = createRes.body.id;

        const readPromises = Array.from({ length: 30 }, () => request(app).get(`/db/${id}`));
        const results = await Promise.all(readPromises);

        for (const res of results) {
            expect(res.status).toBe(200);
            expect(res.body.id).toBe(id);
            expect(res.body.name).toBe('Concurrent Reader Test');
        }
    });

    it('updates a record and increments vector clock', async () => {
        const createRes = await request(app)
            .post('/db')
            .send({ name: 'Charlie', email: 'charlie@example.com' });

        const id = createRes.body.id;
        const initialClock = createRes.body.record_clock;

        const updateRes = await request(app)
            .put(`/db/${id}`)
            .send({
                name: 'Charlie Updated',
                record_clock: initialClock
            });

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.status).toBe('ok');
        expect(updateRes.body.success_count).toBe(2);

        const getRes = await request(app).get(`/db/${id}`);
        expect(getRes.status).toBe(200);
        expect(getRes.body.name).toBe('Charlie Updated');
        expect(getRes.body.email).toBe('charlie@example.com');
    });

    it('rejects stale update with 409 Conflict (Optimistic Concurrency Control)', async () => {
        const createRes = await request(app)
            .post('/db')
            .send({ name: 'David', email: 'david@example.com' });

        const id = createRes.body.id;
        const originalClock = createRes.body.record_clock;

        const firstUpdate = await request(app)
            .put(`/db/${id}`)
            .send({
                name: 'David Version 2',
                record_clock: originalClock
            });
        expect(firstUpdate.status).toBe(200);

        const staleUpdate = await request(app)
            .put(`/db/${id}`)
            .send({
                name: 'David Version Stale',
                record_clock: originalClock
            });

        expect(staleUpdate.status).toBe(409);
        expect(staleUpdate.body.error).toContain('conflict');
        expect(staleUpdate.body.current_clock).toBeDefined();

        const getRes = await request(app).get(`/db/${id}`);
        expect(getRes.body.name).toBe('David Version 2');
    });

    it('deletes a record across replicas and returns 404 on subsequent get', async () => {
        const createRes = await request(app)
            .post('/db')
            .send({ name: 'To Delete', email: 'delete@example.com' });

        const id = createRes.body.id;

        const deleteRes = await request(app).delete(`/db/${id}`);
        expect(deleteRes.status).toBe(200);
        expect(deleteRes.body.status).toBe('ok');
        expect(deleteRes.body.success_count).toBe(2);

        const getRes = await request(app).get(`/db/${id}`);
        expect(getRes.status).toBe(404);
        expect(getRes.body.error).toBe('record not found');
    });

    it('validates request bodies and uuid parameters properly', async () => {
        const postEmpty = await request(app).post('/db').send({});
        expect(postEmpty.status).toBe(400);

        const getInvalidId = await request(app).get('/db/invalid-uuid');
        expect(getInvalidId.status).toBe(400);

        const putInvalidId = await request(app).put('/db/invalid-uuid').send({ name: 'Test' });
        expect(putInvalidId.status).toBe(400);

        const deleteInvalidId = await request(app).delete('/db/invalid-uuid');
        expect(deleteInvalidId.status).toBe(400);

        const putEmptyBody = await request(app).put('/db/550e8400-e29b-41d4-a716-446655440000').send({});
        expect(putEmptyBody.status).toBe(400);

        const nonExistentId = '00000000-0000-0000-0000-000000000000';
        const getNonExistent = await request(app).get(`/db/${nonExistentId}`);
        expect(getNonExistent.status).toBe(404);

        const putNonExistent = await request(app).put(`/db/${nonExistentId}`).send({ name: 'Non Existent' });
        expect(putNonExistent.status).toBe(404);

        const deleteNonExistent = await request(app).delete(`/db/${nonExistentId}`);
        expect(deleteNonExistent.status).toBe(404);
    });

    it('maintains quorum write and read when 1 node goes down', async () => {
        await nodes.get('node-2')?.pool.end().catch(() => {});
        await container3.stop();

        const healthRes = await request(app).get('/health');
        expect(healthRes.status).toBe(503);
        expect(healthRes.body.status).toBe('degraded');
        expect(healthRes.body.nodes['node-2']).toBe('unhealthy');

        const createRes = await request(app)
            .post('/db')
            .send({ name: 'Resilient User', email: 'resilient@example.com' });

        expect([201, 500]).toContain(createRes.status);

        if (createRes.status === 201) {
            const getRes = await request(app).get(`/db/${createRes.body.id}`);
            expect(getRes.status).toBe(200);
            expect(getRes.body.name).toBe('Resilient User');
        }
    });

    it('fails write with 500 quorum not reached when 2 of 3 nodes are down', async () => {
        await nodes.get('node-1')?.pool.end().catch(() => {});
        await container2.stop();

        const createRes = await request(app)
            .post('/db')
            .send({ name: 'Failing Write', email: 'fail@example.com' });

        expect(createRes.status).toBe(500);
        expect(createRes.body.error).toBe('quorum not reached');
    });
});

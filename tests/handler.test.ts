import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Handler } from '../src/api/handler';
import { setupRoutes } from '../src/api/routes';
import { HashRing } from '../src/hashing/hashring';
import { PgNode } from '../src/pgnode/node';

function createMockNode(id: string, queryFn?: any): PgNode {
    return {
        id,
        connectionString: `mock://${id}`,
        pool: {
            query: queryFn || vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
            connect: vi.fn().mockResolvedValue({
                query: queryFn || vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
                release: vi.fn(),
            }),
            end: vi.fn().mockResolvedValue(undefined),
            on: vi.fn(),
        } as any,
    };
}

describe('Handler Unit & Mocked Distributed Tests', () => {
    it('successfully inserts a record across replicas', async () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');
        ring.addNode('node-1');

        const mockQuery0 = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
        const mockQuery1 = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });

        const nodes = new Map<string, PgNode>([
            ['node-0', createMockNode('node-0', mockQuery0)],
            ['node-1', createMockNode('node-1', mockQuery1)],
        ]);

        const handler = new Handler(nodes, ring, 2);
        const app = express();
        app.use(express.json());
        const router = express.Router();
        setupRoutes(router, handler);
        app.use(router);

        const res = await request(app)
            .post('/db')
            .send({ name: 'Alice', email: 'alice@test.com' });

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('ok');
        expect(res.body.success_count).toBe(2);
        expect(mockQuery0).toHaveBeenCalled();
        expect(mockQuery1).toHaveBeenCalled();
    });

    it('performs compensation rollback when quorum fails on insert', async () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');
        ring.addNode('node-1');

        const mockQuery0 = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
        const mockQuery1 = vi.fn().mockRejectedValue(new Error('Connection lost'));

        const nodes = new Map<string, PgNode>([
            ['node-0', createMockNode('node-0', mockQuery0)],
            ['node-1', createMockNode('node-1', mockQuery1)],
        ]);

        const handler = new Handler(nodes, ring, 2);
        const app = express();
        app.use(express.json());
        const router = express.Router();
        setupRoutes(router, handler);
        app.use(router);

        const res = await request(app)
            .post('/db')
            .send({ name: 'Fail User', email: 'fail@test.com' });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('quorum not reached');
        expect(mockQuery0).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM records WHERE id = $1'),
            expect.any(Array)
        );
    });

    it('validates record_clock on update and rejects malformed values', async () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');
        const nodes = new Map<string, PgNode>([
            ['node-0', createMockNode('node-0')],
        ]);

        const handler = new Handler(nodes, ring, 1);
        const app = express();
        app.use(express.json());
        const router = express.Router();
        setupRoutes(router, handler);
        app.use(router);

        const res = await request(app)
            .put('/db/550e8400-e29b-41d4-a716-446655440000')
            .send({ name: 'Bob', record_clock: ['invalid', 'array'] });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('record_clock');
    });

    it('handles idempotent delete and returns 404 when no rows affected', async () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');
        ring.addNode('node-1');

        const mockQuery = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
        const nodes = new Map<string, PgNode>([
            ['node-0', createMockNode('node-0', mockQuery)],
            ['node-1', createMockNode('node-1', mockQuery)],
        ]);

        const handler = new Handler(nodes, ring, 2);
        const app = express();
        app.use(express.json());
        const router = express.Router();
        setupRoutes(router, handler);
        app.use(router);

        const res = await request(app).delete('/db/550e8400-e29b-41d4-a716-446655440000');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('record not found');
    });

    it('resolves dominant vector clock on GET and schedules read repair', async () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');
        ring.addNode('node-1');

        const now = new Date();
        const staleRecord = {
            id: '550e8400-e29b-41d4-a716-446655440000',
            name: 'Old Name',
            email: 'user@test.com',
            created_at: now,
            updated_at: new Date(now.getTime() - 10000),
            vector_clock: { 'node-0': 1 }
        };

        const newerRecord = {
            id: '550e8400-e29b-41d4-a716-446655440000',
            name: 'New Name',
            email: 'user@test.com',
            created_at: now,
            updated_at: now,
            vector_clock: { 'node-0': 2 }
        };

        const mockQuery0 = vi.fn().mockResolvedValue({ rows: [staleRecord], rowCount: 1 });
        const mockQuery1 = vi.fn().mockResolvedValue({ rows: [newerRecord], rowCount: 1 });

        const nodes = new Map<string, PgNode>([
            ['node-0', createMockNode('node-0', mockQuery0)],
            ['node-1', createMockNode('node-1', mockQuery1)],
        ]);

        const handler = new Handler(nodes, ring, 2);
        const app = express();
        app.use(express.json());
        const router = express.Router();
        setupRoutes(router, handler);
        app.use(router);

        const res = await request(app).get('/db/550e8400-e29b-41d4-a716-446655440000');

        expect(res.status).toBe(200);
        expect(res.body.name).toBe('New Name');
        expect(res.body.record_clock).toEqual({ 'node-0': 2 });
    });

    it('dynamically elects available primary on PUT when node-0 fails to connect', async () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');
        ring.addNode('node-1');

        const existingRecord = {
            id: '550e8400-e29b-41d4-a716-446655440000',
            name: 'Existing',
            email: 'test@test.com',
            vector_clock: { 'node-1': 1 }
        };

        const failingConnect = vi.fn().mockRejectedValue(new Error('node-0 connection failed'));
        const node0 = createMockNode('node-0');
        node0.pool.connect = failingConnect;

        const node1 = createMockNode('node-1', vi.fn().mockResolvedValue({ rows: [existingRecord], rowCount: 1 }));

        const nodes = new Map<string, PgNode>([
            ['node-0', node0],
            ['node-1', node1],
        ]);

        const handler = new Handler(nodes, ring, 1);
        const app = express();
        app.use(express.json());
        const router = express.Router();
        setupRoutes(router, handler);
        app.use(router);

        const res = await request(app)
            .put('/db/550e8400-e29b-41d4-a716-446655440000')
            .send({ name: 'Updated Name', record_clock: { 'node-1': 1 } });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.record_clock).toEqual({ 'node-1': 2 });
    });

    it('rejects stale update with 409 Conflict', async () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');

        const dbRecord = {
            id: '550e8400-e29b-41d4-a716-446655440000',
            name: 'Current Name',
            email: 'test@test.com',
            vector_clock: { 'node-0': 5 }
        };

        const node0 = createMockNode('node-0', vi.fn().mockResolvedValue({ rows: [dbRecord], rowCount: 1 }));
        const nodes = new Map<string, PgNode>([['node-0', node0]]);

        const handler = new Handler(nodes, ring, 1);
        const app = express();
        app.use(express.json());
        const router = express.Router();
        setupRoutes(router, handler);
        app.use(router);

        const res = await request(app)
            .put('/db/550e8400-e29b-41d4-a716-446655440000')
            .send({ name: 'Stale Write', record_clock: { 'node-0': 3 } });

        expect(res.status).toBe(409);
        expect(res.body.error).toContain('conflict');
        expect(res.body.current_clock).toEqual({ 'node-0': 5 });
    });

    it('health check returns healthy when all nodes respond, degraded when one fails', async () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');
        ring.addNode('node-1');

        const node0 = createMockNode('node-0', vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }));
        const node1 = createMockNode('node-1', vi.fn().mockRejectedValue(new Error('Dead')));

        const nodes = new Map<string, PgNode>([
            ['node-0', node0],
            ['node-1', node1],
        ]);

        const handler = new Handler(nodes, ring, 2);
        const app = express();
        app.use(express.json());
        const router = express.Router();
        setupRoutes(router, handler);
        app.use(router);

        const res = await request(app).get('/health');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('degraded');
        expect(res.body.nodes['node-0']).toBe('healthy');
        expect(res.body.nodes['node-1']).toBe('unhealthy');
    });
});

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { PgNode } from '../pgnode/node';
import { HashRing } from '../hashing/hashring';
import { VectorClock } from '../versioning/vectorclock';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface VersionedRecord {
    id: string;
    name: string;
    email: string;
    created_at: Date;
    updated_at: Date;
    vector_clock: Record<string, number>;
}

export class Handler {
    private nodes: Map<string, PgNode>;
    private hashRing: HashRing;
    private replicationFactor: number;

    constructor(
        nodes: Map<string, PgNode>,
        hashRing: HashRing,
        replicationFactor: number
    ) {
        this.nodes = nodes;
        this.hashRing = hashRing;
        this.replicationFactor = replicationFactor;
    }

    private isStale(
        clientClock: Record<string, number>,
        dbClock: Record<string, number>
    ): boolean {
        for (const [nodeId, dbTs] of Object.entries(dbClock)) {
            const clientTs = clientClock[nodeId] ?? 0;
            if (dbTs > clientTs) return true;
        }
        return false;
    }

    async insert(req: Request, res: Response): Promise<void> {
        const startTime = Date.now();
        console.log('========== [INSERT] Request Started ==========');

        const { name, email } = req.body;

        if (!name || !email) {
            console.log('[ERROR] Missing required fields: name or email');
            res.status(400).json({ error: 'name and email are required' });
            return;
        }

        const id = uuidv4();
        console.log(`[INFO] Generated ID: ${id}, Name: ${name}, Email: ${email}`);

        const replicationFactor = Math.max(this.replicationFactor, 1);
        const replicaNodeIds = this.hashRing.getNodes(id, replicationFactor);
        console.log(`[INFO] Hash ring resolved ID ${id} -> Replicas: ${replicaNodeIds}`);

        if (replicaNodeIds.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(503).json({ error: 'no nodes available' });
            return;
        }

        const primaryNodeId = replicaNodeIds[0];
        const keyClock: Record<string, number> = { [primaryNodeId]: 1 };
        const now = new Date();

        const results = await Promise.allSettled(
            replicaNodeIds.map(async (nodeId) => {
                const node = this.nodes.get(nodeId);
                if (!node) throw new Error(`Node ${nodeId} not found in node map`);

                console.log(`[INFO] Writing to replica node: ${nodeId}`);

                await node.pool.query(
                    `INSERT INTO records (id, name, email, created_at, updated_at, vector_clock)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [id, name, email, now, now, JSON.stringify(keyClock)]
                );

                console.log(`[SUCCESS] INSERT completed on replica ${nodeId}`);
                return nodeId;
            })
        );

        const successNodes = results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
            .map(r => r.value);

        for (const r of results) {
            if (r.status === 'rejected') {
                console.log(`[ERROR] INSERT failed on a replica: ${r.reason}`);
            }
        }

        const successCount = successNodes.length;
        const quorum = Math.floor(replicaNodeIds.length / 2) + 1;

        if (successCount < quorum) {
            console.log(`[ERROR] Quorum not reached: ${successCount}/${replicaNodeIds.length} (need ${quorum})`);
            res.status(500).json({
                error: 'quorum not reached',
                success: successCount,
                required: quorum
            });
            return;
        }

        const duration = Date.now() - startTime;
        console.log(`[SUCCESS] INSERT completed - ID: ${id} stored on ${successCount}/${replicaNodeIds.length} replicas`);
        console.log(`[INFO] INSERT request completed in ${duration}ms`);
        console.log('========== [INSERT] Request Finished ==========');

        res.status(201).json({
            status: 'ok',
            id,
            name,
            email,
            created_at: now,
            updated_at: now,
            replicas: successNodes,
            success_count: successCount,
            quorum,
            record_clock: keyClock
        });
    }

    async get(req: Request, res: Response): Promise<void> {
        const startTime = Date.now();
        console.log('========== [GET] Request Started ==========');

        const { id } = req.params;

        if (!id || !UUID_REGEX.test(id)) {
            console.log('[ERROR] Invalid or missing UUID');
            res.status(400).json({ error: 'a valid UUID id parameter is required' });
            return;
        }

        console.log(`[INFO] Received GET request - ID: ${id}`);

        const replicationFactor = Math.max(this.replicationFactor, 1);
        const replicaNodeIds = this.hashRing.getNodes(id, replicationFactor);
        console.log(`[INFO] Hash ring resolved ID ${id} -> Replicas: ${replicaNodeIds}`);

        if (replicaNodeIds.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(503).json({ error: 'no nodes available' });
            return;
        }

        const queryResults = await Promise.allSettled(
            replicaNodeIds.map(async (nodeId) => {
                const node = this.nodes.get(nodeId);
                if (!node) throw new Error(`Node ${nodeId} not found in node map`);

                console.log(`[INFO] Attempting GET on Node: ${nodeId}`);

                const client = await node.pool.connect();
                try {
                    await client.query('BEGIN');
                    const result = await client.query(
                        `SELECT id, name, email, created_at, updated_at, vector_clock
                         FROM records WHERE id = $1 FOR SHARE`,
                        [id]
                    );
                    await client.query('COMMIT');

                    if (result.rows.length === 0) {
                        console.log(`[INFO] Record ${id} not found on node ${nodeId}`);
                        return null;
                    }

                    console.log(`[INFO] Successfully read from node ${nodeId}`);
                    return { record: result.rows[0] as VersionedRecord, nodeId };
                } catch (err) {
                    await client.query('ROLLBACK').catch(() => {});
                    throw err;
                } finally {
                    client.release();
                }
            })
        );

        const reads = queryResults
            .filter((r): r is PromiseFulfilledResult<{ record: VersionedRecord; nodeId: string } | null> =>
                r.status === 'fulfilled')
            .map(r => r.value)
            .filter((r): r is { record: VersionedRecord; nodeId: string } => r !== null);

        for (const r of queryResults) {
            if (r.status === 'rejected') {
                console.log(`[WARN] GET failed on a replica: ${r.reason}`);
            }
        }

        if (reads.length === 0) {
            const duration = Date.now() - startTime;
            console.log(`[INFO] Record ${id} not found on any replica`);
            console.log(`[INFO] GET request completed in ${duration}ms (not found)`);
            console.log('========== [GET] Request Finished ==========');
            res.status(404).json({ error: 'record not found', id });
            return;
        }

        let best = reads[0];
        for (let i = 1; i < reads.length; i++) {
            const bestClock = VectorClock.fromObject(best.record.vector_clock || {});
            const candidateClock = VectorClock.fromObject(reads[i].record.vector_clock || {});
            const cmp = candidateClock.compare(bestClock);

            if (cmp > 0) {
                best = reads[i];
            } else if (cmp === 0) {
                const candidateTime = new Date(reads[i].record.updated_at).getTime();
                const bestTime = new Date(best.record.updated_at).getTime();
                if (candidateTime > bestTime) {
                    best = reads[i];
                }
            }
        }

        const duration = Date.now() - startTime;
        console.log(`[SUCCESS] GET completed - ID: ${id}, Name: ${best.record.name} from Node: ${best.nodeId}`);
        console.log(`[INFO] GET request completed in ${duration}ms`);
        console.log('========== [GET] Request Finished ==========');

        res.status(200).json({
            id: best.record.id,
            name: best.record.name,
            email: best.record.email,
            created_at: best.record.created_at,
            updated_at: best.record.updated_at,
            node: best.nodeId,
            replicas: replicaNodeIds,
            record_clock: best.record.vector_clock
        });
    }

    async update(req: Request, res: Response): Promise<void> {
        const startTime = Date.now();
        console.log('========== [UPDATE] Request Started ==========');

        const { id } = req.params;
        const { name, email, record_clock: clientClock } = req.body;

        if (!id || !UUID_REGEX.test(id)) {
            console.log('[ERROR] Invalid or missing UUID');
            res.status(400).json({ error: 'a valid UUID id parameter is required' });
            return;
        }

        if (!name && !email) {
            console.log('[ERROR] No fields to update');
            res.status(400).json({ error: 'at least one of name or email is required' });
            return;
        }

        console.log(`[INFO] Received UPDATE request - ID: ${id}`);

        const replicationFactor = Math.max(this.replicationFactor, 1);
        const replicaNodeIds = this.hashRing.getNodes(id, replicationFactor);
        console.log(`[INFO] Hash ring resolved ID ${id} -> Replicas: ${replicaNodeIds}`);

        if (replicaNodeIds.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(503).json({ error: 'no nodes available' });
            return;
        }

        const primaryNodeId = replicaNodeIds[0];
        const primaryNode = this.nodes.get(primaryNodeId);

        if (!primaryNode) {
            console.log('[ERROR] Primary node unavailable');
            res.status(503).json({ error: 'primary node unavailable' });
            return;
        }

        const client = await primaryNode.pool.connect();

        try {
            await client.query('BEGIN');

            const lockResult = await client.query(
                'SELECT vector_clock FROM records WHERE id = $1 FOR UPDATE',
                [id]
            );

            if (lockResult.rows.length === 0) {
                await client.query('ROLLBACK');
                console.log(`[INFO] Record ${id} not found on primary`);
                res.status(404).json({ error: 'record not found', id });
                return;
            }

            const dbClock: Record<string, number> = lockResult.rows[0].vector_clock || {};

            if (clientClock && typeof clientClock === 'object') {
                if (this.isStale(clientClock as Record<string, number>, dbClock)) {
                    await client.query('ROLLBACK');
                    console.log(`[WARN] Stale write detected for record ${id}`);
                    res.status(409).json({
                        error: 'conflict: record was modified since you last read it',
                        id,
                        current_clock: dbClock
                    });
                    return;
                }
            }

            const existingClock: Record<string, number> = { ...dbClock };
            existingClock[primaryNodeId] = (existingClock[primaryNodeId] || 0) + 1;

            const now = new Date();

            const setClauses: string[] = ['updated_at = $2', 'vector_clock = $3'];
            const values: any[] = [id, now, JSON.stringify(existingClock)];
            let paramIndex = 4;

            if (name) {
                setClauses.push(`name = $${paramIndex}`);
                values.push(name);
                paramIndex++;
            }
            if (email) {
                setClauses.push(`email = $${paramIndex}`);
                values.push(email);
                paramIndex++;
            }

            const updateQuery = `UPDATE records SET ${setClauses.join(', ')} WHERE id = $1`;

            await client.query(updateQuery, values);
            await client.query('COMMIT');
            console.log(`[SUCCESS] UPDATE committed on primary ${primaryNodeId}`);

            const secondaryNodeIds = replicaNodeIds.slice(1);
            const secondaryResults = await Promise.allSettled(
                secondaryNodeIds.map(async (nodeId) => {
                    const node = this.nodes.get(nodeId);
                    if (!node) throw new Error(`Node ${nodeId} not found in node map`);

                    console.log(`[INFO] Updating on secondary node: ${nodeId}`);

                    const result = await node.pool.query(updateQuery, values);

                    if ((result.rowCount ?? 0) === 0) {
                        console.log(`[WARN] Record ${id} not found on secondary ${nodeId}`);
                        throw new Error(`Record ${id} not found on node ${nodeId}`);
                    }

                    console.log(`[SUCCESS] UPDATE completed on secondary ${nodeId}`);
                    return nodeId;
                })
            );

            const successNodes = [primaryNodeId];
            for (const r of secondaryResults) {
                if (r.status === 'fulfilled') {
                    successNodes.push(r.value);
                } else {
                    console.log(`[ERROR] Secondary update failed: ${r.reason}`);
                }
            }

            const successCount = successNodes.length;
            const quorum = Math.floor(replicaNodeIds.length / 2) + 1;

            if (successCount < quorum) {
                console.log(`[ERROR] Quorum not reached: ${successCount}/${replicaNodeIds.length} (need ${quorum})`);
                res.status(500).json({
                    error: 'quorum not reached',
                    success: successCount,
                    required: quorum
                });
                return;
            }

            const duration = Date.now() - startTime;
            console.log(`[SUCCESS] UPDATE completed - ID: ${id} on ${successCount}/${replicaNodeIds.length} replicas`);
            console.log(`[INFO] UPDATE request completed in ${duration}ms`);
            console.log('========== [UPDATE] Request Finished ==========');

            res.status(200).json({
                status: 'ok',
                id,
                updated_at: now,
                replicas: successNodes,
                success_count: successCount,
                quorum,
                record_clock: existingClock
            });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.log(`[ERROR] Update transaction failed: ${err}`);
            res.status(500).json({ error: 'update failed' });
        } finally {
            client.release();
        }
    }

    async delete(req: Request, res: Response): Promise<void> {
        const startTime = Date.now();
        console.log('========== [DELETE] Request Started ==========');

        const { id } = req.params;

        if (!id || !UUID_REGEX.test(id)) {
            console.log('[ERROR] Invalid or missing UUID');
            res.status(400).json({ error: 'a valid UUID id parameter is required' });
            return;
        }

        console.log(`[INFO] Received DELETE request - ID: ${id}`);

        const replicationFactor = Math.max(this.replicationFactor, 1);
        const replicaNodeIds = this.hashRing.getNodes(id, replicationFactor);
        console.log(`[INFO] Hash ring resolved ID ${id} -> Replicas: ${replicaNodeIds}`);

        if (replicaNodeIds.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(503).json({ error: 'no nodes available' });
            return;
        }

        const results = await Promise.allSettled(
            replicaNodeIds.map(async (nodeId) => {
                const node = this.nodes.get(nodeId);
                if (!node) throw new Error(`Node ${nodeId} not found in node map`);

                console.log(`[INFO] Deleting on node: ${nodeId}`);

                const result = await node.pool.query(
                    'DELETE FROM records WHERE id = $1',
                    [id]
                );

                const affected = result.rowCount ?? 0;

                if (affected === 0) {
                    console.log(`[INFO] Record ${id} not found on node ${nodeId}`);
                }

                return { nodeId, affected };
            })
        );

        const successNodes = results
            .filter((r): r is PromiseFulfilledResult<{ nodeId: string; affected: number }> =>
                r.status === 'fulfilled' && r.value.affected > 0)
            .map(r => r.value.nodeId);

        for (const r of results) {
            if (r.status === 'rejected') {
                console.log(`[ERROR] DELETE failed on a replica: ${r.reason}`);
            }
        }

        if (successNodes.length === 0) {
            console.log(`[INFO] Record ${id} not found on any replica`);
            res.status(404).json({ error: 'record not found', id });
            return;
        }

        const quorum = Math.floor(replicaNodeIds.length / 2) + 1;
        if (successNodes.length < quorum) {
            console.log(`[ERROR] Quorum not reached: ${successNodes.length}/${replicaNodeIds.length} (need ${quorum})`);
            res.status(500).json({
                error: 'quorum not reached',
                success: successNodes.length,
                required: quorum
            });
            return;
        }

        const duration = Date.now() - startTime;
        console.log(`[SUCCESS] DELETE completed - ID: ${id} on ${successNodes.length}/${replicaNodeIds.length} replicas`);
        console.log(`[INFO] DELETE request completed in ${duration}ms`);
        console.log('========== [DELETE] Request Finished ==========');

        res.status(200).json({
            status: 'ok',
            id,
            replicas: successNodes,
            success_count: successNodes.length,
            quorum
        });
    }

    async health(_req: Request, res: Response): Promise<void> {
        const nodeResults: Record<string, string> = {};
        let allHealthy = true;

        const checks = await Promise.allSettled(
            Array.from(this.nodes.entries()).map(async ([nodeId, node]) => {
                try {
                    await node.pool.query('SELECT 1');
                    return { nodeId, status: 'healthy' };
                } catch {
                    return { nodeId, status: 'unhealthy' };
                }
            })
        );

        for (const check of checks) {
            if (check.status === 'fulfilled') {
                nodeResults[check.value.nodeId] = check.value.status;
                if (check.value.status === 'unhealthy') allHealthy = false;
            }
        }

        res.status(allHealthy ? 200 : 503).json({
            status: allHealthy ? 'healthy' : 'degraded',
            nodes: nodeResults,
            total_nodes: this.nodes.size,
            ring_nodes: this.hashRing.getUniqueNodeCount()
        });
    }
}

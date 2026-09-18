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

    private scheduleReadRepair(
        id: string,
        bestRecord: VersionedRecord,
        targetNodeIds: string[],
        reads: Array<{ record: VersionedRecord; nodeId: string }>
    ): void {
        const readMap = new Map<string, VersionedRecord>();
        for (const r of reads) {
            readMap.set(r.nodeId, r.record);
        }

        const bestClock = VectorClock.fromObject(bestRecord.vector_clock || {});

        for (const nodeId of targetNodeIds) {
            const existing = readMap.get(nodeId);
            let needsRepair = false;

            if (!existing) {
                needsRepair = true;
            } else {
                const nodeClock = VectorClock.fromObject(existing.vector_clock || {});
                if (bestClock.compare(nodeClock) > 0) {
                    needsRepair = true;
                }
            }

            if (needsRepair) {
                const node = this.nodes.get(nodeId);
                if (node) {
                    node.pool.query(
                        `INSERT INTO records (id, name, email, created_at, updated_at, vector_clock)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (id) DO UPDATE SET
                           name = EXCLUDED.name,
                           email = EXCLUDED.email,
                           updated_at = EXCLUDED.updated_at,
                           vector_clock = EXCLUDED.vector_clock
                         WHERE records.updated_at < EXCLUDED.updated_at`,
                        [
                            id,
                            bestRecord.name,
                            bestRecord.email,
                            bestRecord.created_at,
                            bestRecord.updated_at,
                            JSON.stringify(bestRecord.vector_clock)
                        ]
                    ).then(() => {
                        console.log(`[REPAIR] Read repair successfully updated node ${nodeId} for record ${id}`);
                    }).catch((err: Error) => {
                        console.log(`[REPAIR] Read repair skipped/failed for node ${nodeId}: ${err.message}`);
                    });
                }
            }
        }
    }


    async insert(req: Request, res: Response): Promise<void> {
        const startTime = Date.now();
        console.log('========== [INSERT] Request Started ==========');

        const { name, email } = req.body;

        if (!name || !email || typeof name !== 'string' || typeof email !== 'string') {
            console.log('[ERROR] Missing or invalid required fields: name and email must be strings');
            res.status(400).json({ error: 'name and email are required and must be strings' });
            return;
        }

        const id = uuidv4();
        console.log(`[INFO] Generated ID: ${id}, Name: ${name}, Email: ${email}`);

        const preferenceList = this.hashRing.getNodes(id, this.nodes.size);
        if (preferenceList.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(503).json({ error: 'no nodes available' });
            return;
        }

        const replicationFactor = Math.min(Math.max(this.replicationFactor, 1), preferenceList.length);
        const replicaNodeIds = preferenceList.slice(0, replicationFactor);
        console.log(`[INFO] Hash ring resolved ID ${id} -> Primary Replicas: ${replicaNodeIds}`);

        const primaryNodeId = replicaNodeIds[0];
        const keyClock: Record<string, number> = { [primaryNodeId]: 1 };
        const now = new Date();

        const successNodes: string[] = [];

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

        for (const r of results) {
            if (r.status === 'fulfilled') {
                successNodes.push(r.value);
            } else {
                console.log(`[WARN] INSERT failed on a replica: ${r.reason}`);
            }
        }

        const quorum = Math.floor(replicationFactor / 2) + 1;

        if (successNodes.length < quorum && preferenceList.length > replicationFactor) {
            const fallbackNodeIds = preferenceList.slice(replicationFactor);
            console.log(`[INFO] Quorum not reached on primary replicas (${successNodes.length}/${quorum}). Trying fallback replicas: ${fallbackNodeIds}`);

            for (const fallbackId of fallbackNodeIds) {
                if (successNodes.length >= quorum) break;
                if (successNodes.includes(fallbackId)) continue;

                const node = this.nodes.get(fallbackId);
                if (!node) continue;

                try {
                    console.log(`[INFO] Attempting write to fallback replica: ${fallbackId}`);
                    await node.pool.query(
                        `INSERT INTO records (id, name, email, created_at, updated_at, vector_clock)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [id, name, email, now, now, JSON.stringify(keyClock)]
                    );
                    successNodes.push(fallbackId);
                    console.log(`[SUCCESS] INSERT completed on fallback replica: ${fallbackId}`);
                } catch (err) {
                    console.log(`[WARN] Fallback write failed on node ${fallbackId}: ${err}`);
                }
            }
        }

        const successCount = successNodes.length;

        if (successCount < quorum) {
            console.log(`[ERROR] Quorum not reached: ${successCount}/${replicaNodeIds.length} (need ${quorum}). Performing compensation rollback...`);
            await Promise.allSettled(
                successNodes.map(async (nodeId) => {
                    const node = this.nodes.get(nodeId);
                    if (node) {
                        await node.pool.query('DELETE FROM records WHERE id = $1', [id]).catch(() => {});
                    }
                })
            );

            res.status(500).json({
                error: 'quorum not reached',
                success: successCount,
                required: quorum
            });
            return;
        }

        const duration = Date.now() - startTime;
        console.log(`[SUCCESS] INSERT completed - ID: ${id} stored on ${successCount} replicas`);
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

        const preferenceList = this.hashRing.getNodes(id, this.nodes.size);
        if (preferenceList.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(503).json({ error: 'no nodes available' });
            return;
        }

        const replicationFactor = Math.min(Math.max(this.replicationFactor, 1), preferenceList.length);
        const replicaNodeIds = preferenceList.slice(0, replicationFactor);
        console.log(`[INFO] Hash ring resolved ID ${id} -> Primary Replicas: ${replicaNodeIds}`);

        const queryReplica = async (nodeId: string) => {
            const node = this.nodes.get(nodeId);
            if (!node) throw new Error(`Node ${nodeId} not found in node map`);

            console.log(`[INFO] Querying GET on Node: ${nodeId}`);
            const result = await node.pool.query(
                `SELECT id, name, email, created_at, updated_at, vector_clock
                 FROM records WHERE id = $1`,
                [id]
            );

            if (result.rows.length === 0) {
                console.log(`[INFO] Record ${id} not found on node ${nodeId}`);
                return null;
            }

            console.log(`[INFO] Successfully read from node ${nodeId}`);
            return { record: result.rows[0] as VersionedRecord, nodeId };
        };

        const queryResults = await Promise.allSettled(replicaNodeIds.map(queryReplica));

        const reads = queryResults
            .filter((r): r is PromiseFulfilledResult<{ record: VersionedRecord; nodeId: string } | null> =>
                r.status === 'fulfilled')
            .map(r => r.value)
            .filter((r): r is { record: VersionedRecord; nodeId: string } => r !== null);

        if (reads.length === 0 && preferenceList.length > replicationFactor) {
            const fallbackNodeIds = preferenceList.slice(replicationFactor);
            console.log(`[INFO] Record ${id} not found on primary replicas. Checking fallback replicas: ${fallbackNodeIds}`);

            const fallbackResults = await Promise.allSettled(fallbackNodeIds.map(queryReplica));
            for (const r of fallbackResults) {
                if (r.status === 'fulfilled' && r.value !== null) {
                    reads.push(r.value);
                }
            }
        }

        if (reads.length === 0) {
            const duration = Date.now() - startTime;
            console.log(`[INFO] Record ${id} not found on any reachable replica`);
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

        this.scheduleReadRepair(id, best.record, replicaNodeIds, reads);

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

        if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
            res.status(400).json({ error: 'name must be a non-empty string if provided' });
            return;
        }

        if (email !== undefined && (typeof email !== 'string' || email.trim() === '')) {
            res.status(400).json({ error: 'email must be a non-empty string if provided' });
            return;
        }

        if (clientClock !== undefined) {
            if (typeof clientClock !== 'object' || clientClock === null || Array.isArray(clientClock)) {
                res.status(400).json({ error: 'record_clock must be a valid JSON object' });
                return;
            }
            for (const [k, v] of Object.entries(clientClock)) {
                if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
                    res.status(400).json({ error: `Invalid counter value for node ${k} in record_clock: ${v}` });
                    return;
                }
            }
        }

        console.log(`[INFO] Received UPDATE request - ID: ${id}`);

        const preferenceList = this.hashRing.getNodes(id, this.nodes.size);
        if (preferenceList.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(503).json({ error: 'no nodes available' });
            return;
        }

        const replicationFactor = Math.min(Math.max(this.replicationFactor, 1), preferenceList.length);
        const quorum = Math.floor(replicationFactor / 2) + 1;

        let primaryNodeId: string | null = null;
        let primaryClient: any = null;
        let lockRow: any = null;

        for (const candidateId of preferenceList) {
            const candidate = this.nodes.get(candidateId);
            if (!candidate) continue;

            let client: any = null;
            try {
                client = await candidate.pool.connect();
                await client.query('BEGIN');
                const lockResult = await client.query(
                    'SELECT id, name, email, vector_clock FROM records WHERE id = $1 FOR UPDATE',
                    [id]
                );

                if (lockResult.rows.length > 0) {
                    primaryNodeId = candidateId;
                    primaryClient = client;
                    lockRow = lockResult.rows[0];
                    break;
                } else {
                    await client.query('ROLLBACK').catch(() => {});
                    client.release();
                }
            } catch (err) {
                if (client) {
                    await client.query('ROLLBACK').catch(() => {});
                    client.release();
                }
                console.log(`[WARN] Candidate node ${candidateId} could not be used as primary: ${err}`);
            }
        }

        if (!primaryNodeId || !primaryClient || !lockRow) {
            console.log(`[INFO] Record ${id} not found on any reachable node`);
            res.status(404).json({ error: 'record not found', id });
            return;
        }

        try {
            const dbClock: Record<string, number> = lockRow.vector_clock || {};

            if (clientClock && typeof clientClock === 'object') {
                if (this.isStale(clientClock as Record<string, number>, dbClock)) {
                    await primaryClient.query('ROLLBACK');
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

            const primaryReplicas = preferenceList.slice(0, replicationFactor);
            const secondaryNodeIds = primaryReplicas.filter(nid => nid !== primaryNodeId);

            const successNodes = [primaryNodeId];

            const secondaryResults = await Promise.allSettled(
                secondaryNodeIds.map(async (nodeId) => {
                    const node = this.nodes.get(nodeId);
                    if (!node) throw new Error(`Node ${nodeId} not found in node map`);

                    console.log(`[INFO] Updating on secondary node: ${nodeId}`);
                    const result = await node.pool.query(updateQuery, values);

                    if ((result.rowCount ?? 0) === 0) {
                        await node.pool.query(
                            `INSERT INTO records (id, name, email, created_at, updated_at, vector_clock)
                             VALUES ($1, $2, $3, $4, $5, $6)
                             ON CONFLICT (id) DO UPDATE SET
                               name = EXCLUDED.name,
                               email = EXCLUDED.email,
                               updated_at = EXCLUDED.updated_at,
                               vector_clock = EXCLUDED.vector_clock`,
                            [
                                id,
                                name || lockRow.name,
                                email || lockRow.email,
                                now,
                                now,
                                JSON.stringify(existingClock)
                            ]
                        );
                    }

                    console.log(`[SUCCESS] UPDATE completed on secondary ${nodeId}`);
                    return nodeId;
                })
            );

            for (const r of secondaryResults) {
                if (r.status === 'fulfilled') {
                    successNodes.push(r.value);
                } else {
                    console.log(`[WARN] Secondary update failed on a node: ${r.reason}`);
                }
            }

            if (successNodes.length < quorum && preferenceList.length > replicationFactor) {
                const fallbackNodeIds = preferenceList.slice(replicationFactor).filter(nid => !successNodes.includes(nid));
                for (const fallbackId of fallbackNodeIds) {
                    if (successNodes.length >= quorum) break;
                    const node = this.nodes.get(fallbackId);
                    if (!node) continue;

                    try {
                        await node.pool.query(
                            `INSERT INTO records (id, name, email, created_at, updated_at, vector_clock)
                             VALUES ($1, $2, $3, $4, $5, $6)
                             ON CONFLICT (id) DO UPDATE SET
                               name = EXCLUDED.name,
                               email = EXCLUDED.email,
                               updated_at = EXCLUDED.updated_at,
                               vector_clock = EXCLUDED.vector_clock`,
                            [
                                id,
                                name || lockRow.name,
                                email || lockRow.email,
                                now,
                                now,
                                JSON.stringify(existingClock)
                            ]
                        );
                        successNodes.push(fallbackId);
                    } catch (err) {
                        console.log(`[WARN] Fallback update failed on node ${fallbackId}: ${err}`);
                    }
                }
            }

            const successCount = successNodes.length;

            if (successCount < quorum) {
                console.log(`[ERROR] Quorum not reached: ${successCount}/${replicationFactor} (need ${quorum}). Aborting primary update.`);
                await primaryClient.query('ROLLBACK');
                res.status(500).json({
                    error: 'quorum not reached',
                    success: successCount,
                    required: quorum
                });
                return;
            }

            await primaryClient.query(updateQuery, values);
            await primaryClient.query('COMMIT');
            console.log(`[SUCCESS] UPDATE committed on primary ${primaryNodeId}`);

            const duration = Date.now() - startTime;
            console.log(`[SUCCESS] UPDATE completed - ID: ${id} on ${successCount} replicas`);
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
            await primaryClient.query('ROLLBACK').catch(() => {});
            console.log(`[ERROR] Update transaction failed: ${err}`);
            res.status(500).json({ error: 'update failed' });
        } finally {
            primaryClient.release();
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

        const preferenceList = this.hashRing.getNodes(id, this.nodes.size);
        if (preferenceList.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(503).json({ error: 'no nodes available' });
            return;
        }

        const replicationFactor = Math.min(Math.max(this.replicationFactor, 1), preferenceList.length);
        const replicaNodeIds = preferenceList.slice(0, replicationFactor);
        const quorum = Math.floor(replicationFactor / 2) + 1;
        console.log(`[INFO] Hash ring resolved ID ${id} -> Primary Replicas: ${replicaNodeIds}`);

        const deleteFromNode = async (nodeId: string) => {
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
        };

        const results = await Promise.allSettled(replicaNodeIds.map(deleteFromNode));

        const fulfilledResults = results
            .filter((r): r is PromiseFulfilledResult<{ nodeId: string; affected: number }> => r.status === 'fulfilled')
            .map(r => r.value);

        if (fulfilledResults.length < quorum && preferenceList.length > replicationFactor) {
            const fallbackNodeIds = preferenceList.slice(replicationFactor);
            console.log(`[INFO] Attempting DELETE on fallback replicas: ${fallbackNodeIds}`);
            const fallbackResults = await Promise.allSettled(fallbackNodeIds.map(deleteFromNode));
            for (const r of fallbackResults) {
                if (r.status === 'fulfilled') {
                    fulfilledResults.push(r.value);
                }
            }
        }

        for (const r of results) {
            if (r.status === 'rejected') {
                console.log(`[WARN] DELETE failed on a replica: ${r.reason}`);
            }
        }

        const totalAffected = fulfilledResults.reduce((sum, r) => sum + r.affected, 0);
        const confirmedNodes = fulfilledResults.map(r => r.nodeId);

        if (totalAffected === 0) {
            console.log(`[INFO] Record ${id} not found on any reachable replica`);
            res.status(404).json({ error: 'record not found', id });
            return;
        }

        if (confirmedNodes.length < quorum) {
            console.log(`[ERROR] Quorum not reached: ${confirmedNodes.length}/${replicationFactor} (need ${quorum})`);
            res.status(500).json({
                error: 'quorum not reached',
                success: confirmedNodes.length,
                required: quorum
            });
            return;
        }

        const duration = Date.now() - startTime;
        console.log(`[SUCCESS] DELETE completed - ID: ${id} on ${confirmedNodes.length} replicas`);
        console.log(`[INFO] DELETE request completed in ${duration}ms`);
        console.log('========== [DELETE] Request Finished ==========');

        res.status(200).json({
            status: 'ok',
            id,
            replicas: confirmedNodes,
            success_count: confirmedNodes.length,
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

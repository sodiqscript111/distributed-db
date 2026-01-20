import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { PgNode } from '../pgnode/node';
import { HashRing } from '../hashing/hashring';
import { VectorClock } from '../versioning/vectorclock';

interface VersionedRecord {
    id: string;
    name: string;
    email: string;
    created_at: Date;
    updated_at: Date;
    vector_clock: Record<string, number>;
}

export class Handler {
    nodes: Map<string, PgNode>;
    hashRing: HashRing;
    vectorClock: VectorClock;
    replicationFactor: number;

    constructor(
        nodes: Map<string, PgNode>,
        hashRing: HashRing,
        vectorClock: VectorClock,
        replicationFactor: number
    ) {
        this.nodes = nodes;
        this.hashRing = hashRing;
        this.vectorClock = vectorClock;
        this.replicationFactor = replicationFactor;
    }

    private pickRandomNode(): PgNode | null {
        const nodesArray = Array.from(this.nodes.values());
        if (nodesArray.length === 0) return null;
        return nodesArray[Math.floor(Math.random() * nodesArray.length)];
    }

    async insert(req: Request, res: Response): Promise<void> {
        const startTime = Date.now();
        console.log('========== [INSERT] Request Started ==========');
        console.log(`[INFO] Client IP: ${req.ip}`);

        const { name, email } = req.body;

        if (!name || !email) {
            console.log('[ERROR] Missing required fields: name or email');
            res.status(400).json({ error: 'name and email are required' });
            return;
        }

        const id = uuidv4();
        console.log(`[INFO] Generated ID: ${id}, Name: ${name}, Email: ${email}`);

        let replicationFactor = this.replicationFactor;
        if (replicationFactor <= 0) replicationFactor = 1;

        const replicaNodeIds = this.hashRing.getNodes(id, replicationFactor);
        console.log(`[INFO] Hash ring resolved ID ${id} -> Replicas: ${replicaNodeIds}`);

        if (replicaNodeIds.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(500).json({ error: 'no nodes available' });
            return;
        }

        const primaryNodeId = replicaNodeIds[0];
        const keyClock: Record<string, number> = {};
        keyClock[primaryNodeId] = 1;

        const now = new Date();
        let successCount = 0;
        const successNodes: string[] = [];

        const insertPromises = replicaNodeIds.map(async (nodeId) => {
            const node = this.nodes.get(nodeId);
            if (!node) {
                console.log(`[ERROR] Node ${nodeId} not found`);
                return;
            }

            console.log(`[INFO] Writing to replica node: ${nodeId} (ID=${node.id})`);

            try {
                await node.pool.query(
                    `INSERT INTO records (id, name, email, created_at, updated_at, vector_clock)
           VALUES ($1, $2, $3, $4, $5, $6)`,
                    [id, name, email, now, now, JSON.stringify(keyClock)]
                );
                successCount++;
                successNodes.push(nodeId);
                console.log(`[SUCCESS] INSERT completed on replica ${nodeId}`);
            } catch (err) {
                console.log(`[ERROR] PostgreSQL INSERT failed on node ${nodeId}: ${err}`);
            }
        });

        await Promise.all(insertPromises);

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

        console.log(`[SUCCESS] INSERT completed - ID: ${id} stored on ${successCount}/${replicaNodeIds.length} replicas`);
        this.vectorClock.increment(primaryNodeId);

        const duration = Date.now() - startTime;
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
            record_clock: keyClock,
            global_clock: this.vectorClock.copy()
        });
    }

    async get(req: Request, res: Response): Promise<void> {
        const startTime = Date.now();
        console.log('========== [GET] Request Started ==========');
        console.log(`[INFO] Client IP: ${req.ip}`);

        const { id } = req.params;

        if (!id) {
            console.log('[ERROR] Missing id parameter');
            res.status(400).json({ error: 'id parameter is required' });
            return;
        }

        console.log(`[INFO] Received GET request - ID: ${id}`);

        let replicationFactor = this.replicationFactor;
        if (replicationFactor <= 0) replicationFactor = 1;

        const replicaNodeIds = this.hashRing.getNodes(id, replicationFactor);
        console.log(`[INFO] Hash ring resolved ID ${id} -> Replicas: ${replicaNodeIds}`);

        if (replicaNodeIds.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(500).json({ error: 'no nodes available' });
            return;
        }

        let record: VersionedRecord | null = null;
        let successNodeId: string | null = null;
        let lastErr: Error | null = null;

        for (const nodeId of replicaNodeIds) {
            const node = this.nodes.get(nodeId);
            if (!node) {
                console.log(`[WARN] Node ${nodeId} not found, trying next replica`);
                continue;
            }

            console.log(`[INFO] Attempting GET on Node: ${nodeId} (ID=${node.id})`);

            try {
                const result = await node.pool.query(
                    'SELECT id, name, email, created_at, updated_at, vector_clock FROM records WHERE id = $1',
                    [id]
                );

                if (result.rows.length === 0) {
                    console.log(`[INFO] Record ${id} not found on node ${nodeId}, trying next`);
                    continue;
                }

                record = result.rows[0];
                successNodeId = nodeId;
                console.log(`[INFO] Successfully read from node ${nodeId}`);
                break;
            } catch (err) {
                console.log(`[WARN] PostgreSQL GET failed on node ${nodeId}: ${err}`);
                lastErr = err as Error;
            }
        }

        if (!successNodeId || !record) {
            console.log(`[INFO] Record ${id} not found on any replica`);
            const duration = Date.now() - startTime;
            console.log(`[INFO] GET request completed in ${duration}ms (not found)`);
            console.log('========== [GET] Request Finished ==========');
            res.status(404).json({
                error: 'record not found',
                id,
                replicas: replicaNodeIds,
                global_clock: this.vectorClock.copy()
            });
            return;
        }

        console.log(`[SUCCESS] GET completed - ID: ${id}, Name: ${record.name} from Node: ${successNodeId}`);

        const duration = Date.now() - startTime;
        console.log(`[INFO] GET request completed in ${duration}ms`);
        console.log('========== [GET] Request Finished ==========');

        res.status(200).json({
            id: record.id,
            name: record.name,
            email: record.email,
            created_at: record.created_at,
            updated_at: record.updated_at,
            node: successNodeId,
            replicas: replicaNodeIds,
            record_clock: record.vector_clock,
            global_clock: this.vectorClock.copy()
        });
    }

    async update(req: Request, res: Response): Promise<void> {
        const startTime = Date.now();
        console.log('========== [UPDATE] Request Started ==========');
        console.log(`[INFO] Client IP: ${req.ip}`);

        const { id } = req.params;
        const { name, email } = req.body;

        if (!id) {
            console.log('[ERROR] Missing id parameter');
            res.status(400).json({ error: 'id parameter is required' });
            return;
        }

        console.log(`[INFO] Received UPDATE request - ID: ${id}`);

        let replicationFactor = this.replicationFactor;
        if (replicationFactor <= 0) replicationFactor = 1;

        const replicaNodeIds = this.hashRing.getNodes(id, replicationFactor);
        console.log(`[INFO] Hash ring resolved ID ${id} -> Replicas: ${replicaNodeIds}`);

        if (replicaNodeIds.length === 0) {
            console.log('[ERROR] No nodes available');
            res.status(500).json({ error: 'no nodes available' });
            return;
        }

        const primaryNodeId = replicaNodeIds[0];
        const primaryNode = this.nodes.get(primaryNodeId);

        let existingClock: Record<string, number> = {};
        if (primaryNode) {
            try {
                const result = await primaryNode.pool.query(
                    'SELECT vector_clock FROM records WHERE id = $1',
                    [id]
                );
                if (result.rows.length > 0) {
                    existingClock = result.rows[0].vector_clock || {};
                }
            } catch (err) {
                console.log(`[WARN] Failed to get existing clock: ${err}`);
            }
        }

        existingClock[primaryNodeId] = (existingClock[primaryNodeId] || 0) + 1;
        const now = new Date();

        let successCount = 0;
        const successNodes: string[] = [];

        const updatePromises = replicaNodeIds.map(async (nodeId) => {
            const node = this.nodes.get(nodeId);
            if (!node) {
                console.log(`[ERROR] Node ${nodeId} not found`);
                return;
            }

            console.log(`[INFO] Updating on replica node: ${nodeId} (ID=${node.id})`);

            try {
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

                const result = await node.pool.query(
                    `UPDATE records SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
                    values
                );

                if (result.rowCount === 0) {
                    console.log(`[WARN] Record ${id} not found on node ${nodeId}`);
                    return;
                }

                successCount++;
                successNodes.push(nodeId);
                console.log(`[SUCCESS] UPDATE completed on replica ${nodeId}`);
            } catch (err) {
                console.log(`[ERROR] PostgreSQL UPDATE failed on node ${nodeId}: ${err}`);
            }
        });

        await Promise.all(updatePromises);

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

        console.log(`[SUCCESS] UPDATE completed - ID: ${id} updated on ${successCount}/${replicaNodeIds.length} replicas`);
        this.vectorClock.increment(primaryNodeId);

        const duration = Date.now() - startTime;
        console.log(`[INFO] UPDATE request completed in ${duration}ms`);
        console.log('========== [UPDATE] Request Finished ==========');

        res.status(200).json({
            status: 'ok',
            id,
            updated_at: now,
            replicas: successNodes,
            success_count: successCount,
            quorum,
            record_clock: existingClock,
            global_clock: this.vectorClock.copy()
        });
    }
}

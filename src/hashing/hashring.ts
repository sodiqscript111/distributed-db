import * as crc32 from 'crc-32';

export class HashRing {
    private nodes: Map<number, string>;
    private keys: number[];
    private replicas: number;

    constructor(replicas: number) {
        this.nodes = new Map<number, string>();
        this.keys = [];
        this.replicas = replicas;
    }

    addNode(nodeId: string): void {
        for (let i = 0; i < this.replicas; i++) {
            const hash = crc32.str(`${i}${nodeId}`) >>> 0;

            if (this.nodes.has(hash)) {
                console.log(`[WARN] Hash collision at ${hash} for virtual node ${i} of ${nodeId}, skipping`);
                continue;
            }

            this.nodes.set(hash, nodeId);
            this.keys.push(hash);
        }
        this.keys.sort((a, b) => a - b);
    }

    removeNode(nodeId: string): void {
        const hashesToRemove = new Set<number>();

        for (const [hash, id] of this.nodes) {
            if (id === nodeId) {
                hashesToRemove.add(hash);
            }
        }

        for (const hash of hashesToRemove) {
            this.nodes.delete(hash);
        }

        this.keys = this.keys.filter(k => !hashesToRemove.has(k));
    }

    getNode(key: string): string {
        if (this.keys.length === 0) {
            return '';
        }

        const hash = crc32.str(key) >>> 0;
        let idx = this.binarySearch(hash);

        if (idx === this.keys.length) {
            idx = 0;
        }

        return this.nodes.get(this.keys[idx]) || '';
    }

    getNodes(key: string, count: number): string[] {
        if (this.keys.length === 0) {
            return [];
        }

        const hash = crc32.str(key) >>> 0;
        let idx = this.binarySearch(hash);

        if (idx === this.keys.length) {
            idx = 0;
        }

        const seen = new Set<string>();
        const result: string[] = [];

        for (let i = 0; i < this.keys.length && result.length < count; i++) {
            const nodeIdx = (idx + i) % this.keys.length;
            const nodeId = this.nodes.get(this.keys[nodeIdx]);

            if (nodeId && !seen.has(nodeId)) {
                seen.add(nodeId);
                result.push(nodeId);
            }
        }

        return result;
    }

    getUniqueNodeCount(): number {
        return new Set(this.nodes.values()).size;
    }

    private binarySearch(hash: number): number {
        let left = 0;
        let right = this.keys.length;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (this.keys[mid] >= hash) {
                right = mid;
            } else {
                left = mid + 1;
            }
        }

        return left;
    }
}

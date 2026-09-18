export class VectorClock {
    private clock: Map<string, number>;

    constructor() {
        this.clock = new Map<string, number>();
    }

    increment(nodeId: string): void {
        const current = this.clock.get(nodeId) || 0;
        this.clock.set(nodeId, current + 1);
    }

    merge(other: VectorClock): void {
        for (const [nodeId, timestamp] of other.clock) {
            const current = this.clock.get(nodeId) || 0;
            if (timestamp > current) {
                this.clock.set(nodeId, timestamp);
            }
        }
    }

    compare(other: VectorClock): number {
        let less = false;
        let greater = false;

        for (const [nodeId, ts] of this.clock) {
            const otherTs = other.clock.get(nodeId) || 0;
            if (ts < otherTs) {
                less = true;
            } else if (ts > otherTs) {
                greater = true;
            }
        }

        for (const [nodeId, otherTs] of other.clock) {
            if (!this.clock.has(nodeId) && otherTs > 0) {
                less = true;
            }
        }

        if (less && !greater) return -1;
        if (greater && !less) return 1;
        return 0;
    }

    copy(): Record<string, number> {
        const result: Record<string, number> = {};
        for (const [key, value] of this.clock) {
            result[key] = value;
        }
        return result;
    }

    get(nodeId: string): number {
        return this.clock.get(nodeId) || 0;
    }

    set(nodeId: string, timestamp: number): void {
        this.clock.set(nodeId, timestamp);
    }

    isEqual(other: VectorClock): boolean {
        if (this.clock.size !== other.clock.size) return false;
        for (const [nodeId, ts] of this.clock) {
            if (other.clock.get(nodeId) !== ts) return false;
        }
        return true;
    }

    isConcurrent(other: VectorClock): boolean {
        return this.compare(other) === 0 && !this.isEqual(other);
    }

    static fromObject(obj: Record<string, number>): VectorClock {
        const vc = new VectorClock();
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            for (const [key, value] of Object.entries(obj)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    vc.set(key, value);
                }
            }
        }
        return vc;
    }
}

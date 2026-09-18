import { describe, it, expect } from 'vitest';
import { VectorClock } from '../src/versioning/vectorclock';
import { HashRing } from '../src/hashing/hashring';
import { validateConfig, Config } from '../src/types/config';

describe('VectorClock Unit Tests', () => {
    it('initializes and increments correctly', () => {
        const vc = new VectorClock();
        expect(vc.get('node-0')).toBe(0);
        vc.increment('node-0');
        expect(vc.get('node-0')).toBe(1);
        vc.increment('node-0');
        expect(vc.get('node-0')).toBe(2);
        vc.increment('node-1');
        expect(vc.get('node-1')).toBe(1);
    });

    it('merges clocks taking maximum per node', () => {
        const vc1 = VectorClock.fromObject({ 'node-0': 2, 'node-1': 1 });
        const vc2 = VectorClock.fromObject({ 'node-0': 1, 'node-1': 3, 'node-2': 5 });
        vc1.merge(vc2);

        expect(vc1.get('node-0')).toBe(2);
        expect(vc1.get('node-1')).toBe(3);
        expect(vc1.get('node-2')).toBe(5);
    });

    it('correctly compares dominant, dominated, and concurrent clocks', () => {
        const c1 = VectorClock.fromObject({ 'node-0': 2, 'node-1': 2 });
        const c2 = VectorClock.fromObject({ 'node-0': 1, 'node-1': 1 });
        expect(c1.compare(c2)).toBe(1);
        expect(c2.compare(c1)).toBe(-1);

        const concurrentA = VectorClock.fromObject({ 'node-0': 2, 'node-1': 1 });
        const concurrentB = VectorClock.fromObject({ 'node-0': 1, 'node-1': 2 });
        expect(concurrentA.compare(concurrentB)).toBe(0);
        expect(concurrentA.isConcurrent(concurrentB)).toBe(true);

        const equalA = VectorClock.fromObject({ 'node-0': 2, 'node-1': 2 });
        const equalB = VectorClock.fromObject({ 'node-0': 2, 'node-1': 2 });
        expect(equalA.compare(equalB)).toBe(0);
        expect(equalA.isEqual(equalB)).toBe(true);
        expect(equalA.isConcurrent(equalB)).toBe(false);
    });

    it('safely handles malformed objects in fromObject', () => {
        const vc = VectorClock.fromObject({ 'node-0': 1, 'node-1': NaN, 'node-2': -5 as any });
        expect(vc.get('node-0')).toBe(1);
        expect(vc.get('node-1')).toBe(0);
        expect(vc.get('node-2')).toBe(-5);
    });
});

describe('HashRing Unit Tests', () => {
    it('deterministically maps keys to virtual node replicas', () => {
        const ring = new HashRing(50);
        ring.addNode('node-0');
        ring.addNode('node-1');
        ring.addNode('node-2');

        expect(ring.getUniqueNodeCount()).toBe(3);

        const key = '550e8400-e29b-41d4-a716-446655440000';
        const nodes1 = ring.getNodes(key, 2);
        const nodes2 = ring.getNodes(key, 2);

        expect(nodes1).toHaveLength(2);
        expect(nodes1).toEqual(nodes2);
        expect(nodes1[0]).not.toEqual(nodes1[1]);
    });

    it('handles wrap-around correctly', () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');
        ring.addNode('node-1');

        const nodes = ring.getNodes('some-arbitrary-key', 2);
        expect(nodes).toHaveLength(2);
        expect(new Set(nodes).size).toBe(2);
    });

    it('removes node properly', () => {
        const ring = new HashRing(10);
        ring.addNode('node-0');
        ring.addNode('node-1');
        expect(ring.getUniqueNodeCount()).toBe(2);

        ring.removeNode('node-0');
        expect(ring.getUniqueNodeCount()).toBe(1);
        const nodes = ring.getNodes('test-key', 2);
        expect(nodes).toEqual(['node-1']);
    });
});

describe('Config Validation Unit Tests', () => {
    const validConfig: Config = {
        server: { port: 8080 },
        replication: { factor: 2, hash_ring_replicas: 50 },
        aws: { region: 'us-east-1', secret_name: 'test' }
    };

    it('accepts valid config', () => {
        expect(() => validateConfig(validConfig)).not.toThrow();
    });

    it('rejects invalid port', () => {
        const invalid = { ...validConfig, server: { port: 99999 } };
        expect(() => validateConfig(invalid)).toThrow(/Invalid server port/);
    });

    it('rejects invalid replication factor', () => {
        const invalid = { ...validConfig, replication: { factor: 0, hash_ring_replicas: 50 } };
        expect(() => validateConfig(invalid)).toThrow(/Invalid replication factor/);
    });
});

export interface ServerConfig {
  port: number;
}

export interface PostgresConfig {
  nodes: string[];
}

export interface ReplicationConfig {
  factor: number;
  hash_ring_replicas: number;
}

export interface Config {
  server: ServerConfig;
  postgres: PostgresConfig;
  replication: ReplicationConfig;
}

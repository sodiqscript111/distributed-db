export interface ServerConfig {
  port: number;
}

export interface ReplicationConfig {
  factor: number;
  hash_ring_replicas: number;
}

export interface DatabaseConfig {
  local_nodes?: string[];
}

export interface AwsConfig {
  enabled?: boolean;
  region: string;
  secret_name: string;
}

export interface Config {
  server: ServerConfig;
  replication: ReplicationConfig;
  database?: DatabaseConfig;
  aws: AwsConfig;
}

export function validateConfig(cfg: Config): void {
  if (!cfg.server || typeof cfg.server.port !== 'number' || cfg.server.port < 1 || cfg.server.port > 65535) {
    throw new Error(`Invalid server port: ${cfg.server?.port}. Must be between 1 and 65535.`);
  }

  if (!cfg.replication || typeof cfg.replication.factor !== 'number' || cfg.replication.factor < 1) {
    throw new Error(`Invalid replication factor: ${cfg.replication?.factor}. Must be >= 1.`);
  }

  if (typeof cfg.replication.hash_ring_replicas !== 'number' || cfg.replication.hash_ring_replicas < 1) {
    throw new Error(`Invalid hash_ring_replicas: ${cfg.replication?.hash_ring_replicas}. Must be >= 1.`);
  }
}


export interface ServerConfig {
  port: number;
}

export interface ReplicationConfig {
  factor: number;
  hash_ring_replicas: number;
}

export interface AwsConfig {
  region: string;
  secret_name: string;
}

export interface Config {
  server: ServerConfig;
  replication: ReplicationConfig;
  aws: AwsConfig;
}

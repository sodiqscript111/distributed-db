# Distributed Database Layer

A distributed database system built with TypeScript and PostgreSQL, featuring consistent hashing, vector clocks for versioning, and quorum-based replication.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Express API                         │
├─────────────────────────────────────────────────────────┤
│  Hash Ring          │  Vector Clock    │  Handler       │
│  (CRC32)            │  (Versioning)    │  (CRUD + Quorum)│
├─────────────────────────────────────────────────────────┤
│     PostgreSQL 1    │  PostgreSQL 2    │  PostgreSQL 3  │
└─────────────────────────────────────────────────────────┘
```

## Features

- **Consistent Hashing** - CRC32-based hash ring for deterministic data distribution
- **Vector Clocks** - Conflict detection and causal ordering of events
- **Quorum Replication** - Write succeeds only when majority of replicas confirm
- **Automatic Failover** - Reads try multiple replicas on failure

## Quick Start

```bash
# Start PostgreSQL instances
docker compose up -d

# Install dependencies
npm install

# Run the server
npm run dev
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/db` | Create record |
| GET | `/db/:id` | Get record by ID |
| PUT | `/db/:id` | Update record |

### Example

```bash
# Create
curl -X POST http://localhost:8080/db \
  -H "Content-Type: application/json" \
  -d '{"name": "John", "email": "john@example.com"}'

# Read
curl http://localhost:8080/db/{id}

# Update
curl -X PUT http://localhost:8080/db/{id} \
  -H "Content-Type: application/json" \
  -d '{"name": "John Updated"}'
```

## Configuration

```toml
[server]
port = 8080

[postgres]
nodes = ["postgres://...@localhost:5432/db1", "..."]

[replication]
factor = 2              # Number of replicas per record
hash_ring_replicas = 50 # Virtual nodes per physical node
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL
- **Hashing**: CRC-32

# Distributed Database Layer

A distributed database system built with TypeScript, Node.js, Express, and PostgreSQL. It implements consistent hashing, vector clocks, quorum-based replication, concurrent read safety, and optimistic concurrency control — all at the application layer on top of standard PostgreSQL instances.

---

## Architecture

```
                         ┌─────────────────────────────────┐
                         │           Express API            │
                         │  POST /db  GET /db/:id          │
                         │  PUT /db/:id  DELETE /db/:id    │
                         │  GET /health                     │
                         └────────────────┬────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
   ┌──────────▼─────────┐    ┌───────────▼──────────┐    ┌──────────▼─────────┐
   │    Hash Ring        │    │    Vector Clock       │    │   Quorum Logic     │
   │  CRC32 consistent   │    │  Per-record version   │    │  W > N/2 to succeed│
   │  hashing with 50    │    │  stamps, conflict     │    │  Parallel writes   │
   │  virtual nodes each │    │  detection & OCC      │    │  to all replicas   │
   └──────────┬──────────┘    └───────────────────────┘    └────────────────────┘
              │
   ┌──────────▼──────────────────────────────────────┐
   │                  PostgreSQL Nodes                │
   │   node-0 (us-east-1)  node-1 (af-south-1)       │
   │   node-2 (eu-west-1)                             │
   └─────────────────────────────────────────────────┘
```

---

## How It Works

### 1. Consistent Hashing (Hash Ring)

When a record is written or read, the system needs to know which database nodes are responsible for it. Rather than keeping a central lookup table (which is a single point of failure), it uses a **consistent hash ring**:

- Every database node is placed at 50 positions around a virtual ring using CRC32 hashing
- When a key (record ID) comes in, its CRC32 hash is computed and the ring is walked clockwise to find the nearest node
- The next N unique nodes around the ring become the **replica set** for that record

This means:
- The same record ID always maps to the same nodes, deterministically, without any central coordinator
- Adding or removing a node only remaps a fraction of records, not everything
- Load is distributed evenly across nodes

### 2. Vector Clocks (Per-Record Versioning)

Every record carries a `vector_clock` — a map of `{ nodeId: counter }` — stored alongside the data in PostgreSQL. This is updated on every write:

```json
{ "node-0": 1 }           ← after first write
{ "node-0": 2 }           ← after first update
{ "node-0": 3 }           ← after second update via node-0
```

Vector clocks serve two purposes:

**Conflict resolution on reads:** When a GET queries multiple replicas in parallel, they may have slightly different versions of the same record (due to async replication lag). The vector clock is used to compare them and return the most recent version. If two replicas have concurrent (incompatible) clocks, `updated_at` is used as a tiebreaker.

**Optimistic Concurrency Control on writes:** When a client sends an update, it includes the `record_clock` it received from its last GET. The server compares this against the current clock in the database. If the database clock has advanced (meaning someone else updated the record in the meantime), the server rejects the write with a `409 Conflict`. The client must re-read the latest version before retrying.

### 3. Quorum Replication

Writes are sent to all replica nodes in parallel. A write is only considered successful if a **quorum** (majority) of replicas confirm it:

```
quorum = floor(replication_factor / 2) + 1
```

With a replication factor of 2:
- Both replicas must succeed (quorum = 2)

With a replication factor of 3:
- At least 2 out of 3 must succeed (quorum = 2)

If quorum is not reached, the API returns `500 quorum not reached`. This ensures the system does not silently accept partial writes.

### 4. Concurrent Read Safety (`SELECT FOR SHARE`)

PostgreSQL's default MVCC engine already allows unlimited concurrent reads with no blocking. However, without explicit locking, a reader can observe a record mid-way through a multi-replica write — seeing stale or partially-applied data.

To prevent this, every GET wraps its database query in a short transaction using `SELECT FOR SHARE`:

- Multiple concurrent `FOR SHARE` readers on the same record never block each other
- A `FOR UPDATE` write waits until all active `FOR SHARE` readers have committed before it can proceed
- This guarantees that every reader sees a fully-committed, consistent snapshot

```
Reader 1:  BEGIN → SELECT FOR SHARE → COMMIT  ✅
Reader 2:  BEGIN → SELECT FOR SHARE → COMMIT  ✅  (runs simultaneously ✅)
Writer:            UPDATE → waits... ──────────────────── writes ✅
```

### 5. Optimistic Concurrency Control (OCC)

The lost update problem occurs when two clients read the same record, then both try to update it based on their stale copy — the second write silently overwrites the first:

```
User A reads  → { name: "John", record_clock: { "node-0": 3 } }
User B reads  → { name: "John", record_clock: { "node-0": 3 } }
User B writes → { name: "Jane" } with clock { "node-0": 3 } → ✅ succeeds (clock → 4)
User A writes → { name: "Bob"  } with clock { "node-0": 3 } → ❌ 409 Conflict
                                                                    (clock is now 4, not 3)
```

User A must re-read the record, see that it was already changed to "Jane", and decide what to do — rather than silently overwriting it.

`record_clock` is optional in the PUT body. If omitted, no conflict check is performed.

---

## API Reference

### `POST /db` — Create a record

**Request**
```json
{
  "name": "John Doe",
  "email": "john@example.com"
}
```

**Response `201`**
```json
{
  "status": "ok",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "John Doe",
  "email": "john@example.com",
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z",
  "replicas": ["node-0", "node-1"],
  "success_count": 2,
  "quorum": 2,
  "record_clock": { "node-0": 1 }
}
```

---

### `GET /db/:id` — Read a record

**Response `200`**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "John Doe",
  "email": "john@example.com",
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z",
  "node": "node-0",
  "replicas": ["node-0", "node-1"],
  "record_clock": { "node-0": 1 }
}
```

> Save `record_clock` from the response. You will need it to perform a conflict-safe update.

---

### `PUT /db/:id` — Update a record

**Request** (include `record_clock` from your last GET for conflict detection)
```json
{
  "name": "Jane Doe",
  "record_clock": { "node-0": 1 }
}
```

**Response `200`**
```json
{
  "status": "ok",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "updated_at": "2024-01-01T00:01:00.000Z",
  "replicas": ["node-0", "node-1"],
  "success_count": 2,
  "quorum": 2,
  "record_clock": { "node-0": 2 }
}
```

**Response `409 Conflict`** — record was modified by another writer since your last read
```json
{
  "error": "conflict: record was modified since you last read it",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "current_clock": { "node-0": 2 }
}
```

---

### `DELETE /db/:id` — Delete a record

**Response `200`**
```json
{
  "status": "ok",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "replicas": ["node-0", "node-1"],
  "success_count": 2,
  "quorum": 2
}
```

---

### `GET /health` — Node health check

**Response `200`**
```json
{
  "status": "healthy",
  "nodes": {
    "node-0": "healthy",
    "node-1": "healthy",
    "node-2": "healthy"
  },
  "total_nodes": 3,
  "ring_nodes": 3
}
```

---

## Quick Start (Local)

```bash
# Start three PostgreSQL instances
docker compose up -d

# Install dependencies
npm install

# Run the server
npm run dev
```

The server starts on port `8080`.

---

## Automated Testing (Testcontainers)

The test suite uses **Testcontainers** to dynamically spin up 3 isolated PostgreSQL instances in Docker, running full integration tests for CRUD, hash ring mapping, concurrent reads (`SELECT FOR SHARE`), optimistic concurrency control (OCC 409 conflict), and node failure quorum degradation.

```bash
# Run all integration tests
npm test
```

---

## Configuration

`config.toml` controls non-sensitive settings. Database credentials and node connection strings are fetched from AWS Secrets Manager at startup.

```toml
[server]
port = 8080

[replication]
factor = 2
hash_ring_replicas = 50

[aws]
region = "us-east-1"
secret_name = "distributed-db/db-credentials"
```

Environment variables `AWS_REGION` and `SECRET_NAME` override the config file values.

The secret stored in AWS Secrets Manager must have this shape:

```json
{
  "username": "postgres",
  "password": "...",
  "nodes": [
    "postgres://postgres:...@node-0-host:5432/distributed_db",
    "postgres://postgres:...@node-1-host:5432/distributed_db",
    "postgres://postgres:...@node-2-host:5432/distributed_db"
  ]
}
```

---

## Multi-Region AWS Deployment

The `terraform/` directory provisions three independent RDS PostgreSQL instances across three AWS regions, connected via full-mesh VPC peering:

| Node | Region | AWS Code |
|------|--------|----------|
| node-0 | United States (N. Virginia) | `us-east-1` |
| node-1 | Africa (Cape Town) | `af-south-1` |
| node-2 | Europe (Ireland) | `eu-west-1` |

Each node is a `db.r6g.large` (Graviton2) instance with:
- Multi-AZ enabled
- gp3 encrypted storage with autoscaling (100 GB → 500 GB)
- Enhanced monitoring and Performance Insights
- Deletion protection and automated backups (7 days)

```bash
cd terraform
terraform init
terraform apply \
  -var="db_password=YourStrongPassword!" \
  -var='allowed_cidr_blocks=["YOUR_APP_SERVER_IP/32"]'
```

> `af-south-1` must be opted in under AWS Account Settings before applying.

---

## Edge Cases Fixed

The following issues were identified and resolved during a full code review:

### Security

**Credentials leaked in API responses** — The original code used full PostgreSQL connection strings (including username and password) as node map keys, which were then returned in every API response. Fixed by using opaque identifiers (`node-0`, `node-1`, `node-2`) as keys throughout, keeping credentials exclusively in AWS Secrets Manager.

### Correctness

**Race condition on updates (TOCTOU)** — The original update handler read the vector clock in one query and wrote it back in a separate query with no locking between them. Two concurrent updates to the same record would both read the same clock value and one would silently overwrite the other. Fixed by wrapping the read and write inside a single PostgreSQL transaction using `SELECT ... FOR UPDATE`, which holds an exclusive row lock for the duration.

**Vector clock reset when primary is down** — If the primary node was unreachable during an update, the original code silently caught the error and continued with an empty clock (`{}`), erasing the record's entire version history. Fixed by returning a `503` error immediately when the primary cannot be reached rather than proceeding with corrupt state.

**No read quorum — stale reads** — The original `GET` handler queried replicas sequentially and returned the first successful result, which could be a stale replica. Fixed by querying all replicas in parallel and selecting the result with the most advanced vector clock. `updated_at` is used as a tiebreaker when clocks are concurrent.

**Dirty reads during writes** — A reader could observe a record mid-way through a multi-replica write, seeing a mix of old and new data. Fixed by wrapping all `GET` replica queries in `BEGIN / SELECT FOR SHARE / COMMIT` transactions, which guarantee a consistent committed snapshot and cause writes to wait until all active readers have finished.

**Lost updates (concurrent writers)** — Two clients reading and then both updating the same record would result in the second write silently overwriting the first. Fixed by implementing Optimistic Concurrency Control: clients include the `record_clock` from their last `GET` in their `PUT` request. If the database clock has advanced since the client's read, the update is rejected with `409 Conflict`.

### Reliability

**Hash ring collisions** — CRC32 can produce the same hash for different virtual node inputs. The original code silently overwrote colliding entries, biasing load distribution toward certain nodes. Fixed by skipping duplicate hash positions with a warning log.

**No `removeNode` method** — Once a node was added to the hash ring there was no way to remove it, meaning permanently failed nodes would continue to receive requests and cause repeated timeouts. Fixed by adding `removeNode()` to evict all virtual nodes for a given physical node.

**No Express error middleware** — Unhandled exceptions in route handlers would cause raw stack traces to be returned to clients or crash the process. Fixed by adding a standard Express error middleware that returns a clean `500` response.

**No graceful shutdown** — On SIGTERM or SIGINT, the process would exit immediately, potentially abandoning in-flight queries and leaving replicas in an inconsistent state. Fixed by closing the HTTP server and draining all PostgreSQL connection pools before exiting, with a 10-second hard timeout.

### Data Integrity

**`rowCount` may be `null`** — In newer versions of the `pg` library, `rowCount` is typed as `number | null`. The original code compared it directly to `0`, which would not catch `null`. Fixed by using `result.rowCount ?? 0` throughout.

**Update with empty body still executed** — Sending a `PUT` with no `name` or `email` would execute a query that only updated `updated_at` and incremented the vector clock, wasting resources and polluting version history. Fixed by returning `400` when no updatable fields are present.

**"Quorum not reached" vs "record not found"** — When a record did not exist on any node, the update handler returned `500 quorum not reached`, giving the client no way to distinguish between a missing record and a node outage. Fixed by detecting zero-row results and returning `404 record not found`.

### Infrastructure

**No connection pool tuning** — The default `pg.Pool` configuration uses a maximum of 10 connections. Under load this pool is quickly exhausted. Fixed by setting pool limits per node (`max: 20`) with connection and idle timeouts.

**Hardcoded relative config path** — The original `loadConfig('config.toml')` was relative to the process's working directory, which fails when the server is started from any other directory. Fixed by resolving the path relative to the project root, with `CONFIG_PATH` environment variable override support.

**Docker data not persisted** — The original `docker-compose.yml` had no named volumes, so all data was lost every time containers were stopped. Fixed by adding named volumes for each PostgreSQL service along with healthchecks and restart policies.

**No health check endpoint** — Without a `/health` endpoint, container orchestrators have no way to know if the service is ready or degraded. Fixed by adding `GET /health` which pings all node pools and reports their status.

**No DELETE endpoint** — The API had no way to remove records. Fixed by adding `DELETE /db/:id` with full quorum checks.

---

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL 16
- **Hashing**: CRC-32 (consistent hash ring)
- **Infrastructure**: Terraform + AWS RDS + AWS Secrets Manager + VPC Peering

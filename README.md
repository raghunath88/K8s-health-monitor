# k8s-health-monitor

A **zero-external-dependency** Node.js health monitoring system for Kubernetes clusters. Workers collect metrics using only built-in Node.js APIs, pod masters aggregate them, a cluster aggregator service polls all pods, and a React dashboard renders real-time views.

---

## Architecture

### Cluster Architecture

![Cluster Architecture](docs/k8s_health_monitor_cluster_architecture.svg)

Three-layer structure:

- **Cluster aggregator** — polls all pods via Kubernetes DNS, exposes `GET /cluster-health`
- **Pod layer (Pod A / Pod B)** — each pod runs a master process that merges its workers and exposes `GET /pod-health`
- **Worker processes** — collect raw metrics using built-in Node.js APIs (`perf_hooks`, `async_hooks`, `process`, `os`)

### Data Flow

![Data Flow](docs/k8s_health_monitor_data_flow.svg)

```
Worker process
  │  metrics object
  ▼
Pod master process        ──►  K8s probes  (/live · /ready)
  │  HTTP GET /pod-health
  ▼
Cluster aggregator service  ◄──  Bearer token auth
  │  unified JSON response
  ▼
React dashboard  (cluster · pod · worker views · alerts)
```

---

## Components

| Component | Role | Endpoints |
|---|---|---|
| **Worker** | Collects CPU, memory, event-loop lag, async task count | — (internal IPC) |
| **Pod master** | Merges worker metrics, handles K8s probes | `GET /pod-health` · `/live` · `/ready` |
| **Cluster aggregator** | Polls all pods via K8s DNS, unifies cluster state | `GET /cluster-health` |
| **React dashboard** | Real-time cluster / pod / worker views, alerting | — (consumer) |

---

## Built-in Node.js APIs used

- `perf_hooks` — performance timing & event-loop lag
- `async_hooks` — async task tracking
- `process` — CPU usage, memory (`process.memoryUsage()`), uptime
- `os` — system-level CPU and memory info

**No npm packages required for metric collection.**

---

## Security

All health endpoints are protected with **Bearer token authentication**. The cluster aggregator attaches the token when polling pod endpoints; the React dashboard must supply the same token when querying `/cluster-health`.

---

## Kubernetes integration

- Pod discovery via **K8s DNS** — the aggregator resolves pod addresses automatically
- **Liveness probe** → `GET /live`
- **Readiness probe** → `GET /ready`
- Supports **horizontal pod autoscaling** and **rolling updates** via the service discovery layer

---

## Diagrams

Both architecture diagrams are interactive SVGs located in [`docs/`](docs/):

| File | Description |
|---|---|
| [`k8s_health_monitor_cluster_architecture.svg`](docs/k8s_health_monitor_cluster_architecture.svg) | Full three-layer cluster structure |
| [`k8s_health_monitor_data_flow.svg`](docs/k8s_health_monitor_data_flow.svg) | Step-by-step metric data flow |

---

## License

MIT

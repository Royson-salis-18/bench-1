# bench-1 (ShopFlow) -- command reference

Every command used to build, run, break, observe and debug this test bench, in the order you need them.
Subject: **shopflow** (gateway `http://<ip>:8080`). Repo: `https://github.com/Royson-salis-18/bench-1`.

## 1. Create the EC2 instance (AWS console)

| Setting | Value |
|---|---|
| AMI | Ubuntu Server 24.04 LTS |
| Type | `c7i-flex.large` (2 vCPU, 4 GiB) -- one bench needs ~0.6 GiB of containers; `t3.micro` is too small |
| Disk | 20 GiB gp3 |
| Key pair | create/download once (`.pem`); AWS cannot re-download it -- keep a copy |
| Security group inbound | TCP **22** from *My IP*, TCP **8080** from *My IP* (or your demo audience). Nothing else. |

## 2. Connect from your laptop (Windows PowerShell / cmd)

```
ssh -i "C:\Users\<you>\Downloads\<key>.pem" ubuntu@<instance-public-ip>
```
Use the **full path** to the key. "Permission denied (publickey)" = wrong key path or wrong user (`ubuntu` on Ubuntu, `ec2-user` on Amazon Linux).

## 3. Install and start the whole bench (one command, on the instance)

```
curl -fsSL https://raw.githubusercontent.com/Royson-salis-18/bench-1/main/bootstrap/ec2-setup.sh | bash
```
Installs Docker/git/make, clones the repo to `~/bench`, builds the images and runs `make bench` (application + traffic generator + Prometheus/Grafana/Loki/Promtail/docker-exporter). First run takes a few minutes. Log out and back in once so the `docker` group applies.

Options (environment variables before `bash`): `DEST=/path` (clone location), `BRANCH=main`, `GRAFANA_PASSWORD=...`, `DRY_RUN=1` (print only).

### Re-install / update to the latest repo
```
cd ~
sudo docker rm -f $(sudo docker ps -aq) 2>/dev/null
sudo rm -rf ~/bench
curl -fsSL https://raw.githubusercontent.com/Royson-salis-18/bench-1/main/bootstrap/ec2-setup.sh | bash
```
Quicker update without wiping: `cd ~/bench && git fetch --depth 1 origin main && git reset --hard FETCH_HEAD && cd shopflow && sudo make down && sudo make bench`.
If apt says *"Could not get lock ... unattended-upgr"*, wait: `while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 5; done`.

## 4. Day-to-day (`cd ~/bench/shopflow`)

| Command | What it does |
|---|---|
| `sudo make bench` | app + traffic + observability |
| `sudo make up` | app only (healthy baseline) |
| `sudo make test` | start if needed and run the API tests |
| `sudo make ps` | container status |
| `sudo make logs SVC=<service>` | follow one service's logs |
| `sudo make urls` | where to look |
| `sudo make down` | stop everything and delete volumes (databases re-seed next start) |
| `sudo make traffic-off` | stop the always-on traffic generator -- gateway goes quiet, only your own requests remain |
| `sudo make traffic-on` | start it again |
| `sudo make obs-up` / `obs-down` | observability only |
| `sudo make scenarios` | list production-issue scenarios |

`make scenario` and `make bench` start the traffic generator again -- run `traffic-off` afterwards if you want a quiet system.

## 5. Break it on purpose (scenarios)

```
cd ~/bench/shopflow
sudo make scenarios                              # ids
sudo make scenario SCEN=sf-04-retry-storm     # apply one production condition
```
One command that applies a scenario, drives the load that triggers it, probes the symptoms, prints the **expected result** from `scenario.yaml` next to what happened, then resets (output also saved to `~/bench-results/`):
```
cd ~/bench
lab/bench-scenario.sh shopflow sf-04-retry-storm 60          # 60 s of load
KEEP=1 lab/bench-scenario.sh shopflow sf-04-retry-storm      # leave the scenario applied afterwards
```
Back to healthy: `sudo make scenario SCEN=sf-00-baseline`.
Full list with ground truth: [docs/SCENARIO-CATALOG.md](SCENARIO-CATALOG.md).

## 6. Drive traffic by hand

Quiet the bench, then use the **storefront** at `http://<instance-ip>:8080/` like a customer (browse, add to cart, check out, My orders; the live request log at the bottom shows each call; *Autopilot* browses for you):
```
cd ~/bench/shopflow && sudo make traffic-off
```
Or with curl:
```
curl -s "http://localhost:8080/api/catalog/products?limit=3"
curl -s -X POST localhost:8080/api/cart/me/items -H 'content-type: application/json' -d '{"productId":1,"qty":1,"priceCents":537}'
curl -s localhost:8080/api/cart/me
curl -s -X POST localhost:8080/api/checkout -H 'content-type: application/json' -d '{"userId":"me","email":"me@example.test"}'
curl -s "localhost:8080/api/orders?userId=me"
```

Load generator directly (from the app directory):
```
sudo make load                                   # 20 users, 60 s
sudo docker run --rm --network shopflow_default shopflow/traffic:dev node loadgen/loadgen.mjs --base http://api-gateway:8080 --concurrency 20 --duration 30
# organic visitor sessions (think times, popular items, day/night wave) -- the always-on default:
#   add --continuous --organic        flat mix: omit --organic
```
Background-traffic tuning (env vars read by compose): `TRAFFIC_MODE=steady|organic`, `TRAFFIC_CONCURRENCY=12`, `TRAFFIC_THINK_MS=1500`.

## 6b. Break any service and watch the cascade

```
cd ~/bench
lab/chaos.sh shopflow list
lab/chaos.sh shopflow predict catalog-db
lab/chaos.sh shopflow run catalog-db pause 40
lab/chaos.sh shopflow heal
```
Staged organic cascade starting in orders (about 3 minutes, real load):
```
cd ~/bench && sudo lab/cascade.sh shopflow orders
```
Faults: stop, pause, cpu, net, crash, flap. Full guide and experiments: [CHAOS.md](CHAOS.md).

## 7. Observability (Grafana / Prometheus / Loki)

All monitoring listens on `127.0.0.1` of the instance only. From your laptop open a tunnel (leave it running):
```
ssh -i "C:\Users\<you>\Downloads\<key>.pem" -L 3000:localhost:3000 -L 9090:localhost:9090 ubuntu@<instance-public-ip>
```
Then: Grafana `http://localhost:3000` (admin / `bench`, anonymous viewing on; dashboard "test bench"), Prometheus `http://localhost:9090`.
Loki is queried through Grafana (Explore -> Loki, `{service="<name>"}`). A small `grafana-viewer` container keeps Grafana -> Prometheus/Loki connections alive so they appear in the mapper.

## 8. Point the mapper at it

Mapper UI -> *Add Project*: Target ID `shopflow`, Host `<instance-public-ip>`, SSH user `ubuntu`, your `.pem` key.
The mapper discovers declared dependencies from the merged compose file at `~/bench/shopflow/.rendered/docker-compose.yml`, observed connections from `/proc/net/tcp` inside containers, and metrics from `docker stats` / the gateway access log / Prometheus.

## 9. Debugging on the instance

```
sudo docker ps                                   # what is running / healthy
sudo docker ps -a                                # including stopped/crashed
sudo docker logs --tail 50 <container>           # e.g. shopflow-orders-1
sudo docker stats --no-stream                    # CPU / memory per container
sudo docker exec -it <container> sh              # shell inside
sudo docker compose -f ~/bench/shopflow/.rendered/docker-compose.yml ps
curl -s http://localhost:8080/healthz          # gateway health
free -h; df -h /                                 # memory / disk
```

## 10. Common problems

| Symptom | Cause / fix |
|---|---|
| `404 Not Found` from nginx at `/` (shopflow) | old clone without the storefront -> re-install (section 3) |
| `No rule to make target 'traffic-off'` / `'bench'` | you are in an old clone, or the wrong folder -> update (section 3), `cd ~/bench/shopflow` |
| Page does not load from your laptop | security group lacks TCP 8080 from your IP |
| `Permission denied (publickey)` | wrong key path or user |
| `rm: cannot remove ... .rendered/...: Permission denied` | files created by `sudo` -> `sudo rm -rf ~/bench` |
| Mapper shows no links for Grafana/Loki | idle Grafana opens no connections -> `sudo make obs-up` (starts `grafana-viewer`) |
| Mapper links red | stop traffic (`make traffic-off`), wait ~30 s; if still red a service is unhealthy (`sudo docker ps`) |
| Out of memory | use >= 4 GiB; swap is added automatically below 3 GiB |

## 11. Security hygiene

* Keep SSH (22) and the app port restricted to *My IP* when not demoing.
* The `.pem` never goes in GitHub; copy it between machines securely and rotate it if it was ever shared.
* Stop/terminate the instance when done to avoid charges.

# Scenario catalogue

Generated from each `scenario.yaml`; open one for why review/tests pass, the production condition, the load that triggers it, what a mapper should see, its blind spots and the fix.

| Scenario | What happens | Class | Verified | True root cause |
|---|---|---|---|---|
| [`sf-00-baseline`](shopflow/scenarios/sf-00-baseline/scenario.yaml) | Healthy baseline (control group) | control | — | — |
| [`sf-01-missing-index`](shopflow/scenarios/sf-01-missing-index/scenario.yaml) | Order history is fast in staging, melts the database in production | capacity / data volume | local-process | orders-db |
| [`sf-02-cache-thrash`](shopflow/scenarios/sf-02-cache-thrash/scenario.yaml) | Cache sized for staging evicts itself in production | capacity / infrastructure sizing | local-process | catalog-cache |
| [`sf-03-unbounded-cache`](shopflow/scenarios/sf-03-unbounded-cache/scenario.yaml) | Memory climbs for an hour, then the container is OOM-killed | resource leak (configuration-induced) | docker + local-process | cart |
| [`sf-04-retry-storm`](shopflow/scenarios/sf-04-retry-storm/scenario.yaml) | A third party throttles us; our own retries make it ten times worse | cascading failure / retry amplification | local-process | psp-sandbox |
| [`sf-05-secret-rotation`](shopflow/scenarios/sf-05-secret-rotation/scenario.yaml) | Rotated database password; one service still has the old one | deployment / configuration drift | docker | orders |
| [`sf-06-shadow-dependency`](shopflow/scenarios/sf-06-shadow-dependency/scenario.yaml) | A dependency that exists only in the code | undocumented dependency / hidden blast radius | local-process | — |
| [`sf-07-dead-dependency`](shopflow/scenarios/sf-07-dead-dependency/scenario.yaml) | A declared dependency nobody calls | stale configuration / wasted capacity | compose-validated | — |
| [`sf-08-noisy-neighbor`](shopflow/scenarios/sf-08-noisy-neighbor/scenario.yaml) | A reporting job on the shared database slows checkout | shared infrastructure contention | local-process (direction confirmed; magnitude depends on host cores -- compose caps catalog-db at 1 CPU) | catalog-db |
| [`sf-09-cpu-throttle`](shopflow/scenarios/sf-09-cpu-throttle/scenario.yaml) | Slow but healthy -- a container throttled at a quarter of a core | resource sizing / CFS throttling | docker | catalog |
| [`sf-10-poison-message`](shopflow/scenarios/sf-10-poison-message/scenario.yaml) | One un-processable message stops every confirmation e-mail | asynchronous failure / silent degradation | local-process | notifier |
| [`sf-11-wrong-hostname`](shopflow/scenarios/sf-11-wrong-hostname/scenario.yaml) | A renamed service still referenced by its old name | configuration drift / silent degradation | local-process | — |

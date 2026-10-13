# Always-on traffic for the test bench: realistic shopper/customer journeys against the gateway, forever, with no per-request history kept.
FROM node:22-alpine
WORKDIR /app
COPY loadgen ./loadgen
USER node
ENV BASE_URL=http://localhost CONCURRENCY=12 THINK_MS=1500 USERS=300 MODE=organic BASE_RPS=0.6 SEED=
CMD ["sh", "-c", "F=; [ \"$MODE\" = organic ] && F=\"--organic --base-rps $BASE_RPS\"; [ -n \"$SEED\" ] && F=\"$F --seed $SEED\"; exec node loadgen/loadgen.mjs --continuous $F --concurrency $CONCURRENCY --think-ms $THINK_MS --users $USERS"]

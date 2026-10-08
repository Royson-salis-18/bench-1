# Always-on traffic for the test bench: realistic shopper/customer journeys against the gateway, forever, with no per-request history kept.
FROM node:22-alpine
WORKDIR /app
COPY loadgen ./loadgen
USER node
ENV BASE_URL=http://localhost CONCURRENCY=12 THINK_MS=1500 USERS=300 MODE=organic
CMD ["sh", "-c", "F=; [ \"$MODE\" = organic ] && F=--organic; exec node loadgen/loadgen.mjs --continuous $F --concurrency $CONCURRENCY --think-ms $THINK_MS --users $USERS"]

# Always-on traffic for the test bench: realistic shopper/customer journeys against the gateway, forever, with no per-request history kept.
FROM node:22-alpine
WORKDIR /app
COPY loadgen ./loadgen
USER node
ENV BASE_URL=http://localhost CONCURRENCY=4 THINK_MS=300 USERS=100
CMD ["sh", "-c", "exec node loadgen/loadgen.mjs --continuous --concurrency $CONCURRENCY --think-ms $THINK_MS --users $USERS"]

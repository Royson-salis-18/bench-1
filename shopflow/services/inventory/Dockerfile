# shopflow/inventory -- build context is the shopflow/ directory:  docker build -f services/inventory/Dockerfile .
FROM node:22-alpine
ENV NODE_ENV=production PORT=3003 SERVICE_NAME=inventory
WORKDIR /app
COPY package.json package-lock.json ./
# An optional build secret `ca` lets builds behind a TLS-intercepting corporate proxy trust its CA:
#   docker build --secret id=ca,src=/path/to/ca-bundle.crt ...   (ignored when absent)
RUN --mount=type=secret,id=ca,required=false \
    sh -c '[ -f /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca; npm ci --omit=dev && npm cache clean --force'
COPY lib ./lib
COPY services/inventory ./services/inventory
USER node
EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:3003/healthz || exit 1
CMD ["node", "services/inventory/index.js"]

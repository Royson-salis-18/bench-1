# Prometheus exporter for one compose project, reading the Docker API. Runs as root only because the docker socket requires it (read-only mount).
FROM node:22-alpine
WORKDIR /app
COPY index.js .
EXPOSE 9200
CMD ["node", "index.js"]

FROM oven/bun:1.2-alpine AS base

WORKDIR /app

RUN apk add --no-cache python3 py3-pip ca-certificates \
  && pip install --break-system-packages uv

COPY plugin/scripts/worker-service.cjs .
COPY plugin/package.json .
RUN bun install --production

# The bundled worker resolves plugin assets relative to its own dirname's parent
# (getPackageRoot() = /app/.. = /), so plugin assets must live at the root.
COPY plugin/modes /modes
COPY plugin/ui /ui
COPY plugin/skills /skills
COPY plugin/.mcp.json /plugin/.mcp.json
COPY plugin/package.json /package.json

RUN mkdir -p /data && chown 1000:1000 /data
VOLUME ["/data"]
USER 1000

ARG WORKER_PORT=37777
EXPOSE ${WORKER_PORT}
ENV CLAUDE_MEM_WORKER_HOST=0.0.0.0
ENV CLAUDE_MEM_WORKER_PORT=${WORKER_PORT}
ENV CLAUDE_MEM_DATA_DIR=/data
ENV CLAUDE_MEM_CHROMA_MODE=remote

CMD ["bun", "worker-service.cjs", "start"]

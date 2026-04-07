ARG BASE_IMAGE=ghcr.io/1panel-dev/clawswarm-base:python3.12-20260403

FROM node:22-bookworm-slim AS web-build

COPY web-client /web-client
WORKDIR /web-client

RUN if [ -d "dist" ]; then exit 0; fi \
    && npm ci \
    && npm run build


FROM ${BASE_IMAGE} AS stage-build

WORKDIR /opt/clawswarm-build

COPY scheduler-server/run_dev.py ./scheduler-server/run_dev.py
COPY scheduler-server/src ./scheduler-server/src
COPY --from=web-build /web-client/dist ./web


FROM ${BASE_IMAGE}

ARG DOCKER_IMAGE_TAG=dev
ARG BUILD_AT
ARG GITHUB_COMMIT

ENV CLAWSWARM_VERSION="${DOCKER_IMAGE_TAG} (build at ${BUILD_AT}, commit: ${GITHUB_COMMIT})" \
    APP_HOST=0.0.0.0 \
    APP_PORT=18080 \
    WEB_DIST_DIR=/opt/clawswarm-web

WORKDIR /app/scheduler-server

COPY --from=stage-build /opt/clawswarm-build/scheduler-server /app/scheduler-server
COPY --from=stage-build /opt/clawswarm-build/web /opt/clawswarm-web

RUN mkdir -p /opt/clawswarm

EXPOSE 18080
VOLUME ["/opt/clawswarm"]

CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "18080"]

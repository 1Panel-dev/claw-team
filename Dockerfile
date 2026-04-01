FROM node:22-bookworm-slim AS web-build

WORKDIR /build/web-client

COPY web-client/package.json web-client/package-lock.json ./
RUN npm ci

COPY web-client/ ./
RUN npm run build


FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_HOST=0.0.0.0 \
    APP_PORT=18080 \
    WEB_DIST_DIR=/app/web

WORKDIR /app/scheduler-server

COPY scheduler-server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY scheduler-server/run_dev.py ./
COPY scheduler-server/src ./src
COPY --from=web-build /build/web-client/dist /app/web

RUN mkdir -p /app/data

EXPOSE 18080
VOLUME ["/app/data"]

CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "18080"]

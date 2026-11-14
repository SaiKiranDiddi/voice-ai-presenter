# Stage 1: build the frontend
FROM node:22-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Voice visual: wave or orb. Override with --build-arg VITE_VOICE_VISUAL=orb.
ARG VITE_VOICE_VISUAL=wave
ENV VITE_VOICE_VISUAL=$VITE_VOICE_VISUAL
RUN npm run build

# Stage 2: Python API that also serves the built frontend
FROM python:3.13-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY --from=frontend /build/dist frontend/dist

WORKDIR /app/backend
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]

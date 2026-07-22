# AI For Vector

A general-purpose full-stack starter for map-imagery and AI-related work: **React (Vite)** frontend + **Python (FastAPI)** backend, wired together with a minimal example (Leaflet map fed by a backend API).

## Structure

```
backend/            FastAPI app
  app/main.py        API entrypoint (health check + sample map data)
  app/ai_exercises/   Space for backend-side AI scripts/modules
  requirements.txt
frontend/            React + Vite app
  src/App.jsx         Example page: Leaflet map + backend status
exercises/           Space for notebooks/scripts/experiments (framework-agnostic)
```

## Run it

**Backend** (http://localhost:1315)
```
cd backend
.venv\Scripts\activate      # Windows
uvicorn app.main:app --reload --port 1315
```

**Frontend** (http://localhost:1314)
```
cd frontend
npm run dev
```

Open http://localhost:1314 — you should see "backend: ok" and a world map with two sample markers, proving the two sides are talking to each other.

## Next steps

This is intentionally a thin skeleton — the map example, sample endpoint, and folder layout are just proof that everything is wired up. Replace/extend as you build out your own imagery and AI exercises.

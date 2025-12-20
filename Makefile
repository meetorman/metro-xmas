SHELL := /bin/bash

.PHONY: dev backend frontend stop
.PHONY: clean db-clean

stop:
	@echo "Stopping any existing dev servers on :4000 and :5173..."
	@pids=$$(lsof -ti :4000 2>/dev/null); if [ -n "$$pids" ]; then kill -9 $$pids 2>/dev/null || true; fi
	@pids=$$(lsof -ti :5173 2>/dev/null); if [ -n "$$pids" ]; then kill -9 $$pids 2>/dev/null || true; fi
	@pids=$$(lsof -ti :5174 2>/dev/null); if [ -n "$$pids" ]; then kill -9 $$pids 2>/dev/null || true; fi
	@pkill -f "nodemon src/server.js" 2>/dev/null || true
	@pkill -f "vite --host" 2>/dev/null || true
	@pkill -f "socket.io" 2>/dev/null || true

# Start backend and frontend together. Ctrl+C stops both.
dev: stop
	@echo "Starting backend and frontend..."
	cd backend && npm install >/dev/null 2>&1 || exit $$?
	cd frontend && npm install >/dev/null 2>&1 || exit $$?
	cd backend && npm run dev & \
	backend_pid=$$!; \
	cd frontend && npm run dev -- --host & \
	frontend_pid=$$!; \
	trap 'echo \"Stopping...\"; kill $${backend_pid} $${frontend_pid} 2>/dev/null' SIGINT SIGTERM; \
	wait $${backend_pid} $${frontend_pid}

backend:
	cd backend && npm run dev

frontend:
	cd frontend && npm run dev -- --host

# Remove generated artifacts (keeps local DB safe by default)
clean:
	cd frontend && rm -rf dist

db-clean:
	rm -f backend/data/game.db


#!/bin/bash
# run-demo.sh — clean end-to-end run of the mortgage multi-agent demo
#
# What this does, in order:
#   1. Kill any lingering processes on 3300 / 3500
#   2. Clean tasks.db so we start with a fresh board
#   3. Start oauth-server-demo.ts (port 3300)        — backgrounded
#   4. Start mcp-server-secure-tasks.ts (port 3500)  — backgrounded
#   5. Launch 3 workers in parallel                   — backgrounded
#   6. Launch the orchestrator                        — foreground (you see output)
#   7. After completion, show the audit trail
#
# Stop the backgrounded servers afterward with:
#   lsof -ti:3300,3500 | xargs kill
#
# Assumes you are in /Users/cjayasur/claude-cod/claude-code-simple
# and that .env has AGENT_API_URL + AGENT_API_KEY + AGENT_MODEL set.

set -e

# Ensure bun is in PATH (some shells / subshells don't inherit the user's profile)
export PATH="$HOME/.bun/bin:$PATH"

cd "$(dirname "$0")/.."

echo "🧹 Cleaning state..."
lsof -ti:3300,3500 2>/dev/null | xargs -r kill 2>/dev/null || true
sleep 1
rm -f tasks.db tasks.db-journal tasks.db-wal tasks.db-shm

echo "🚀 Starting OAuth server (port 3300)..."
bun run servers/oauth-server-demo.ts > /tmp/dobbyai-oauth.log 2>&1 &
OAUTH_PID=$!

echo "🚀 Starting Secure Tasks MCP server (port 3500)..."
bun run servers/mcp-server-secure-tasks.ts > /tmp/dobbyai-tasks.log 2>&1 &
TASKS_PID=$!

sleep 3

# Verify both servers are alive
if ! curl -s --max-time 3 http://localhost:3300/ > /dev/null; then
  echo "❌ OAuth server failed to start. See /tmp/dobbyai-oauth.log"
  exit 1
fi
if ! curl -s --max-time 3 http://localhost:3500/ > /dev/null; then
  echo "❌ Tasks server failed to start. See /tmp/dobbyai-tasks.log"
  exit 1
fi
echo "   ✅ Both servers up."

echo "🤖 Launching 3 workers in parallel..."
MCP_CLIENT_ID=dobbyai-worker-001 MCP_CLIENT_SECRET=worker-001-secret-key \
    bun run workers/mortgage-worker.ts > /tmp/worker-001.log 2>&1 &
WORKER1_PID=$!

MCP_CLIENT_ID=dobbyai-worker-002 MCP_CLIENT_SECRET=worker-002-secret-key \
    bun run workers/mortgage-worker.ts > /tmp/worker-002.log 2>&1 &
WORKER2_PID=$!

MCP_CLIENT_ID=dobbyai-worker-003 MCP_CLIENT_SECRET=worker-003-secret-key \
    bun run workers/mortgage-worker.ts > /tmp/worker-003.log 2>&1 &
WORKER3_PID=$!

sleep 1

echo "🧠 Running orchestrator..."
echo "═══════════════════════════════════════════════════════════════════"
bun run orchestrator/mortgage-orchestrator.ts
echo "═══════════════════════════════════════════════════════════════════"

# Wait for workers to drain idle and exit
echo "💤 Waiting for workers to drain..."
wait $WORKER1_PID $WORKER2_PID $WORKER3_PID 2>/dev/null || true

echo
echo "📋 Audit trail (first 30 events):"
sqlite3 tasks.db "SELECT id, task_id, actor, event, datetime(created_at) FROM task_events ORDER BY id LIMIT 30"

echo
echo "📊 Tasks summary:"
sqlite3 tasks.db "SELECT status, COUNT(*) FROM tasks GROUP BY status"

echo
echo "🪵 Server logs: /tmp/dobbyai-oauth.log /tmp/dobbyai-tasks.log"
echo "🪵 Worker logs: /tmp/worker-00{1,2,3}.log"
echo "🛑 Stop servers: lsof -ti:3300,3500 | xargs kill"

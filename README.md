# AI Agent Workflow Builder

A mini n8n-style workflow builder for chaining AI agent steps, built with nhost (Postgres + Hasura + Auth + Functions) and Next.js. Built as a full-stack take-home assignment.

## Live Deployment

- **Frontend (Vercel):** https://agent-workflow-builder-git-main-jagadeeshktm7s-projects.vercel.app
- **Backend (nhost, Mumbai region):** https://pgqeznozctfsgrgpgxwg.hasura.ap-south-1.nhost.run
- **Hasura Console:** https://pgqeznozctfsgrgpgxwg.hasura.ap-south-1.nhost.run/console

> Note: at time of last testing, the nhost backend experienced what appeared to be a transient regional service interruption unrelated to the last deployed commit. If the live demo is unreachable, this is likely why — see commit history and the local test harness results below as evidence of prior working state.

## Test Credentials

### Quick connectivity check (Phase 0 probe user)
- **Email:** test@example.com
- **Password:** *(set at signup — use the credentials you created when first testing the deployed frontend; if you don't remember, just sign up a new account on the live site, since email verification is disabled for this project)*

### Seeded organization test users (Phase 2)
> These were created by `scripts/seed-phase2.mjs` (or equivalent — check the `scripts/` directory for the exact filename) to test cross-org permission isolation. Fill in the actual values below from that script's output, or from the Hasura Auth → Users table in the dashboard:

| Org | Role | Email | Password |
|---|---|---|---|
| Org A | owner | *(from seed script)* | *(from seed script)* |
| Org A | editor | *(from seed script)* | *(from seed script)* |
| Org A | viewer | *(from seed script)* | *(from seed script)* |
| Org B | owner | *(from seed script)* | *(from seed script)* |
| Org B | editor | *(from seed script)* | *(from seed script)* |
| Org B | viewer | *(from seed script)* | *(from seed script)* |

To find these: check `scripts/seed-phase2.mjs` in the repo, or query `auth.users` directly via the Hasura Console → Data → auth schema.

## Tech Stack

- **Backend:** nhost (Postgres, Hasura GraphQL Engine, Auth, Functions) — Mumbai region
- **Frontend:** Next.js 15 + React 19, urql (GraphQL client), @nhost/nextjs
- **LLM:** Google Gemini via `@google/genai`
- **Hosting:** nhost Cloud (backend), Vercel (frontend)

## Local Setup

### Prerequisites
- Node.js 18+
- Hasura CLI (`npx hasura`, no separate install needed — see root `package.json` script)
- A Gemini API key (free tier at aistudio.google.com)

### 1. Clone and install
```bash
git clone https://github.com/jagadeeshktm7/agent-workflow-builder.git
cd agent-workflow-builder
cd frontend && npm install && cd ..
cd functions && npm install && cd ..
```

### 2. Configure environment

Copy the example files and fill in real values from your own nhost project (or ask for access to this one):

```bash
cp nhost/config.example.yaml nhost/config.yaml
cp frontend/.env.example frontend/.env.local
```

Fill in:
- `frontend/.env.local`: `NEXT_PUBLIC_NHOST_SUBDOMAIN`, `NEXT_PUBLIC_NHOST_REGION`
- `nhost/config.yaml`: `endpoint`, `admin_secret` (from nhost dashboard → Settings → Secrets)
- nhost dashboard → Settings → Environment Variables → `GEMINI_API_KEY` (set as a **Secret**, referenced via `{{ secrets.GEMINI_API_KEY }}` in `nhost.toml` — do not put the raw key in any committed file)

### 3. Apply schema

```bash
npx hasura migrate apply --database-name default --project nhost
npx hasura metadata apply --project nhost
```

### 4. Run frontend locally

```bash
cd frontend
npm run dev
```

Visit `http://localhost:3000`.

### 5. Run the test harnesses

```bash
node scripts/test-phase3.mjs        # local logic test
node scripts/test-phase3-live.mjs   # live test against deployed functions
```

Last live run: **19/19 passing**, covering:
- Dual-layer authorization (org/role scoping + step-level gating)
- Quota enforcement
- Full step pipeline: `llm_call`, `http_request`, `db_write`, `conditional_branch` (with correct skip logic), `notify`
- Retry-then-failure handling on external calls
- Approval-gate pause/resume, including double-gate scenarios

## Architecture Notes

### Two permission layers
1. **Org + role scoping** (Hasura declarative permissions): every table permission uses an `_exists` check against `org_members` — verifying the caller is actually a member of the org that owns the row, rather than trusting a static claim on the JWT. This means a user's access is checked fresh on every request against real membership data, not a cached role.
2. **Step-level gating**: certain step/trigger types (`db_write`, `webhook`, `notify`) are restricted to `owner` role only. The `approval_gate` resume decision is enforced in the `approveStep` Action's own code, not as a database permission, since it's a mid-execution business decision (is this specific person allowed to unblock this specific paused run) rather than a simple row-level read/write check.

### Pause/resume mechanism
`triggerWorkflowRun` executes steps sequentially. On hitting an `approval_gate` step, it sets `workflow_run.status = 'paused'` and returns immediately — it does not run inside one long-lived transaction, since the pause could last indefinitely (waiting on a human). `approveStep` re-verifies the approver's role, records `approved_by`/`approved_at`, and resumes execution of the remaining steps.

## Known Limitations / Not Completed

- Workflow builder UI (create/edit workflows visually) not built — only the Phase 0 auth/connectivity screen is deployed
- Webhook trigger designed but not wired into a live external test
- Full end-to-end live demo scenario (two orgs, cross-org isolation proof, live subscription view) not recorded
- Scheduled and database-event triggers not implemented (optional per assignment spec)

## Deployment Debugging Log (for context)

This project hit several non-obvious nhost/Hasura cloud config issues during setup, documented here in case useful for review:
- `nhost.toml` deploys overwrite cloud config wholesale — missing required fields (`hasura.jwtSecrets`, `postgres.resources.storage.capacity`, `observability.grafana.adminPassword`) caused silent config validation failures with truncated error messages, requiring several iterations to fully diagnose
- Dashboard environment variables are not automatically visible to nhost Functions at runtime — required setting the key as a project **Secret** and referencing it via `{{ secrets.GEMINI_API_KEY }}` in `nhost.toml` instead
- A production-only bug: the retry loop in `triggerWorkflowRun` had no deadline budget, causing Gemini calls to occasionally exceed the 10s Lambda timeout mid-retry — fixed with a 6s time budget and retry-only-if-sufficient-time-remains logic

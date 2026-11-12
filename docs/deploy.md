# Deploy runbook: Render

**Related:** [render.yaml](../render.yaml) · [tech stack](tech-stack.md) · [architecture](architecture.md)

The API, the web app and Postgres are described as code in [`render.yaml`](../render.yaml) (a Render Blueprint): `mandate-api` (Node web service), `mandate-web` (static site) and `mandate-db` (Postgres 17).

## Deployment

| Service | URL | Plan |
|---|---|---|
| API (`mandate-api`) | `<api-url>` | Free |
| Web app (`mandate-web`) | `<web-url>` | Free (static) |
| Postgres (`mandate-db`) | private to the Render workspace (no external connections) | Free, created 2026-11-07 |

The live URLs are deliberately not published here. The API has no login, so a public URL invites abuse of the LLM quota; the limits in [Abuse protection](#abuse-protection) cap the damage (see Known limits). Get them from the Render dashboard or a teammate.

Render adds a random suffix (`mandate-api-xxxx.onrender.com`) when a service name is already taken on `onrender.com`. **Never guess a URL**: the unsuffixed names belong to other people's services. Copy each URL from its service page.

## First deploy

1. Render dashboard → **New → Blueprint** → `PxA-Labs/Paypal` → branch `main` → name `mandate`. An org member can connect the org repo: the Blueprint page shows "You are deploying from a Blueprint for PxA-Labs/Paypal" when Render can read it.
2. Render asks for every `sync: false` variable. Enter what you have now, then fix the URLs in step 4. **Names only below. Never paste values into git, issues, PRs or chat.** Judges get sandbox credentials only through the Devpost testing instructions (hard rule 7).

   | Variable | Set on | Value | Needed for |
   |---|---|---|---|
   | `DATABASE_URL` | mandate-api | Set by Render from `mandate-db` | Everything |
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | mandate-api | Sandbox app credentials (developer.paypal.com → Apps & Credentials → **Sandbox**) | Purchases |
   | `LLM_API_KEY` | mandate-api | NVIDIA API key from build.nvidia.com. The other `LLM_*` values are set in `render.yaml` ([llm-layer.md](llm-layer.md) section 9). Set the key only once abuse protection is deployed | Purchases |
   | `LLM_FALLBACK_API_KEY` | mandate-api | Optional Gemini fallback ([llm-layer.md](llm-layer.md) section 9). Set it **in the same save** as `LLM_FALLBACK_MODEL`: one without the other is a config error and disables purchases. Use a key from a project without billing, and read the "Before turning the fallback on" notes first | Fallback |
   | `LLM_FALLBACK_MODEL` | mandate-api | `gemini-3.5-flash-lite` (verified locally; take the id from `GET <base>/models`). Not secret | Fallback |
   | `LLM_TIMEOUT_MS` | mandate-api | Default `120000`. Ours is `240000`: one NVIDIA call ran past 120 s and the request ended `INTENT_FAILED` (see [Gate 1 evidence](#gate-1-evidence)) | Optional |
   | `PURCHASES_ENABLED` | mandate-api | Unset or `true`; `false` is the kill switch (see below) | Optional |
   | `TRUST_PROXY`, `LLM_DAILY_REQUEST_CAP`, `LLM_DAILY_PER_IP_CAP`, `LLM_MAX_CONCURRENT` | mandate-api | Set in `render.yaml`; see [Abuse protection](#abuse-protection) | Client IP, LLM limits |
   | `DEBUG_PROXY_HOPS` | mandate-api | Unset (off). `true` only while verifying `TRUST_PROXY` (see Abuse protection) | Optional |
   | `WEB_ORIGIN` | mandate-api | The web app URL, no trailing slash | The browser calling the API (CORS) |
   | `WEB_APP_URL` | mandate-api | The web app URL | Review links in approval messages |
   | `ZAPIER_APPROVAL_WEBHOOK_URL` | mandate-api | Zapier Catch Hook ([zapier.md](zapier.md)) | Approval messages (optional) |
   | `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL` | mandate-api | Where PayPal sends the buyer back. Default `https://example.com/paypal/...` | Optional |
   | `PAYPAL_WEBHOOK_ID` | mandate-api | Id of the webhook on the sandbox app (see below) | Webhook route (optional: the 60 s reconcile job also settles orders) |
   | `VITE_API_URL` | mandate-web | The **API** URL | The web app. Compiled into public JavaScript at build time, so never a secret, and a change needs a rebuild |

3. **Deploy Blueprint.** Render creates `mandate-db`, builds both services and starts `mandate-api` with `pnpm db:migrate && pnpm db:seed && pnpm --filter @mandate/api start`. The demo seed only inserts missing rows, so it is safe on every boot. The free plan has no Shell or pre-deploy command to run it once by hand.
4. Copy the real URLs from the two service pages. Set `WEB_ORIGIN` and `WEB_APP_URL` on **mandate-api** to the web URL, and `VITE_API_URL` on **mandate-web** to the API URL. Then **Save, rebuild, and deploy** each.
5. Check from your machine:

   ```sh
   pnpm smoke:deployed https://<api> --web https://<web>
   pnpm smoke:deployed https://<api> --web https://<web> --purchase   # also submits one purchase
   ```

   It prints one PASS/FAIL line per check (health, Postgres, demo mandate, dashboard summary, CORS, and with `--purchase`, a purchase decision) and exits non-zero on any failure. It prints status codes only, never bodies or configuration. `--purchase` is opt-in because an `ALLOW` holds demo budget and opens a sandbox PayPal order. It asks for whiteboard markers: the deployed API searches only the offline fixture catalog ([`fixture.ts`](../apps/api/src/modules/catalog/fixture.ts)), so a request must name one of its items or it ends `NO_MATCH`.

## Gate 1 evidence

One sandbox purchase created and captured by the deployed API on 2026-11-09, 20:22–20:31 UTC (`main` at `769935d`, Render free plan). The calls were plain HTTP requests from a laptop; the buyer approved on PayPal's sandbox checkout page. Sandbox only: no real money moved.

| Step | Result |
|---|---|
| `POST /mandates/<demo-mandate>/purchases` as the demo requester (Riya): "Two packs of whiteboard markers for the office" | `201` in 83 s. Policy `ALLOW` (`WITHIN_MANDATE`), cart 2 × "Whiteboard markers, 12 colours" = 23.00 USD. PayPal order created, `PAYER_ACTION_REQUIRED` |
| Buyer approval | A US sandbox Personal account approved the order |
| `POST /purchases/<id>/capture` | `200` in 3.5 s. Purchase `CAPTURED`, PayPal order `COMPLETED` |
| Read back from PayPal (`pnpm --filter @mandate/payments spike get <order>`) | Capture `COMPLETED`, 23.00 USD |

| Record (sandbox ids, not secrets) | Id |
|---|---|
| Purchase request | `66e6d620-8342-4caa-99ea-923532f2404b` |
| PayPal order | `0T9321544D519493Y` |
| PayPal capture | `9KR605721A308010M` |

**Approval path (20:32–20:34 UTC):** "Two conference speakerphones and three HD webcams for the club room" returned `NEEDS_APPROVAL` (`THRESHOLD_EXCEEDED`, 355.00 USD) in 143 s, and the audit trail records `approval.notified` 0.4 s later (purchase `18f28e55-8844-4427-8584-7c47ce7d1d5b`). That shows the API called the Zapier Catch Hook; what the Zap does next is in [zapier.md](zapier.md).

**What failed first:** "printer paper" ended `NO_MATCH` (not in the fixture catalog). One request ended `INTENT_FAILED` when the LLM call ran past the 120 s default timeout. One `ALLOW` ended `PAYPAL_AUTH` because the PayPal credentials on Render had been pasted wrong. Requests took 55–143 s end to end on the NVIDIA free endpoint.

At boot the API logs `feature disabled: configuration missing` with the **names** of missing variables, never their values, and still serves `/health` and `/ready`. Purchases are registered only when the database, PayPal and LLM settings are all present.

## Abuse protection

The API has no login, so these limits bound what an anonymous client can spend (#62). All rejections use the usual error body (`{ error, message, requestId }`), and `429`/`503` answers carry `Retry-After` when a wait is known. Each rejection is counted by reason and logged as `request rejected` with the reason and running count only: never bodies, headers or IPs.

| Control | Limit | Answer |
|---|---|---|
| Per-IP rate limit, all routes | 120 requests/minute | `429 RATE_LIMITED` |
| `POST /mandates/:id/purchases` (calls the LLM) | 5/minute per IP, on top of the above | `429 RATE_LIMITED` |
| `/approvals/preview`, `/approvals/decision` | 10/minute per IP, to slow token guessing | `429 RATE_LIMITED` |
| `POST /purchases/:id/capture` | 10/minute per IP: it calls PayPal and writes an order event even when refused | `429 RATE_LIMITED` |
| `POST /webhooks/paypal` | 600/minute per IP, its own budget: a busy client cannot block PayPal | `429 RATE_LIMITED` |
| `/health`, `/ready` | never limited (Render polls them) | |
| LLM requests in flight | `LLM_MAX_CONCURRENT` (default 2) | `503 LLM_BUSY` |
| LLM requests per UTC day | `LLM_DAILY_REQUEST_CAP` (default 100) | `429 LLM_DAILY_CAP`, `Retry-After` until midnight UTC |
| LLM requests per client per UTC day | `LLM_DAILY_PER_IP_CAP` (default 20), so one client cannot use up the day | `429 LLM_DAILY_CLIENT_CAP`, `Retry-After` until midnight UTC |
| Request body | 64 KiB | `413 PAYLOAD_TOO_LARGE` |
| Kill switch | `PURCHASES_ENABLED=false` | `503 PURCHASES_DISABLED` on new purchases, capture and `APPROVE` decisions. See below for exactly what it stops |

- **The daily cap is counted in Postgres**, as the number of `purchase_request` rows created since midnight UTC: each one is what triggers the LLM calls (intent, then ranking). It survives restarts and the free plan's spin-down, and needs no extra table. A concurrency slot is taken before the count is read, so the cap can be overshot by at most `LLM_MAX_CONCURRENT - 1`. If the count cannot be read, LLM requests are refused (`503 LLM_CAP_UNAVAILABLE`).
- **Per-IP limits are in memory**, per instance; a restart resets them, which is acceptable for per-minute windows. A client is an IPv4 address or an IPv6 /64 (`::ffff:a.b.c.d` counts as the IPv4 client). Memory is capped at 50,000 clients per limit, evicting the oldest first; an evicted client just starts a fresh window.
- **The per-client daily quota is in memory too**, so a restart or the free plan's spin-down resets it; the Postgres-backed global cap still holds. It stores salted SHA-256 hashes of the client key (random salt per process), never raw IPs. It is spent before the global count is read and given back if the global cap refuses.
- **Client IP behind Render's proxy.** `TRUST_PROXY` lists the proxy addresses or CIDRs whose `X-Forwarded-For` entries are trusted. Fastify walks the header from the right and stops at the first untrusted address, so a forged left-most entry is ignored. It is never `true` (which would trust the forgeable left-most entry), and not a hop count (Fastify 5.12 ignores numeric `trustProxy` by design). If the setting is too narrow, all clients share the proxy's address and are limited together: safe, but strict.
- **Kill switch:** set `PURCHASES_ENABLED=false` on mandate-api and redeploy. The boot log says `feature disabled: PURCHASES_ENABLED=false`. It is enforced at one choke point in `PurchaseService`: every PayPal call that creates or captures an order goes through it, so no route, webhook or job can move money while it is off. The routes also answer early with `503`.

  | Stops (no PayPal order is created or captured, no LLM call) | Keeps working |
  |---|---|
  | New purchase requests (`POST /mandates/:id/purchases`), including their LLM calls | Reads: purchases, mandates, dashboard, audit trail, approval previews |
  | `POST /purchases/:id/capture` | `/health`, `/ready` |
  | `APPROVE` decisions (the approval stays pending) | `REJECT` decisions, which release the budget hold |
  | Captures a verified webhook or the reconcile job would start: the order is marked `capture_deferred_at` and an order event `capture_deferred` is recorded | Webhook signature verification and event recording; the webhook answers `200`, so PayPal does not retry |
  | Retrying an order creation whose outcome was unknown | The expiry sweep, and reading PayPal orders (`getOrder`) to reconcile |
  | | Idempotent replays of an existing request, answered from the database |

  When the switch is back on, the 60 s reconcile job picks up every deferred order: it captures it if PayPal still reports the order `APPROVED` and accepts the capture. If PayPal refuses (for example, the buyer's approval has expired), the order becomes `FAILED` with `CAPTURE_REFUSED_AFTER_DEFERRAL` and its budget hold is released. A `VOIDED` order fails as before.

`VERIFY` on the deployed API, once, with the `DEBUG_PROXY_HOPS` diagnostic. It logs one `proxy diagnostic` line per request with `xffHops` (how many `X-Forwarded-For` entries arrived), `pickedHop` (which one became the client IP: `0` is the socket peer, meaning the proxy itself was not trusted; `1` is the right-most forwarded entry) and `clientHash` (a salted hash of the client, stable within one process). It never logs a raw IP.

1. mandate-api → **Environment** → add `DEBUG_PROXY_HOPS` = `true` → **Save, rebuild, and deploy**. Wait for **Live**.
2. From network A (for example home Wi-Fi), run three times: `curl -s -o /dev/null -w "%{http_code}\n" https://<api-url>/health`
3. From network B (for example a phone hotspot), run the same command three times.
4. Spoofing check, from network A: `for i in $(seq 1 11); do curl -s -o /dev/null -w "%{http_code} " -X POST -H "content-type: application/json" -H "X-Forwarded-For: 203.0.113.$i" -d '{"token":"x"}' https://<api-url>/approvals/preview; done; echo`. The first ten should be `400` and the 11th `429`.
5. mandate-api → **Logs**, search `proxy diagnostic`. Expected:
   - `pickedHop` is the same small number (`1` if Render adds one hop) on every line, and `xffHops` is `pickedHop` or more.
   - Network A's three lines share one `clientHash`, network B's share a **different** one.
   - Step 4's eleven lines all show network A's hash, despite the eleven different spoofed values.
6. mandate-api → **Environment** → delete `DEBUG_PROXY_HOPS` (or set `false`) → redeploy.

Reading the result: if `pickedHop` is `0`, the proxy's address is outside `TRUST_PROXY`, so all clients share one bucket (safe but strict); if the hash changes on every line from one network, a rotating CDN edge is being picked, so unrelated users share buckets and an attacker could get fresh ones. In either case, report `xffHops` and `pickedHop` and widen or narrow `TRUST_PROXY` before relying on the per-IP limits.

## PayPal webhook

1. developer.paypal.com → **Apps & Credentials → Sandbox** → the app → **Sandbox Webhooks → Add Webhook**.
2. URL: `https://<api>/webhooks/paypal`. Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`. The handler only triggers a reconcile from PayPal's `getOrder`, and never trusts the payload for money state.
3. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID` on mandate-api and redeploy. The route is registered only when it is set.

`VERIFY`: the event list and a signature check against a delivery from PayPal's webhook simulator.

## Every deploy after that

Merging to `main` deploys automatically (`autoDeployTrigger: commit`). Migrations run on boot. If one fails, the new version does not start and the previous one keeps serving.

Background jobs run inside the API every 60 s: expired approvals are swept, and orders in `UNKNOWN_OUTCOME` are reconciled from PayPal. This assumes **one instance**. The sweep locks each row, but `reconcile()` does not, so don't scale out until it does.

## Rollback

Service → **Events** → pick the last good deploy → **Rollback**. Migrations are forward-only: roll back code, then fix the schema with a new migration, never by editing an applied one (the runner refuses edited migrations).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A URL answers with someone else's app (e.g. `x-render-origin-server: uvicorn`) | The name was taken; Render added a suffix to ours | Use the URL from the service page |
| Smoke: `demo mandate HTTP 404 MANDATE_NOT_FOUND` | Demo data not seeded: the service still has an old start command | `render.yaml` changes reach a service only on a **Blueprint sync**, not on a redeploy. Blueprint page → **Manual sync**, then check the service's Start Command |
| `429 RATE_LIMITED`, `503 LLM_BUSY` or `429 LLM_DAILY_CAP` | A limit in [Abuse protection](#abuse-protection) | Wait for `Retry-After`; raise the variable only if the quota allows |
| Smoke: `origin not allowed (set WEB_ORIGIN)`; browser console shows CORS errors | `WEB_ORIGIN` on mandate-api is not exactly the web URL | Set it (scheme + host, no trailing slash) and redeploy mandate-api |
| The web app calls `127.0.0.1:3000` or its own URL | `VITE_API_URL` unset or wrong at **build** time | Fix it on mandate-web, then rebuild |
| Smoke: `purchases disabled` | A purchase variable is missing | The API boot log names it |
| Purchase `NO_MATCH` | The request names nothing in the offline fixture catalog | Ask for one of its items ([`fixture.ts`](../apps/api/src/modules/catalog/fixture.ts)) |
| Purchase `FAILED`, `INTENT_FAILED` or `RANKING_FAILED`, after about 120 s | An LLM call ran past `LLM_TIMEOUT_MS` | Raise it (maximum `300000`) and redeploy |
| Order `FAILED`, `PAYPAL_AUTH` | PayPal rejected `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Re-paste both from the **Sandbox** app, with no quotes or spaces, then redeploy |
| First request takes about a minute | Free web services sleep after 15 minutes idle | Expected on the free plan; open the URL before a demo |

## Known limits

From Render's free-plan docs (render.com/docs/free, read 2026-11-07; check before relying on them):

| Item | Why it matters |
|---|---|
| **Free Postgres expires 30 days after creation**, then is inaccessible for a 14-day grace period, then deleted. No backups | Ours was created 2026-11-07, so it stops working about **2026-12-07**, before judging ends. Upgrade `mandate-db` to a paid plan before then (price: check render.com/pricing) |
| **Free web services sleep** after 15 minutes without traffic and take about a minute to wake | Judges may see a slow first load. Consider a paid instance for judging |
| One free Postgres per workspace; 750 free instance hours per month | Don't create a second free database in the same workspace |
| **No authentication yet** (#10 follow-up) | The API is public, and the demo user ids are in the repo, so anyone with the URL can edit the demo mandate or submit sandbox purchases. Sandbox only: no real money moves. The [abuse protection](#abuse-protection) limits bound the LLM quota and the request rate, but do not stop someone editing the demo mandate |
| Region `singapore` | Close to the team. Judges are mostly US-based; latency is acceptable for a demo |

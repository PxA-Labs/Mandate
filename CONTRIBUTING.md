# Contributing to Mandate

Thanks for helping. Mandate is a spending guardrail for AI agents, so a change here can make an agent spend money it should not. Please read the [hard rules](#hard-rules) before you write code. Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

**Found a security problem?** Do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Contents

- [Ways to contribute](#ways-to-contribute)
- [Set up](#set-up)
- [Hard rules](#hard-rules)
- [Workflow](#workflow)
- [Checks before you open a PR](#checks-before-you-open-a-pr)
- [Pull requests](#pull-requests)
- [Where things live](#where-things-live)
- [Working with AI assistants](#working-with-ai-assistants)

## Ways to contribute

- **Report a bug.** Open an issue. Say what you did, what you expected and what happened, and include the request ID from the API log if you have one.
- **Add an attack case.** New prompt-injection, structuring or price-drift scenarios for `packages/evals` are very welcome. Read the [eval protocol](README.md#eval-protocol) first.
- **Improve the docs.** Fix anything in the README or `docs/` that is unclear, out of date or wrong.
- **Fix or build something.** For anything larger than a small fix, open an issue first so we can agree on the approach.

## Set up

You need **Node 22.12+** (24 recommended), **pnpm 11** (`corepack enable` installs the pinned version) and **Docker** for Postgres.

```bash
git clone https://github.com/PxA-Labs/Mandate.git mandate && cd mandate
corepack enable
pnpm install
cp .env.example .env          # .env is git-ignored; never commit it
docker compose up -d          # Postgres on 127.0.0.1:5432
pnpm db:migrate
pnpm db:seed
pnpm dev                      # API on http://127.0.0.1:3000
pnpm dev:web                  # web app on http://localhost:5173 (second terminal)
```

The API starts without provider keys, and the README's [Getting started](README.md#getting-started) section says which feature needs which key. **Only use sandbox credentials.**

## Hard rules

These come from [CLAUDE.md](CLAUDE.md) and [ADR 0004](docs/adr/0004-llm-has-no-tools-policy-in-code.md). A PR that breaks one of them will not be merged.

1. **The LLM proposes, code decides.** LLM modules never get payment tools or credentials. Only the `payments` module calls PayPal, and only after a policy `ALLOW` or a recorded human approval. Import-boundary tests enforce this, so do not weaken them.
2. **Never trust LLM output for money.** The LLM returns candidate IDs and quantities. Code computes prices and totals from normalized catalog data, and every LLM output is validated against a Zod schema.
3. **Product text is untrusted.** Quarantine it: truncate it, delimit it, and use it only in calls that have no tools.
4. **Money is integer minor units plus an ISO currency code.** Never use floats.
5. **Idempotency.** Every money-moving call carries an idempotency key, and webhook handlers dedupe by event ID.
6. **Sandbox only.** No real money, and no automation of real retailer checkouts.
7. **No secrets in git.** Keys, tokens and `.env` stay out of the repo. Add new variables to `.env.example` with placeholder values.
8. **Don't claim what we haven't verified.** Mark anything unconfirmed as `VERIFY`, and never invent results, datasets or citations.
9. **Keep the eval honest.** Never use the held-out attack set to tune prompts. Report eval failures as they are.

## Workflow

**Maintainers** create branches in this repository. **Everyone else** forks it and opens a PR from their fork. Either way:

1. **Branch from an up-to-date `main`.** Name it `type/short-topic`, for example `feat/split-purchase-check` or `fix/webhook-dedupe`.
2. **Make one logical change per commit.** Use [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(policy): block split purchases`.
3. **Use a type from this list** (CI checks PR titles against it): `feat`, `fix`, `docs`, `chore`, `test`, `eval`, `ci`, `refactor`, `perf`, `build`, `revert`. The scope is optional, and the subject starts with a lowercase letter.
4. **Never push to `main`, never force-push a shared branch, and never merge without a teammate's review.** [CODEOWNERS](.github/CODEOWNERS) requests reviewers automatically.

## Checks before you open a PR

```bash
pnpm lint
pnpm typecheck
pnpm test                    # Vitest with coverage floors
pnpm smoke:offline           # each package's offline smoke test
```

The Postgres integration tests run only when `TEST_DATABASE_URL` is set. CI always runs them:

```bash
docker compose up -d
TEST_DATABASE_URL=postgres://mandate:mandate@127.0.0.1:5432/mandate_test pnpm test
```

Some changes need more than the standard checks:

| If you change | Also do |
|---|---|
| `packages/policy` | Add unit tests, and property tests where they fit. The policy must stay pure: no I/O, no clock, no randomness |
| `packages/llm` or any prompt | Run the eval on the **dev set only** (`pnpm eval`) and put the results in the PR |
| `packages/payments` | Test with the fake gateway. Use `pnpm --filter @mandate/payments spike` only against the sandbox |
| A database migration | Add a new numbered file in `apps/api/migrations/`. Never edit a migration that has already been applied, because checksums are verified |
| An API endpoint | Update the Postman collection in `postman/` |
| Behavior described in the docs | Update the README or `docs/` in the same PR |

TypeScript and JavaScript source must be ASCII-only, and a test enforces it. Write `\u` escapes instead of literal non-ASCII characters.

## Pull requests

A PR description has four parts:

- **Summary:** what the change does and why.
- **What changed:** the main edits.
- **How tested:** the commands you ran and what you checked by hand.
- **VERIFY:** anything still unconfirmed.

Keep PRs small. CI must pass, which covers lint, typecheck, tests, CodeQL, the secret scan, dependency review and the PR title check.

## Where things live

| Path | What |
|---|---|
| `apps/api` | Fastify API (modular monolith): purchases, approvals, mandates, webhooks, jobs |
| `apps/web` | React + Vite web app |
| `packages/policy` | Deterministic policy engine |
| `packages/llm` | Intent parser and ranker (no tools) |
| `packages/shared` | Zod schemas, money utilities, quarantine |
| `packages/payments` | PayPal Orders v2 sandbox client, the only PayPal caller |
| `packages/evals` | Three-configuration attack benchmark ([README](packages/evals/README.md)) |
| `docs/` | Architecture, UML, ER diagram, ADRs, deploy runbook |

For larger design changes, add an ADR in `docs/adr/` and follow the format of the existing ones.

## Working with AI assistants

AI-assisted work is welcome, but it must follow [CLAUDE.md](CLAUDE.md). You are responsible for every line you submit, so review generated code as carefully as code you wrote yourself, especially anything that touches money, policy or untrusted text.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

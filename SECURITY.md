# Security Policy

Mandate is a hackathon project that moves money through the **PayPal sandbox only**. It never handles real funds or real payment credentials. We still take security reports seriously, because the whole point of the project is to stop an AI agent from spending money it should not.

## Supported versions

| Version | Supported |
|---|---|
| `main` branch | Yes |
| Any other branch, fork or tag | No |

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: go to the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/PxA-Labs/Mandate/security/advisories/new)). Only the maintainers can see the report.

Please include:

- what the problem is and which component it affects (for example `packages/policy`, `packages/payments`, `apps/api`)
- steps to reproduce it, or a minimal proof of concept
- what an attacker could achieve
- any fix you suggest

**What to expect.** This is a small student team, so these are goals, not guarantees: we aim to acknowledge a report within 3 days and to share an assessment within 7 days. We will credit you in the advisory unless you ask us not to.

## What is in scope

We especially want reports that break one of the project's [hard rules](CLAUDE.md#hard-rules-non-negotiable):

- **Policy bypass.** A purchase is paid even though the policy engine should have returned `DENY` or `NEEDS_APPROVAL`, or a budget, per-item cap, category limit or approval threshold is exceeded.
- **The LLM reaching money.** LLM output changes a price, a total or a payee, or an LLM module reaches payment tools or credentials.
- **Prompt injection.** Product text gets past the quarantine and changes a decision.
- **Approval flaws.** An approval token is reused, guessed or forged, or works after it has expired.
- **Idempotency flaws.** A duplicate charge, a replayed webhook, or a budget reservation race.
- **Leaked secrets.** Credentials or tokens in the repository, logs or API responses.
- **API weaknesses.** Missing authorization or input validation, or a way around the rate limits.

## What is out of scope

- Vulnerabilities in PayPal, Render, Zapier, NVIDIA or other third-party services. Report those to the vendor.
- Denial-of-service or load testing against the deployed demo.
- Findings that need a compromised maintainer account or local machine.
- Reports produced only by automated scanners, with no demonstrated impact.

## Safe harbor

If you research in good faith, only use sandbox accounts, avoid harming other users' data and give us reasonable time to fix the problem before you disclose it, we will not pursue or support any action against you.

## How the project defends itself

- **The LLM proposes, code decides.** A deterministic policy engine with no I/O and no LLM (`packages/policy`) makes every spending decision. Only `packages/payments` calls PayPal, and import-boundary tests enforce that.
- **Product text is untrusted.** It is truncated, quarantined and wrapped in nonce-delimited blocks, and it is only used in model calls that have no tools.
- **Money is stored as integer minor units plus an ISO currency code.** Every money-moving call has an idempotency key, and webhooks are deduplicated by event ID.
- **CI runs** CodeQL, a secret scan, dependency review and OpenSSF Scorecard.

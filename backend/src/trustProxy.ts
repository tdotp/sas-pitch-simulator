// Fase 8 PASS_WITH_FIXES (P1) — client IP resolution behind the real
// reverse proxy. Express never trusts `X-Forwarded-For` by default; the
// number here is Express's `trust proxy` setting (see index.ts), and it
// is grounded in the actual deployment topology, not a guess.
//
// TOPOLOGY (verified from docker-compose.yml + Caddyfile at the repo
// root, not assumed):
//   internet -> Caddy (docker-compose: the ONLY service with a host
//   `ports:` mapping, 80/443) -> backend (docker-compose: `expose:
//   "8080"` only — no `ports:` mapping, so the backend container is
//   unreachable from outside the `sas-net` docker network). Exactly ONE
//   reverse proxy sits between any external client and this Express
//   process; there is no path for a client to open a TCP connection to
//   the backend directly.
//
// CONDITION under which this process ever receives traffic: only via
// Caddy's `reverse_proxy backend:8080` directive, which appends the
// address it actually observed the connecting peer as to
// `X-Forwarded-For` (standard Caddy reverse_proxy behavior) rather than
// forwarding a client-supplied header unmodified.
//
// WHY A CLIENT CAN'T PICK ITS OWN req.ip: with Express's `trust proxy`
// set to this exact number of hops, Express (via the `proxy-addr`
// library) reads ONLY the right-most (closest-to-server) entry of
// `X-Forwarded-For` as the client address, and ignores everything a
// caller prepends to the left of it — a client prepending fake hops to
// its own request cannot influence which entry Express reads, because
// that entry is the one CADDY appended, not the client. The actual
// vulnerability would be setting this number HIGHER than the real proxy
// count (e.g. 2 here, when there is only 1 real hop): Express would then
// read an entry a client fully controls. See TRUST_PROXY_SPOOFING tests
// in trustProxy.test.ts for the empirically-verified behavior this
// reasoning rests on.
export const TRUSTED_PROXY_HOPS = 1;

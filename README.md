# traderoom

Plataforma de opções binárias cripto (MVP). Monorepo npm workspaces.

## Dev

```sh
cp .env.example .env
npm install
npm run dev:deps      # Postgres 16 + Redis 7 via Docker Compose
npm run db:migrate    # aplica db/migrations
npm run dev:api       # API em http://127.0.0.1:3000
npm run dev:ws        # relay de preços + gateway WebSocket em ws://127.0.0.1:3001/ws
                      # /metrics e /healthz na mesma porta (internos; o Caddy só expõe /ws)
npm run dev:worker    # liquidação de ordens (/metrics e /healthz em 127.0.0.1:3002)
npm run dev:web       # front em http://localhost:5173 (proxy de /api e /ws, mesma origem)
```

Abra http://localhost:5173. Contas novas começam com saldo zero; um admin credita pelo `/admin`.

## Admin

Não existe endpoint para mudar papel de usuário: o primeiro admin é promovido pelo terminal
(no servidor, com o `.env` de produção carregado):

```sh
npm run admin-role -w @traderoom/api -- promote ana@exemplo.com   # vira admin (vale na hora)
npm run admin-role -w @traderoom/api -- demote ana@exemplo.com
npm run admin-role -w @traderoom/api -- list
# build de produção: node --env-file=.env apps/api/dist/cli/admin-role.js promote ana@exemplo.com
```

No `/admin`: busca de usuários, crédito/débito (com motivo, vai para o extrato), bloqueio
(derruba as sessões na hora), payout e disponibilidade por ativo, e o log de auditoria.
Toda ação grava em `admin_audit` na mesma transação da mudança.

## Checks

```sh
npm run typecheck
npm test              # unit
npm run test:int      # integração (precisa de dev:deps + db:migrate)
npm run test:e2e      # Playwright no Chrome instalado: cadastro → login → ordem → liquidação → saldo
                      # sobe api/ws/worker/web sozinho (ou reusa os que já estiverem rodando);
                      # precisa de dev:deps e internet (feed real); leva ~1,5 min
npm run build
npm audit
```

`npm run db:rollback` desfaz 1 migration; `npm run db:rollback -- N` desfaz N.

## Teste de carga do WebSocket

```sh
npm run load-users -w @traderoom/api -- create 500 ../../tests/k6/.sessions.json
npm run dev:ws                                   # ou o build: node apps/ws/dist/main.js
k6 run tests/k6/ws-load.js                       # 500 conexões por 10 min (critério do spec)
node tests/load/ws-load.mjs                      # mesmo cenário sem k6; mede também o RSS do ws
npm run load-users -w @traderoom/api -- delete   # remove os usuários de carga
```

Variáveis: `VUS`, `HOLD_SEC`, `RAMP_SEC`, `WS_URL`. Rode o gerador na mesma máquina do `ws`:
a latência compara o relógio do cliente com o horário do preço.

## Teste de aceite (marco 8)

```sh
npm run build && npm run dev:deps
npm run test:acceptance          # 500 conexões por 10 min + ordens + derrubada do feed (~14 min)
VUS=20 HOLD_SEC=90 npm run test:acceptance   # ensaio curto
```

Sobe os builds de produção (ws, api e **dois** workers), mede p95 do tick, RSS do ws, respostas
da Binance, confere que nenhuma ordem foi liquidada duas vezes (ledger) e derruba o ws com
SIGKILL para medir: recusa de ordens por preço velho, `/api/health` 503 e recuperação automática.
Relatório em `tests/load/results/<data>/report.json`. Variáveis: `VUS`, `HOLD_SEC`, `RAMP_SEC`, `TRADERS`.

## Deploy (GCP)

> Projeto Firebase `traderoom-48951`: passo a passo, custos e checklist em [`infra/LANCAMENTO.md`](infra/LANCAMENTO.md)
> (`source infra/firebase.env` antes dos comandos abaixo).

Pré-requisitos na máquina local: `gcloud` autenticado, Node 22+, npm, tar.

```sh
export GCP_PROJECT=meu-projeto TRADEROOM_DOMAIN=trade.exemplo.com ACME_EMAIL=ops@exemplo.com
export SMTP_PASS=...                                # senha da caixa de MAIL_FROM (Hostinger, smtp.hostinger.com:465); Secret Manager
export RESEND_API_KEY=re_...                        # alternativa ao SMTP; vai para o Secret Manager
export MAIL_FROM='Traderoom <nao-responda@exemplo.com>'

infra/deploy.sh provision   # VPC, IP fixo, firewall 80/443 (22 só via IAP), Cloud SQL 16 com IP privado
                            # e backup diário (7 dias), segredos, VM e2-small Debian 12, uptime check
# → crie o registro A do domínio apontando para o IP impresso
infra/deploy.sh setup       # Node, Caddy, Redis local, sysctl, swap, units do systemd
infra/deploy.sh release     # build + testes, envio, migrations, troca atômica, health check e rollback
```

Todos os passos são idempotentes: rodar de novo só cria o que falta. Novas versões: só `release`.

- **Segredos**: a senha do banco (e a chave do Resend) ficam no Secret Manager; no boot,
  `traderoom-secrets.service` grava `/run/traderoom/secrets.env` (tmpfs, 0640) e as units o leem
  via `EnvironmentFile`. Nada de segredo no repositório nem no disco da VM.
- **Caddy** (`infra/Caddyfile`): TLS automático. Equivalentes do `proxy_read_timeout 3600s` e
  `proxy_buffering off` do nginx em `/ws`: o Caddy não aplica timeout de leitura em conexões
  WebSocket, `stream_timeout 24h` limita a vida de cada uma, `flush_interval -1` desliga o buffer,
  `stream_close_delay 5m` evita derrubar todo mundo num reload. `/metrics` e `/healthz` não saem da VM.
- **Admin em produção**:
  `gcloud compute ssh traderoom-vm --tunnel-through-iap -- sudo -u traderoom bash -c 'set -a; . /etc/traderoom/traderoom.env; . /run/traderoom/secrets.env; cd /opt/traderoom/current && node apps/api/dist/cli/admin-role.js promote ana@exemplo.com'`
- **Logs**: `journalctl -u traderoom-api -u traderoom-ws -u traderoom-worker -f`; Caddy em `/var/log/caddy/`.

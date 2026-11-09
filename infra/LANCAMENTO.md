# Lançamento em produção — Firebase / Google Cloud (traderoom-48951)

## Como fica montado

```
cliente (navegador/celular)
   │ HTTPS + WebSocket (seudominio.com)
   ▼
VM traderoom-vm — São Paulo (southamerica-east1-c), e2-small, Debian 12
   ├─ Caddy ........ HTTPS automático, site, /api → API, /ws → gateway
   ├─ API .......... Fastify (contas, ordens, carteira, admin, KYC)
   ├─ ws ........... preços (Binance + OTC) e WebSocket dos clientes
   ├─ worker ....... liquidação das ordens
   └─ Redis ........ preços ao vivo, fila de liquidação, rate limit (só local)
   │ IP privado, TLS
   ▼
Cloud SQL traderoom-48951-instance (Postgres 18, criado pelo Firebase SQL Connect)
   └─ banco "traderoom"   ← todos os dados (saldos, ordens, usuários, auditoria)

Firebase Storage traderoom-48951.firebasestorage.app ← fotos do KYC (privado)
Secret Manager ← senha do banco, chaves EaglePay (e Novus), chave Resend
```

- **Tudo na mesma região (São Paulo)**: VM e banco ficam na mesma zona, com ~1 ms entre eles.
- **Sem arquivo de chave em produção**: a VM usa a própria conta de serviço para falar com o Storage
  e o Secret Manager. O `secrets/firebase-admin.json` é só para o seu PC.
- **Banco fechado**: só a VM entra (IP privado). O IP público do banco continua existindo (o SQL Connect
  e o `npm run db:tunnel` usam), mas sem nenhuma rede autorizada: só conexões com credencial do Google.

## Custos estimados (por mês, São Paulo)

Valores aproximados em US$. Confira na calculadora do Google antes de ligar
(https://cloud.google.com/products/calculator). A região de São Paulo custa mais que a dos EUA.

| Peça                                | Configuração                                           | Estimativa/mês                 |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------ |
| VM                                  | e2-small (2 vCPU compartilhadas, 2 GB) + disco 20 GB   | ~US$ 20                        |
| IP fixo                             | 1 IP externo em uso                                    | ~US$ 4                         |
| Cloud SQL                           | **db-f1-micro** (atual, teste grátis até 05/02/2027)   | US$ 0 no teste, depois ~US$ 12 |
| Cloud SQL                           | **db-g1-small** (recomendado para lançar)              | ~US$ 35–40                     |
| Cloud SQL                           | disco 10 GB SSD + backups 7 dias + logs de recuperação | ~US$ 3–5                       |
| Storage (KYC)                       | poucos GB de fotos                                     | ~US$ 0–1                       |
| Secret Manager, logs, monitoramento | uso baixo                                              | ~US$ 0–2                       |
| Tráfego de saída                    | depende do número de clientes (preços ao vivo)         | ~US$ 0,12–0,19 por GB          |

**Total para começar: ~US$ 65–75/mês** com db-g1-small, mais o tráfego.
Ficar no db-f1-micro durante o teste grátis: ~US$ 25–30/mês, mas só para poucos clientes.
Recomendo definir um alerta de orçamento em Faturamento → Orçamentos e alertas.

### Quando crescer

- **Banco**: db-f1-micro aguenta ~25 conexões; db-g1-small ~50; `db-custom-1-3840` (1 vCPU dedicada)
  100+ e ~US$ 70–80/mês. O `setup` ajusta os pools de conexão sozinho ao tamanho.
- **Alta disponibilidade** do banco (cópia em outra zona, troca automática): ~2× o preço do banco.
  `gcloud sql instances patch traderoom-48951-instance --availability-type REGIONAL`
- **VM**: e2-medium (4 GB) se a memória apertar com muitos WebSockets.

## O que fazer, em ordem

### 1. Antes (uma vez)

- [ ] Domínio comprado e acesso ao DNS dele.
- [ ] Chaves da EaglePay de **produção** (Painel → Integrações → API e Webhooks: Client ID, Public Key, Secret Key)
      e (opcional) chave do Resend para e-mails.
- [ ] Alerta de orçamento no Faturamento do Google Cloud.
- [ ] Rodar no seu PC: `npm ci && npm run typecheck && npm test` (o `release` repete isso).

### 2. Provisionar (cria e protege a infraestrutura)

No Git Bash, na raiz do projeto:

```sh
source infra/firebase.env
export TRADEROOM_DOMAIN=seudominio.com ACME_EMAIL=voce@seudominio.com
export EAGLE_CLIENT_ID='...' EAGLE_PUBLIC_KEY='...' EAGLE_SECRET_KEY='...'   # vão direto para o Secret Manager
export NOVUS_API_KEY='...'        # opcional: só enquanto houver transações abertas na Novus
export RESEND_API_KEY='...'       # opcional
export MAIL_FROM='Kyden <nao-responda@seudominio.com>'
# Para já sair do db-f1-micro (encerra o teste grátis do SQL Connect):
#   export SQL_RESIZE=1
infra/deploy.sh provision
```

Isso: liga as APIs, cria rede privada, firewall (só 80/443; SSH só pelo IAP), IP fixo, **adapta o
banco do Firebase** (IP privado, só TLS, backup diário + recuperação até o minuto, 7 dias), cria o
banco `traderoom` e o usuário com senha aleatória no Secret Manager, dá à VM acesso **só** ao bucket
do KYC e aos segredos dela, cria a VM e o monitor de uptime.

Atenção: ligar o IP privado reinicia o banco (1–2 min). Faça antes de ter clientes.

- [ ] Criar no DNS: `seudominio.com  A  <IP impresso no fim>`

### 3. Preparar a VM

```sh
infra/deploy.sh setup      # Node 22, Caddy, Redis, systemd (pode rodar de novo)
```

### 4. Publicar

```sh
infra/deploy.sh release    # testes, build, envio, migrations, troca e rollback automático
```

- [ ] Abrir `https://seudominio.com`, criar conta, fazer um depósito Pix pequeno de verdade.
- [ ] Promover seu usuário a admin (comando no README, seção Deploy).
- [ ] Enviar um KYC de teste e conferir a foto no Storage do Firebase e no painel admin.

### 5. Antes de abrir para clientes

- [ ] **Teste de carga** contra o domínio (`tests/load`, README "Teste de aceite") com o número de
      clientes que você espera no pico. Se o banco ou a VM saturarem, suba o tamanho.
- [ ] **Teste de restauração**: Cloud SQL → Backups → restaurar num clone. Backup que nunca foi
      restaurado não é garantia.
- [ ] Conferir o uptime check e criar um alerta de e-mail em Monitoring → Alertas.

### Novas versões

Só `infra/deploy.sh release`. Ele roda os testes, aplica migrations e volta para a versão
anterior sozinho se a nova não responder.

## Desenvolvimento no seu PC depois do lançamento

- Continue usando o **Postgres local** (`npm run dev:deps`) no `.env` do PC. Nunca aponte o PC para o
  banco de produção no dia a dia: um teste rodando por engano mexeria em saldos reais.
- `npm run db:tunnel` serve para manutenção pontual no banco da nuvem (ex.: consultar algo, rodar
  `npm run kyc:to-storage -w @traderoom/api -- --apply`). Use com o usuário e a senha do Secret Manager.
- Fotos do KYC no PC ficam no Postgres local (deixe `FIREBASE_STORAGE_BUCKET` vazio) ou num bucket
  separado de testes, nunca no de produção.

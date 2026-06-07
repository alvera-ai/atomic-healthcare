.PHONY: run-backing-services stop-backing-services ingest-knowledge build-identity-index run-careops-agent seed logs status help

# Backing services: Medplum (system of record) + Watchman (identity index).
# PostgreSQL and Redis run natively on the host.
COMPOSE := docker compose -f local-dependencies.yaml
PROFILE ?=

help: ## List targets
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'

run-backing-services: ## Start Medplum + Watchman (PROFILE=mail adds the mail catcher)
	@echo "Starting Medplum :8103 + Watchman :8084 (expects native Postgres :5432, Redis :6379)..."
	@echo "Waiting for healthchecks — first boot runs migrations, give it a minute. See docs/getting-started.md for one-time host setup."
	@$(COMPOSE) $(if $(PROFILE),--profile $(PROFILE),) up -d --wait

stop-backing-services: ## Stop and remove the containers
	@$(COMPOSE) down

ingest-knowledge: ## Load company knowledge into Moss (contracts + recent CMS judgements)
	@bun run ingest-knowledge

build-identity-index: ## Real data: FHIR export → Senzing (RECORD_ID = Patient id) → Watchman
	@bun run build-identity-index

seed: ## Demo cohort: Synthea → Medplum (FHIR bundles) + Watchman (identity)
	@bun run seed

run-careops-agent: ## Launch the CareOps voice agent (config via env / idiomatic OAuth)
	@bun run careops-agent

logs: ## Follow container logs
	@$(COMPOSE) logs -f

status: ## Show container status
	@$(COMPOSE) ps

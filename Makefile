.PHONY: run-backing-services stop-backing-services ingest-knowledge build-identity-index run-careops-agent synthea seed logs status help

# Backing services: Medplum (system of record) + Watchman (identity index).
# PostgreSQL and Redis run natively on the host.
COMPOSE := docker compose -f local-dependencies.yaml
PROFILE ?=

# Synthea — synthetic patient generator (Java). Emits FHIR R4 transaction bundles
# that Medplum imports natively via the FHIR batch endpoint.
SYNTHEA_JAR := tools/synthea-with-dependencies.jar
SYNTHEA_OUT := seed-output/synthea
SYNTHEA_POP ?= 20

# Force a small provider set: one facility per type (overrides Synthea's national
# CSVs in seed/providers/), so the cohort funnels to a handful of orgs/practitioners
# instead of ~69. Drop a line to let a type use Synthea's full national list.
SYNTHEA_PROVIDERS := \
	--generate.providers.hospitals.default_file seed/providers/hospitals.csv \
	--generate.providers.primarycare.default_file seed/providers/primary_care_facilities.csv \
	--generate.providers.urgentcare.default_file seed/providers/urgent_care_facilities.csv \
	--generate.providers.nursing.default_file seed/providers/nursing.csv \
	--generate.providers.longterm.default_file seed/providers/longterm.csv \
	--generate.providers.hospice.default_file seed/providers/hospice.csv \
	--generate.providers.dialysis.default_file seed/providers/dialysis.csv \
	--generate.providers.homehealth.default_file seed/providers/home_health_agencies.csv \
	--generate.providers.rehab.default_file seed/providers/rehab.csv \
	--generate.providers.veterans.default_file seed/providers/va_facilities.csv

help: ## List targets
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'

run-backing-services: ## Start Medplum + Watchman (PROFILE=mail adds the mail catcher)
	@echo "Starting Medplum :8103 + Watchman :8084 (expects native Postgres :5432, Redis :6379)..."
	@echo "Waiting for healthchecks — first boot runs migrations, give it a minute. See docs/getting-started.md for one-time host setup."
	@mkdir -p seed-output && [ -f seed-output/patients.jsonl ] || : > seed-output/patients.jsonl
	@$(COMPOSE) $(if $(PROFILE),--profile $(PROFILE),) up -d --wait

stop-backing-services: ## Stop and remove the containers
	@$(COMPOSE) down

ingest-knowledge: ## Load company knowledge into Moss (contracts + recent CMS judgements)
	@bun run ingest-knowledge

build-identity-index: ## Real data: FHIR export → Senzing (RECORD_ID = Patient id) → Watchman
	@bun run build-identity-index

$(SYNTHEA_JAR):
	@mkdir -p tools
	@echo "Downloading synthea-with-dependencies.jar (~80MB, one time)..."
	@curl -fL --progress-bar -o $(SYNTHEA_JAR) https://github.com/synthetichealth/synthea/releases/download/master-branch-latest/synthea-with-dependencies.jar

synthea: $(SYNTHEA_JAR) ## Generate a Synthea cohort (SYNTHEA_POP patients) → seed-output/synthea
	@echo "Generating $(SYNTHEA_POP) Synthea patients (FHIR R4 transaction bundles)..."
	@rm -rf $(SYNTHEA_OUT)
	@java -jar $(SYNTHEA_JAR) -p $(SYNTHEA_POP) -s 42 -cs 42 \
		--exporter.baseDirectory $(SYNTHEA_OUT) \
		--exporter.fhir.transaction_bundle true \
		--exporter.years_of_history 5 \
		--generate.only_alive_patients true \
		--generate.append_numbers_to_person_names false \
		$(SYNTHEA_PROVIDERS) \
		Florida Miami

seed: ## Import the Synthea cohort → Medplum + Watchman (run `make synthea` first)
	@bun run seed

run-careops-agent: ## Launch the CareOps voice agent (config via env / idiomatic OAuth)
	@bun run careops-agent

logs: ## Follow container logs
	@$(COMPOSE) logs -f

status: ## Show container status
	@$(COMPOSE) ps

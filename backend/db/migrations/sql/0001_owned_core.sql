DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moneylens_runtime') THEN
    CREATE ROLE moneylens_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'moneylens_runtime'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolcanlogin OR rolinherit)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'moneylens_runtime'
  ) THEN
    RAISE EXCEPTION 'moneylens_runtime must be an unprivileged NOLOGIN group without inherited memberships';
  END IF;
END $$;

CREATE SCHEMA moneylens;
REVOKE ALL ON SCHEMA moneylens FROM PUBLIC;
GRANT USAGE ON SCHEMA moneylens TO moneylens_runtime;

CREATE DOMAIN moneylens.currency AS text CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN moneylens.minor AS bigint CHECK (VALUE BETWEEN -9007199254740991 AND 9007199254740991);

CREATE TABLE moneylens.tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE moneylens.users (
  tenant_id uuid NOT NULL REFERENCES moneylens.tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  subject_issuer text NOT NULL,
  subject_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  permission_version bigint NOT NULL DEFAULT 1 CHECK (permission_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, subject_issuer, subject_id)
);
CREATE TABLE moneylens.user_state (
  tenant_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  id uuid NOT NULL,
  data_version bigint NOT NULL DEFAULT 1 CHECK (data_version > 0),
  plan_version bigint NOT NULL DEFAULT 1 CHECK (plan_version > 0),
  PRIMARY KEY (tenant_id, owner_user_id, id),
  UNIQUE (tenant_id, owner_user_id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.connections (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  provider text NOT NULL,
  provider_mode text NOT NULL CHECK (provider_mode IN ('synthetic','sandbox','live')),
  consent_state text NOT NULL CHECK (consent_state IN ('requested','authorizing','active','expired','revoked','denied')),
  consent_generation bigint NOT NULL DEFAULT 1 CHECK (consent_generation > 0),
  scopes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(scopes) = 'array'),
  expires_at timestamptz, revoked_at timestamptz, last_success_at timestamptz,
  secret_reference text,
  PRIMARY KEY (tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.accounts (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  name text NOT NULL, currency moneylens.currency NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('current','savings','credit','restricted')),
  included boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.account_source_aliases (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  account_id uuid NOT NULL, connection_id uuid NOT NULL, provider_account_id text NOT NULL,
  PRIMARY KEY (tenant_id,owner_user_id,id),
  UNIQUE (tenant_id,owner_user_id,connection_id,provider_account_id),
  FOREIGN KEY (tenant_id,owner_user_id,account_id) REFERENCES moneylens.accounts(tenant_id,owner_user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,owner_user_id,connection_id) REFERENCES moneylens.connections(tenant_id,owner_user_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.balance_snapshots (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  account_id uuid NOT NULL, amount_minor moneylens.minor NOT NULL, currency moneylens.currency NOT NULL,
  balance_kind text NOT NULL CHECK (balance_kind IN ('available','booked')),
  pending_reflection text NOT NULL CHECK (pending_reflection IN ('included','excluded','unknown')),
  included_credit_minor moneylens.minor NOT NULL DEFAULT 0 CHECK (included_credit_minor >= 0),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id,account_id) REFERENCES moneylens.accounts(tenant_id,owner_user_id,id) ON DELETE CASCADE
);
CREATE INDEX balance_latest ON moneylens.balance_snapshots (tenant_id,owner_user_id,account_id,observed_at DESC);
CREATE TABLE moneylens.import_batches (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  object_key text NOT NULL, source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_version text NOT NULL, source_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('staging','validating','published','failed','cancelled')),
  accepted_rows bigint NOT NULL DEFAULT 0 CHECK (accepted_rows >= 0),
  rejected_rows bigint NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
  published_at timestamptz,
  PRIMARY KEY (tenant_id,owner_user_id,id),
  UNIQUE (tenant_id,owner_user_id,source_sha256,mapping_version),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.transactions (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  account_id uuid NOT NULL, connection_id uuid, import_batch_id uuid,
  source_id text NOT NULL, source_revision bigint NOT NULL DEFAULT 1 CHECK (source_revision > 0),
  amount_minor moneylens.minor NOT NULL, currency moneylens.currency NOT NULL,
  booked_on date NOT NULL, value_on date, observed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('pending','booked','reversed')),
  merchant text NOT NULL, category text NOT NULL,
  basket text NOT NULL CHECK (basket IN ('mandatory_regular','mandatory_irregular','everyday','unresolved')),
  economic_flow text NOT NULL CHECK (economic_flow IN ('expense','refund','income','internal_transfer','liability_settlement','unknown')),
  related_transaction_id uuid,
  PRIMARY KEY (tenant_id,owner_user_id,id),
  UNIQUE NULLS NOT DISTINCT (tenant_id,owner_user_id,account_id,connection_id,source_id),
  FOREIGN KEY (tenant_id,owner_user_id,account_id) REFERENCES moneylens.accounts(tenant_id,owner_user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,owner_user_id,connection_id) REFERENCES moneylens.connections(tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id,import_batch_id) REFERENCES moneylens.import_batches(tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id,related_transaction_id) REFERENCES moneylens.transactions(tenant_id,owner_user_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX tx_owner_date ON moneylens.transactions (tenant_id,owner_user_id,booked_on DESC,id DESC)
  INCLUDE (amount_minor,currency,category,status,economic_flow);
CREATE TABLE moneylens.classification_corrections (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  transaction_id uuid NOT NULL, category text NOT NULL,
  basket text NOT NULL CHECK (basket IN ('mandatory_regular','mandatory_irregular','everyday','unresolved')),
  essentiality text NOT NULL CHECK (essentiality IN ('essential','flexible','unknown')),
  recurrence text NOT NULL CHECK (recurrence IN ('regular','irregular','unknown')),
  reason text NOT NULL, rule_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id,transaction_id) REFERENCES moneylens.transactions(tenant_id,owner_user_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.transfer_links (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  debit_id uuid NOT NULL, credit_id uuid NOT NULL, reason text NOT NULL,
  state text NOT NULL CHECK (state IN ('candidate','confirmed','rejected')),
  PRIMARY KEY (tenant_id,owner_user_id,id),
  CHECK (debit_id <> credit_id), UNIQUE (tenant_id,owner_user_id,debit_id,credit_id),
  FOREIGN KEY (tenant_id,owner_user_id,debit_id) REFERENCES moneylens.transactions(tenant_id,owner_user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,owner_user_id,credit_id) REFERENCES moneylens.transactions(tenant_id,owner_user_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.obligations (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  account_id uuid NOT NULL, amount_minor moneylens.minor NOT NULL CHECK (amount_minor >= 0),
  currency moneylens.currency NOT NULL, due_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('planned','paid','cancelled')), assumption_source text NOT NULL,
  PRIMARY KEY (tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id,account_id) REFERENCES moneylens.accounts(tenant_id,owner_user_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.reserves (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  account_id uuid NOT NULL, obligation_id uuid,
  kind text NOT NULL CHECK (kind IN ('essential','irregular','savings','buffer')),
  amount_minor moneylens.minor NOT NULL CHECK (amount_minor >= 0), currency moneylens.currency NOT NULL,
  consumed_minor moneylens.minor NOT NULL DEFAULT 0 CHECK (consumed_minor >= 0 AND consumed_minor <= amount_minor),
  PRIMARY KEY (tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id,account_id) REFERENCES moneylens.accounts(tenant_id,owner_user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,owner_user_id,obligation_id) REFERENCES moneylens.obligations(tenant_id,owner_user_id,id)
);
CREATE TABLE moneylens.plans (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  plan_version bigint NOT NULL CHECK (plan_version > 0), data_version bigint NOT NULL CHECK (data_version > 0),
  starts_at timestamptz NOT NULL, through_at timestamptz NOT NULL CHECK (through_at > starts_at),
  state text NOT NULL CHECK (state IN ('draft','active','superseded')),
  PRIMARY KEY (tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.plan_accounts (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  plan_id uuid NOT NULL, account_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,owner_user_id,id), UNIQUE (tenant_id,owner_user_id,plan_id,account_id),
  FOREIGN KEY (tenant_id,owner_user_id,plan_id) REFERENCES moneylens.plans(tenant_id,owner_user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,owner_user_id,account_id) REFERENCES moneylens.accounts(tenant_id,owner_user_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.goals (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  name text NOT NULL, target_minor moneylens.minor NOT NULL CHECK (target_minor > 0),
  currency moneylens.currency NOT NULL, deadline date NOT NULL,
  state text NOT NULL CHECK (state IN ('active','paused','completed')),
  PRIMARY KEY (tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.allocations (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  plan_id uuid NOT NULL, goal_id uuid, reserve_id uuid NOT NULL,
  amount_minor moneylens.minor NOT NULL CHECK (amount_minor > 0), currency moneylens.currency NOT NULL,
  idempotency_key text NOT NULL, accepted_plan_version bigint NOT NULL CHECK (accepted_plan_version > 0),
  PRIMARY KEY (tenant_id,owner_user_id,id), UNIQUE (tenant_id,owner_user_id,plan_id,idempotency_key),
  UNIQUE (tenant_id,owner_user_id,reserve_id),
  FOREIGN KEY (tenant_id,owner_user_id,plan_id) REFERENCES moneylens.plans(tenant_id,owner_user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,owner_user_id,goal_id) REFERENCES moneylens.goals(tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id,reserve_id) REFERENCES moneylens.reserves(tenant_id,owner_user_id,id)
);
CREATE TABLE moneylens.public_benchmark_releases (
  id text PRIMARY KEY, source_url text NOT NULL, table_id text NOT NULL,
  response_sha256 text NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  retrieved_at timestamptz NOT NULL, reference_period text NOT NULL,
  unit text NOT NULL, statistic_type text NOT NULL, mapping_version text NOT NULL,
  attribution text NOT NULL, licence_url text NOT NULL, manifest jsonb NOT NULL
);
CREATE TABLE moneylens.calculation_snapshots (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  data_version bigint NOT NULL CHECK (data_version > 0), calculation_version integer NOT NULL CHECK (calculation_version > 0),
  plan_id uuid, benchmark_release_id text REFERENCES moneylens.public_benchmark_releases(id),
  as_of timestamptz NOT NULL, status text NOT NULL CHECK (status IN ('ok','estimated','blocked','superseded')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND result ? 'amount_minor'),
  evidence jsonb NOT NULL, assumptions jsonb NOT NULL DEFAULT '[]', blockers jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id,owner_user_id,id),
  CHECK (jsonb_typeof(blockers) = 'array'),
  CHECK (status <> 'blocked' OR (result->'amount_minor' = 'null'::jsonb AND jsonb_array_length(blockers) > 0)),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,owner_user_id,plan_id) REFERENCES moneylens.plans(tenant_id,owner_user_id,id)
);
CREATE TABLE moneylens.conversation_turns (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  conversation_id uuid NOT NULL, calculation_id uuid,
  state text NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled')),
  idempotency_key text NOT NULL, message_content text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,owner_user_id,id), UNIQUE (tenant_id,owner_user_id,conversation_id,idempotency_key),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,owner_user_id,calculation_id) REFERENCES moneylens.calculation_snapshots(tenant_id,owner_user_id,id)
);
CREATE TABLE moneylens.jobs (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  type text NOT NULL, schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  state text NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled','dead_letter')),
  idempotency_key text NOT NULL, payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,owner_user_id,id), UNIQUE (tenant_id,owner_user_id,type,idempotency_key),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX jobs_ready ON moneylens.jobs (tenant_id,owner_user_id,state,available_at);
CREATE TABLE moneylens.outbox_events (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  type text NOT NULL, event_key text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  PRIMARY KEY (tenant_id,owner_user_id,id), UNIQUE (tenant_id,owner_user_id,event_key),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE moneylens.audit_events (
  tenant_id uuid NOT NULL, owner_user_id uuid NOT NULL, id uuid NOT NULL,
  action text NOT NULL, resource_id uuid, trace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id,owner_user_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES moneylens.users(tenant_id,id) ON DELETE CASCADE
);

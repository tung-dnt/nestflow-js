BEGIN;

CREATE TABLE workflow_orders (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('draft', 'submitted', 'finished', 'failed'))
);

CREATE TABLE workflow_transitions (
  order_id text NOT NULL REFERENCES workflow_orders (id),
  event_id text NOT NULL,
  workflow text NOT NULL,
  event text NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'unretriable', 'exhausted')),
  output_json text,
  available_at timestamptz,
  recovery_owner uuid,
  PRIMARY KEY (order_id, event_id),
  CHECK (outcome = 'applied' OR available_at IS NULL),
  CHECK (recovery_owner IS NULL OR available_at IS NOT NULL)
);

CREATE INDEX workflow_pending_transitions ON workflow_transitions (available_at)
WHERE available_at IS NOT NULL;

COMMIT;

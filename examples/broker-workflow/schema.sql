BEGIN;

CREATE TABLE workflow_orders (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('draft', 'submitted', 'finished', 'failed'))
);

CREATE TABLE workflow_transitions (
  order_id text NOT NULL REFERENCES workflow_orders (id),
  event_id text NOT NULL,
  to_status text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'unretriable', 'exhausted')),
  output_json text,
  history_json text,
  PRIMARY KEY (order_id, event_id)
);

COMMIT;

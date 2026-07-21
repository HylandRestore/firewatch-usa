-- FireWatch USA — Postgres schema (Supabase-compatible)
-- Run this once against your Supabase project (SQL Editor, or via the
-- migration runner in lib/db.js which applies it automatically on boot).

create extension if not exists "uuid-ossp";

-- Every fire/incident we've ever seen: NASA FIRMS wildfire clusters,
-- NIFC perimeters, and FireNotification structural incidents.
create table if not exists incidents (
  id              text primary key,         -- source-native id (FIRMS cluster id, FN incidentId, etc.)
  source          text not null,             -- 'firms_wildfire' | 'fn_structural' | 'nifc'
  incident_type   text,                      -- e.g. 'HOUSE | FIRE', 'wildfire'
  structure_type  text,
  status          text default 'active',     -- 'active' | 'closed'
  alarm           int,
  line1           text,
  city            text,
  county          text,
  state           text,
  zip             text,
  lat             double precision not null,
  lon             double precision not null,
  frp             double precision,          -- fire radiative power (MW) — intensity proxy
  detections      int default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  closed_at       timestamptz,
  raw_payload     jsonb,
  inserted_at     timestamptz not null default now()
);
create index if not exists idx_incidents_source on incidents(source);
create index if not exists idx_incidents_status on incidents(status);
create index if not exists idx_incidents_created on incidents(created_at desc);

-- Per-incident, per-timestamp, per-altitude wind observations.
-- Lets us couple wind history to a specific incident's timeline instead of
-- one global wind reading, and lets the smoke-cone calc use elevated wind
-- (surface vs 10m vs 80m vs 120m vs 180m) rather than a single flat value.
create table if not exists weather_snapshots (
  id              bigserial primary key,
  incident_id     text not null references incidents(id) on delete cascade,
  observed_at     timestamptz not null default now(),
  altitude_m      numeric not null,          -- 0 = surface, 10, 80, 120, 180
  wind_speed_ms   numeric,
  wind_dir_deg    numeric,
  gust_ms         numeric,
  temperature_c   numeric,
  source          text default 'open-meteo',
  raw             jsonb
);
create index if not exists idx_weather_incident on weather_snapshots(incident_id, observed_at desc);

-- Cached real building footprints pulled from OSM Overpass, so we don't
-- re-query Overpass every time the same structure shows up near a new fire.
create table if not exists structures (
  id              text primary key,          -- 'osm:<type>:<id>'
  osm_id          text,
  osm_type        text,                       -- way | node | relation
  lat             double precision not null,  -- centroid
  lon             double precision not null,
  geom            jsonb,                      -- GeoJSON footprint (polygon coords), when available
  building_type   text,                       -- OSM building=* tag
  name            text,
  address         text,
  fetched_at      timestamptz not null default now()
);
create index if not exists idx_structures_latlon on structures(lat, lon);

-- One row per (incident, structure, computed_at): the risk assessment.
-- This is the table the risk model reads from/writes to, and the table the
-- future Monday.com feedback loop will join against to compare predicted
-- vs. actual outcomes.
create table if not exists incident_structures (
  id                  bigserial primary key,
  incident_id         text not null references incidents(id) on delete cascade,
  structure_id        text not null references structures(id) on delete cascade,
  computed_at         timestamptz not null default now(),
  distance_m          numeric,
  bearing_deg         numeric,
  wind_dir_deg        numeric,
  wind_speed_ms       numeric,
  stability_class     int,
  smoke_cone_reach_m  numeric,
  in_cone             boolean,
  risk_score          numeric,               -- 0.0–1.0 probability of smoke/ash damage
  risk_tier           text,                  -- High | Moderate | Low
  model_version       text,
  inputs              jsonb,                 -- full snapshot of factors used, for auditability/retraining
  unique(incident_id, structure_id, computed_at)
);
create index if not exists idx_incstruct_incident on incident_structures(incident_id);
create index if not exists idx_incstruct_structure on incident_structures(structure_id);

-- Ground-truth outcomes. Starts empty/manual; the Monday.com integration
-- (later) will insert rows here whenever a real inspection closes out,
-- which is what lets the risk model be recalibrated over time.
create table if not exists feedback_outcomes (
  id                    bigserial primary key,
  incident_structure_id bigint references incident_structures(id) on delete cascade,
  inspected_at          timestamptz default now(),
  damage_observed       boolean,
  damage_severity       text,               -- none | light | moderate | severe
  source                text default 'manual',  -- 'manual' | 'monday'
  notes                 text,
  raw                   jsonb
);
create index if not exists idx_feedback_incstruct on feedback_outcomes(incident_structure_id);

-- Versioned scoring coefficients so the risk model can be recalibrated
-- from feedback_outcomes without losing the history of past predictions.
create table if not exists model_versions (
  version       text primary key,
  description   text,
  coefficients  jsonb,
  created_at    timestamptz not null default now()
);

insert into model_versions (version, description, coefficients)
values ('v0-heuristic', 'Initial rudimentary heuristic model, pre-calibration', '{
  "distance_decay": 1.5,
  "intensity_weight": 0.35,
  "duration_weight": 0.15,
  "wind_speed_weight": 0.25,
  "stability_weight": 0.25
}'::jsonb)
on conflict (version) do nothing;

import type { Pool } from "pg";

/** Additive, idempotent schema only. Epoch activation is a separate release action. */
export async function ensureProductionDatabaseAdmissionSchema(
  connection: Pick<Pool, "query">,
): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS public.production_database_admission_epochs (
      epoch uuid PRIMARY KEY,
      namespace text NOT NULL DEFAULT 'production',
      state text NOT NULL DEFAULT 'prepared',
      worker_deployment_version text NOT NULL,
      evidence_sha256 text NOT NULL,
      observed_at timestamptz NOT NULL,
      activated_at timestamptz,
      project_id_floor integer NOT NULL,
      CONSTRAINT production_database_admission_epoch_namespace_check
        CHECK (namespace = 'production'),
      CONSTRAINT production_database_admission_epoch_state_check
        CHECK (state IN ('prepared', 'active', 'closed')),
      CONSTRAINT production_database_admission_epoch_evidence_check
        CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'
          AND length(worker_deployment_version) BETWEEN 1 AND 200
          AND project_id_floor >= 0),
      CONSTRAINT production_database_admission_epoch_drain_check
        CHECK (state <> 'active' OR (activated_at IS NOT NULL
          AND activated_at >= observed_at + interval '6 minutes'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS production_database_admission_epoch_active_uq
      ON public.production_database_admission_epochs (namespace) WHERE state = 'active';

    -- Privacy-minimal, non-cascading authorization receipt, not project content.
    CREATE TABLE IF NOT EXISTS public.production_database_admission_receipts (
      project_id integer PRIMARY KEY,
      registration_epoch uuid NOT NULL REFERENCES public.production_database_admission_epochs(epoch),
      birth_token uuid NOT NULL,
      birth_registered boolean NOT NULL,
      allocation_identity text,
      state text NOT NULL,
      authorization_id uuid,
      seal_id uuid,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT production_database_admission_receipt_project_check CHECK (project_id > 0),
      CONSTRAINT production_database_admission_receipt_identity_check
        CHECK (allocation_identity IS NULL OR allocation_identity ~ '^[0-9a-f]{64}$'),
      CONSTRAINT production_database_admission_receipt_state_check CHECK (
        (state = 'fresh' AND birth_registered AND authorization_id IS NULL AND seal_id IS NULL)
        OR (state = 'authorized' AND allocation_identity IS NOT NULL
          AND authorization_id IS NOT NULL AND seal_id IS NULL)
        OR (state = 'sealed' AND allocation_identity IS NOT NULL AND seal_id IS NOT NULL)
      )
    );

    CREATE OR REPLACE FUNCTION public.guard_production_database_admission_receipt()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'production_database_admission_receipt_retained';
      END IF;
      IF ROW(NEW.project_id, NEW.registration_epoch, NEW.birth_token,
             NEW.birth_registered, NEW.created_at)
          IS DISTINCT FROM
         ROW(OLD.project_id, OLD.registration_epoch, OLD.birth_token,
             OLD.birth_registered, OLD.created_at)
        OR (OLD.allocation_identity IS NOT NULL
          AND NEW.allocation_identity IS DISTINCT FROM OLD.allocation_identity)
        OR (OLD.authorization_id IS NOT NULL
          AND NEW.authorization_id IS DISTINCT FROM OLD.authorization_id)
        OR (OLD.state = 'sealed' AND NEW IS DISTINCT FROM OLD)
        OR (OLD.state = 'authorized' AND NEW.state NOT IN ('authorized', 'sealed'))
      THEN
        RAISE EXCEPTION 'production_database_admission_receipt_immutable';
      END IF;
      RETURN NEW;
    END;
    $guard$;

    CREATE OR REPLACE FUNCTION public.register_production_database_project_birth()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $birth$
    DECLARE
      active_epoch public.production_database_admission_epochs%ROWTYPE;
      sequence_name text;
      generated_id bigint;
    BEGIN
      IF EXISTS (SELECT 1 FROM public.production_database_admission_receipts
                 WHERE project_id = NEW.id) THEN
        RAISE EXCEPTION 'production_database_project_identity_reused';
      END IF;
      SELECT * INTO active_epoch FROM public.production_database_admission_epochs
        WHERE namespace = 'production' AND state = 'active'
          AND activated_at <= clock_timestamp() FOR SHARE;
      IF NOT FOUND THEN
        -- Never retrofit a pre-cutover insert into authoritative birth history.
        RETURN NEW;
      END IF;
      sequence_name := pg_get_serial_sequence('public.projects', 'id');
      IF sequence_name IS NULL OR NEW.id <= active_epoch.project_id_floor THEN
        RAISE EXCEPTION 'production_database_birth_identity_untrusted';
      END IF;
      BEGIN
        generated_id := currval(sequence_name::regclass);
      EXCEPTION WHEN object_not_in_prerequisite_state THEN
        RAISE EXCEPTION 'production_database_birth_identity_untrusted';
      END;
      IF generated_id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'production_database_birth_identity_untrusted';
      END IF;
      INSERT INTO public.production_database_admission_receipts
        (project_id, registration_epoch, birth_token, birth_registered, state)
        VALUES (NEW.id, active_epoch.epoch, gen_random_uuid(), true, 'fresh');
      RETURN NEW;
    END;
    $birth$;

    DO $install$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid =
          'public.production_database_admission_receipts'::regclass
          AND tgname = 'production_database_admission_receipt_guard') THEN
        CREATE TRIGGER production_database_admission_receipt_guard
          BEFORE UPDATE OR DELETE ON public.production_database_admission_receipts
          FOR EACH ROW EXECUTE FUNCTION public.guard_production_database_admission_receipt();
      END IF;
      -- Validate currval while it still belongs to this row, including bulk inserts.
      -- A generated ID skipped by ON CONFLICT retains only a conservative reservation;
      -- without a project row it cannot authorize allocation or a new release seal.
      -- Replace the earlier AFTER trigger as well as installing on a fresh database.
      CREATE OR REPLACE TRIGGER production_database_project_birth BEFORE INSERT ON public.projects
        FOR EACH ROW EXECUTE FUNCTION public.register_production_database_project_birth();
    END;
    $install$;
  `);
}

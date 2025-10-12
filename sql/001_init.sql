-- Users
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  cpf text UNIQUE SET NOT NULL,
  phone text,
  name text,
  qr_payload text,
  qr_image_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2) coluna gerada só com dígitos do CPF (normalização)
--    usar regexp_replace é uma prática comum no Postgres para normalizar entradas. 
--    (ex: remover não-dígitos)  :contentReference[oaicite:1]{index=1}
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS cpf_digits text
  GENERATED ALWAYS AS (regexp_replace(coalesce(cpf,''), '\D', '', 'g')) STORED;

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS cpf_digits   text GENERATED ALWAYS AS (regexp_replace(coalesce(cpf,''),   '\D', '', 'g')) STORED,
ADD COLUMN IF NOT EXISTS phone_digits text GENERATED ALWAYS AS (regexp_replace(coalesce(phone,''), '\D', '', 'g')) STORED,
ADD COLUMN IF NOT EXISTS email_canonical text GENERATED ALWAYS AS (lower(coalesce(email,''))) STORED;
-- 4) unicidade obrigatória de CPF e telefone (em dígitos)
CREATE UNIQUE INDEX IF NOT EXISTS users_cpf_digits_key   ON public.users (cpf_digits);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_digits_key ON public.users (phone_digits);
-- 5) (opcional) checks simples de formato:
-- CPF sempre 11 dígitos / telefone 10..13 (ex.: 5511999999999)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_cpf_digits_len'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_cpf_digits_len CHECK (char_length(cpf_digits)=11);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_phone_digits_len'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_phone_digits_len CHECK (char_length(phone_digits) BETWEEN 10 AND 13);
  END IF;
END$$;

-- Sessions (16h e 19h)
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  venue_name text,
  venue_address text,
  status text NOT NULL DEFAULT 'on_sale', -- on_sale | closed | archived
  created_at timestamptz DEFAULT now()
);

-- Seats (por sessão)
CREATE TABLE IF NOT EXISTS seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  floor text, -- "1", "2", "3"
  row_label text NOT NULL,
  seat_number int NOT NULL,
  base_price numeric(10,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'available', -- available | reserved | sold | blocked
  reserve_expires timestamptz,
  reserve_token text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (session_id, row_label, seat_number)
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending', -- pending | awaiting_payment | paid | expired | canceled
  total_amount numeric(10,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'BRL',
  provider text, -- mercado_pago
  provider_ref text UNIQUE,
  checkout_url text,
  paid_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Order Items
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  seat_id uuid NOT NULL REFERENCES seats (id) ON DELETE RESTRICT,
  price numeric(10,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'reserved', -- reserved | issued | checked_in | void
  reserve_expires timestamptz,
  ticket_image_url text,
  checked_in_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_seats_session_status ON seats(session_id, status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_status ON order_items(status);
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_seats_session_status ON seats(session_id, status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_status ON order_items(status);
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);

-- 1) Assentos únicos por sessão
alter table seats add constraint seats_unique unique (session_id, row_label, seat_number);

-- 2) Índices úteis
create index if not exists idx_seats_session_floor on seats(session_id, floor);
create index if not exists idx_seats_reserve_token on seats(reserve_token);
create index if not exists idx_seats_status on seats(status);

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

create or replace function parse_seat_code(code text, out row_label text, out seat_number int)
language sql immutable as $$
  select split_part(code,'-',1), split_part(code,'-',2)::int
$$;

CREATE OR REPLACE FUNCTION seat_hold(
  p_session_id uuid,
  p_floor text,
  p_seat_codes text[],
  p_ttl_sec int DEFAULT 600,
  p_reserve_token text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_token     text := coalesce(p_reserve_token, encode(gen_random_bytes(16), 'hex'));
  v_total     int;
  v_conflicts text[];
  v_expires   timestamptz;
BEGIN
  -- limpa reservas expiradas
  UPDATE seats
     SET status='available', reserve_expires=NULL, reserve_token=NULL
   WHERE session_id = p_session_id
     AND status = 'reserved'
     AND reserve_expires <= now();

  -- tranca as linhas alvo
  WITH wanted AS (
    SELECT (parse_seat_code(c)).row_label AS row_label,
           (parse_seat_code(c)).seat_number AS seat_number
      FROM unnest(p_seat_codes) AS t(c)
  ),
  locked AS (
    SELECT s.*
      FROM seats s
      JOIN wanted w
        ON w.row_label = s.row_label
       AND w.seat_number = s.seat_number
     WHERE s.session_id = p_session_id
       AND s.floor::text = p_floor
     FOR UPDATE
  )
  SELECT COUNT(*) INTO v_total FROM locked;

  IF v_total <> cardinality(p_seat_codes) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- conflitos?
  SELECT coalesce(array_agg(l.row_label || '-' || lpad(l.seat_number::text,2,'0')), '{}')
    INTO v_conflicts
    FROM (
      SELECT row_label, seat_number
        FROM seats s
        JOIN (SELECT (parse_seat_code(c)).row_label rl,
                     (parse_seat_code(c)).seat_number sn
                FROM unnest(p_seat_codes) t(c)) x
          ON x.rl = s.row_label AND x.sn = s.seat_number
       WHERE s.session_id = p_session_id
         AND s.floor::text = p_floor
         AND s.status <> 'available'
    ) l;

  IF array_length(v_conflicts,1) IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unavailable', 'conflicts', v_conflicts);
  END IF;

  -- aplica a reserva usando SEMPRE o mesmo v_token
  UPDATE seats s
     SET status='reserved',
         reserve_token = v_token,
         reserve_expires = now() + (p_ttl_sec || ' seconds')::interval
    FROM (SELECT (parse_seat_code(c)).row_label rl,
                 (parse_seat_code(c)).seat_number sn
            FROM unnest(p_seat_codes) t(c)) x
   WHERE s.session_id = p_session_id
     AND s.floor::text = p_floor
     AND s.row_label = x.rl
     AND s.seat_number = x.sn
     AND s.status = 'available';

  SELECT min(reserve_expires) INTO v_expires
    FROM seats s
   WHERE s.session_id = p_session_id
     AND s.reserve_token = v_token;

  RETURN jsonb_build_object(
    'ok', true,
    'reserveToken', v_token,
    'seats', p_seat_codes,
    'expiresAt', v_expires
  );
END;
$$;

create or replace function seat_release(
  p_session_id uuid,
  p_reserve_token text,
  p_seat_codes text[]
) returns jsonb
language plpgsql
as $$
begin
  update seats s
     set status='available', reserve_expires=null, reserve_token=null
    from (select (parse_seat_code(c)).row_label rl,
                 (parse_seat_code(c)).seat_number sn
            from unnest(p_seat_codes) t(c)) x
   where s.session_id = p_session_id
     and s.reserve_token = p_reserve_token
     and s.row_label = x.rl
     and s.seat_number = x.sn
     and s.status='reserved';

  return jsonb_build_object('ok', true);
end;
$$;

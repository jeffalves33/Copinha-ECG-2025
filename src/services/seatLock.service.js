const dayjs = require('dayjs');
const { pool } = require('./db');
const { nanoid } = require('nanoid');

/**
 * Tenta reservar (hold) uma lista de assentos com TTL.
 * - idempotente por reserve_token: no mesmo token, pode acrescentar/remover
 */
async function holdSeats({ sessionId, floor, seatCodes, ttlSec = 600 }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1) liberar travas expiradas (higienização local)
        await client.query(
            `UPDATE seats
         SET status='available', reserve_expires=NULL, reserve_token=NULL
       WHERE session_id=$1 AND status='reserved' AND reserve_expires <= NOW()`,
            [sessionId]
        );

        // 2) mapear códigos "A-05" -> (row_label='A', seat_number=5)
        const pairs = seatCodes.map(code => {
            const [row, num] = code.split('-');
            return `('${row}', ${Number(num)})`;
        }).join(',');

        // pegar ids dos assentos do andar
        const { rows: found } = await client.query(
            `SELECT id, row_label, seat_number, status
         FROM seats
        WHERE session_id=$1 AND floor=$2
          AND (row_label, seat_number) IN (${pairs})
        FOR UPDATE`, // lock nas linhas consultadas
            [sessionId, floor]
        );

        if (found.length !== seatCodes.length) {
            throw new Error('Alguns assentos não existem para este andar/sessão');
        }

        // 3) verificar disponibilidade
        const unavailable = found.filter(r => r.status !== 'available');
        if (unavailable.length) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'unavailable', conflicts: unavailable.map(r => `${r.row_label}-${String(r.seat_number).padStart(2, '0')}`) };
        }

        // 4) reservar com token + TTL
        const token = nanoid(24);
        const { rows: updated } = await client.query(
            `UPDATE seats
          SET status='reserved',
              reserve_token=$1,
              reserve_expires=NOW() + ($2 || ' seconds')::interval
        WHERE id = ANY($3::uuid[])
        RETURNING id, row_label, seat_number, reserve_expires`,
            [token, String(ttlSec), found.map(f => f.id)]
        );

        await client.query('COMMIT');
        return { ok: true, reserveToken: token, seats: updated.map(r => `${r.row_label}-${String(r.seat_number).padStart(2, '0')}`), expiresAt: updated[0]?.reserve_expires };
    } catch (e) {
        await pool.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

async function releaseSeats({ sessionId, reserveToken, seatCodes }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const pairs = seatCodes.map(code => {
            const [row, num] = code.split('-');
            return `('${row}', ${Number(num)})`;
        }).join(',');

        await client.query(
            `UPDATE seats
          SET status='available', reserve_expires=NULL, reserve_token=NULL
        WHERE session_id=$1
          AND reserve_token=$2
          AND (row_label, seat_number) IN (${pairs})
          AND status='reserved'`,
            [sessionId, reserveToken]
        );

        await client.query('COMMIT');
        return { ok: true };
    } catch (e) {
        await pool.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { holdSeats, releaseSeats };

const { supabase } = require('../services/supabase');

async function getSeats(req, res, next) {
    try {
        const { sessionId, floor } = req.query;
        const { data, error } = await supabase
            .from('seats')
            .select('row_label, seat_number, status')
            .eq('session_id', sessionId)
            .eq('floor', String(floor))
            .order('row_label', { ascending: true })
            .order('seat_number', { ascending: true });

        if (error) throw error;

        res.json(
            data.map(r => ({
                code: `${r.row_label}-${String(r.seat_number).padStart(2, '0')}`,
                status: r.status
            }))
        );
    } catch (e) { next(e); }
}

async function postHold(req, res, next) {
    try {
        const { sessionId, floor, seats, ttlSec, reserveToken } = req.body;
        const { data, error } = await supabase.rpc('seat_hold', {
            p_session_id: sessionId,
            p_floor: String(floor),
            p_seat_codes: seats,
            p_ttl_sec: ttlSec || 600,
            p_reserve_token: reserveToken || null
        });
        if (error) throw error;

        res.status(data.ok ? 200 : 409).json(data);
    } catch (e) { next(e); }
}

async function postRelease(req, res, next) {
    try {
        const { sessionId, reserveToken, seats } = req.body;
        const { data, error } = await supabase.rpc('seat_release', {
            p_session_id: sessionId,
            p_reserve_token: reserveToken,
            p_seat_codes: seats
        });
        if (error) throw error;
        res.json(data);
    } catch (e) { next(e); }
}

module.exports = { getSeats, postHold, postRelease };

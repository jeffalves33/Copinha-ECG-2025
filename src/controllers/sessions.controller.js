//controllers/sessions.controller.js
const { supabase } = require('../services/supabase');

async function listSessions(req, res, next) {
    try {
        const { data, error } = await supabase
            .from('sessions')
            .select('id, name, starts_at, ends_at, venue_name, venue_address, status')
            .neq('status', 'archived')
            .order('starts_at', { ascending: true });

        if (error) throw error;

        res.json(data);
    } catch (e) {
        next(e);
    }
}

module.exports = { listSessions };

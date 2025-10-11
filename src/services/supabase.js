const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY, // backend: service role
    {
        auth: { persistSession: false },
        global: { headers: { 'X-Client-Info': 'auditorio-backend/0.1' } }
    }
);

module.exports = { supabase };

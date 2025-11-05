require('dotenv').config();
const { supabase } = require('../services/supabase');

const FLOORS = {
    '1': {
        ROWS_DEF: [
            { id: 'A', blocks: [5, 12, 6] },
            { id: 'B', blocks: [7, 12, 7] },
            { id: 'C', blocks: [8, 12, 8] },
            { id: 'D', blocks: [8, 12, 8] },
            { id: 'E', blocks: [8, 12, 8] },
            { id: 'F', blocks: [8, 12, 8] },
            { id: 'G', blocks: [8, 12, 8] },
            { id: 'H', blocks: [8, 12, 8] },
            { id: 'I', blocks: [8, 12, 8] },
            { id: 'J', blocks: [8, 12, 8] },
            { id: 'K', blocks: [8, 12, 8] },
            { id: 'L', blocks: [7, 10, 8] },
        ],
        WHEELCHAIR: new Set(['A-06', 'A-23', 'L-08', 'L-09', 'L-15', 'L-18', 'L-19', 'L-25'])
    },
    '2': {
        ROWS_DEF: [
            { id: 'A', blocks: [2, 0, 2] },
            { id: 'B', blocks: [2, 0, 2] },
            { id: 'C', blocks: [2, 0, 2] },
            { id: 'D', blocks: [2, 0, 2] },
            { id: 'E', blocks: [2, 0, 2] },
            { id: 'F', blocks: [2, 0, 2] },
            { id: 'G', blocks: [8, 0, 8] },
            { id: 'H', blocks: [2, 0, 2] },
        ],
        WHEELCHAIR: new Set([]),
    },
    '3': {
        ROWS_DEF: [
            { id: 'AA', blocks: [0, 7, 0] },
            { id: 'A', blocks: [5, 9, 4] },
            { id: 'B', blocks: [5, 9, 5] },
            { id: 'C', blocks: [4, 11, 4] },
            { id: 'D', blocks: [4, 11, 4] },
            { id: 'E', blocks: [8, 12, 8] },
            { id: 'F', blocks: [8, 12, 8] },
            { id: 'G', blocks: [8, 12, 8] },
            { id: 'H', blocks: [8, 13, 8] },
            { id: 'I', blocks: [8, 13, 8] },
            { id: 'J', blocks: [7, 13, 8] },
            { id: 'K', blocks: [6, 12, 12] },
        ],
        WHEELCHAIR: new Set([]),
    },
};

function expandRow(row) {
    const total = row.blocks.reduce((a, b) => a + b, 0);
    const list = [];
    for (let i = 1; i <= total; i++) list.push(i);
    return list;
}

(async function main() {
    // 1) cria (ou pega) sessões
    const sessions = [
        { name: '16h', starts_at: '2025-12-14T16:00:00-03', ends_at: '2025-12-14T19:00:00-03', venue_name: 'Sesc Glória', venue_address: 'Av. Jerônimo Monteiro, 428 - Centro - Vitória/ES' },
        { name: '19h', starts_at: '2025-12-14T19:00:00-03', ends_at: '2025-12-14T22:00:00-03', venue_name: 'Sesc Glória', venue_address: 'Av. Jerônimo Monteiro, 428 - Centro - Vitória/ES' },
    ];
    const { data: up, error: upErr } = await supabase.from('sessions').upsert(sessions, { onConflict: 'name' }).select('id,name');
    if (upErr) throw upErr;

    // mapear nome->id
    const map = new Map(up.map(s => [s.name, s.id]));
    const price = 70;

    for (const sessionName of ['16h', '19h']) {
        const session_id = map.get(sessionName);

        for (const floor of ['1', '2', '3']) {
            const payload = [];
            for (const row of FLOORS[floor].ROWS_DEF) {
                for (const n of expandRow(row)) {
                    const code = `${row.id}-${String(n).padStart(2, '0')}`;
                    const isWC = FLOORS[floor].WHEELCHAIR.has(code);
                    payload.push({
                        session_id, floor: String(floor),
                        row_label: row.id, seat_number: n,
                        base_price: price,
                        status: 'available'
                    });
                }
            }
            // upsert em lotes de 500
            while (payload.length) {
                const batch = payload.splice(0, 500);
                const { error } = await supabase.from('seats').upsert(batch, { onConflict: 'session_id,floor,row_label,seat_number' });
                if (error) throw error;
            }
        }
    }

    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

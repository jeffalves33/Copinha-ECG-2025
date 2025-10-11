function toCSV(rows) {
    if (!rows?.length) return 'order_id,buyer,contact,seats,total,paid_at\n';
    const header = Object.keys(rows[0]);
    const esc = (v) => {
        const s = String(v ?? '');
        return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const r of rows) {
        lines.push(header.map(k => esc(r[k])).join(','));
    }
    return lines.join('\n');
}
module.exports = { toCSV };

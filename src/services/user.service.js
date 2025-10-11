const { supabase } = require('./supabase');

function toDigits(phone) {
    return (phone || '').replace(/\D/g, '');
}
function toCanonical(email) {
    return (email || '').trim().toLowerCase();
}

/**
 * Regras:
 * - Busca por email_canonical OU phone_digits.
 * - Se achou 0 -> cria.
 * - Se achou 1 -> retorna o existente; se vier novo nome/telefone, atualiza (opcional).
 * - Se achou 1 mas telefone pertence a outro email divergente -> 409.
 * - Se achou >1 (incomum) -> 409 pedindo para usar o mesmo email/telefone.
 */
async function getOrCreateUser({ name, email, phone }) {
    const emailC = toCanonical(email);
    const phoneD = toDigits(phone);

    // busca por qualquer um dos dois
    const { data: found, error: ferr } = await supabase
        .from('users')
        .select('id, name, email, phone, email_canonical, phone_digits')
        .or(`email_canonical.eq.${emailC},phone_digits.eq.${phoneD}`);

    if (ferr) throw ferr;

    if (!found || found.length === 0) {
        // cria novo
        const { data: ins, error: ierr } = await supabase
            .from('users')
            .insert([{ name, email: emailC, phone }])
            .select('id')
            .single();
        if (ierr) {
            // pode ter batido em UNIQUE por corrida -> tenta buscar de novo
            if (ierr.code === '23505') {
                const { data: again } = await supabase
                    .from('users')
                    .select('id')
                    .or(`email_canonical.eq.${emailC},phone_digits.eq.${phoneD}`)
                    .limit(1)
                    .single();
                if (again) return again;
            }
            throw ierr;
        }
        return ins;
    }

    if (found.length > 1) {
        // situação inconsistente: pegue o que bate por email e verifique
        const byEmail = found.find(u => u.email_canonical === emailC);
        if (byEmail) return byEmail;
        const byPhone = found.find(u => u.phone_digits === phoneD);
        if (byPhone && byPhone.email_canonical !== emailC) {
            const err = new Error('Este telefone já está associado a outro e-mail. Use o mesmo e-mail ou outro telefone.');
            err.status = 409;
            throw err;
        }
        const err = new Error('Conflito de identidade. Use o mesmo e-mail/telefone desta compra.');
        err.status = 409;
        throw err;
    }

    // found.length === 1
    const u = found[0];

    // se telefone pertence a um usuário com email diferente (incomum aqui), bloqueia
    if (u.phone_digits && u.email_canonical !== emailC && u.phone_digits === phoneD) {
        const err = new Error('Este telefone já está associado a outro e-mail. Use o mesmo e-mail ou outro telefone.');
        err.status = 409;
        throw err;
    }

    // opcional: atualizar nome/telefone se mudou
    const needsUpdate =
        (name && name !== u.name) ||
        (phone && toDigits(u.phone || '') !== phoneD);

    if (needsUpdate) {
        await supabase.from('users')
            .update({ name, phone })
            .eq('id', u.id);
    }

    return { id: u.id };
}

module.exports = { getOrCreateUser, toCanonical, toDigits };

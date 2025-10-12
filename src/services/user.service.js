// src/services/user.service.js
const { supabase } = require('./supabase');

// normalizações
function onlyDigits(v) { return (v || '').replace(/\D/g, ''); }
function toCanonicalEmail(email) { return (email || '').trim().toLowerCase(); }

// valida CPF (módulo 11, 2 dígitos)
function isValidCPF(raw) {
    const cpf = onlyDigits(raw);
    if (!cpf || cpf.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false; // rejeita repetidos 000.. 111.. etc.

    // 1º dígito
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
    let rest = (sum * 10) % 11;
    if (rest === 10) rest = 0;
    if (rest !== Number(cpf[9])) return false;

    // 2º dígito
    sum = 0;
    for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
    rest = (sum * 10) % 11;
    if (rest === 10) rest = 0;
    return rest === Number(cpf[10]);
}

/**
 * NOVA regra de identidade:
 * - CPF e Telefone são obrigatórios e únicos.
 * - E-mail pode repetir.
 * - Se CPF e Telefone apontarem para usuários diferentes -> 409 claro informando o campo divergente.
 */
async function getOrCreateUser({ name, email, phone, cpf }) {
    const cpfD = onlyDigits(cpf);
    const phoneD = onlyDigits(phone);
    const emailC = toCanonicalEmail(email);

    // validações básicas
    if (!cpfD || !isValidCPF(cpfD)) {
        const err = new Error('CPF inválido. Verifique os 11 dígitos.');
        err.status = 400; throw err;
    }
    if (!phoneD || phoneD.length < 10) {
        const err = new Error('Telefone inválido. Informe DDD + número.');
        err.status = 400; throw err;
    }

    // busca por cpf e por telefone separadamente
    const { data: byCPF, error: e1 } = await supabase
        .from('users').select('id, phone_digits').eq('cpf_digits', cpfD).maybeSingle();
    if (e1) throw e1;

    const { data: byPhone, error: e2 } = await supabase
        .from('users').select('id, cpf_digits').eq('phone_digits', phoneD).maybeSingle();
    if (e2) throw e2;

    // conflitos explícitos
    if (byCPF && byPhone && byCPF.id !== byPhone.id) {
        const err = new Error('Telefone e CPF pertencem a usuários diferentes. Verifique qual dado está incorreto.');
        err.status = 409; throw err;
    }
    if (byCPF && byPhone && byCPF.id === byPhone.id) {
        return { id: byCPF.id }; // mesmo usuário => OK
    }

    if (byCPF && !byPhone) {
        // CPF existe, telefone não: só permitir se o CPF ainda não tem telefone ou for o mesmo
        await supabase.from('users').update({ phone }).eq('id', byCPF.id);
        return { id: byCPF.id };
    }

    if (!byCPF && byPhone) {
        // Telefone existe (com outro CPF) => não permitir
        const err = new Error('Telefone já cadastrado com outro CPF. Corrija o telefone.');
        err.status = 409; throw err;
    }

    // nenhum existe => cria novo
    const { data: ins, error: ierr } = await supabase
        .from('users')
        .insert([{ name, email: emailC, phone, cpf }])
        .select('id')
        .single();

    if (ierr) {
        // corrida de índice único: tenta descobrir qual campo conflitou
        if (ierr.code === '23505') {
            const { data: againCPF } = await supabase.from('users').select('id').eq('cpf_digits', cpfD).maybeSingle();
            if (againCPF) {
                const err = new Error('CPF já cadastrado. Corrija o CPF.');
                err.status = 409; throw err;
            }
            const { data: againPhone } = await supabase.from('users').select('id').eq('phone_digits', phoneD).maybeSingle();
            if (againPhone) {
                const err = new Error('Telefone já cadastrado. Corrija o telefone.');
                err.status = 409; throw err;
            }
        }
        throw ierr;
    }

    return ins; // { id }
}

module.exports = { getOrCreateUser, isValidCPF, onlyDigits, toCanonicalEmail };

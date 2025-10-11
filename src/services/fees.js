const P = Number(process.env.MP_FEE_PERCENT || 0); // ex: 0.0499
const F = Number(process.env.MP_FEE_FIXED || 0); // ex: 0.49

function computeFees(gross, paymentsCount = 0) {
    const percent = +(gross * P).toFixed(2);
    const fixed = +(F * paymentsCount).toFixed(2);
    return { percent, fixed, total: +(percent + fixed).toFixed(2) };
}

module.exports = { computeFees };

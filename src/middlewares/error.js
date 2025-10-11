module.exports = (err, req, res, next) => {
    console.error(err);
    res.status(400).json({ ok: false, message: err.message || 'Erro' });
};
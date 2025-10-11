async function selectSession(session) {
    sessionStorage.setItem('selectedSession', session);

    // buscar o id da sessão no backend
    const r = await fetch('/api/sessions');
    const list = await r.json();
    const s = list.find(x => x.name === session);
    if (!s) { alert('Sessão indisponível'); return; }
    sessionStorage.setItem('sessionId', s.id);

    window.location.href = 'andar.html?session=' + session;
}
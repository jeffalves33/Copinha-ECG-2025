// public/admin/js/admin.js

// ---------- utils ----------
function fmtBRL(n) { return (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
function qs(sel) { return document.querySelector(sel) }
function qsa(sel) { return Array.from(document.querySelectorAll(sel)) }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }
async function api(path, opts) {
  const r = await fetch('/api' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (!r.ok) {
    let msg = '';
    try { const j = await r.json(); msg = j.message || ''; } catch (e) { }
    throw new Error(`${r.status} ${msg}`.trim());
  }
  return r.json();
}

async function populateSessionsSelect(selectId, includeAll = true) {
  const sel = qs('#' + selectId);
  if (!sel) return;
  sel.innerHTML = includeAll ? `<option value="">Todas</option>` : '';

  const r = await fetch('/api/sessions'); // sua rota pública já lista sessões
  if (!r.ok) return;
  const sessions = await r.json(); // [{id,name,...}]

  sessions.forEach(s => {
    const opt = document.createElement('option');
    // exibe “16:00” se seu name for “16h”
    const label = s.name?.endsWith('h') ? s.name.replace('h', ':00') : s.name;
    opt.value = s.id;       // <<<<<<<<<<<<<<  usa o UUID aqui!
    opt.textContent = label;
    sel.appendChild(opt);
  });
}

// ---------- auth ----------
const AdminAuth = {
  checkAuth() {
    if (location.pathname.endsWith('/login.html')) return;
    const ok = sessionStorage.getItem('adminAuthenticated') === 'true';
    if (!ok) location.href = 'login.html';
  },
  logout() {
    sessionStorage.removeItem('adminAuthenticated');
    location.href = 'login.html';
  }
};
window.AdminAuth = AdminAuth;

// ---------- dashboard ----------
const AdminDashboard = {
  async loadDashboard() {
    try {
      const d = await api('/admin/metrics');
      // cards topo
      const el = (id, v) => { const e = qs('#' + id); if (e) e.textContent = v; };
      el('totalAvailable', d.seats?.available ?? 0);
      el('totalReserved', d.seats?.reserved ?? 0);
      el('totalSold', d.seats?.sold ?? 0);
      el('totalRevenue', fmtBRL(d.revenue?.gross || 0));

      // análise financeira
      el('grossRevenue', fmtBRL(d.revenue?.gross || 0));
      el('mpFees', '- ' + fmtBRL(d.revenue?.fees?.total || 0));
      el('netRevenue', fmtBRL(d.revenue?.net || 0));

      // (opcional) se você quiser popular os blocos por sessão/andar aqui,
      // crie um endpoint /api/admin/metrics/by-session e preencha:
      // el('session15Sold', ...); el('session15Available', ...); el('session15Revenue', ...); etc.
    } catch (e) {
      console.error(e);
    }
  }
};
window.AdminDashboard = AdminDashboard;

// ---------- vendas ----------
const AdminSales = {
  async loadSales() {
    const sess = qs('#filterSession')?.value || '';
    const floor = qs('#filterFloor')?.value || '';
    const search = qs('#filterSearch')?.value || '';
    const params = new URLSearchParams();
    if (sess) params.set('sessionId', sess);
    if (floor) params.set('floor', floor);
    if (search) params.set('search', search);

    const { items } = await api('/admin/sales?' + params.toString());
    this.render(items || []);
  },
  applyFilters: debounce(function () { AdminSales.loadSales() }, 200),
  render(items) {
    const tbody = qs('#salesTable');
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Nenhuma venda encontrada</td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(it => {
      const seats = it.seats.map(s => `${s.code} (andar ${s.floor})`).join(', ');
      const paidAt = it.paidAt ? new Date(it.paidAt).toLocaleString('pt-BR') : '-';
      return `<tr>
        <td>${it.id}</td>
        <td>${it.buyer}</td>
        <td>${it.contact}</td>
        <td>${it.sessionId || '-'}</td>
        <td>${[...new Set(it.seats.map(s => s.floor))].join(', ')}</td>
        <td>${seats}</td>
        <td>${fmtBRL(it.total)}</td>
        <td>${paidAt}</td>
        <td>
          <button class="btn btn-secondary" onclick="AdminSales.openCancel('${it.id}', '${(it.buyer || '').replace(/'/g, '’')}', '${fmtBRL(it.total)}')">Cancelar</button>
        </td>
      </tr>`;
    }).join('');
  },
  exportToCSV() {
    location.href = '/api/admin/sales/export.csv';
  },
  openCancel(id, buyer, total) {
    window.__cancelOrderId = id;
    const box = qs('#cancelDetails');
    if (box) box.innerHTML = `<p><strong>Pedido:</strong> ${id}<br/><strong>Cliente:</strong> ${buyer}<br/><strong>Valor:</strong> ${total}</p>`;
    const m = qs('#cancelModal'); if (m) m.style.display = 'block';
  },
  closeCancelModal() { const m = qs('#cancelModal'); if (m) m.style.display = 'none' },
  async confirmCancel() {
    const reason = qs('#cancelReason')?.value || '';
    try {
      const r = await api(`/admin/orders/${window.__cancelOrderId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
      alert(r.refunded ? 'Venda estornada e cancelada.' : 'Venda cancelada.');
      this.closeCancelModal();
      this.loadSales();
    } catch (e) {
      alert('Não foi possível cancelar: ' + e.message);
    }
  }
};
window.AdminSales = AdminSales;

// ---------- assentos ----------
const AdminSeats = {
  async loadSeats() {
    const sess = qs('#seatFilterSession')?.value || '';
    const floor = qs('#seatFilterFloor')?.value || '';
    const q = qs('#seatSearch')?.value || '';
    const params = new URLSearchParams();
    if (sess) params.set('sessionId', sess);
    if (floor) params.set('floor', floor);
    if (q) params.set('q', q);

    const { items } = await api('/admin/seats?' + params.toString());

    // estatísticas
    const stats = { available: 0, reserved: 0, sold: 0 };
    (items || []).forEach(i => stats[i.status] = (stats[i.status] || 0) + 1);
    const el = (id, v) => { const e = qs('#' + id); if (e) e.textContent = v; };
    el('availableCount', stats.available || 0);
    el('reservedCount', stats.reserved || 0);
    el('occupiedCount', stats.sold || 0);
    el('totalCount', (items || []).length);

    // tabela
    const tbody = qs('#seatsTable');
    if (!tbody) return;
    tbody.innerHTML = (items || []).map(row => {
      const badge = row.status === 'available' ? 'Disponível' :
        row.status === 'reserved' ? 'Reservado' : 'Vendido';
      const actions = row.status === 'reserved'
        ? `<button class="btn btn-secondary" onclick="AdminSeats.release('${row.seat}','${row.floor}')">Liberar</button>`
        : '-';
      return `<tr>
        <td>${row.seat}</td>
        <td>${row.seat.split('-')[0]}</td>
        <td>${badge}</td>
        <td>${row.orderId || '-'}</td>
        <td>${row.orderId || '-'}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('');
  },
  applyFilters: debounce(function () { AdminSeats.loadSeats() }, 200),
  async release(code, floor) {
    const sess = qs('#seatFilterSession')?.value || '';
    try {
      // admin libera forçadamente (não precisa reserveToken)
      await api('/admin/seats/release', {
        method: 'POST',
        body: JSON.stringify({ sessionId: sess, floor, seats: [code] })
      });
      this.loadSeats();
    } catch (e) { alert('Falha ao liberar: ' + e.message) }
  }
};
window.AdminSeats = AdminSeats;

// ---------- usuários ----------
const AdminUsers = {
  async loadStats() {
    // estatísticas simples reaproveitando vendas
    const { items } = await api('/admin/sales');
    const orders = items || [];
    const buyers = new Set(orders.map(o => o.buyer));
    const totalSold = orders.reduce((acc, o) => acc + o.seats.length, 0);
    const totalValue = orders.reduce((acc, o) => acc + o.total, 0);
    const el = (id, v) => { const e = qs('#' + id); if (e) e.textContent = v; };
    el('totalBuyers', buyers.size);
    el('avgTickets', orders.length ? (totalSold / orders.length).toFixed(2) : '0');
    el('avgValue', fmtBRL(orders.length ? (totalValue / orders.length) : 0));
  },
  async search() {
    const q = qs('#userSearch')?.value || '';
    if (!q.trim()) return;
    const { items } = await api('/admin/users/search?q=' + encodeURIComponent(q.trim()));
    const box = qs('#userResults');
    if (!items.length) {
      box.innerHTML = `<div class="empty-state"><div class="empty-state-icon">👤</div><h4>Nenhum resultado</h4></div>`;
      return;
    }
    box.innerHTML = items.map(u => `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <strong>${u.name || '—'}</strong><br/>
            <span class="muted">${u.email || ''} ${u.phone ? ' • ' + u.phone : ''}</span>
          </div>
          <button class="btn btn-secondary" onclick="AdminUsers.open('${u.id}')">Ver detalhes</button>
        </div>
      </div>
    `).join('');
  },
  async open(id) {
    const m = qs('#userModal'); const body = qs('#userModalBody');
    const { user, tickets } = await api('/admin/users/' + id);
    body.innerHTML = `
      <p><strong>${user.name}</strong><br/><span class="muted">${user.email} • ${user.phone || ''}</span></p>
      <h4>Pedidos</h4>
      ${(tickets || []).map(t => `
        <div class="card" style="margin-bottom:10px">
          <div><strong>Pedido ${t.orderId}</strong> — ${t.status}</div>
          <div class="muted">${t.paidAt ? new Date(t.paidAt).toLocaleString('pt-BR') : '—'}</div>
          <div>${t.seats.join(', ')}</div>
          <div class="muted">Total: ${fmtBRL(t.total)}</div>
        </div>
      `).join('') || '<p class="muted">Sem pedidos</p>'}
    `;
    if (m) m.style.display = 'block';
  },
  closeModal() { const m = qs('#userModal'); if (m) m.style.display = 'none'; }
};
window.AdminUsers = AdminUsers;

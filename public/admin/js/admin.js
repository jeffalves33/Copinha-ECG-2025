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

function updateCard(prefix, data) {
  const { sold = 0, available = 0, revenue = 0 } = data;
  const total = available;
  const pct = total > 0 ? Math.round((sold / total) * 100) : 0;

  setText(`#${prefix}Sold`, sold);
  setText(`#${prefix}Available`, available);
  setText(`#${prefix}Revenue`, fmtBRL(revenue));

  const bar = document.querySelector(`#${prefix}Progress`);
  if (bar) bar.style.width = `${pct}%`;
}

function setText(sel, val) {
  const el = document.querySelector(sel);
  if (el) el.textContent = val;
}

function fmtBRL(n) {
  return (n ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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

      const bd = d.revenue?.feesBreakdown || {};
      const elBD = qs('#mpFeesBreakdown');
      if (elBD) {
        const parts = [];
        if (bd.card_mdr) parts.push(`Cartão (4,98%): ${fmtBRL(bd.card_mdr)}`);
        if (bd.pix_mdr) parts.push(`Pix (0,99%): ${fmtBRL(bd.pix_mdr)}`);
        if (bd.installment) parts.push(`Parcelamento (vendedor): ${fmtBRL(bd.installment)}`);
        if (bd.fixed) parts.push(`Tarifa fixa: ${fmtBRL(bd.fixed)}`);
        elBD.innerHTML = parts.length ? parts.join(' • ') : '—';
      }


      //Sales
      const sales = await api('/admin/sales/sold');
      const sessions = sales?.sessions || [];
      const s16 = sessions.find(s => s.session === '16h') || { sold: 0, available: 0, revenue: 0 };
      const s19 = sessions.find(s => s.session === '19h') || { sold: 0, available: 0, revenue: 0 };
      updateCard('session16', s16);
      updateCard('session19', s19);

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
      tbody.innerHTML = `<tr><td colspan="13" class="table-empty">Nenhuma venda encontrada</td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(it => {
      const paidAt = it.paidAt ? new Date(it.paidAt).toLocaleString('pt-BR') : '-';
      const seat = it.sessionId === '9c3c87cb-4107-4d8e-a4ea-c1e8b0084e34' ? '16h' : '19h';
      return `<tr>
          <td>${it.orderItemId.slice(0, 8)}</td>
          <td>${(it.buyer || '').slice(0, 8)}</td>
          <td>${it.email || ''}</td>
          <td>${it.cpf || ''}</td>
          <td>${it.phone || ''}</td>
          <td>${seat}</td>
          <td>${it.floor || '-'}</td>
          <td>${it.seatCode || '-'}</td>
          <td>${it.method || '-'}</td>
          <td>${it.installments || 1}x</td>
          <td>${fmtBRL(it.total)}</td>
          <td>${paidAt}</td>
          <td>
            <button class="btn btn-secondary"
              onclick="AdminSales.openCancel(
                '${(it.buyer || '')}',
                '${it.orderId}',
                '${it.orderItemId}',
                '${it.seatId}',
                '${(it.seatCode || '').replace(/'/g, '’')}',
                '${fmtBRL(it.total)}'
              )">
              Cancelar
            </button>
          </td>
        </tr>`
        ;
    }).join('');
  },
  exportToCSV() {
    location.href = '/api/admin/sales/export.csv';
  },
  openCancel(buyer, orderId, orderItemId, seatId, seatCode, priceBRL) {
    window.__cancel = { orderId, orderItemId, seatId };
    const box = qs('#cancelDetails');
    if (box) box.innerHTML = `<p><strong>Pedido:</strong> ${orderItemId}<br/><strong>Cliente:</strong> ${buyer}<br/><strong>Valor:</strong> ${priceBRL}</p>`;
    const m = qs('#cancelModal');
    if (m) m.style.display = 'block';
  },
  closeCancelModal() { const m = qs('#cancelModal'); if (m) m.style.display = 'none' },
  async confirmCancel() {
    try {
      const { orderId, orderItemId, seatId } = window.__cancel || {};
      if (!orderId || !orderItemId || !seatId) throw new Error('Dados incompletos do cancelamento.');
      await api(`/admin/orders/${orderId}/items/${orderItemId}?seatId=${encodeURIComponent(seatId)}`, { method: 'DELETE' });
      this.closeCancelModal();
      await this.loadSales(); // recarrega a lista por ingresso
    } catch (e) {
      alert('Falha ao cancelar: ' + (e?.message || e));
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

    // Ordenação dos assentos
    const sorted = (items || []).sort((a, b) => {
      const [la, na] = a.seat.split('-');
      const [lb, nb] = b.seat.split('-');
      if (la === lb) return parseInt(na, 10) - parseInt(nb, 10);
      return la.localeCompare(lb);
    });

    tbody.innerHTML = sorted.map(row => {
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
    box.innerHTML = items.map(user => `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <strong>${user.name || '—'}</strong><br/>
            <span class="muted">e-mail: ${user.email} <br/> telefone: ${user.phone || ''} <br/> CPF: ${user.cpf || ''}</span>
          </div>
          <button class="btn btn-secondary" onclick="AdminUsers.open('${user.id}')">Ver detalhes</button>
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

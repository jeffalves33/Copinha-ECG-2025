// ============================================
// FUNÇÕES GLOBAIS E UTILITÁRIOS
// ============================================

/**
 * Formata preço para o padrão brasileiro
 * @param {number} value - Valor numérico
 * @returns {string} - Valor formatado (ex: "R$ 150,00")
 */
function formatPrice(value) {
  return `R$ ${value.toFixed(2).replace(".", ",")}`
}

/**
 * Formata data para o padrão brasileiro
 * @param {Date} date - Objeto Date
 * @returns {string} - Data formatada (ex: "31/12/2024")
 */
function formatDate(date) {
  const day = String(date.getDate()).padStart(2, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const year = date.getFullYear()
  return `${day}/${month}/${year}`
}

/**
 * Valida e-mail
 * @param {string} email - E-mail a ser validado
 * @returns {boolean} - True se válido
 */
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return re.test(email)
}

/**
 * Valida telefone brasileiro
 * @param {string} phone - Telefone a ser validado
 * @returns {boolean} - True se válido
 */
function validatePhone(phone) {
  const digits = phone.replace(/\D/g, "")
  return digits.length >= 10 && digits.length <= 11
}

/**
 * Mostra notificação toast (pode ser expandido com uma lib)
 * @param {string} message - Mensagem a ser exibida
 * @param {string} type - Tipo: 'success', 'error', 'info', 'warning'
 */
function showToast(message, type = "info") {
  // Implementação simples com alert
  // Em produção, use uma biblioteca de toast como Toastify
  alert(message)
}

/**
 * Debounce para otimizar eventos
 * @param {Function} func - Função a ser executada
 * @param {number} wait - Tempo de espera em ms
 * @returns {Function} - Função com debounce
 */
function debounce(func, wait) {
  let timeout
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout)
      func(...args)
    }
    clearTimeout(timeout)
    timeout = setTimeout(later, wait)
  }
}

// ============================================
// GERENCIAMENTO DE SESSÃO E CARRINHO
// ============================================

const Cart = {
  /**
   * Obtém a sessão selecionada
   */
  getSession() {
    return sessionStorage.getItem("selectedSession")
  },

  /**
   * Define a sessão selecionada
   */
  setSession(session) {
    sessionStorage.setItem("selectedSession", session)
  },

  /**
   * Obtém o andar selecionado
   */
  getFloor() {
    return sessionStorage.getItem("selectedFloor")
  },

  /**
   * Define o andar selecionado
   */
  setFloor(floor) {
    sessionStorage.setItem("selectedFloor", floor)
  },

  /**
   * Obtém os assentos selecionados
   */
  getSeats() {
    return JSON.parse(sessionStorage.getItem("selectedSeats") || "[]")
  },

  /**
   * Define os assentos selecionados
   */
  setSeats(seats) {
    sessionStorage.setItem("selectedSeats", JSON.stringify(seats))
  },

  /**
   * Limpa o carrinho
   */
  clear() {
    sessionStorage.removeItem("selectedSession")
    sessionStorage.removeItem("selectedFloor")
    sessionStorage.removeItem("selectedSeats")
    sessionStorage.removeItem("totalPrice")
  },

  /**
   * Obtém o total do carrinho
   */
  getTotal() {
    return Number.parseFloat(sessionStorage.getItem("totalPrice") || "0")
  },

  /**
   * Define o total do carrinho
   */
  setTotal(total) {
    sessionStorage.setItem("totalPrice", total.toFixed(2))
  },
}

// ============================================
// GERENCIAMENTO DE COMPRAS (PERSISTÊNCIA)
// ============================================

const Purchases = {
  /**
   * Obtém todas as compras
   */
  getAll() {
    return JSON.parse(localStorage.getItem("purchases") || "[]")
  },

  /**
   * Adiciona uma nova compra
   */
  add(purchase) {
    const purchases = this.getAll()
    purchases.push({
      ...purchase,
      date: new Date().toISOString(),
    })
    localStorage.setItem("purchases", JSON.stringify(purchases))
  },

  /**
   * Busca compras por e-mail ou telefone
   */
  search(term) {
    const purchases = this.getAll()
    const searchTerm = term.toLowerCase()
    return purchases.filter(
      (purchase) =>
        purchase.buyerEmail.toLowerCase().includes(searchTerm) ||
        (purchase.buyerPhone && purchase.buyerPhone.replace(/\D/g, "").includes(searchTerm.replace(/\D/g, ""))),
    )
  },

  /**
   * Obtém uma compra específica por ID
   */
  getById(orderId) {
    const purchases = this.getAll()
    return purchases.find((purchase) => purchase.orderId === orderId)
  },
}

// ============================================
// ACESSIBILIDADE
// ============================================

/**
 * Adiciona suporte a navegação por teclado
 */
function initKeyboardNavigation() {
  document.addEventListener("keydown", (e) => {
    // ESC para fechar modais (se implementados)
    if (e.key === "Escape") {
      // Fechar modais aqui
    }
  })
}

/**
 * Anuncia mensagem para leitores de tela
 */
function announceToScreenReader(message) {
  const announcement = document.createElement("div")
  announcement.setAttribute("role", "status")
  announcement.setAttribute("aria-live", "polite")
  announcement.className = "sr-only"
  announcement.textContent = message
  document.body.appendChild(announcement)

  setTimeout(() => {
    document.body.removeChild(announcement)
  }, 1000)
}

// ============================================
// INICIALIZAÇÃO
// ============================================

document.addEventListener("DOMContentLoaded", () => {
  // Inicializar navegação por teclado
  initKeyboardNavigation()

  // Adicionar foco visível em elementos interativos
  document.querySelectorAll("button, a, input, select, textarea").forEach((element) => {
    element.addEventListener("focus", function () {
      this.style.outline = "2px solid var(--color-primary)"
      this.style.outlineOffset = "2px"
    })

    element.addEventListener("blur", function () {
      this.style.outline = ""
      this.style.outlineOffset = ""
    })
  })

  console.log("[v0] App initialized successfully")
})

// ============================================
// DETECÇÃO DE CONEXÃO (OFFLINE)
// ============================================

window.addEventListener("online", () => {
  showToast("Conexão restaurada!", "success")
})

window.addEventListener("offline", () => {
  showToast("Você está offline. Algumas funcionalidades podem não estar disponíveis.", "warning")
})

// ============================================
// EXPORTAR PARA USO GLOBAL
// ============================================

window.Cart = Cart
window.Purchases = Purchases
window.formatPrice = formatPrice
window.formatDate = formatDate
window.validateEmail = validateEmail
window.validatePhone = validatePhone
window.showToast = showToast
window.announceToScreenReader = announceToScreenReader

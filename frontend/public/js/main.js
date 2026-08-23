 // ===== CONFIGURATION =====
// URL du backend (Render)
const API_URL = 'https://epistrategix-backend.onrender.com';

// URL du frontend (Firebase Hosting)
const FRONTEND_URL = 'https://epistrategix.web.app';

// ===== FONCTIONS UTILITAIRES =====

/**
 * Fonction pour les appels API
 */
async function apiCall(endpoint, options = {}) {
    const url = `${API_URL}/api/${endpoint}`;
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
        },
    };
    
    // Ajouter le token d'authentification si disponible
    const user = firebase?.auth()?.currentUser;
    if (user) {
        const token = await user.getIdToken();
        defaultOptions.headers['Authorization'] = `Bearer ${token}`;
    }

    const config = { ...defaultOptions, ...options };
    if (options.body && typeof options.body === 'object') {
        config.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, config);
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(data.error || 'Erreur API');
    }
    
    return data;
}

/**
 * Charger les services
 */
async function loadServices() {
    try {
        const response = await fetch(`${API_URL}/api/services`);
        const services = await response.json();
        return services;
    } catch (error) {
        console.error('Erreur chargement services:', error);
        return [];
    }
}

/**
 * Charger les contenus
 */
async function loadContents() {
    try {
        const response = await fetch(`${API_URL}/api/contents`);
        const contents = await response.json();
        return contents;
    } catch (error) {
        console.error('Erreur chargement contenus:', error);
        return [];
    }
}

/**
 * Formater les prix
 */
function formatPrice(amount) {
    return new Intl.NumberFormat('fr-FR', {
        style: 'currency',
       currency: 'XOF'
    }).format(amount);
}

/**
 * Afficher une notification
 */
function showNotification(message, type = 'info') {
    const colors = {
        success: '#1f9a6e',
        error: '#c73b3b',
        info: '#1e5fb0',
        warning: '#e6a020'
    };
    
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 1rem 1.5rem;
        background: ${colors[type] || colors.info};
        color: white;
        border-radius: 12px;
        font-weight: 500;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        z-index: 9999;
        animation: slideIn 0.3s ease;
        max-width: 400px;
    `;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transition = 'opacity 0.3s';
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

// Exporter les fonctions
window.API_URL = API_URL;
window.FRONTEND_URL = FRONTEND_URL;
window.apiCall = apiCall;
window.loadServices = loadServices;
window.loadContents = loadContents;
window.formatPrice = formatPrice;
window.showNotification = showNotification;
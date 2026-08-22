// ===== GESTION DES PAIEMENTS AVEC FEDAPAY =====

const API_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:5000' 
    : 'https://votre-backend.onrender.com';

/**
 * Initialiser un paiement FedaPay
 */
async function initiatePayment({
    reservationId,
    amount,
    customerName,
    customerEmail,
    serviceName
}) {
    try {
        const response = await fetch(`${API_URL}/api/payments/initiate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                reservationId,
                amount,
                customerName,
                customerEmail,
                serviceName
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Erreur lors de l\'initiation du paiement');
        }

        return data;
    } catch (error) {
        console.error('Erreur paiement:', error);
        throw error;
    }
}

/**
 * Ouvrir le modal de paiement FedaPay
 */
function openFedaPayPayment(url) {
    if (url) {
        // Rediriger vers l'URL de paiement FedaPay
        window.location.href = url;
    } else {
        throw new Error('URL de paiement manquante');
    }
}

/**
 * Vérifier le statut d'une transaction
 */
async function checkTransactionStatus(transactionId) {
    try {
        const response = await fetch(`${API_URL}/api/payments/status/${transactionId}`);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Erreur vérification statut:', error);
        return null;
    }
}

/**
 * Gérer le retour de paiement (callback)
 */
function handlePaymentCallback() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    const transactionId = params.get('transaction_id');

    if (status === 'success') {
        showNotification('✅ Paiement réussi ! Merci pour votre confiance.', 'success');
        // Rediriger vers la page de confirmation après 3 secondes
        setTimeout(() => {
            window.location.href = '/confirmation.html?status=success';
        }, 3000);
    } else if (status === 'cancelled') {
        showNotification('❌ Paiement annulé. Vous pouvez réessayer.', 'error');
    } else if (status === 'failed') {
        showNotification('❌ Le paiement a échoué. Veuillez réessayer.', 'error');
    }
}

/**
 * Formater le montant pour FedaPay (en centimes)
 */
function formatAmountForFedaPay(amount) {
    return Math.round(amount * 100);
}

/**
 * Valider les données de paiement
 */
function validatePaymentData(data) {
    const errors = [];

    if (!data.reservationId) {
        errors.push('ID de réservation manquant');
    }
    if (!data.amount || data.amount <= 0) {
        errors.push('Montant invalide');
    }
    if (!data.customerName || data.customerName.trim() === '') {
        errors.push('Nom du client requis');
    }
    if (!data.customerEmail || !data.customerEmail.includes('@')) {
        errors.push('Email valide requis');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

// Exporter les fonctions
window.initiatePayment = initiatePayment;
window.openFedaPayPayment = openFedaPayPayment;
window.checkTransactionStatus = checkTransactionStatus;
window.handlePaymentCallback = handlePaymentCallback;
window.formatAmountForFedaPay = formatAmountForFedaPay;
window.validatePaymentData = validatePaymentData;

// Vérifier automatiquement le callback de paiement
document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('status') || urlParams.has('transaction_id')) {
        handlePaymentCallback();
    }
});
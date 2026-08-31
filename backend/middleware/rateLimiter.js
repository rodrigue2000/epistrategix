const rateLimit = require('express-rate-limit');

// ✅ Limite générale pour la création de réservations publiques :
// évite qu'un script crée des centaines de réservations bidons.
const reservationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 réservations par IP / 15 min
  message: { error: 'Trop de tentatives de réservation. Merci de réessayer dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ✅ Limite pour l'initiation de paiement (réservations, contenus, packs) :
// évite qu'un script crée des centaines de transactions FedaPay inutiles.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Trop de tentatives de paiement. Merci de réessayer dans quelques minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { reservationLimiter, paymentLimiter };

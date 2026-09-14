const axios = require('axios');

// ✅ Brevo (ex-Sendinblue) : API HTTP (port 443, jamais bloqué par Render,
// contrairement au SMTP classique). Plan gratuit : 300 emails/jour à vie,
// vérification d'une simple adresse email (pas de domaine requis), envoi
// possible vers n'importe quel destinataire.
//
// ⚠️ Après inscription, Brevo valide manuellement les nouveaux comptes
// avant d'activer l'envoi — généralement sous quelques heures, pas un blocage
// permanent, juste un délai à anticiper.
//
// Variables d'environnement à définir sur Render :
// BREVO_API_KEY=xkeysib-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// EMAIL_FROM=tonadresse@gmail.com (doit être vérifiée dans Brevo d'abord :
//   Dashboard → Senders, Domains & Dedicated IPs → Senders → Add a sender)

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error('Service email non configuré (BREVO_API_KEY ou EMAIL_FROM manquant sur le serveur)');
  }

  try {
    const response = await axios.post(BREVO_API_URL, {
      sender: { email: from, name: 'EpiStrategix' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }, {
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    return response.data;
  } catch (error) {
    const apiError = error.response?.data?.message || error.response?.data || error.message;
    console.error('❌ Erreur Brevo:', apiError);
    throw new Error(typeof apiError === 'string' ? apiError : 'Erreur lors de l\'envoi de l\'email');
  }
}

module.exports = { sendEmail };

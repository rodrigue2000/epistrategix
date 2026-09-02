const { Resend } = require('resend');

// ✅ Variable d'environnement à définir sur Render : RESEND_API_KEY
// (récupérable dans le Dashboard Resend → API Keys)
// Et EMAIL_FROM, ex: "EpiStrategix <noreply@tondomaine.com>"
// ⚠️ Pour envoyer depuis ton propre domaine, il faut d'abord le vérifier
// dans le Dashboard Resend (quelques enregistrements DNS à ajouter).
// En attendant cette vérification, tu peux utiliser l'adresse de test
// fournie par Resend : "onboarding@resend.dev" (fonctionne immédiatement,
// mais uniquement pour tester — pas pour de la production).

let resend = null;

if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
  console.log('✅ Client Resend configuré');
} else {
  console.warn('⚠️ RESEND_API_KEY manquante — l\'envoi d\'email est désactivé');
}

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    throw new Error('Service email non configuré (RESEND_API_KEY manquante sur le serveur)');
  }

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || 'EpiStrategix <onboarding@resend.dev>',
    to,
    subject,
    html,
  });

  if (error) {
    throw new Error(error.message || 'Erreur lors de l\'envoi de l\'email');
  }

  return data;
}

module.exports = { sendEmail };

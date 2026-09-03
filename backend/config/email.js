const nodemailer = require('nodemailer');

// ✅ Variables d'environnement à définir sur Render :
// SMTP_HOST=smtp.gmail.com
// SMTP_PORT=587
// SMTP_USER=tonadresse@gmail.com
// SMTP_PASS=<mot de passe d'application Gmail> (PAS ton mot de passe normal)
// SMTP_FROM=EpiStrategix <tonadresse@gmail.com>  (optionnel)
//
// ⚠️ Pourquoi Gmail et pas Resend pour l'instant : le domaine gratuit
// resend.dev ne peut envoyer QUE vers l'adresse email du compte Resend
// lui-même, pas vers de vrais clients, tant qu'aucun domaine personnalisé
// n'est vérifié. Comme le site n'a pas encore de domaine personnel
// (juste epistrategix.web.app, qui appartient à Firebase), Gmail est la
// seule option qui fonctionne réellement dès maintenant pour contacter
// de vrais clients. À remplacer par Resend (ou autre) une fois qu'un
// domaine personnalisé sera acheté et vérifié — seul ce fichier changera.
//
// Comment générer un "mot de passe d'application" Gmail :
// Compte Google → Sécurité → Validation en 2 étapes (doit être activée)
// → Mots de passe des applications → Créer → copier la valeur générée.

let transporter = null;

try {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    console.log('✅ Transporteur email configuré (Gmail SMTP)');
  } else {
    console.warn('⚠️ Variables SMTP manquantes — l\'envoi d\'email est désactivé');
  }
} catch (error) {
  console.error('❌ Erreur configuration email:', error.message);
}

async function sendEmail({ to, subject, html }) {
  if (!transporter) {
    throw new Error('Service email non configuré (variables SMTP manquantes sur le serveur)');
  }
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
  });
}

module.exports = { sendEmail };

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cloudinary = require('../config/cloudinary');
const { db } = require('../config/firebase');
const verifyToken = require('../middleware/auth');
const isAdmin = require('../middleware/admin');

const router = express.Router();

// ============================================================
// UPLOAD DES IMAGES (signature, cachet) - en mémoire, jamais sur le disque
// ============================================================
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Format d\'image non supporté (JPG ou PNG)'));
  },
}).fields([
  { name: 'signature', maxCount: 1 },
  { name: 'stamp', maxCount: 1 },
]);

function handleImageUpload(req, res, next) {
  imageUpload(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Image trop volumineuse (8 Mo maximum)' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}

// ============================================================
// CADRAGE AUTOMATIQUE D'UNE SIGNATURE / D'UN CACHET PHOTOGRAPHIÉ
// ============================================================
// ✅ Traitement 100 % JavaScript (modules "jpeg-js" et "pngjs") : aucun composant natif,
// donc aucun risque de « module impossible à charger » selon la machine du serveur.
// Ils sont chargés à la demande : s'ils manquaient, seules les routes qui traitent des
// images échoueraient (avec la VRAIE cause), pas tout le site.
function describeImageLibFailure(e) {
  const raw = String((e && e.message) || e || '');
  const firstLine = raw.split('\n').find(l => l.trim()) || raw;
  const absent = e && e.code === 'MODULE_NOT_FOUND';
  return absent
    ? 'Les modules "jpeg-js" et "pngjs" sont absents du serveur : ils n\'ont pas été installés au déploiement. Vérifiez que backend/package.json et backend/package-lock.json (contenant jpeg-js et pngjs) ont bien été envoyés sur GitHub, puis relancez un déploiement.'
    : `Les modules de traitement d'image ne peuvent pas se charger sur ce serveur (${firstLine.slice(0, 200)}).`;
}

let imageLibs = null;
function getImageLibs() {
  if (!imageLibs) {
    try {
      imageLibs = { PNG: require('pngjs').PNG, jpeg: require('jpeg-js') };
    } catch (e) {
      console.error(`❌ Chargement des modules d'image impossible (Node ${process.version}) : code=${e && e.code} | ${String(e && e.message).split('\n').slice(0, 3).join(' / ')}`);
      throw new Error(describeImageLibFailure(e));
    }
  }
  return imageLibs;
}

// Erreur causée par les données envoyées (et non par le serveur) : renvoyée en 400
function userError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Orientation EXIF d'une photo JPEG de téléphone (1 = normale). Sans cette lecture,
// une photo prise en mode portrait donnerait une signature couchée.
function jpegOrientation(buf) {
  try {
    let off = 2;
    while (off + 4 < buf.length && buf[off] === 0xFF) {
      const marker = buf[off + 1];
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xE1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
        const t = off + 10; // début de l'en-tête TIFF
        const little = buf.toString('latin1', t, t + 2) === 'II';
        const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = t + u32(t + 4);
        const count = u16(ifd);
        for (let i = 0; i < count; i++) {
          const entry = ifd + 2 + i * 12;
          if (u16(entry) === 0x0112) return u16(entry + 8);
        }
        return 1;
      }
      if (marker === 0xDA) break; // début des données image : plus de métadonnées
      off += 2 + len;
    }
  } catch (e) { /* métadonnées illisibles : on considère l'image droite */ }
  return 1;
}

// Remet une image RGB « à l'endroit » selon son orientation EXIF
function applyOrientation(img, o) {
  if (!(o >= 2 && o <= 8)) return img;
  const { data, width: w, height: h } = img;
  const swap = o >= 5;
  const nw = swap ? h : w;
  const nh = swap ? w : h;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx, dy;
      switch (o) {
        case 2: dx = w - 1 - x; dy = y; break;
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;
        case 4: dx = x; dy = h - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = h - 1 - y; dy = x; break;
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;
        default: dx = y; dy = w - 1 - x; // 8
      }
      const s = (y * w + x) * 3;
      const d = (dy * nw + dx) * 3;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
    }
  }
  return { data: out, width: nw, height: nh };
}

// Décode une photo JPEG ou PNG en RGB, aplatie sur fond blanc et remise à l'endroit
function decodeToRgb(buffer) {
  const { PNG, jpeg } = getImageLibs();
  let width, height, rgba, orientation = 1;
  try {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) {                 // PNG
      const png = PNG.sync.read(buffer);
      width = png.width; height = png.height; rgba = png.data;
    } else if (buffer[0] === 0xFF && buffer[1] === 0xD8) {          // JPEG
      const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 60, maxMemoryUsageInMB: 700 });
      width = img.width; height = img.height; rgba = img.data;
      orientation = jpegOrientation(buffer);
    } else {
      throw new Error('format non pris en charge');
    }
  } catch (e) {
    throw userError('Image illisible ou format non pris en charge. Utilisez une photo JPG ou PNG.');
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 4, q += 3) {
    const a = rgba[p + 3] / 255;
    rgb[q] = rgba[p] * a + 255 * (1 - a);
    rgb[q + 1] = rgba[p + 1] * a + 255 * (1 - a);
    rgb[q + 2] = rgba[p + 2] * a + 255 * (1 - a);
  }
  return applyOrientation({ data: rgb, width, height }, orientation);
}

// Réduction par moyenne de surface (la meilleure méthode pour réduire une photo)
function boxResize(src, sw, sh, ch, tw, th) {
  const dst = new Uint8Array(tw * th * ch);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * sh) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * sh) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * sw) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * sw) / tw));
      const area = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) sum += src[(y * sw + x) * ch + c];
        }
        dst[(ty * tw + tx) * ch + c] = sum / area;
      }
    }
  }
  return dst;
}

// Idem pour une image RGBA, en tenant compte de la transparence (sinon les bords noircissent)
function boxResizeRgba(src, sw, sh, tw, th) {
  const dst = new Uint8Array(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * sh) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * sh) / th));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * sw) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * sw) / tw));
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          const al = src[i + 3];
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al;
        }
      }
      const o = (ty * tw + tx) * 4;
      if (a > 0) {
        dst[o] = r / a; dst[o + 1] = g / a; dst[o + 2] = b / a;
        dst[o + 3] = a / ((y1 - y0) * (x1 - x0));
      }
    }
  }
  return dst;
}

// Filtre médian : sert à estimer le papier (fond) en effaçant les traits fins de l'encre
function medianFilter(src, w, h, ch, radius) {
  const size = 2 * radius + 1;
  const win = new Uint8Array(size * size);
  const dst = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            win[n++] = src[(yy * w + xx) * ch + c];
          }
        }
        win.sort();
        dst[(y * w + x) * ch + c] = win[n >> 1];
      }
    }
  }
  return dst;
}

async function frameImage(buffer) {
  const { PNG } = getImageLibs();

  // 1. Décodage, orientation, fond blanc, taille de travail raisonnable (1400 px max)
  let { data, width, height } = decodeToRgb(buffer);
  const work = Math.min(1, 1400 / Math.max(width, height));
  if (work < 1) {
    const tw = Math.max(1, Math.round(width * work));
    const th = Math.max(1, Math.round(height * work));
    data = boxResize(data, width, height, 3, tw, th);
    width = tw; height = th;
  }

  // 2. Estimation LOCALE du fond : médiane sur une version réduite (1/8). Les traits fins
  // (signature, cachet) disparaissent, il reste le papier avec ses ombres et son éclairage
  // inégal, ce qui permet de traiter correctement une photo de téléphone.
  const smallW = Math.max(16, Math.round(width / 8));
  const smallH = Math.max(16, Math.round(height / 8));
  const small = boxResize(data, width, height, 3, smallW, smallH);
  const bgSmall = medianFilter(small, smallW, smallH, 3, 4);

  // Interpolation bilinéaire du fond jusqu'à la taille de travail
  const x0s = new Int32Array(width), x1s = new Int32Array(width), fxs = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const sx = Math.min(smallW - 1, Math.max(0, ((x + 0.5) * smallW) / width - 0.5));
    x0s[x] = Math.floor(sx); x1s[x] = Math.min(smallW - 1, x0s[x] + 1); fxs[x] = sx - x0s[x];
  }

  // 3. Suppression du fond : on ne garde que l'encre, sur transparent.
  //    pixel = encre × a + fond × (1 − a)   ⇒   encre = (pixel − fond × (1 − a)) / a
  const out = new Uint8Array(width * height * 4);
  const colCount = new Uint32Array(width);
  const rowCount = new Uint32Array(height);
  const edge = Math.round(Math.min(width, height) * 0.02); // bords de photo ignorés (ombres, table)
  const smooth = (v, e0, e1) => {
    const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const bg = [0, 0, 0];
  let solid = 0;

  for (let y = 0; y < height; y++) {
    if (y < edge || y >= height - edge) continue;
    const sy = Math.min(smallH - 1, Math.max(0, ((y + 0.5) * smallH) / height - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(smallH - 1, y0 + 1), fy = sy - y0;
    for (let x = edge; x < width - edge; x++) {
      const x0 = x0s[x], x1 = x1s[x], fx = fxs[x];
      for (let c = 0; c < 3; c++) {
        const top = bgSmall[(y0 * smallW + x0) * 3 + c] * (1 - fx) + bgSmall[(y0 * smallW + x1) * 3 + c] * fx;
        const bottom = bgSmall[(y1 * smallW + x0) * 3 + c] * (1 - fx) + bgSmall[(y1 * smallW + x1) * 3 + c] * fx;
        bg[c] = Math.max(1, top * (1 - fy) + bottom * fy);
      }
      const p = (y * width + x) * 3;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      // assombrissement relatif au fond local : 0 = comme le papier, 1 = noir
      const d = Math.max(1 - r / bg[0], 1 - g / bg[1], 1 - b / bg[2]);
      const a = smooth(d, 0.12, 0.38);
      if (a <= 0) continue;
      const o = (y * width + x) * 4;
      out[o] = byte((r - bg[0] * (1 - a)) / a);
      out[o + 1] = byte((g - bg[1] * (1 - a)) / a);
      out[o + 2] = byte((b - bg[2] * (1 - a)) / a);
      out[o + 3] = byte(a * 255);
      if (a > 0.5) { colCount[x]++; rowCount[y]++; solid++; }
    }
  }

  if (solid < 150) {
    throw userError('Aucune signature ni aucun cachet détecté dans cette image. Photographiez-le de près, sur une feuille blanche bien éclairée.');
  }

  // 4. Cadrage au plus près de l'encre (les grains de poussière isolés sont ignorés)
  const first = (arr) => arr.findIndex(c => c >= 2);
  const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= 2) return i; return -1; };
  const pad = 8;
  const left = Math.max(0, first(colCount) - pad);
  const right = Math.min(width - 1, last(colCount) + pad);
  const top = Math.max(0, first(rowCount) - pad);
  const bottom = Math.min(height - 1, last(rowCount) + pad);
  const cw = right - left + 1;
  const chh = bottom - top + 1;

  let cropped = new Uint8Array(cw * chh * 4);
  for (let y = 0; y < chh; y++) {
    const from = ((top + y) * width + left) * 4;
    cropped.set(out.subarray(from, from + cw * 4), y * cw * 4);
  }

  // 5. Ajustement dans un cadre maximal (ratio conservé, jamais agrandie)
  const fit = Math.min(1, 700 / cw, 350 / chh);
  let fw = cw, fh = chh;
  if (fit < 1) {
    fw = Math.max(1, Math.round(cw * fit));
    fh = Math.max(1, Math.round(chh * fit));
    cropped = boxResizeRgba(cropped, cw, chh, fw, fh);
  }

  const png = new PNG({ width: fw, height: fh });
  png.data = Buffer.from(cropped.buffer, cropped.byteOffset, cropped.length);
  return PNG.sync.write(png);
}

// ============================================================
// DONNÉES : signataire par défaut, profil membre
// ============================================================
const settingsRef = () => db.collection('settings').doc('certificate');

async function getSignatorySettings() {
  const snap = await settingsRef().get();
  const d = snap.exists ? snap.data() : {};
  return {
    signatoryName: d.signatoryName || '',
    signatoryTitle: d.signatoryTitle || '',
    signatureBuf: d.signatureB64 ? Buffer.from(d.signatureB64, 'base64') : null,
    stampBuf: d.stampB64 ? Buffer.from(d.stampB64, 'base64') : null,
  };
}

async function getMemberProfile(uid) {
  const snap = await db.collection('member_profiles').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

function isProfileComplete(p) {
  return !!(p && p.lastName && p.firstName && p.birthDate && p.birthPlace);
}

// ============================================================
// DATES
// ============================================================
function parseIsoDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

function formatFr(date) {
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ============================================================
// GÉNÉRATION DU PDF
// ============================================================
async function generateCertificatePdfBuffer(data) {
  const qrBuffer = await QRCode.toBuffer(data.verificationUrl, { margin: 1, width: 300 });

  return new Promise((resolve, reject) => {
    try {
      // margin 0 : toutes les positions sont explicites, rien ne peut déclencher une 2e page
      const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;
      const H = doc.page.height;

      // Cadre
      doc.lineWidth(2).rect(20, 20, W - 40, H - 40).stroke('#1e5fb0');
      doc.lineWidth(0.5).rect(28, 28, W - 56, H - 56).stroke('#b9cde8');

      // En-tête
      doc.font('Helvetica').fontSize(11).fillColor('#4d6f94')
        .text('EPISTRATEGIX', 0, 48, { width: W, align: 'center', characterSpacing: 3 });
      doc.font('Helvetica').fontSize(30).fillColor('#0a2647')
        .text('CERTIFICAT DE RÉUSSITE', 0, 70, { width: W, align: 'center' });

      // Bénéficiaire
      doc.font('Helvetica').fontSize(13).fillColor('#3e6188')
        .text('Ce certificat est décerné à', 0, 122, { width: W, align: 'center' });

      const fullName = `${data.firstName} ${data.lastName.toUpperCase()}`;
      doc.font('Helvetica-Bold');
      let nameSize = 26;
      while (nameSize > 14 && doc.fontSize(nameSize).widthOfString(fullName) > W - 160) nameSize -= 1;
      doc.fontSize(nameSize).fillColor('#1e5fb0')
        .text(fullName, 80, 146, { width: W - 160, align: 'center', lineBreak: false });

      doc.font('Helvetica').fontSize(12).fillColor('#3e6188')
        .text(`Né(e) le ${formatFr(data.birthDateObj)} à ${data.birthPlace}`, 80, 184,
          { width: W - 160, align: 'center', height: 16, ellipsis: true });

      doc.font('Helvetica').fontSize(13).fillColor('#3e6188')
        .text('pour avoir complété avec succès', 0, 218, { width: W, align: 'center' });

      // L'intitulé n'est jamais tronqué : sa taille diminue jusqu'à tenir sur 2 lignes
      doc.font('Helvetica');
      let titleSize = 20;
      while (titleSize > 11 && doc.fontSize(titleSize).heightOfString(data.title, { width: W - 200 }) > titleSize * 2.5) {
        titleSize -= 1;
      }
      doc.fontSize(titleSize).fillColor('#0a2647')
        .text(data.title, 100, 240, { width: W - 200, align: 'center', height: 56, ellipsis: true });

      // Mention et observations (facultatives)
      let y = 302;
      if (data.mention) {
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#0a2647')
          .text(`Mention : ${data.mention}`, 80, y, { width: W - 160, align: 'center', height: 18, ellipsis: true });
        y += 26;
      }
      if (data.observations) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#4d6f94')
          .text(data.observations, 130, y, { width: W - 260, align: 'center', height: 40, ellipsis: true });
      }

      // Date et code
      doc.font('Helvetica').fontSize(10).fillColor('#7b95b5')
        .text(`Délivré le ${data.issueDate}`, 0, 388, { width: W, align: 'center' });
      doc.fontSize(9)
        .text(`Code de vérification : ${data.code}`, 0, 402, { width: W, align: 'center' });

      // Bas de page : cachet | signature + signataire | QR code
      const bottomY = 428;
      if (data.stampBuf) {
        doc.image(data.stampBuf, 80, bottomY, { fit: [120, 110], align: 'center', valign: 'center' });
      }

      const sigX = 300;
      const sigW = 240;
      if (data.signatureBuf) {
        doc.image(data.signatureBuf, sigX, bottomY, { fit: [sigW, 70], align: 'center', valign: 'center' });
      }
      if (data.signatoryName) {
        doc.lineWidth(0.7).moveTo(sigX, bottomY + 76).lineTo(sigX + sigW, bottomY + 76).stroke('#7b95b5');
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#0a2647')
          .text(data.signatoryName, sigX, bottomY + 82, { width: sigW, align: 'center', height: 14, ellipsis: true });
        if (data.signatoryTitle) {
          doc.font('Helvetica').fontSize(9.5).fillColor('#4d6f94')
            .text(data.signatoryTitle, sigX, bottomY + 98, { width: sigW, align: 'center', height: 26, ellipsis: true });
        }
      }

      doc.image(qrBuffer, W - 170, bottomY, { width: 100 });
      doc.font('Helvetica').fontSize(7.5).fillColor('#7b95b5')
        .text('Vérifier ce certificat', W - 190, bottomY + 104, { width: 140, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function uploadPdfBuffer(buffer, publicIdPrefix) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image', // ✅ Cloudinary traite les PDF comme des images paginées
        folder: 'epistrategix/certificates',
        public_id: `${publicIdPrefix}-${crypto.randomBytes(6).toString('hex')}`,
        format: 'pdf',
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    uploadStream.end(buffer);
  });
}

// ============================================================
// CRÉATION D'UN CERTIFICAT (commune aux flux automatique et manuel)
// ============================================================
async function createCertificate({
  type, firstName, lastName, birthDate, birthPlace, title, issueDate,
  mention, observations, recipientEmail, clientUid, courseId, signatory,
}) {
  const code = crypto.randomBytes(8).toString('hex').toUpperCase();
  const verificationUrl = `${process.env.FRONTEND_URL}/verifier-certificat.html?code=${code}`;

  const pdfBuffer = await generateCertificatePdfBuffer({
    firstName, lastName, birthPlace, title, issueDate, code, verificationUrl,
    birthDateObj: parseIsoDate(birthDate),
    mention, observations,
    signatoryName: signatory.signatoryName,
    signatoryTitle: signatory.signatoryTitle,
    signatureBuf: signatory.signatureBuf,
    stampBuf: signatory.stampBuf,
  });
  const uploadResult = await uploadPdfBuffer(pdfBuffer, type);

  const record = {
    type,
    code,
    firstName,
    lastName,
    recipientName: `${firstName} ${lastName}`,
    recipientEmail: recipientEmail || null,
    birthDate,
    birthPlace,
    title,
    issueDate,
    mention: mention || '',
    observations: observations || '',
    signatoryName: signatory.signatoryName || '',
    signatoryTitle: signatory.signatoryTitle || '',
    pdfUrl: uploadResult.secure_url,
    createdAt: new Date().toISOString(),
  };
  if (clientUid) record.clientUid = clientUid;
  if (courseId) record.courseId = courseId;

  await db.collection('certificates').doc(code).set(record);
  return { code, pdfUrl: uploadResult.secure_url };
}

// ============================================================
// ÉMISSION AUTOMATIQUE (appelée à la complétion d'une formation certifiante)
// ============================================================
// Lève une erreur de code PROFILE_INCOMPLETE si le membre n'a pas renseigné
// son identité complète : l'appelant met alors le certificat "en attente".
async function issueAutoCertificate({ clientUid, clientEmail, courseId, courseTitle }) {
  const profile = await getMemberProfile(clientUid);
  if (!isProfileComplete(profile)) {
    const err = new Error('Profil du membre incomplet');
    err.code = 'PROFILE_INCOMPLETE';
    throw err;
  }

  // ✅ Un signataire mal configuré ne doit jamais bloquer un apprenant :
  // on émet avec ce qui existe (images et noms facultatifs côté automatique).
  const signatory = await getSignatorySettings();

  const { code } = await createCertificate({
    type: 'auto',
    firstName: profile.firstName,
    lastName: profile.lastName,
    birthDate: profile.birthDate,
    birthPlace: profile.birthPlace,
    title: courseTitle,
    issueDate: formatFr(new Date()),
    recipientEmail: clientEmail,
    clientUid,
    courseId,
    signatory,
  });
  return code;
}

// ============================================================
// CERTIFICATS EN ATTENTE (formation terminée avant que le profil soit complet)
// ============================================================
async function issuePendingCertificatesForClient(clientUid, clientEmail) {
  const snap = await db.collection('enrollments')
    .where('clientUid', '==', clientUid)
    .where('certificatePending', '==', true)
    .get();

  let issued = 0;
  for (const doc of snap.docs) {
    const ref = db.collection('enrollments').doc(doc.id);

    // Réservation atomique : si deux requêtes arrivent en même temps,
    // une seule émet le certificat (évite les doublons).
    const claimed = await db.runTransaction(async (t) => {
      const fresh = await t.get(ref);
      if (!fresh.exists || fresh.data().certificatePending !== true) return false;
      t.update(ref, { certificatePending: false, certificateIssuing: true });
      return true;
    });
    if (!claimed) continue;

    const enrollment = doc.data();
    try {
      let title = enrollment.courseTitle;
      if (!title) {
        const courseDoc = await db.collection('courses').doc(enrollment.courseId).get();
        title = courseDoc.exists ? courseDoc.data().title : 'Formation';
      }
      const code = await issueAutoCertificate({
        clientUid,
        clientEmail: enrollment.clientEmail || clientEmail,
        courseId: enrollment.courseId,
        courseTitle: title,
      });
      await ref.update({ certificateIssuing: false, certificateCode: code });
      issued++;
    } catch (error) {
      await ref.update({ certificateIssuing: false, certificatePending: true });
      if (error.code !== 'PROFILE_INCOMPLETE') {
        console.error('❌ Erreur émission certificat en attente:', error.message);
      }
    }
  }
  return issued;
}

// ============================================================
// 0. DIAGNOSTIC DU TRAITEMENT D'IMAGE (admin) - affiché sur la page des certificats
// ============================================================
router.get('/admin/health', verifyToken, isAdmin, (req, res) => {
  try {
    getImageLibs();
    res.json({ imageProcessing: true, node: process.version });
  } catch (error) {
    res.json({ imageProcessing: false, node: process.version, reason: error.message });
  }
});

// ============================================================
// 1. SIGNATAIRE PAR DÉFAUT - lecture (admin)
// ============================================================
router.get('/admin/settings', verifyToken, isAdmin, async (req, res) => {
  try {
    const s = await getSignatorySettings();
    res.json({
      signatoryName: s.signatoryName,
      signatoryTitle: s.signatoryTitle,
      signaturePreview: s.signatureBuf ? `data:image/png;base64,${s.signatureBuf.toString('base64')}` : null,
      stampPreview: s.stampBuf ? `data:image/png;base64,${s.stampBuf.toString('base64')}` : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. SIGNATAIRE PAR DÉFAUT - enregistrement (admin)
// ============================================================
router.put('/admin/settings', verifyToken, isAdmin, handleImageUpload, async (req, res) => {
  try {
    const b = req.body;
    const updates = {
      signatoryName: (b.signatoryName || '').trim().slice(0, 80),
      signatoryTitle: (b.signatoryTitle || '').trim().slice(0, 120),
      updatedAt: new Date().toISOString(),
    };

    const files = req.files || {};
    if (files.signature && files.signature[0]) {
      updates.signatureB64 = (await frameImage(files.signature[0].buffer)).toString('base64');
    } else if (b.removeSignature === 'true') {
      updates.signatureB64 = '';
    }
    if (files.stamp && files.stamp[0]) {
      updates.stampB64 = (await frameImage(files.stamp[0].buffer)).toString('base64');
    } else if (b.removeStamp === 'true') {
      updates.stampB64 = '';
    }

    await settingsRef().set(updates, { merge: true });
    res.json({ success: true });
  } catch (error) {
    if (!error.status) console.error('❌ Erreur enregistrement signataire:', error);
    res.status(error.status || 500).json({ error: error.message || 'Erreur lors de l\'enregistrement' });
  }
});

// ============================================================
// 3. CERTIFICAT MANUEL (admin) - formation / accompagnement hors plateforme
// ============================================================
router.post('/admin/manual', verifyToken, isAdmin, handleImageUpload, async (req, res) => {
  try {
    const b = req.body;
    const lastName = (b.lastName || '').trim();
    const firstName = (b.firstName || '').trim();
    const birthPlace = (b.birthPlace || '').trim();
    const title = (b.title || '').trim();
    const mention = (b.mention || '').trim().slice(0, 60);
    const observations = (b.observations || '').trim().slice(0, 300);

    if (!lastName || !firstName) {
      return res.status(400).json({ error: 'Nom et prénom du bénéficiaire requis' });
    }
    const birthDateObj = parseIsoDate(b.birthDate);
    if (!birthDateObj || birthDateObj > new Date() || birthDateObj.getFullYear() < 1900) {
      return res.status(400).json({ error: 'Date de naissance invalide' });
    }
    if (!birthPlace) return res.status(400).json({ error: 'Lieu de naissance requis' });
    if (!title) return res.status(400).json({ error: 'Intitulé de la formation requis' });

    let issueDate = formatFr(new Date());
    if (b.issueDate) {
      const d = parseIsoDate(b.issueDate);
      if (!d) return res.status(400).json({ error: 'Date de délivrance invalide' });
      issueDate = formatFr(d);
    }

    // Signataire : valeurs saisies, sinon signataire par défaut
    const defaults = await getSignatorySettings();
    const signatoryName = (b.signatoryName || '').trim() || defaults.signatoryName;
    const signatoryTitle = (b.signatoryTitle || '').trim() || defaults.signatoryTitle;
    if (!signatoryName || !signatoryTitle) {
      return res.status(400).json({ error: 'Nom et titre du signataire requis (ou définissez le signataire par défaut)' });
    }

    const files = req.files || {};
    const signatureBuf = files.signature && files.signature[0]
      ? await frameImage(files.signature[0].buffer)
      : defaults.signatureBuf;
    const stampBuf = files.stamp && files.stamp[0]
      ? await frameImage(files.stamp[0].buffer)
      : defaults.stampBuf;

    if (!signatureBuf) {
      return res.status(400).json({ error: 'Ajoutez une signature (ou définissez-la dans « Signataire par défaut »)' });
    }
    if (!stampBuf) {
      return res.status(400).json({ error: 'Ajoutez un cachet (ou définissez-le dans « Signataire par défaut »)' });
    }

    const result = await createCertificate({
      type: 'manual',
      firstName, lastName,
      birthDate: b.birthDate,
      birthPlace, title, issueDate, mention, observations,
      recipientEmail: (b.recipientEmail || '').trim(),
      signatory: { signatoryName, signatoryTitle, signatureBuf, stampBuf },
    });

    res.status(201).json(result);
  } catch (error) {
    if (!error.status) console.error('❌ Erreur création certificat manuel:', error);
    res.status(error.status || 500).json({ error: error.message || 'Erreur lors de la génération du certificat' });
  }
});

// ============================================================
// 4. LISTER TOUS LES CERTIFICATS (admin)
// ============================================================
router.get('/admin', verifyToken, isAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('certificates').orderBy('createdAt', 'desc').get();
    const certificates = [];
    snapshot.forEach(doc => certificates.push(doc.data()));
    res.json(certificates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 5. VÉRIFIER UN CERTIFICAT PAR CODE (public)
// ============================================================
// ✅ Volontairement minimal : la date et le lieu de naissance ne sont JAMAIS
// exposés publiquement.
router.get('/verify/:code', async (req, res) => {
  try {
    const doc = await db.collection('certificates').doc(req.params.code.toUpperCase()).get();
    if (!doc.exists) return res.json({ valid: false });
    const cert = doc.data();
    res.json({
      valid: true,
      recipientName: cert.recipientName,
      title: cert.title,
      issueDate: cert.issueDate,
      type: cert.type,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 6. MES CERTIFICATS (client connecté)
// ============================================================
router.get('/my-certificates', verifyToken, async (req, res) => {
  try {
    // Auto-réparation : si le profil est complet, on émet d'abord les
    // certificats restés "en attente" (formation terminée avant le profil).
    try {
      const profile = await getMemberProfile(req.user.uid);
      if (isProfileComplete(profile)) {
        await issuePendingCertificatesForClient(req.user.uid, req.user.email);
      }
    } catch (e) {
      console.error('❌ Erreur émission certificats en attente:', e.message);
    }

    const snapshot = await db.collection('certificates')
      .where('clientUid', '==', req.user.uid)
      .get();
    const certificates = [];
    snapshot.forEach(doc => certificates.push(doc.data()));
    res.json(certificates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.issueAutoCertificate = issueAutoCertificate;
module.exports.issuePendingCertificatesForClient = issuePendingCertificatesForClient;
module.exports.getMemberProfile = getMemberProfile;
module.exports.isProfileComplete = isProfileComplete;
